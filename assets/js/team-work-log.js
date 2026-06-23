import {
  createTeamWorkLog as createBackendTeamWorkLog,
  getMyTeamWorkLogs,
  getTeamWorkLogMembers
} from './api-client.js';
import { escapeHtml, formatDateTime, uuid } from './utils.js';
import { setDateInputValue } from './date-inputs.js';

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

export function createTeamWorkLogModule({
  els,
  state,
  renderStatusBanner,
  handleSessionExpired,
  isBackendSessionError,
  renderWorkerSummary,
  renderHistory
}) {
  let rowCounter = 0;

  function selectedMemberIds(row) {
    return [...(row.selectedMemberIds || new Set())];
  }

  function renderSelectedMembers(row) {
    const selected = selectedMemberIds(row)
      .map((memberId) => (state.teamWorkLogMembers || []).find(
        (member) => String(member.id) === String(memberId)
      ))
      .filter(Boolean);
    const selectedContainer = row.querySelector('[data-team-selected-members]');
    selectedContainer.innerHTML = selected.length
      ? selected.map((member) => `
        <button type="button" class="team-member-chip" data-remove-team-member="${member.id}">
          ${escapeHtml(member.name)}
          <span aria-hidden="true">&times;</span>
        </button>
      `).join('')
      : '<span class="team-member-empty">No members selected yet.</span>';

    selectedContainer.querySelectorAll('[data-remove-team-member]').forEach((button) => {
      button.addEventListener('click', () => {
        row.selectedMemberIds.delete(String(button.dataset.removeTeamMember));
        renderMemberChoices(row);
        renderSelectedMembers(row);
        updateRowHours(row);
      });
    });
  }

  function renderMemberChoices(row) {
    const query = row.querySelector('[data-team-member-search]').value.trim().toLowerCase();
    const matches = (state.teamWorkLogMembers || []).filter((member) => (
      !query
      || member.name.toLowerCase().includes(query)
      || (member.worker_class || 'normal').toLowerCase().includes(query)
    ));
    const options = row.querySelector('[data-team-member-options]');
    options.innerHTML = matches.length
      ? matches.map((member) => `
        <label class="team-member-option">
          <input
            type="checkbox"
            value="${member.id}"
            data-team-member-choice
            ${row.selectedMemberIds.has(String(member.id)) ? 'checked' : ''}
          />
          <span>
            <strong>${escapeHtml(member.name)}</strong>
            <small>${escapeHtml(member.worker_class === 'leader' ? 'Leader' : 'Normal worker')}</small>
          </span>
        </label>
      `).join('')
      : '<div class="team-member-no-results">No members match this search.</div>';

    options.querySelectorAll('[data-team-member-choice]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          row.selectedMemberIds.add(String(checkbox.value));
        } else {
          row.selectedMemberIds.delete(String(checkbox.value));
        }
        renderSelectedMembers(row);
        updateRowHours(row);
      });
    });
  }

  function initialiseMemberPicker(row, initial = {}) {
    const initialIds = initial.worker_ids || (initial.worker_id ? [initial.worker_id] : []);
    row.selectedMemberIds = new Set(initialIds.map(String));
    row.querySelector('[data-team-member-search]').addEventListener('input', () => {
      renderMemberChoices(row);
    });
    renderMemberChoices(row);
    renderSelectedMembers(row);
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
    const memberCount = selectedMemberIds(row).length;
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
        <fieldset class="team-member-picker">
          <legend>Members</legend>
          <label class="team-member-search">
            Search members
            <input data-team-member-search type="search" placeholder="Type a member name" autocomplete="off" />
          </label>
          <div class="team-selected-members" data-team-selected-members aria-live="polite"></div>
          <div class="team-member-options" data-team-member-options></div>
        </fieldset>
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
          <input data-team-start type="time" value="${escapeHtml(initial.start_time || '07:00')}" required />
        </label>
        <label>
          Finish
          <input data-team-end type="time" value="${escapeHtml(initial.end_time || '15:30')}" required />
        </label>
        <label>
          Break minutes
          <input data-team-break type="number" min="0" max="1440" step="5" value="${escapeHtml(initial.break_minutes ?? 30)}" required />
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
    });
    row.querySelector('[data-remove-team-row]').addEventListener('click', () => {
      row.remove();
      if (!els.teamWorkLogEntries.children.length) addEntry();
    });
    updateRowHours(row);
    els.teamWorkLogEntries.appendChild(row);
  }

  function workRows() {
    return [...els.teamWorkLogEntries.querySelectorAll('[data-team-log-row]')].map((row) => ({
      worker_ids: selectedMemberIds(row).map(Number),
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
        renderMemberChoices(row);
        renderSelectedMembers(row);
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
    els.teamWorkLogForm.reset();
    setDateInputValue(els.teamWorkLogWeekStart, mondayDateInput());
    els.teamWorkLogEntries.innerHTML = '';
    addEntry();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user || state.user.workerClass !== 'leader') return;
    const rows = workRows();
    if (!rows.length || rows.some((row) => (
      !row.worker_ids.length || !row.site_id || !row.work_date || !row.start_time
      || !row.end_time || !row.work_description
    ))) {
      renderStatusBanner('Select at least one member and complete every team work row before submitting.', true);
      return;
    }
    const entries = entriesPayload(rows);

    els.submitTeamWorkLogButton.disabled = true;
    try {
      await createBackendTeamWorkLog({
        week_start: els.teamWorkLogWeekStart.value,
        notes: els.teamWorkLogNotes.value.trim() || null,
        entries,
        client_submission_id: uuid()
      });
      resetForm();
      await refresh();
      await renderWorkerSummary();
      await renderHistory();
      renderStatusBanner('Weekly team work log submitted for supervisor review.');
    } catch (error) {
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      renderStatusBanner(error.message || 'Could not submit the weekly team log.', true);
    } finally {
      els.submitTeamWorkLogButton.disabled = false;
    }
  }

  function bindEvents() {
    els.addTeamWorkLogEntryButton.addEventListener('click', () => addEntry());
    els.teamWorkLogWeekStart.addEventListener('change', () => {
      els.teamWorkLogEntries.querySelectorAll('[data-team-log-row]').forEach(applyWeekRange);
    });
    els.teamWorkLogForm.addEventListener('submit', handleSubmit);
    els.refreshTeamWorkLogsButton.addEventListener('click', refresh);
  }

  setDateInputValue(els.teamWorkLogWeekStart, mondayDateInput());

  return { bindEvents, refresh };
}
