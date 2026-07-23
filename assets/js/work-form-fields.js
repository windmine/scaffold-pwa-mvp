import {
  selectedTeamMemberLabels,
  setTeamMemberPickerSelectionFromNames,
  setupTeamMemberPicker,
  teamMemberPickerMarkup
} from './team-member-picker.js';
import { setTranslatableText } from './i18n.js';
import { escapeHtml } from './utils.js';

const DEFAULT_FIELD_PREFIX = 'workFormField';
const DEFAULT_REPEAT_MAX_ROWS = 12;
const SIGNATURE_KEYBOARD_STEP = 12;
const SIGNATURE_KEYBOARD_LARGE_STEP = 36;

function fieldInputId(field, idPrefix = DEFAULT_FIELD_PREFIX, rowContext = null) {
  if (!rowContext) return `${idPrefix}_${field.id}`;
  return `${idPrefix}_${rowContext.parentId}_${rowContext.rowKey}_${field.id}`;
}

function fieldTimeInputId(field, part, idPrefix = DEFAULT_FIELD_PREFIX, rowContext = null) {
  return `${fieldInputId(field, idPrefix, rowContext)}_${part}`;
}

function normaliseFieldType(type) {
  const value = String(type || 'text').trim().toLowerCase();
  if (['subsection', 'sub_section'].includes(value)) return 'section';
  if (['time-range', 'timerange'].includes(value)) return 'time_range';
  return value;
}

function normaliseField(field = {}) {
  return {
    ...field,
    type: normaliseFieldType(field.type),
    required: Boolean(field.required),
    options: field.options || [],
    show_if: field.show_if || field.showIf || '',
    formula: field.formula || '',
    repeat: field.repeat || '',
    min_rows: Number.isFinite(Number(field.min_rows ?? field.minRows)) ? Number(field.min_rows ?? field.minRows) : null,
    max_rows: Number.isFinite(Number(field.max_rows ?? field.maxRows)) ? Number(field.max_rows ?? field.maxRows) : null
  };
}

function normalisedFields(form) {
  return (form?.fields || []).map(normaliseField);
}

function repeatChildren(fields, repeatId) {
  return fields.filter((field) => field.repeat === repeatId);
}

function topLevelFields(fields) {
  return fields.filter((field) => !field.repeat);
}

function minRows(field) {
  if (Number.isFinite(field.min_rows)) return Math.max(0, field.min_rows);
  return field.required ? 1 : 0;
}

function maxRows(field) {
  if (Number.isFinite(field.max_rows)) return Math.max(1, field.max_rows);
  return DEFAULT_REPEAT_MAX_ROWS;
}

function timeToMinutes(value) {
  const [hoursRaw, minutesRaw] = String(value || '').split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function timeRangeDurationHours(start, end) {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  if (startMinutes == null || endMinutes == null) return null;

  const durationMinutes = endMinutes >= startMinutes
    ? endMinutes - startMinutes
    : (24 * 60) - startMinutes + endMinutes;
  return Math.round((durationMinutes / 60) * 100) / 100;
}

export function formatWorkFormAnswer(value, type = '') {
  if (type === 'signature') return value ? 'Signed' : '';
  if (type === 'repeat' && Array.isArray(value)) {
    return value
      .map((row, index) => {
        const details = Object.entries(row || {})
          .filter(([, item]) => item !== '' && item != null && item !== false)
          .map(([key, item]) => `${key}: ${formatWorkFormAnswer(item)}`)
          .join(', ');
        return details ? `Row ${index + 1}: ${details}` : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (value == null || value === '') return '';
  if (type === 'time_range' && typeof value === 'object') {
    const start = value.start || '-';
    const end = value.end || '-';
    return `${start} to ${end}${value.duration_hours != null ? ` (${value.duration_hours}h)` : ''}`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatWorkFormAnswer(item)).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${formatWorkFormAnswer(item)}`)
      .join(', ');
  }
  return String(value);
}

function signatureStatusElement(canvas) {
  const statusId = canvas.dataset.signatureStatus;
  return statusId ? canvas.ownerDocument.getElementById(statusId) : null;
}

function announceSignatureStatus(canvas, message) {
  const status = signatureStatusElement(canvas);
  if (status) setTranslatableText(status, message);
}

function resetSignatureCanvas(canvas, { announce = false } = {}) {
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#111111';
  context.lineWidth = 4;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  canvas.dataset.signed = 'false';
  canvas.dataset.signatureKeyboardDrawing = 'false';
  canvas.dataset.signatureKeyboardChanged = 'false';
  canvas.dataset.signatureKeyboardX = String(canvas.width / 2);
  canvas.dataset.signatureKeyboardY = String(canvas.height / 2);
  delete canvas.dataset.restoredSignature;
  delete canvas.dataset.signatureRestoreToken;
  if (announce) announceSignatureStatus(canvas, 'Signature cleared. The signature pad is blank.');
}

function signaturePoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function beginSignatureEdit(canvas) {
  if (canvas.dataset.restoredSignature) canvas.dataset.signed = 'false';
  delete canvas.dataset.restoredSignature;
  delete canvas.dataset.signatureRestoreToken;
}

function drawSignatureSegment(canvas, start, end) {
  if (start.x === end.x && start.y === end.y) return false;

  const context = canvas.getContext('2d');
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();

  const wasSigned = canvas.dataset.signed === 'true';
  canvas.dataset.signed = 'true';
  canvas.removeAttribute('aria-invalid');
  if (!wasSigned) canvas.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function keyboardSignaturePoint(canvas) {
  const x = Number(canvas.dataset.signatureKeyboardX);
  const y = Number(canvas.dataset.signatureKeyboardY);
  return {
    x: Number.isFinite(x) ? x : canvas.width / 2,
    y: Number.isFinite(y) ? y : canvas.height / 2
  };
}

function keyboardSignatureDestination(canvas, point, key, step) {
  const destination = { ...point };
  if (key === 'ArrowUp') destination.y -= step;
  if (key === 'ArrowDown') destination.y += step;
  if (key === 'ArrowLeft') destination.x -= step;
  if (key === 'ArrowRight') destination.x += step;
  destination.x = Math.max(0, Math.min(canvas.width, destination.x));
  destination.y = Math.max(0, Math.min(canvas.height, destination.y));
  return destination;
}

function stopKeyboardSignature(canvas, { announce = true } = {}) {
  if (canvas.dataset.signatureKeyboardDrawing !== 'true') return;

  const changed = canvas.dataset.signatureKeyboardChanged === 'true';
  canvas.dataset.signatureKeyboardDrawing = 'false';
  canvas.dataset.signatureKeyboardChanged = 'false';
  if (changed) canvas.dispatchEvent(new Event('change', { bubbles: true }));
  if (announce) {
    announceSignatureStatus(
      canvas,
      canvas.dataset.signed === 'true'
        ? 'Keyboard drawing stopped. Signature captured.'
        : 'Keyboard drawing stopped. The signature pad is still blank.'
    );
  }
}

function setupSignaturePads(container) {
  container.querySelectorAll('[data-signature-canvas]').forEach((canvas) => {
    if (canvas.dataset.signatureReady === 'true') return;

    resetSignatureCanvas(canvas);
    canvas.dataset.signatureReady = 'true';
    let drawing = false;
    let lastPoint = null;

    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      stopKeyboardSignature(canvas, { announce: false });
      beginSignatureEdit(canvas);
      drawing = true;
      lastPoint = signaturePoint(canvas, event);
      canvas.setPointerCapture?.(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!drawing || !lastPoint) return;
      event.preventDefault();
      const point = signaturePoint(canvas, event);
      drawSignatureSegment(canvas, lastPoint, point);
      lastPoint = point;
    });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
      canvas.addEventListener(eventName, () => {
        const completedStroke = drawing && canvas.dataset.signed === 'true';
        drawing = false;
        lastPoint = null;
        if (completedStroke) {
          canvas.dispatchEvent(new Event('change', { bubbles: true }));
          announceSignatureStatus(canvas, 'Signature captured.');
        }
      });
    });

    canvas.addEventListener('keydown', (event) => {
      const isToggleKey = event.key === ' ' || event.key === 'Enter';
      if (isToggleKey) {
        event.preventDefault();
        if (event.repeat) return;
        if (canvas.dataset.signatureKeyboardDrawing === 'true') {
          stopKeyboardSignature(canvas);
        } else {
          beginSignatureEdit(canvas);
          canvas.dataset.signatureKeyboardDrawing = 'true';
          canvas.dataset.signatureKeyboardChanged = 'false';
          announceSignatureStatus(canvas, 'Keyboard drawing started. Use the arrow keys to draw, then press Space, Enter or Escape to stop.');
        }
        return;
      }

      if (event.key === 'Escape' && canvas.dataset.signatureKeyboardDrawing === 'true') {
        event.preventDefault();
        stopKeyboardSignature(canvas);
        return;
      }

      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (canvas.dataset.signatureKeyboardDrawing !== 'true') return;

      event.preventDefault();
      const point = keyboardSignaturePoint(canvas);
      const step = event.shiftKey ? SIGNATURE_KEYBOARD_LARGE_STEP : SIGNATURE_KEYBOARD_STEP;
      const destination = keyboardSignatureDestination(canvas, point, event.key, step);
      if (drawSignatureSegment(canvas, point, destination)) {
        canvas.dataset.signatureKeyboardChanged = 'true';
        canvas.dataset.signatureKeyboardX = String(destination.x);
        canvas.dataset.signatureKeyboardY = String(destination.y);
      }
    });

    canvas.addEventListener('blur', () => stopKeyboardSignature(canvas, { announce: false }));
  });

  container.querySelectorAll('[data-signature-clear]').forEach((button) => {
    if (button.dataset.signatureClearReady === 'true') return;
    button.dataset.signatureClearReady = 'true';
    button.addEventListener('click', () => {
      const canvas = container.querySelector(`[data-signature-canvas="${CSS.escape(button.dataset.signatureClear)}"]`);
      if (canvas) {
        resetSignatureCanvas(canvas, { announce: true });
        canvas.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
}

function fieldDataAttributes(field, rowContext = null) {
  return [
    `data-work-form-field="${escapeHtml(field.id)}"`,
    `data-field-type="${escapeHtml(field.type)}"`,
    field.show_if ? `data-show-if="${escapeHtml(field.show_if)}"` : '',
    field.formula ? `data-formula="${escapeHtml(field.formula)}"` : '',
    rowContext ? `data-repeat-child="${escapeHtml(rowContext.parentId)}"` : ''
  ].filter(Boolean).join(' ');
}

function usesDayworkTeamMemberPicker(field, options = {}, rowContext = null) {
  return Boolean(
    options.enhanceDayworkTeamMembers
    && rowContext?.parentId === 'teams'
    && field.id === 'team_name'
  );
}

function usesDayworkTeamMemberCount(field, options = {}, rowContext = null) {
  return Boolean(
    options.enhanceDayworkTeamMembers
    && rowContext?.parentId === 'teams'
    && field.id === 'team_people'
  );
}

function renderField(field, options = {}, rowContext = null) {
  const idPrefix = options.idPrefix || DEFAULT_FIELD_PREFIX;
  const required = field.required ? ' required' : '';
  const label = `${field.label}${field.required ? ' *' : ''}`;
  const attrs = fieldDataAttributes(field, rowContext);

  if (usesDayworkTeamMemberPicker(field, options, rowContext)) {
    return `
      <div class="daywork-team-member-field" ${attrs}>
        ${teamMemberPickerMarkup({ legend: label })}
        <input id="${fieldInputId(field, idPrefix, rowContext)}" type="hidden" data-daywork-team-member-names />
      </div>
    `;
  }

  if (usesDayworkTeamMemberCount(field, options, rowContext)) {
    return `
      <input id="${fieldInputId(field, idPrefix, rowContext)}" type="hidden" ${attrs} data-daywork-team-member-count />
    `;
  }

  if (field.type === 'section') {
    return `
      <section class="work-form-section" aria-label="${escapeHtml(field.label)}" ${attrs}>
        <p class="eyebrow">Subsection</p>
        <h3>${escapeHtml(field.label)}</h3>
      </section>
    `;
  }

  if (field.type === 'time_range') {
    return `
      <fieldset class="time-range-field" ${attrs}>
        <legend>${escapeHtml(label)}</legend>
        <div class="time-range-inputs">
          <label>
            Start time
            <input id="${fieldTimeInputId(field, 'start', idPrefix, rowContext)}" type="time"${required} />
          </label>
          <label>
            End time
            <input id="${fieldTimeInputId(field, 'end', idPrefix, rowContext)}" type="time"${required} />
          </label>
        </div>
      </fieldset>
    `;
  }

  if (field.type === 'textarea') {
    return `
      <label ${attrs}>
        ${escapeHtml(label)}
        <textarea id="${fieldInputId(field, idPrefix, rowContext)}" rows="4"${required}></textarea>
      </label>
    `;
  }

  if (field.type === 'select') {
    return `
      <label ${attrs}>
        ${escapeHtml(label)}
        <select id="${fieldInputId(field, idPrefix, rowContext)}"${required}>
          <option value="">Select</option>
          ${(field.options || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}
        </select>
      </label>
    `;
  }

  if (field.type === 'checkbox') {
    return `
      <label class="checkbox-field form-checkbox-field" ${attrs}>
        <input id="${fieldInputId(field, idPrefix, rowContext)}" type="checkbox" />
        <span class="form-checkbox-control" aria-hidden="true"></span>
        <span class="form-checkbox-label">${escapeHtml(label)}</span>
      </label>
    `;
  }

  if (field.type === 'signature') {
    const signatureKey = fieldInputId(field, idPrefix, rowContext);
    const signatureLabelId = `${signatureKey}_label`;
    const signatureInstructionsId = `${signatureKey}_instructions`;
    const signatureStatusId = `${signatureKey}_status`;
    return `
      <div class="signature-field" data-signature-field="${escapeHtml(field.id)}" data-signature-required="${field.required ? 'true' : 'false'}" ${attrs}>
        <div class="signature-toolbar">
          <strong id="${escapeHtml(signatureLabelId)}">
            ${escapeHtml(field.label)}${field.required ? '<span aria-hidden="true"> *</span><span class="visually-hidden"> (required)</span>' : ''}
          </strong>
          <button type="button" class="ghost" data-signature-clear="${escapeHtml(signatureKey)}" aria-label="Clear ${escapeHtml(field.label)} signature" aria-controls="${escapeHtml(signatureKey)}">Clear</button>
        </div>
        <canvas
          id="${escapeHtml(signatureKey)}"
          class="signature-canvas"
          width="720"
          height="220"
          data-signature-canvas="${escapeHtml(signatureKey)}"
          data-signature-status="${escapeHtml(signatureStatusId)}"
          tabindex="0"
          role="application"
          aria-roledescription="signature pad"
          aria-labelledby="${escapeHtml(signatureLabelId)}"
          aria-describedby="${escapeHtml(signatureInstructionsId)} ${escapeHtml(signatureStatusId)}"
          aria-keyshortcuts="Space Enter ArrowUp ArrowDown ArrowLeft ArrowRight Escape"
        ></canvas>
        <p id="${escapeHtml(signatureInstructionsId)}" class="muted">Draw your signature inside the box. Keyboard: focus the signature pad, press Space or Enter to start, use the arrow keys to draw (hold Shift for larger moves), then press Space, Enter or Escape to stop.</p>
        <p id="${escapeHtml(signatureStatusId)}" class="visually-hidden" data-signature-status role="status" aria-live="polite" aria-atomic="true">The signature pad is blank.</p>
      </div>
    `;
  }

  if (field.type === 'formula') {
    return `
      <label ${attrs}>
        ${escapeHtml(label)}
        <input id="${fieldInputId(field, idPrefix, rowContext)}" type="number" step="0.01" readonly data-formula-output="${escapeHtml(field.id)}" />
      </label>
    `;
  }

  const inputType = field.type === 'number' || field.type === 'date' ? field.type : 'text';
  const step = field.type === 'number' ? ' step="0.01"' : '';
  return `
    <label ${attrs}>
      ${escapeHtml(label)}
      <input id="${fieldInputId(field, idPrefix, rowContext)}" type="${inputType}"${step}${required} />
    </label>
  `;
}

function renderRepeatRow(parent, children, rowKey, options = {}) {
  const rowContext = { parentId: parent.id, rowKey };
  return `
    <div class="repeat-row" data-repeat-row="${escapeHtml(parent.id)}" data-repeat-row-key="${escapeHtml(rowKey)}">
      <div class="repeat-row-header">
        <strong>${escapeHtml(parent.label)} row</strong>
        <button type="button" class="ghost" data-repeat-remove="${escapeHtml(parent.id)}">Remove</button>
      </div>
      <div class="repeat-row-fields">
        ${children.map((child) => renderField(child, options, rowContext)).join('')}
      </div>
    </div>
  `;
}

function renderRepeatField(parent, children, options = {}) {
  const idPrefix = options.idPrefix || DEFAULT_FIELD_PREFIX;
  const initialRows = Math.max(minRows(parent), 1);
  const rows = Array.from({ length: initialRows }, (_, index) => renderRepeatRow(parent, children, index, { ...options, idPrefix })).join('');
  return `
    <section class="repeat-section" data-repeat-section="${escapeHtml(parent.id)}" data-repeat-min="${minRows(parent)}" data-repeat-max="${maxRows(parent)}" ${fieldDataAttributes(parent)}>
      <div class="repeat-section-header">
        <div>
          <p class="eyebrow">Repeatable section</p>
          <h3>${escapeHtml(parent.label)}${parent.required ? ' *' : ''}</h3>
        </div>
        <button type="button" class="ghost" data-repeat-add="${escapeHtml(parent.id)}">Add row</button>
      </div>
      <div class="repeat-rows" data-repeat-rows="${escapeHtml(parent.id)}">${rows}</div>
    </section>
  `;
}

export function renderWorkFormFields(container, form, options = {}) {
  if (!form) {
    container.innerHTML = '<div class="empty-state">Select a form to show its fields.</div>';
    return;
  }

  const fields = normalisedFields(form);
  container.innerHTML = topLevelFields(fields).map((field) => {
    if (field.type === 'repeat') {
      return renderRepeatField(field, repeatChildren(fields, field.id), options);
    }
    return renderField(field, options);
  }).join('');

  setupWorkFormInteractions(container, { ...form, fields }, options);
}

function setupWorkFormInteractions(container, form, options) {
  container._workFormController?.abort();
  const controller = new AbortController();
  container._workFormController = controller;

  setupSignaturePads(container);
  setupDayworkTeamMemberPickers(container, options);

  container.addEventListener('click', (event) => {
    const addButton = event.target.closest('[data-repeat-add]');
    const removeButton = event.target.closest('[data-repeat-remove]');

    if (addButton) {
      addRepeatRow(container, form, addButton.dataset.repeatAdd, options);
      return;
    }
    if (removeButton) {
      removeRepeatRow(container, form, removeButton, options);
    }
  }, { signal: controller.signal });

  ['input', 'change'].forEach((eventName) => {
    container.addEventListener(eventName, () => {
      updateDynamicState(container, form, options);
    }, { signal: controller.signal });
  });

  updateRepeatButtons(container);
  updateDynamicState(container, form, options);
}

function dayworkTeamRows(scope) {
  const nestedRows = scope.querySelectorAll ? Array.from(scope.querySelectorAll('[data-repeat-row="teams"]')) : [];
  return [
    ...(scope.matches?.('[data-repeat-row="teams"]') ? [scope] : []),
    ...nestedRows
  ];
}

function setupDayworkTeamMemberPickers(scope, options = {}) {
  if (!options.enhanceDayworkTeamMembers) return;

  dayworkTeamRows(scope).forEach((row) => {
    const picker = row.querySelector('[data-team-member-picker]');
    const nameInput = row.querySelector('[data-daywork-team-member-names]');
    const countInput = row.querySelector('[data-daywork-team-member-count]');
    if (!picker || !nameInput || !countInput) return;

    setupTeamMemberPicker(picker, {
      members: options.teamMembers || [],
      initialNames: nameInput.value.split(',').map((name) => name.trim()).filter(Boolean),
      onChange: () => {
        const labels = selectedTeamMemberLabels(picker);
        nameInput.value = labels.join(', ');
        countInput.value = labels.length ? String(labels.length) : '';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        countInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });
}

function addRepeatRow(container, form, repeatId, options = {}, values = null) {
  const fields = normalisedFields(form);
  const parent = fields.find((field) => field.id === repeatId && field.type === 'repeat');
  if (!parent) return;

  const rowsContainer = container.querySelector(`[data-repeat-rows="${CSS.escape(repeatId)}"]`);
  if (!rowsContainer) return;

  const currentRows = rowsContainer.querySelectorAll(`[data-repeat-row="${CSS.escape(repeatId)}"]`);
  if (currentRows.length >= maxRows(parent)) return;

  const nextRowKey = Array.from(currentRows)
    .map((row) => Number(row.dataset.repeatRowKey))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), -1) + 1;

  rowsContainer.insertAdjacentHTML(
    'beforeend',
    renderRepeatRow(
      parent,
      repeatChildren(fields, repeatId),
      nextRowKey,
      { ...options, idPrefix: options.idPrefix || DEFAULT_FIELD_PREFIX }
    )
  );

  const row = rowsContainer.querySelector(`[data-repeat-row-key="${CSS.escape(String(nextRowKey))}"]`);
  setupSignaturePads(row || rowsContainer);
  setupDayworkTeamMemberPickers(row || rowsContainer, options);
  if (row && values) populateRepeatRow(row, parent, repeatChildren(fields, repeatId), values, options);
  updateRepeatButtons(container);
  updateDynamicState(container, form, options);
  if (!values) container.dispatchEvent(new Event('change', { bubbles: true }));
}

function removeRepeatRow(container, form, button, options = {}) {
  const repeatId = button.dataset.repeatRemove;
  const section = container.querySelector(`[data-repeat-section="${CSS.escape(repeatId)}"]`);
  const row = button.closest('[data-repeat-row]');
  if (!section || !row) return;

  const min = Number(section.dataset.repeatMin || 0);
  const rows = section.querySelectorAll(`[data-repeat-row="${CSS.escape(repeatId)}"]`);
  if (rows.length <= Math.max(min, 1)) return;

  row.remove();
  updateRepeatButtons(container);
  updateDynamicState(container, form, options);
  container.dispatchEvent(new Event('change', { bubbles: true }));
}

function updateRepeatButtons(container) {
  container.querySelectorAll('[data-repeat-section]').forEach((section) => {
    const repeatId = section.dataset.repeatSection;
    const rows = section.querySelectorAll(`[data-repeat-row="${CSS.escape(repeatId)}"]`);
    const min = Number(section.dataset.repeatMin || 0);
    const max = Number(section.dataset.repeatMax || DEFAULT_REPEAT_MAX_ROWS);
    const addButton = section.querySelector(`[data-repeat-add="${CSS.escape(repeatId)}"]`);
    if (addButton) addButton.disabled = rows.length >= max;

    section.querySelectorAll(`[data-repeat-remove="${CSS.escape(repeatId)}"]`).forEach((button) => {
      button.disabled = rows.length <= Math.max(min, 1);
    });
  });
}

function setWrapperVisible(wrapper, visible) {
  if (!wrapper) return;
  wrapper.classList.toggle('hidden', !visible);
  wrapper.querySelectorAll('input, textarea, select, button').forEach((element) => {
    if (element.matches('[data-repeat-add], [data-repeat-remove]')) return;
    element.disabled = !visible;
  });
}

function inputValue(field, idPrefix, rowContext = null) {
  if (field.type === 'time_range') {
    const start = document.getElementById(fieldTimeInputId(field, 'start', idPrefix, rowContext))?.value || '';
    const end = document.getElementById(fieldTimeInputId(field, 'end', idPrefix, rowContext))?.value || '';
    return {
      start,
      end
    };
  }

  const input = document.getElementById(fieldInputId(field, idPrefix, rowContext));
  if (!input) return '';
  if (field.type === 'checkbox') return input.checked;
  return input.value;
}

function numericValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const serverDuration = Number(value.duration_hours);
    if (Number.isFinite(serverDuration)) return serverDuration;
    return timeRangeDurationHours(value.start, value.end) ?? 0;
  }
  const breakDuration = breakAnswerDurationHours(value);
  if (breakDuration != null) return breakDuration;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function breakAnswerDurationHours(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (['no break', 'none', '0', '0 minutes', '0 minute'].includes(text)) return 0;
  if (['0.25', '15', '15 min', '15 mins', '15 minute', '15 minutes'].includes(text)) return 0.25;
  if (['0.5', '0.50', '30', '30 min', '30 mins', '30 minute', '30 minutes'].includes(text)) return 0.5;
  if (['0.75', '45', '45 min', '45 mins', '45 minute', '45 minutes'].includes(text)) return 0.75;
  if (['1', '1.0', '1 hour', '1 hr', '60', '60 min', '60 mins', '60 minute', '60 minutes'].includes(text)) return 1;
  return null;
}

function evaluateFormula(expression, answers) {
  // Preview only. Formula values are omitted from submissions and derived again by the API.
  const formula = String(expression || '').trim();
  if (!formula || /[^-+*/().\w\s]/.test(formula)) return '';

  const scope = new Proxy(
    Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, numericValue(value)])),
    { get: (target, key) => (key in target ? target[key] : 0) }
  );

  try {
    const value = Function('scope', `with (scope) { return ${formula}; }`)(scope);
    return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : '';
  } catch {
    return '';
  }
}

function compareConditionValue(left, operator, right) {
  const leftText = left && typeof left === 'object'
    ? String(numericValue(left))
    : String(left ?? '');
  const rightText = String(right || '').trim();

  if (operator === '=' || operator === '!=') {
    const result = leftText.trim().toLowerCase() === rightText.toLowerCase();
    return operator === '!=' ? !result : result;
  }

  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  if (operator === '>') return leftNumber > rightNumber;
  if (operator === '<') return leftNumber < rightNumber;
  if (operator === '>=') return leftNumber >= rightNumber;
  if (operator === '<=') return leftNumber <= rightNumber;
  return false;
}

function conditionMet(condition, answers) {
  const expression = String(condition || '').trim();
  if (!expression) return true;

  for (const operator of ['!=', '>=', '<=', '=', '>', '<']) {
    if (expression.includes(operator)) {
      const [fieldId, expected] = expression.split(operator);
      return compareConditionValue(answers[fieldId.trim()], operator, expected);
    }
  }
  return true;
}

function updateDynamicState(container, form, options = {}) {
  const idPrefix = options.idPrefix || DEFAULT_FIELD_PREFIX;
  const fields = normalisedFields(form);
  const answers = {};

  for (const field of topLevelFields(fields)) {
    if (field.type === 'section') continue;

    const wrapper = container.querySelector(`[data-work-form-field="${CSS.escape(field.id)}"]:not([data-repeat-child])`);
    const visible = conditionMet(field.show_if, answers);
    setWrapperVisible(wrapper, visible);

    if (!visible) {
      answers[field.id] = field.type === 'repeat' ? [] : '';
      continue;
    }

    if (field.type === 'repeat') {
      updateRepeatDynamicState(container, form, field, answers, options);
      answers[field.id] = [];
      continue;
    }

    if (field.type === 'formula') {
      const value = evaluateFormula(field.formula, answers);
      const input = document.getElementById(fieldInputId(field, idPrefix));
      if (input) input.value = value;
      answers[field.id] = value;
      continue;
    }

    answers[field.id] = inputValue(field, idPrefix);
  }
}

function updateRepeatDynamicState(container, form, parent, parentAnswers, options = {}) {
  const idPrefix = options.idPrefix || DEFAULT_FIELD_PREFIX;
  const fields = normalisedFields(form);
  const children = repeatChildren(fields, parent.id);

  container.querySelectorAll(`[data-repeat-row="${CSS.escape(parent.id)}"]`).forEach((row) => {
    const rowKey = row.dataset.repeatRowKey;
    const rowContext = { parentId: parent.id, rowKey };
    const rowAnswers = {};

    for (const child of children) {
      if (child.type === 'section') continue;
      const wrapper = row.querySelector(`[data-work-form-field="${CSS.escape(child.id)}"]`);
      const visible = conditionMet(child.show_if, { ...parentAnswers, ...rowAnswers });
      setWrapperVisible(wrapper, visible);

      if (!visible) {
        rowAnswers[child.id] = '';
        continue;
      }

      if (child.type === 'formula') {
        const value = evaluateFormula(child.formula, { ...parentAnswers, ...rowAnswers });
        const input = document.getElementById(fieldInputId(child, idPrefix, rowContext));
        if (input) input.value = value;
        rowAnswers[child.id] = value;
        continue;
      }

      rowAnswers[child.id] = inputValue(child, idPrefix, rowContext);
    }
  });
}

function workFormValidationError(message, fieldId) {
  const error = new Error(message);
  error.name = 'WorkFormValidationError';
  error.fieldId = fieldId;
  return error;
}

function collectSignatureAnswer(field, options = {}, rowContext = null) {
  const validate = options.validate !== false;
  const canvas = document.getElementById(fieldInputId(field, options.idPrefix, rowContext));
  if (!canvas || canvas.dataset.signed !== 'true') {
    if (field.required && validate) {
      canvas?.setAttribute('aria-invalid', 'true');
      throw workFormValidationError(
        `${field.label} is required.`,
        fieldInputId(field, options.idPrefix, rowContext)
      );
    }
    return '';
  }

  canvas.removeAttribute('aria-invalid');

  if (canvas.dataset.restoredSignature?.startsWith('data:image/')) {
    return canvas.dataset.restoredSignature;
  }

  return canvas.toDataURL('image/png');
}

function collectSingleField(field, options = {}, rowContext = null) {
  const validate = options.validate !== false;
  const idPrefix = options.idPrefix || DEFAULT_FIELD_PREFIX;

  if (field.type === 'time_range') {
    const value = inputValue(field, idPrefix, rowContext);
    if (validate && field.required && (!value.start || !value.end)) {
      throw workFormValidationError(
        `${field.label} needs both start and end times.`,
        fieldTimeInputId(field, value.start ? 'end' : 'start', idPrefix, rowContext)
      );
    }
    if (validate && ((value.start && !value.end) || (!value.start && value.end))) {
      throw workFormValidationError(
        `${field.label} needs both start and end times.`,
        fieldTimeInputId(field, value.start ? 'end' : 'start', idPrefix, rowContext)
      );
    }
    return value;
  }

  if (field.type === 'signature') {
    return collectSignatureAnswer(field, options, rowContext);
  }

  const value = inputValue(field, idPrefix, rowContext);
  if (validate && field.required && (value === '' || value == null || value === false)) {
    throw workFormValidationError(
      `${field.label} is required.`,
      fieldInputId(field, idPrefix, rowContext)
    );
  }
  return value;
}

function isEmptyRepeatRow(row) {
  return Object.values(row).every((value) => {
    if (value === false || value == null || value === '') return true;
    if (value && typeof value === 'object') return !value.start && !value.end;
    return false;
  });
}

function collectRepeatAnswers(parent, children, parentAnswers, options = {}) {
  const validate = options.validate !== false;
  const scope = options.container || document;
  const rows = Array.from(scope.querySelectorAll(`[data-repeat-row="${CSS.escape(parent.id)}"]`));
  const values = [];

  for (const row of rows) {
    const rowContext = { parentId: parent.id, rowKey: row.dataset.repeatRowKey };
    const rowAnswers = {};
    const submittedRow = {};

    for (const child of children) {
      if (child.type === 'section') continue;
      if (!conditionMet(child.show_if, { ...parentAnswers, ...rowAnswers })) {
        rowAnswers[child.id] = '';
        if (child.type !== 'formula') submittedRow[child.id] = '';
        continue;
      }
      if (child.type === 'formula') {
        rowAnswers[child.id] = evaluateFormula(child.formula, { ...parentAnswers, ...rowAnswers });
        continue;
      }
      const value = collectSingleField(child, options, rowContext);
      rowAnswers[child.id] = value;
      submittedRow[child.id] = value;
    }

    if (isEmptyRepeatRow(submittedRow) && minRows(parent) === 0) continue;
    values.push(submittedRow);
  }

  if (validate && values.length < minRows(parent)) {
    throw new Error(`${parent.label} needs at least ${minRows(parent)} row(s).`);
  }
  if (validate && values.length > maxRows(parent)) {
    throw new Error(`${parent.label} can include up to ${maxRows(parent)} row(s).`);
  }

  return values;
}

export function collectWorkFormAnswers(form, options = {}) {
  const answers = {};
  const submittedAnswers = {};
  const fields = normalisedFields(form);

  for (const field of topLevelFields(fields)) {
    if (field.type === 'section') continue;
    if (!conditionMet(field.show_if, answers)) {
      answers[field.id] = field.type === 'repeat' ? [] : '';
      if (field.type !== 'formula') submittedAnswers[field.id] = answers[field.id];
      continue;
    }

    if (field.type === 'repeat') {
      answers[field.id] = collectRepeatAnswers(field, repeatChildren(fields, field.id), answers, options);
      submittedAnswers[field.id] = answers[field.id];
      continue;
    }

    if (field.type === 'formula') {
      answers[field.id] = evaluateFormula(field.formula, answers);
      continue;
    }

    answers[field.id] = collectSingleField(field, options);
    submittedAnswers[field.id] = answers[field.id];
  }

  return submittedAnswers;
}

function populateSignatureAnswer(field, value, idPrefix, rowContext = null) {
  const canvas = document.getElementById(fieldInputId(field, idPrefix, rowContext));
  if (!canvas || typeof value !== 'string' || !value.startsWith('data:image/')) return;

  const restoreToken = `${Date.now()}-${Math.random()}`;
  canvas.dataset.signed = 'true';
  canvas.dataset.restoredSignature = value;
  canvas.dataset.signatureRestoreToken = restoreToken;
  const image = new Image();
  image.onload = () => {
    if (canvas.dataset.signatureRestoreToken !== restoreToken) return;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.dataset.signed = 'true';
    delete canvas.dataset.restoredSignature;
    delete canvas.dataset.signatureRestoreToken;
  };
  image.src = value;
}

function populateField(field, value, idPrefix, rowContext = null) {
  if (value == null) return;

  if (field.type === 'time_range') {
    const startInput = document.getElementById(fieldTimeInputId(field, 'start', idPrefix, rowContext));
    const endInput = document.getElementById(fieldTimeInputId(field, 'end', idPrefix, rowContext));
    if (startInput) startInput.value = value.start || '';
    if (endInput) endInput.value = value.end || '';
    return;
  }

  if (field.type === 'signature') {
    populateSignatureAnswer(field, value, idPrefix, rowContext);
    return;
  }

  const input = document.getElementById(fieldInputId(field, idPrefix, rowContext));
  if (!input) return;
  if (field.type === 'checkbox') {
    input.checked = Boolean(value);
  } else {
    input.value = value;
  }

  const picker = input.closest('[data-work-form-field]')?.querySelector('[data-team-member-picker]');
  if (picker) setTeamMemberPickerSelectionFromNames(picker, input.value);
}

function populateRepeatRow(row, parent, children, values, options = {}) {
  const idPrefix = options.idPrefix || DEFAULT_FIELD_PREFIX;
  const rowContext = { parentId: parent.id, rowKey: row.dataset.repeatRowKey };
  for (const child of children) {
    if (child.type === 'section') continue;
    populateField(child, values?.[child.id], idPrefix, rowContext);
  }
}

export function populateWorkFormAnswers(form, answers = {}, options = {}) {
  const idPrefix = options.idPrefix || DEFAULT_FIELD_PREFIX;
  const fields = normalisedFields(form);
  const container = options.container || document;

  for (const field of topLevelFields(fields)) {
    if (field.type === 'section') continue;

    if (field.type === 'repeat') {
      const rowsContainer = container.querySelector?.(`[data-repeat-rows="${CSS.escape(field.id)}"]`);
      const children = repeatChildren(fields, field.id);
      const values = Array.isArray(answers[field.id]) ? answers[field.id] : [];
      const existingRows = rowsContainer ? Array.from(rowsContainer.querySelectorAll(`[data-repeat-row="${CSS.escape(field.id)}"]`)) : [];
      for (let index = existingRows.length; index < Math.max(values.length, minRows(field), 1); index += 1) {
        addRepeatRow(rowsContainer.closest('.dynamic-fields') || document, { ...form, fields }, field.id, options, {});
      }
      const rows = rowsContainer ? Array.from(rowsContainer.querySelectorAll(`[data-repeat-row="${CSS.escape(field.id)}"]`)) : [];
      rows.forEach((row, index) => populateRepeatRow(row, field, children, values[index] || {}, options));
      continue;
    }

    populateField(field, answers[field.id], idPrefix);
  }

  if (options.container) updateDynamicState(options.container, { ...form, fields }, options);
}

function parseMetadataParts(parts = []) {
  const metadata = {};
  parts
    .flatMap((part) => String(part || '').split(';'))
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const equalsIndex = part.indexOf('=');
      if (equalsIndex === -1) return;
      const key = part.slice(0, equalsIndex).trim().toLowerCase();
      const value = part.slice(equalsIndex + 1).trim();
      metadata[key] = value;
    });
  return metadata;
}

function fieldIdFromLabel(label, index) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || `field_${index + 1}`;
}

export function parseWorkFormFieldsInput(value) {
  const fields = [];
  let currentRepeatId = '';

  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const childLine = line.startsWith('>');
      const source = childLine ? line.replace(/^>\s*/, '') : line;
      const [typeRaw, labelRaw, requiredRaw = '', optionsRaw = '', ...metadataRaw] = source.split('|').map((part) => part.trim());
      const type = normaliseFieldType(typeRaw);
      const label = labelRaw || `Field ${index + 1}`;
      const metadata = parseMetadataParts(metadataRaw);
      const field = {
        id: fieldIdFromLabel(metadata.id || label, index),
        label,
        type,
        required: type === 'section' || type === 'formula' ? false : requiredRaw.toLowerCase() === 'required',
        options: []
      };

      if (childLine && currentRepeatId) {
        field.repeat = currentRepeatId;
      }

      if (type === 'select') {
        field.options = optionsRaw ? optionsRaw.split(',').map((option) => option.trim()).filter(Boolean) : [];
      } else if (type === 'formula') {
        field.formula = metadata.formula || optionsRaw;
      } else if (type === 'repeat') {
        Object.assign(metadata, parseMetadataParts([optionsRaw]));
        field.min_rows = Number(metadata.min_rows || metadata.min || (field.required ? 1 : 0));
        field.max_rows = Number(metadata.max_rows || metadata.max || DEFAULT_REPEAT_MAX_ROWS);
      }

      if (metadata.show_if) field.show_if = metadata.show_if;
      if (metadata.repeat && !field.repeat) field.repeat = metadata.repeat;
      if (metadata.formula && type !== 'formula') field.formula = metadata.formula;

      fields.push(field);
      currentRepeatId = type === 'repeat' && !childLine ? field.id : (childLine ? currentRepeatId : '');
    });

  return fields;
}

function metadataParts(field) {
  const parts = field.id ? [`id=${field.id}`] : [];
  if (field.show_if || field.showIf) parts.push(`show_if=${field.show_if || field.showIf}`);
  if (field.type === 'repeat') {
    if (field.min_rows != null || field.minRows != null) parts.push(`min=${field.min_rows ?? field.minRows}`);
    if (field.max_rows != null || field.maxRows != null) parts.push(`max=${field.max_rows ?? field.maxRows}`);
  }
  return parts;
}

function serialiseFieldLine(field, prefix = '') {
  const type = normaliseFieldType(field.type);
  const parts = [type || 'text', field.label || field.id || 'Field'];
  const options = field.options || [];

  if (type !== 'section' && type !== 'formula' && (field.required || options.length || type === 'repeat')) {
    parts.push(field.required ? 'required' : '');
  } else {
    parts.push('');
  }

  if (type === 'select') {
    parts.push(options.join(','));
  } else if (type === 'formula') {
    parts.push(field.formula || '');
  } else {
    parts.push('');
  }

  const meta = metadataParts({ ...field, type });
  parts.push(...meta);

  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return `${prefix}${parts.join('|')}`;
}

export function serialiseWorkFormFields(fields = []) {
  const normalised = fields.map(normaliseField);
  const lines = [];

  for (const field of topLevelFields(normalised)) {
    lines.push(serialiseFieldLine(field));
    if (field.type === 'repeat') {
      repeatChildren(normalised, field.id).forEach((child) => {
        lines.push(serialiseFieldLine(child, '>'));
      });
    }
  }

  return lines.join('\n');
}
