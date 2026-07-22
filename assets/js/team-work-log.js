import {
  createTeamWorkLog as createBackendTeamWorkLog,
  getMyTeamWorkLogs,
  getTeamWorkLogMembers
} from './api-client.js';
import { clearDraft, saveDraft } from './mock-api.js';
import {
  selectedTeamMemberIds,
  setupTeamMemberPicker,
  teamMemberPickerMarkup,
  updateTeamMemberPickerMembers
} from './team-member-picker.js';
import { escapeHtml, formatDateTime, uuid } from './utils.js';
import { setDateInputValue } from './date-inputs.js';

const TEAM_WORK_LOG_DRAFT_KEY = 'team-work-log';
const AUTOSAVE_DELAY_MS = 700;
const BREAK_MINUTE_OPTIONS = [0, 15, 30, 45, 60];

function mondayDateInput(value = new Date()) {
  const date = new Date(value);
  const day = date.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + offset);
  return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
}

function plusDays(dateText, days) {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function calculatedHours(start, end, breakMinutes) {
  if (!start || !end) return null;
  const [startHours, startMinutes] = start.split(':').map(Number);
  const [endHours, endMinutes] = end.split(':').map(Number);
  let elapsed = ((endHours * 60) + endMinutes) - ((startHours * 60) + startMinutes);
  if (elapsed <= 0) elapsed += 1440;
  const worked = elapsed - Number(breakMinutes || 0);
  return worked > 0 ? Math.round((worked / 60) * 100) / 100 : null;
}

function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function normaliseTimeValue(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return '';
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function timeOptions(selected = '') {
  const selectedValue = normaliseTimeValue(selected);
  const values = new Set();
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    values.add(minutesToTime(minutes));
  }
  if (selectedValue) values.add(selectedValue);

  return [...values]
    .sort((a, b) => {
      const [aHours, aMinutes] = a.split(':').map(Number);
      const [bHours, bMinutes] = b.split(':').map(Number);
      return ((aHours * 60) + aMinutes) - ((bHours * 60) + bMinutes);
    })
    .map((value) => `<option value="${value}"${value === selectedValue ? ' selected' : ''}>${value}</option>`)
    .join('');
}

function normaliseBreakMinutes(value, fallback = 0) {
  const minutes = Number(value);
  return BREAK_MINUTE_OPTIONS.includes(minutes) ? minutes : fallback;
}

function breakLabel(minutes) {
  if (minutes === 0) return 'No break';
  if (minutes === 60) return '1 hour';
  return `${minutes} minutes`;
}

function breakOptions(selected = 0) {
  const selectedValue = normaliseBreakMinutes(selected);
  return BREAK_MINUTE_OPTIONS
    .map((minutes) => (
      `<option value="${minutes}"${minutes === selectedValue ? ' selected' : ''}>${breakLabel(minutes)}</option>`
    ))
    .join('');
}

export function createTeamWorkLogModule({
  els,
  state,
  feedback,
  renderStatusBanner,
  handleSessionExpired,
  isBackendSessionError,
  renderWorkerSummary,
  renderHistory
}) {
  let rowCounter = 0;
  let autosaveTimer = null;
  let restoringDraft = false;

  function setAutosaveStatus(message, stateClass = '') {
    if (!els.teamWorkLogAutosaveStatus) return;
    els.teamWorkLogAutosaveStatus.textContent = message;
    els.teamWorkLogAutosaveStatus.classList.toggle('saved', stateClass === 'saved');
    els.teamWorkLogAutosaveStatus.classList.toggle('error', stateClass === 'error');
  }

  function autosaveTimeLabel(value = new Date()) {
    return new Intl.DateTimeFormat('en-NZ', {
      hour: 'numeric',
      minute: '2-digit'
    }).format(value);
  }

  function initialiseMemberPicker(row, initial = {}) {
    const initialIds = initial.worker_ids || (initial.worker_id ? [initial.worker_id] : []);
    setupTeamMemberPicker(row.querySelector('[data-team-member-picker]'), {
      members: state.teamWorkLogMembers || [],
      initialIds,
      emitInitial: false,
      onChange: () => {
        updateRowHours(row);
        scheduleDraftSave();
      }
    });
  }

  function siteOptions(selected = '') {
    return (state.sites || []).map((site) => (
      `<option value="${site.id}"${String(site.id) === String(selected) ? ' selected' : ''}>${escapeHtml(site.name)}</option>`
    )).join('');
  }

  function updateRowHours(row) {
    const hours = calculatedHours(
      row.querySelector('[data-team-start]').value,
      row.querySelector('[data-team-end]').value,
      row.querySelector('[data-team-break]').value
    );
    const memberCount = selectedTeamMemberIds(row.querySelector('[data-team-member-picker]')).length;
    const totalHours = hours == null ? null : Math.round((hours * memberCount) * 100) / 100;
    row.querySelector('[data-team-hours]').textContent = hours == null
      ? 'Hours: -'
      : memberCount
        ? `${hours}h each | ${memberCount} member${memberCount === 1 ? '' : 's'} | ${totalHours} worker hours`
        : `${hours}h each | Select members`;
  }

  function applyWeekRange(row) {
    const weekStart = els.teamWorkLogWeekStart.value || mondayDateInput();
    const dateInput = row.querySelector('[data-team-date]');
    dateInput.min = weekStart;
    dateInput.max = plusDays(weekStart, 6);
    if (!dateInput.value || dateInput.value < dateInput.min || dateInput.value > dateInput.max) {
      dateInput.value = weekStart;
    }
  }

  function addEntry(initial = {}) {
    rowCounter += 1;
    const row = document.createElement('article');
    row.className = 'team-work-log-entry';
    row.dataset.teamLogRow = String(rowCounter);
    row.innerHTML = `
      <div class="team-log-entry-header">
        <strong>Work row ${rowCounter}</strong>
        <span data-team-hours>Hours: -</span>
        <button type="button" class="ghost" data-remove-team-row>Remove</button>
      </div>
      <div class="team-log-entry-grid">
        ${teamMemberPickerMarkup()}
        <label>
          Work date
          <input data-team-date type="date" value="${escapeHtml(initial.work_date || '')}" required />
        </label>
        <label>
          Site
          <select data-team-site required>
            <option value="">Select site</option>
            ${siteOptions(initial.site_id)}
          </select>
        </label>
        <label>
          Start
          <select data-team-start class="team-time-select" required>
            ${timeOptions(initial.start_time || '07:00')}
          </select>
        </label>
        <label>
          Finish
          <select data-team-end class="team-time-select" required>
            ${timeOptions(initial.end_time || '15:30')}
          </select>
        </label>
        <label>
          Break
          <select data-team-break required>
            ${breakOptions(initial.break_minutes ?? 0)}
          </select>
        </label>
        <label class="team-log-description">
          Work completed
          <textarea data-team-description rows="3" maxlength="3000" required placeholder="What this member completed">${escapeHtml(initial.work_description || '')}</textarea>
        </label>
      </div>
    `;
    initialiseMemberPicker(row, initial);
    applyWeekRange(row);
    ['[data-team-start]', '[data-team-end]', '[data-team-break]'].forEach((selector) => {
      row.querySelector(selector).addEventListener('input', () => updateRowHours(row));
      row.querySelector(selector).addEventListener('change', () => updateRowHours(row));
    });
    row.querySelector('[data-remove-team-row]').addEventListener('click', () => {
      row.remove();
      if (!els.teamWorkLogEntries.children.length) addEntry();
      scheduleDraftSave();
    });
    updateRowHours(row);
    els.teamWorkLogEntries.appendChild(row);
  }

  function draftRows() {
    return [...els.teamWorkLogEntries.querySelectorAll('[data-team-log-row]')].map((row) => ({
      worker_ids: selectedTeamMemberIds(row.querySelector('[data-team-member-picker]')).map(Number),
      site_id: row.querySelector('[data-team-site]').value,
      work_date: row.querySelector('[data-team-date]').value,
      start_time: row.querySelector('[data-team-start]').value,
      end_time: row.querySelector('[data-team-end]').value,
      break_minutes: row.querySelector('[data-team-break]').value,
      work_description: row.querySelector('[data-team-description]').value
    }));
  }

  function rowHasDraftContent(row) {
    return Boolean(
      row.worker_ids.length
      || row.site_id
      || row.work_description.trim()
      || row.work_date !== (els.teamWorkLogWeekStart.value || mondayDateInput())
      || row.start_time !== '07:00'
      || row.end_time !== '15:30'
      || String(row.break_minutes ?? '0') !== '0'
    );
  }

  function draftHasContent(draft) {
    return Boolean(
      (draft.notes || '').trim()
      || draft.week_start !== mondayDateInput()
      || draft.rows.length > 1
      || draft.rows.some(rowHasDraftContent)
    );
  }

  async function persistDraft() {
    if (restoringDraft) return;

    const savedAt = new Date();
    const draft = {
      kind: 'team-work-log',
      week_start: els.teamWorkLogWeekStart.value || mondayDateInput(),
      notes: els.teamWorkLogNotes.value,
      rows: draftRows(),
      saved_at: savedAt.toISOString()
    };

    if (!draftHasContent(draft)) {
      await clearDraft(TEAM_WORK_LOG_DRAFT_KEY);
      setAutosaveStatus('Autosaves on this device.');
      return;
    }

    await saveDraft(TEAM_WORK_LOG_DRAFT_KEY, draft);
    setAutosaveStatus(`Autosaved ${autosaveTimeLabel(savedAt)}.`, 'saved');
  }

  function scheduleDraftSave() {
    if (restoringDraft) return;
    clearTimeout(autosaveTimer);
    setAutosaveStatus('Saving draft...');
    autosaveTimer = setTimeout(async () => {
      try {
        await persistDraft();
      } catch {
        setAutosaveStatus('Could not autosave this team log.', 'error');
      }
    }, AUTOSAVE_DELAY_MS);
  }

  function workRows() {
    return [...els.teamWorkLogEntries.querySelectorAll('[data-team-log-row]')].map((row) => ({
      worker_ids: selectedTeamMemberIds(row.querySelector('[data-team-member-picker]')).map(Number),
      site_id: Number(row.querySelector('[data-team-site]').value),
      work_date: row.querySelector('[data-team-date]').value,
      start_time: row.querySelector('[data-team-start]').value,
      end_time: row.querySelector('[data-team-end]').value,
      break_minutes: Number(row.querySelector('[data-team-break]').value || 0),
      work_description: row.querySelector('[data-team-description]').value.trim()
    }));
  }

  function entriesPayload(rows = workRows()) {
    return rows.flatMap((row) => row.worker_ids.map((workerId) => ({
      worker_id: workerId,
      site_id: row.site_id,
      work_date: row.work_date,
      start_time: row.start_time,
      end_time: row.end_time,
      break_minutes: row.break_minutes,
      work_description: row.work_description
    })));
  }

  function renderSubmittedLogs(logs) {
    els.teamWorkLogHistory.innerHTML = logs.length
      ? logs.map((log) => `
        <article class="record-card team-log-record">
          <div class="record-header">
            <div>
              <h3 class="record-title">Week of ${escapeHtml(log.week_start)}</h3>
              <p class="record-meta">${escapeHtml(log.member_count)} members | ${escapeHtml(log.entry_count)} member entries | ${escapeHtml(log.total_hours)} worker hours | Submitted ${escapeHtml(formatDateTime(log.created_at))}</p>
            </div>
            <span class="badge ${escapeHtml(log.status)}">${escapeHtml(log.status)}</span>
          </div>
          ${log.notes ? `<p class="record-detail">${escapeHtml(log.notes)}</p>` : ''}
          <div class="team-log-entry-summary">
            ${(log.entries || []).map((entry) => `
              <div>
                <strong>${escapeHtml(entry.worker_name)}</strong>
                <span>${escapeHtml(entry.work_date)} | ${escapeHtml(entry.start_time)}-${escapeHtml(entry.end_time)} | ${escapeHtml(entry.hours_worked)}h | ${escapeHtml(entry.site_name)}</span>
                <p>${escapeHtml(entry.work_description)}</p>
              </div>
            `).join('')}
          </div>
        </article>
      `).join('')
      : '<div class="empty-state">No weekly team logs submitted yet.</div>';
  }

  async function refresh() {
    if (!state.user || state.user.workerClass !== 'leader') return;
    try {
      const [members, logs] = await Promise.all([
        getTeamWorkLogMembers(),
        getMyTeamWorkLogs()
      ]);
      state.teamWorkLogMembers = members;
      renderSubmittedLogs(logs);
      if (!els.teamWorkLogEntries.children.length) addEntry();
      els.teamWorkLogEntries.querySelectorAll('[data-team-log-row]').forEach((row) => {
        const site = row.querySelector('[data-team-site]');
        const selectedSite = site.value;
        site.innerHTML = `<option value="">Select site</option>${siteOptions(selectedSite)}`;
        updateTeamMemberPickerMembers(row.querySelector('[data-team-member-picker]'), state.teamWorkLogMembers || []);
      });
    } catch (error) {
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      renderStatusBanner(error.message || 'Could not load team work logs.', true);
    }
  }

  function resetForm() {
    clearTimeout(autosaveTimer);
    els.teamWorkLogForm.reset();
    setDateInputValue(els.teamWorkLogWeekStart, mondayDateInput());
    els.teamWorkLogEntries.innerHTML = '';
    addEntry();
    setAutosaveStatus('Autosaves on this device.');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user || state.user.workerClass !== 'leader') return;
    const rows = workRows();
    if (!rows.length || rows.some((row) => (
      !row.worker_ids.length || !row.site_id || !row.work_date || !row.start_time
      || !row.end_time || !row.work_description
    ))) {
      const invalidRow = [...els.teamWorkLogEntries.querySelectorAll('[data-team-log-row]')]
        .find((row) => (
          !selectedTeamMemberIds(row.querySelector('[data-team-member-picker]')).length
          || !row.querySelector('[data-team-site]').value
          || !row.querySelector('[data-team-date]').value
          || !row.querySelector('[data-team-start]').value
          || !row.querySelector('[data-team-end]').value
          || !row.querySelector('[data-team-description]').value.trim()
        ));
      const invalidField = invalidRow && (
        !selectedTeamMemberIds(invalidRow.querySelector('[data-team-member-picker]')).length
          ? invalidRow.querySelector('[data-team-member-search]')
          : [...invalidRow.querySelectorAll('[data-team-site], [data-team-date], [data-team-start], [data-team-end], [data-team-description]')]
            .find((field) => !field.value.trim())
      );
      renderStatusBanner('Select at least one member and complete every team work row before submitting.', true, {
        local: els.teamWorkLogFeedback,
        field: invalidField,
        tone: 'error'
      });
      return;
    }
    const entries = entriesPayload(rows);

    feedback.clearLocal(els.teamWorkLogFeedback);
    feedback.setButtonBusy(els.submitTeamWorkLogButton, true, 'Submitting weekly log...');
    try {
      await createBackendTeamWorkLog({
        week_start: els.teamWorkLogWeekStart.value,
        notes: els.teamWorkLogNotes.value.trim() || null,
        entries,
        client_submission_id: uuid()
      });
      await clearDraft(TEAM_WORK_LOG_DRAFT_KEY);
      resetForm();
      await refresh();
      await renderWorkerSummary();
      await renderHistory();
      renderStatusBanner('Weekly team work log submitted for supervisor review.', false, {
        local: els.teamWorkLogFeedback,
        tone: 'success'
      });
    } catch (error) {
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      renderStatusBanner(error.message || 'Could not submit the weekly team log.', true, {
        local: els.teamWorkLogFeedback,
        tone: 'error'
      });
    } finally {
      feedback.setButtonBusy(els.submitTeamWorkLogButton, false);
    }
  }

  function bindEvents() {
    els.addTeamWorkLogEntryButton.addEventListener('click', () => {
      addEntry();
      scheduleDraftSave();
    });
    els.teamWorkLogWeekStart.addEventListener('change', () => {
      els.teamWorkLogEntries.querySelectorAll('[data-team-log-row]').forEach(applyWeekRange);
      scheduleDraftSave();
    });
    els.teamWorkLogForm.addEventListener('input', scheduleDraftSave);
    els.teamWorkLogForm.addEventListener('change', scheduleDraftSave);
    els.teamWorkLogForm.addEventListener('submit', handleSubmit);
    els.refreshTeamWorkLogsButton.addEventListener('click', refresh);
  }

  function restoreDraft(draft) {
    if (!draft || draft.kind !== 'team-work-log') return;

    restoringDraft = true;
    clearTimeout(autosaveTimer);
    els.teamWorkLogForm.reset();
    setDateInputValue(els.teamWorkLogWeekStart, draft.week_start || mondayDateInput());
    els.teamWorkLogNotes.value = draft.notes || '';
    els.teamWorkLogEntries.innerHTML = '';
    (draft.rows?.length ? draft.rows : [{}]).forEach((row) => addEntry(row));
    setAutosaveStatus(
      draft.saved_at
        ? `Restored autosaved draft from ${autosaveTimeLabel(new Date(draft.saved_at))}.`
        : 'Restored autosaved draft.',
      'saved'
    );
    restoringDraft = false;
  }

  setDateInputValue(els.teamWorkLogWeekStart, mondayDateInput());

  return { bindEvents, refresh, restoreDraft };
}
