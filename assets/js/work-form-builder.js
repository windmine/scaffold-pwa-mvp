import { parseWorkFormFieldsInput, serialiseWorkFormFields } from './work-form-fields.js';
import { escapeHtml } from './utils.js';

const MAX_FIELDS = 30;
const MAX_REPEAT_ROWS = 50;
const CONDITION_OPERATORS = ['!=', '>=', '<=', '=', '>', '<'];
const FIELD_ID_PATTERN = /^[a-z0-9_]+$/;
const FORMULA_CHARACTER_PATTERN = /^[a-z0-9_+\-*/().\s]+$/i;

export const WORK_FORM_FIELD_TYPES = Object.freeze([
  { value: 'text', label: 'Short answer' },
  { value: 'textarea', label: 'Long answer' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Choice' },
  { value: 'checkbox', label: 'Yes / No' },
  { value: 'signature', label: 'Signature' },
  { value: 'section', label: 'Section heading' },
  { value: 'time_range', label: 'Time range' },
  { value: 'formula', label: 'Calculated value' },
  { value: 'repeat', label: 'Repeating group' }
]);

const VALID_FIELD_TYPES = new Set(WORK_FORM_FIELD_TYPES.map(({ value }) => value));

function cloneFields(fields = []) {
  return fields.map((field) => ({
    ...field,
    options: Array.isArray(field.options) ? [...field.options] : []
  }));
}

function normaliseField(field = {}, index = 0) {
  const type = String(field.type || 'text').trim().toLowerCase();
  return {
    ...field,
    id: String(field.id || `field_${index + 1}`).trim(),
    label: String(field.label || '').trim(),
    type,
    required: type === 'section' || type === 'formula' ? false : Boolean(field.required),
    options: Array.isArray(field.options)
      ? field.options.map((option) => String(option).trim()).filter(Boolean)
      : [],
    show_if: String(field.show_if || field.showIf || '').trim(),
    formula: String(field.formula || '').trim(),
    repeat: String(field.repeat || '').trim(),
    min_rows: field.min_rows == null && field.minRows == null
      ? null
      : Number(field.min_rows ?? field.minRows),
    max_rows: field.max_rows == null && field.maxRows == null
      ? null
      : Number(field.max_rows ?? field.maxRows)
  };
}

function normaliseFields(fields = []) {
  return fields.map(normaliseField);
}

function repeatGroups(fields) {
  const repeatIds = new Set(fields.filter((field) => field.type === 'repeat').map((field) => field.id));
  return fields
    .filter((field) => !field.repeat || !repeatIds.has(field.repeat))
    .map((field) => ({
      field,
      children: field.type === 'repeat'
        ? fields.filter((child) => child.repeat === field.id)
        : []
    }));
}

function canonicalFields(fields = []) {
  return repeatGroups(normaliseFields(fields)).flatMap(({ field, children }) => [field, ...children]);
}

function parseCondition(value = '') {
  const expression = String(value).trim();
  for (const operator of CONDITION_OPERATORS) {
    const index = expression.indexOf(operator);
    if (index === -1) continue;
    return {
      fieldId: expression.slice(0, index).trim(),
      operator,
      expected: expression.slice(index + operator.length)
    };
  }
  return null;
}

function formulaReferences(expression = '') {
  return new Set(String(expression).match(/[a-z_][a-z0-9_]*/gi) || []);
}

function addFieldError(result, fieldId, message) {
  result.errors.push(message);
  if (!fieldId) return;
  if (!result.fieldErrors[fieldId]) result.fieldErrors[fieldId] = [];
  result.fieldErrors[fieldId].push(message);
}

function validateDependency(field, available, result) {
  if (field.show_if) {
    const condition = parseCondition(field.show_if);
    if (!condition || !FIELD_ID_PATTERN.test(condition.fieldId)) {
      addFieldError(result, field.id, `${field.label || 'Field'} has an invalid condition.`);
    } else if (!available.has(condition.fieldId)) {
      addFieldError(
        result,
        field.id,
        `${field.label || 'Field'} must come after the field used by its condition.`
      );
    }
  }

  if (field.type !== 'formula') return;
  if (!field.formula) {
    addFieldError(result, field.id, `${field.label || 'Calculated value'} needs a formula.`);
    return;
  }
  if (!FORMULA_CHARACTER_PATTERN.test(field.formula)) {
    addFieldError(result, field.id, `${field.label || 'Calculated value'} uses unsupported formula characters.`);
    return;
  }
  const missing = [...formulaReferences(field.formula)].filter((reference) => !available.has(reference));
  if (missing.length) {
    addFieldError(
      result,
      field.id,
      `${field.label || 'Calculated value'} must come after: ${missing.join(', ')}.`
    );
  }
}

export function validateWorkFormBuilderFields(inputFields = []) {
  const fields = canonicalFields(inputFields);
  const result = { valid: true, errors: [], fieldErrors: {} };

  if (!fields.length) {
    addFieldError(result, '', 'Add at least one form field.');
  }
  if (fields.length > MAX_FIELDS) {
    addFieldError(result, '', `Forms can include up to ${MAX_FIELDS} fields.`);
  }

  const ids = new Set();
  const repeatIds = new Set(fields.filter((field) => field.type === 'repeat').map((field) => field.id));
  for (const field of fields) {
    if (!field.id || !FIELD_ID_PATTERN.test(field.id)) {
      addFieldError(result, field.id, 'Field keys can use lowercase letters, numbers, and underscores only.');
    } else if (ids.has(field.id)) {
      addFieldError(result, field.id, `Field key "${field.id}" is duplicated.`);
    }
    ids.add(field.id);

    if (!field.label.trim()) {
      addFieldError(result, field.id, 'Add a label for this field.');
    } else if (field.label.length > 160) {
      addFieldError(result, field.id, `${field.label.slice(0, 32)}… is longer than 160 characters.`);
    } else if (field.label.includes('|')) {
      addFieldError(result, field.id, `${field.label} cannot include the | character.`);
    }

    if (!VALID_FIELD_TYPES.has(field.type)) {
      addFieldError(result, field.id, `${field.label || 'Field'} has an unsupported type.`);
    }

    if (field.type === 'select') {
      if (!field.options.length) {
        addFieldError(result, field.id, `${field.label || 'Choice'} needs at least one option.`);
      } else if (field.options.some((option) => option.includes(',') || option.includes('|'))) {
        addFieldError(result, field.id, `${field.label || 'Choice'} options cannot include commas or | characters.`);
      }
    }

    if (field.repeat && !repeatIds.has(field.repeat)) {
      addFieldError(result, field.id, `${field.label || 'Field'} belongs to a missing repeating group.`);
    }
    if (field.type === 'repeat' && field.repeat) {
      addFieldError(result, field.id, 'Repeating groups cannot be nested.');
    }

    if (field.type === 'repeat') {
      const minRows = Number.isFinite(field.min_rows) ? field.min_rows : (field.required ? 1 : 0);
      const maxRows = Number.isFinite(field.max_rows) ? field.max_rows : 12;
      if (!Number.isInteger(minRows) || minRows < 0 || minRows > MAX_REPEAT_ROWS) {
        addFieldError(result, field.id, `${field.label || 'Repeating group'} minimum rows must be 0-${MAX_REPEAT_ROWS}.`);
      }
      if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_REPEAT_ROWS) {
        addFieldError(result, field.id, `${field.label || 'Repeating group'} maximum rows must be 1-${MAX_REPEAT_ROWS}.`);
      } else if (maxRows < Math.max(1, minRows)) {
        addFieldError(result, field.id, `${field.label || 'Repeating group'} maximum must be at least its minimum.`);
      }
    }
  }

  const topLevelAvailable = new Set();
  for (const { field, children } of repeatGroups(fields)) {
    validateDependency(field, topLevelAvailable, result);
    if (field.type === 'repeat') {
      const childAvailable = new Set(topLevelAvailable);
      for (const child of children) {
        validateDependency(child, childAvailable, result);
        if (child.type !== 'section') childAvailable.add(child.id);
      }
    } else if (field.type !== 'section') {
      topLevelAvailable.add(field.id);
    }
  }

  result.valid = result.errors.length === 0;
  return result;
}

export function workFormBuilderMarkup({ rawInputId = '' } = {}) {
  const idAttribute = rawInputId ? ` id="${escapeHtml(rawInputId)}"` : '';
  return `
    <div class="work-form-field-builder" data-work-form-builder>
      <div class="work-form-builder-toolbar">
        <div>
          <h3>Form fields</h3>
          <p class="muted">Add cards in the same order workers should complete them.</p>
        </div>
        <button type="button" class="secondary" data-add-work-form-field>Add field</button>
      </div>
      <div class="local-feedback hidden" data-work-form-builder-feedback role="alert" aria-live="assertive" aria-atomic="true"></div>
      <p class="work-form-builder-empty" data-work-form-builder-empty>No fields yet. Add the first field to begin.</p>
      <ol class="work-form-field-list" data-work-form-field-list aria-label="Work form fields"></ol>
      <details class="optional-details work-form-advanced" data-work-form-advanced>
        <summary>Advanced: edit raw field syntax</summary>
        <div class="form-grid">
          <p class="builder-help">Use the raw pipe-delimited format only for definitions the cards do not cover. Apply changes before previewing or saving.</p>
          <label>
            Raw field syntax
            <textarea${idAttribute} rows="10" data-work-form-raw spellcheck="false" placeholder="text|Area|required|id=area"></textarea>
          </label>
          <div class="form-actions">
            <button type="button" class="secondary" data-apply-work-form-raw>Apply syntax</button>
            <button type="button" class="ghost" data-discard-work-form-raw>Discard raw changes</button>
          </div>
          <div class="local-feedback hidden" data-work-form-raw-feedback role="alert" aria-live="assertive" aria-atomic="true"></div>
        </div>
      </details>
      <div class="visually-hidden" data-work-form-builder-announcement role="status" aria-live="polite" aria-atomic="true"></div>
    </div>
  `;
}

function typeLabel(type) {
  return WORK_FORM_FIELD_TYPES.find((option) => option.value === type)?.label || type;
}

function conditionSourceOptions(fields, targetField) {
  const available = [];
  const addAvailable = (field) => {
    if (!['section', 'repeat'].includes(field.type)) available.push(field);
  };

  for (const { field, children } of repeatGroups(fields)) {
    if (field.id === targetField.id) return available;
    if (field.type === 'repeat') {
      if (targetField.repeat === field.id) {
        for (const child of children) {
          if (child.id === targetField.id) return available;
          addAvailable(child);
        }
        return available;
      }
    } else {
      addAvailable(field);
    }
  }
  return available;
}

function conditionValueControl(field, source) {
  const condition = parseCondition(field.show_if) || { expected: '' };
  if (source?.type === 'select') {
    const values = ['', ...source.options];
    return `
      <label>
        Value
        <select data-field-property="condition-value">
          ${values.map((value) => `<option value="${escapeHtml(value)}"${value === condition.expected ? ' selected' : ''}>${escapeHtml(value || 'Choose a value')}</option>`).join('')}
        </select>
      </label>
    `;
  }
  if (source?.type === 'checkbox') {
    return `
      <label>
        Value
        <select data-field-property="condition-value">
          <option value="true"${condition.expected === 'true' ? ' selected' : ''}>Yes</option>
          <option value="false"${condition.expected === 'false' ? ' selected' : ''}>No</option>
        </select>
      </label>
    `;
  }
  return `
    <label>
      Value
      <input type="text" value="${escapeHtml(condition.expected)}" data-field-property="condition-value" />
    </label>
  `;
}

function renderTypeOptions(field) {
  return WORK_FORM_FIELD_TYPES
    .filter(({ value }) => !field.repeat || value !== 'repeat')
    .map(({ value, label }) => `<option value="${value}"${field.type === value ? ' selected' : ''}>${label}</option>`)
    .join('');
}

function renderConditionControls(field, fields) {
  if (field.type === 'section') return '';
  const condition = parseCondition(field.show_if);
  const sources = conditionSourceOptions(fields, field);
  const source = sources.find(({ id }) => id === condition?.fieldId);
  const selectedSourceId = condition?.fieldId || sources[0]?.id || '';
  const selectedSource = source || sources.find(({ id }) => id === selectedSourceId);
  const unavailableOption = condition?.fieldId && !source
    ? `<option value="${escapeHtml(condition.fieldId)}" selected>Unavailable field (${escapeHtml(condition.fieldId)})</option>`
    : '';

  return `
    <div class="work-form-condition">
      <label class="checkbox-field form-checkbox-field work-form-condition-toggle">
        <input type="checkbox" data-field-property="condition-enabled"${condition ? ' checked' : ''}${!sources.length && !condition ? ' disabled' : ''} />
        <span class="form-checkbox-control" aria-hidden="true"></span>
        <span class="form-checkbox-label">Only show in some cases</span>
      </label>
      ${condition ? `
        <div class="work-form-condition-grid">
          <label>
            Earlier field
            <select data-field-property="condition-field">
              ${unavailableOption}
              ${sources.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selectedSourceId ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
            </select>
          </label>
          <label>
            Rule
            <select data-field-property="condition-operator">
              ${CONDITION_OPERATORS.map((operator) => `<option value="${operator}"${operator === condition.operator ? ' selected' : ''}>${escapeHtml(operator)}</option>`).join('')}
            </select>
          </label>
          ${conditionValueControl(field, selectedSource)}
        </div>
      ` : (!sources.length ? '<p class="builder-help">Add an answer field before this card to create a condition.</p>' : '')}
    </div>
  `;
}

function renderTypeSpecificControls(field) {
  if (field.type === 'select') {
    return `
      <label class="work-form-options-control">
        Options <span class="muted">(one per line)</span>
        <textarea rows="4" data-field-property="options" placeholder="Pass&#10;Fail&#10;N/A">${escapeHtml(field.options.join('\n'))}</textarea>
      </label>
    `;
  }
  if (field.type === 'formula') {
    return `
      <label class="work-form-formula-control">
        Formula
        <input type="text" value="${escapeHtml(field.formula)}" data-field-property="formula" placeholder="work_time * workers" />
        <span class="builder-help">Use earlier field keys with +, −, ×, ÷ and parentheses.</span>
      </label>
    `;
  }
  if (field.type === 'repeat') {
    const minRows = Number.isFinite(field.min_rows) ? field.min_rows : (field.required ? 1 : 0);
    const maxRows = Number.isFinite(field.max_rows) ? field.max_rows : 12;
    return `
      <div class="work-form-repeat-limits">
        <label>
          Minimum rows
          <input type="number" min="0" max="50" step="1" value="${minRows}" data-field-property="min-rows" />
        </label>
        <label>
          Maximum rows
          <input type="number" min="1" max="50" step="1" value="${maxRows}" data-field-property="max-rows" />
        </label>
      </div>
    `;
  }
  return '';
}

function renderCard(field, fields, position, count, children = []) {
  const label = field.label || 'Untitled field';
  const requiredAllowed = !['section', 'formula', 'repeat'].includes(field.type);
  const repeatRequired = field.type === 'repeat' && (field.min_rows ?? (field.required ? 1 : 0)) > 0;
  const required = requiredAllowed ? field.required : repeatRequired;
  const nested = Boolean(field.repeat);

  return `
    <li class="work-form-field-card${nested ? ' is-repeat-child' : ''}" data-work-form-field-card data-field-id="${escapeHtml(field.id)}" data-repeat-id="${escapeHtml(field.repeat)}">
      <header class="work-form-field-card-header">
        <button type="button" class="work-form-field-drag-handle ghost" draggable="true" data-field-drag-handle aria-label="Drag ${escapeHtml(label)}" title="Drag to reorder">⋮⋮</button>
        <div class="work-form-field-summary">
          <span class="work-form-field-position">${position + 1}</span>
          <div>
            <strong data-field-summary-label>${escapeHtml(label)}</strong>
            <span>${escapeHtml(typeLabel(field.type))}</span>
          </div>
        </div>
        ${required ? '<span class="badge pending">Required</span>' : ''}
        <div class="work-form-field-card-actions">
          <button type="button" class="ghost" data-move-field="up" aria-label="Move ${escapeHtml(label)} up"${position === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="ghost" data-move-field="down" aria-label="Move ${escapeHtml(label)} down"${position === count - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="ghost danger-text" data-remove-work-form-field aria-label="Remove ${escapeHtml(label)}">Remove</button>
        </div>
      </header>
      <div class="work-form-field-card-body">
        <div class="work-form-field-main-controls">
          <label>
            Field type
            <select data-field-property="type">${renderTypeOptions(field)}</select>
          </label>
          <label>
            Label
            <input type="text" maxlength="160" value="${escapeHtml(field.label)}" data-field-property="label" placeholder="What should the worker enter?" />
          </label>
        </div>
        ${requiredAllowed ? `
          <label class="checkbox-field form-checkbox-field work-form-required-toggle">
            <input type="checkbox" data-field-property="required"${field.required ? ' checked' : ''} />
            <span class="form-checkbox-control" aria-hidden="true"></span>
            <span class="form-checkbox-label">Required</span>
          </label>
        ` : ''}
        ${renderTypeSpecificControls(field)}
        ${renderConditionControls(field, fields)}
        <p class="work-form-field-key">Field key: <code>${escapeHtml(field.id)}</code></p>
        <div class="field-error hidden" data-work-form-field-error role="alert"></div>
        ${field.type === 'repeat' ? `
          <section class="work-form-repeat-builder" aria-label="Fields inside ${escapeHtml(label)}">
            <div class="work-form-repeat-builder-header">
              <div>
                <strong>Fields inside this group</strong>
                <p class="muted">These cards repeat together for each row.</p>
              </div>
              <button type="button" class="secondary" data-add-work-form-field data-repeat-id="${escapeHtml(field.id)}">Add group field</button>
            </div>
            ${children.length ? '' : '<p class="work-form-builder-empty">No group fields yet.</p>'}
            <ol class="work-form-field-list nested" data-repeat-field-list="${escapeHtml(field.id)}" aria-label="Fields inside ${escapeHtml(label)}">
              ${children.map((child, childIndex) => renderCard(child, fields, childIndex, children.length)).join('')}
            </ol>
          </section>
        ` : ''}
      </div>
    </li>
  `;
}

function rawLineErrors(value) {
  const errors = [];
  let repeatOpen = false;
  String(value).split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const isChild = line.startsWith('>');
    const source = isChild ? line.replace(/^>\s*/, '') : line;
    const [type = '', label = ''] = source.split('|').map((part) => part.trim());
    if (!type || !label) errors.push(`Line ${index + 1} needs a type and label.`);
    if (isChild && !repeatOpen) errors.push(`Line ${index + 1} is not below a repeating group.`);
    repeatOpen = isChild ? repeatOpen : type.toLowerCase() === 'repeat';
  });
  return errors;
}

export function createWorkFormBuilder(root, { fields: initialFields = [], onChange } = {}) {
  if (!root) throw new Error('Work Form builder root is required.');
  if (!root.matches('[data-work-form-builder]')) {
    root.innerHTML = workFormBuilderMarkup();
    root = root.querySelector('[data-work-form-builder]');
  }

  const list = root.querySelector('[data-work-form-field-list]');
  const empty = root.querySelector('[data-work-form-builder-empty]');
  const feedback = root.querySelector('[data-work-form-builder-feedback]');
  const rawInput = root.querySelector('[data-work-form-raw]');
  const rawFeedback = root.querySelector('[data-work-form-raw-feedback]');
  const advanced = root.querySelector('[data-work-form-advanced]');
  const announcement = root.querySelector('[data-work-form-builder-announcement]');
  const controller = new AbortController();
  const { signal } = controller;
  let fields = canonicalFields(initialFields);
  let rawDirty = false;
  let draggedId = '';
  let dropPosition = 'before';

  function fieldById(id) {
    return fields.find((field) => field.id === id);
  }

  function uniqueFieldId() {
    let index = 1;
    while (fields.some((field) => field.id === `field_${index}`)) index += 1;
    return `field_${index}`;
  }

  function setFeedback(message = '', tone = 'error') {
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.classList.toggle('hidden', !message);
  }

  function setRawFeedback(message = '', tone = 'error') {
    rawFeedback.textContent = message;
    rawFeedback.dataset.tone = tone;
    rawFeedback.classList.toggle('hidden', !message);
  }

  function announce(message) {
    announcement.textContent = '';
    window.requestAnimationFrame(() => {
      announcement.textContent = message;
    });
  }

  function syncRaw() {
    if (!rawDirty) rawInput.value = serialiseWorkFormFields(fields);
    advanced.classList.toggle('has-pending-raw', rawDirty);
  }

  function emitChange() {
    syncRaw();
    onChange?.(cloneFields(fields));
  }

  function render() {
    const groups = repeatGroups(fields);
    list.innerHTML = groups
      .map(({ field, children }, index) => renderCard(field, fields, index, groups.length, children))
      .join('');
    empty.classList.toggle('hidden', groups.length > 0);
    syncRaw();
  }

  function prepareVisualMutation() {
    if (!rawDirty) return;
    rawDirty = false;
    setRawFeedback('Pending raw changes were discarded because a field card was edited.', 'warning');
    announce('Pending raw syntax discarded.');
  }

  function fieldScopeIds(field) {
    if (field.repeat) return fields.filter((item) => item.repeat === field.repeat).map((item) => item.id);
    return repeatGroups(fields).map(({ field: item }) => item.id);
  }

  function rebuildWithScopeOrder(field, orderedIds) {
    const groups = repeatGroups(fields);
    if (field.repeat) {
      return groups.flatMap(({ field: parent, children }) => [
        parent,
        ...(parent.id === field.repeat
          ? orderedIds.map((id) => children.find((child) => child.id === id)).filter(Boolean)
          : children)
      ]);
    }
    return orderedIds.flatMap((id) => {
      const group = groups.find(({ field: item }) => item.id === id);
      return group ? [group.field, ...group.children] : [];
    });
  }

  function tryReorder(fieldId, targetId, position = 'before') {
    const field = fieldById(fieldId);
    const target = fieldById(targetId);
    if (!field || !target || field.id === target.id) return false;
    if ((field.repeat || '') !== (target.repeat || '')) {
      announce('Fields can only be moved within the same group.');
      return false;
    }

    const ids = fieldScopeIds(field).filter((id) => id !== field.id);
    let targetIndex = ids.indexOf(target.id);
    if (targetIndex === -1) return false;
    if (position === 'after') targetIndex += 1;
    ids.splice(targetIndex, 0, field.id);
    const candidate = rebuildWithScopeOrder(field, ids);
    const validation = validateWorkFormBuilderFields(candidate);
    const dependencyError = validation.errors.find((message) => (
      message.includes('must come after') || message.includes('belongs to a missing')
    ));
    if (dependencyError) {
      setFeedback(`Could not move field. ${dependencyError}`, 'warning');
      announce(`Move cancelled. ${dependencyError}`);
      return false;
    }

    fields = candidate;
    setFeedback();
    render();
    emitChange();
    const newPosition = fieldScopeIds(fieldById(field.id)).indexOf(field.id) + 1;
    announce(`Moved ${field.label || 'field'} to position ${newPosition} of ${ids.length}.`);
    return true;
  }

  function moveByOffset(fieldId, offset) {
    const field = fieldById(fieldId);
    if (!field) return;
    const ids = fieldScopeIds(field);
    const index = ids.indexOf(field.id);
    const target = ids[index + offset];
    if (!target) return;
    const moved = tryReorder(field.id, target, offset > 0 ? 'after' : 'before');
    if (moved) {
      root.querySelector(`[data-field-id="${CSS.escape(field.id)}"] [data-move-field="${offset > 0 ? 'down' : 'up'}"]`)?.focus();
    }
  }

  function addField(repeatId = '') {
    prepareVisualMutation();
    if (fields.length >= MAX_FIELDS) {
      setFeedback(`Forms can include up to ${MAX_FIELDS} fields.`);
      return;
    }
    const field = normaliseField({
      id: uniqueFieldId(),
      label: 'New field',
      type: 'text',
      required: false,
      options: [],
      repeat: repeatId
    }, fields.length);
    if (repeatId) {
      const parentIndex = fields.findIndex((item) => item.id === repeatId);
      let insertionIndex = parentIndex + 1;
      while (fields[insertionIndex]?.repeat === repeatId) insertionIndex += 1;
      fields.splice(insertionIndex, 0, field);
    } else {
      fields.push(field);
    }
    fields = canonicalFields(fields);
    setFeedback();
    render();
    emitChange();
    root.querySelector(`[data-field-id="${CSS.escape(field.id)}"] [data-field-property="label"]`)?.select();
    announce(`Added ${repeatId ? 'group ' : ''}field ${field.label}.`);
  }

  function removeField(fieldId) {
    prepareVisualMutation();
    const field = fieldById(fieldId);
    if (!field) return;
    const children = field.type === 'repeat' ? fields.filter((item) => item.repeat === field.id) : [];
    if (children.length && !window.confirm(`Remove "${field.label}" and its ${children.length} group field${children.length === 1 ? '' : 's'}?`)) {
      return;
    }
    const candidate = fields.filter((item) => item.id !== field.id && item.repeat !== field.id);
    const validation = validateWorkFormBuilderFields(candidate);
    const dependencyError = validation.errors.find((message) => message.includes('must come after'));
    if (dependencyError) {
      setFeedback(`Could not remove field. ${dependencyError}`, 'warning');
      announce(`Remove cancelled. ${dependencyError}`);
      return;
    }
    fields = candidate;
    setFeedback();
    render();
    emitChange();
    announce(`Removed ${field.label || 'field'}.`);
  }

  function updateCondition(field, property, value) {
    const current = parseCondition(field.show_if) || { fieldId: '', operator: '=', expected: '' };
    if (property === 'condition-field') current.fieldId = value;
    if (property === 'condition-operator') current.operator = value;
    if (property === 'condition-value') current.expected = value;
    field.show_if = current.fieldId ? `${current.fieldId}${current.operator}${current.expected}` : '';
  }

  function handleTypeChange(field, nextType, select) {
    const children = field.type === 'repeat' ? fields.filter((item) => item.repeat === field.id) : [];
    const losesData = (field.type === 'select' && field.options.length)
      || (field.type === 'formula' && field.formula)
      || children.length;
    if (losesData && !window.confirm('Changing this field type will remove its type-specific settings. Continue?')) {
      select.value = field.type;
      return false;
    }
    if (children.length) fields = fields.filter((item) => item.repeat !== field.id);
    if (field.type === 'select') field.options = [];
    if (field.type === 'formula') field.formula = '';
    field.type = nextType;
    if (nextType === 'section' || nextType === 'formula') field.required = false;
    if (nextType === 'select') field.options = [];
    if (nextType === 'formula') field.formula = '';
    if (nextType === 'repeat') {
      field.min_rows = 0;
      field.max_rows = 12;
      field.required = false;
    } else {
      field.min_rows = null;
      field.max_rows = null;
    }
    return true;
  }

  function handleFieldInput(target) {
    const card = target.closest('[data-work-form-field-card]');
    const field = fieldById(card?.dataset.fieldId);
    const property = target.dataset.fieldProperty;
    if (!field || !property) return;
    prepareVisualMutation();

    if (property === 'label') {
      field.label = target.value;
      card.querySelector('[data-field-summary-label]').textContent = target.value || 'Untitled field';
    } else if (property === 'options') {
      field.options = target.value.split(/\r?\n/).map((option) => option.trim()).filter(Boolean);
    } else if (property === 'formula') {
      field.formula = target.value.trim();
    } else if (property === 'min-rows') {
      field.min_rows = target.value === '' ? null : Number(target.value);
      field.required = Number(field.min_rows) > 0;
    } else if (property === 'max-rows') {
      field.max_rows = target.value === '' ? null : Number(target.value);
    } else if (property.startsWith('condition-') && property !== 'condition-enabled') {
      updateCondition(field, property, target.value);
    }
    setFeedback();
    emitChange();
  }

  function handleFieldChange(target) {
    const card = target.closest('[data-work-form-field-card]');
    const field = fieldById(card?.dataset.fieldId);
    const property = target.dataset.fieldProperty;
    if (!field || !property) return;
    prepareVisualMutation();

    if (property === 'type') {
      if (!handleTypeChange(field, target.value, target)) return;
      fields = canonicalFields(fields);
      render();
      emitChange();
      root.querySelector(`[data-field-id="${CSS.escape(field.id)}"] [data-field-property="type"]`)?.focus();
      return;
    }
    if (property === 'required') {
      field.required = target.checked;
      render();
      emitChange();
      root.querySelector(`[data-field-id="${CSS.escape(field.id)}"] [data-field-property="required"]`)?.focus();
      return;
    }
    if (property === 'condition-enabled') {
      if (target.checked) {
        const source = conditionSourceOptions(fields, field)[0];
        if (!source) {
          setFeedback('Add an answer field before this card before creating a condition.', 'warning');
          target.checked = false;
          return;
        }
        const expected = source.type === 'checkbox' ? 'true' : (source.type === 'select' ? (source.options[0] || '') : '');
        field.show_if = `${source.id}=${expected}`;
      } else {
        field.show_if = '';
      }
      render();
      emitChange();
      root.querySelector(`[data-field-id="${CSS.escape(field.id)}"] [data-field-property="condition-enabled"]`)?.focus();
      return;
    }
    if (property === 'condition-field') {
      updateCondition(field, property, target.value);
      render();
      emitChange();
      root.querySelector(`[data-field-id="${CSS.escape(field.id)}"] [data-field-property="condition-field"]`)?.focus();
    }
  }

  function renderValidation(validation, focus = false) {
    root.querySelectorAll('[data-work-form-field-error]').forEach((node) => {
      node.textContent = '';
      node.classList.add('hidden');
    });
    root.querySelectorAll('[data-work-form-field-card]').forEach((card) => {
      card.classList.remove('has-error');
      card.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute('aria-invalid'));
    });

    Object.entries(validation.fieldErrors).forEach(([fieldId, messages]) => {
      const card = root.querySelector(`[data-field-id="${CSS.escape(fieldId)}"]`);
      if (!card) return;
      card.classList.add('has-error');
      const error = card.querySelector('[data-work-form-field-error]');
      error.textContent = messages.join(' ');
      error.classList.remove('hidden');
      card.querySelector('[data-field-property="label"]')?.setAttribute('aria-invalid', 'true');
    });

    if (validation.valid) {
      setFeedback();
      return true;
    }
    setFeedback(validation.errors[0]);
    if (focus) {
      const firstInvalid = root.querySelector('.work-form-field-card.has-error [aria-invalid="true"]') || feedback;
      if (firstInvalid === feedback) firstInvalid.setAttribute('tabindex', '-1');
      firstInvalid.focus();
    }
    return false;
  }

  function validate({ focus = false } = {}) {
    if (rawDirty) {
      advanced.open = true;
      setRawFeedback('Apply or discard the pending raw syntax before previewing or saving.', 'error');
      if (focus) rawInput.focus();
      return false;
    }
    return renderValidation(validateWorkFormBuilderFields(fields), focus);
  }

  function applyRaw() {
    const lineErrors = rawLineErrors(rawInput.value);
    const parsed = parseWorkFormFieldsInput(rawInput.value);
    const validation = validateWorkFormBuilderFields(parsed);
    const errors = [...lineErrors, ...validation.errors];
    if (errors.length) {
      setRawFeedback(errors[0], 'error');
      rawInput.setAttribute('aria-invalid', 'true');
      rawInput.focus();
      return false;
    }
    fields = canonicalFields(parsed);
    rawDirty = false;
    rawInput.removeAttribute('aria-invalid');
    render();
    setRawFeedback('Raw syntax applied to the field cards.', 'success');
    setFeedback();
    emitChange();
    announce('Raw syntax applied.');
    return true;
  }

  function discardRaw() {
    rawDirty = false;
    rawInput.removeAttribute('aria-invalid');
    syncRaw();
    setRawFeedback('Raw changes discarded.', 'success');
    announce('Raw syntax changes discarded.');
  }

  root.addEventListener('click', (event) => {
    const addButton = event.target.closest('[data-add-work-form-field]');
    if (addButton) {
      addField(addButton.dataset.repeatId || '');
      return;
    }
    const moveButton = event.target.closest('[data-move-field]');
    if (moveButton) {
      moveByOffset(moveButton.closest('[data-work-form-field-card]').dataset.fieldId, moveButton.dataset.moveField === 'up' ? -1 : 1);
      return;
    }
    const removeButton = event.target.closest('[data-remove-work-form-field]');
    if (removeButton) {
      removeField(removeButton.closest('[data-work-form-field-card]').dataset.fieldId);
      return;
    }
    if (event.target.closest('[data-apply-work-form-raw]')) applyRaw();
    if (event.target.closest('[data-discard-work-form-raw]')) discardRaw();
  }, { signal });

  root.addEventListener('input', (event) => {
    if (event.target.matches('[data-work-form-raw]')) {
      rawDirty = true;
      advanced.classList.add('has-pending-raw');
      setRawFeedback('Raw changes are pending. Apply or discard them before saving.', 'warning');
      return;
    }
    handleFieldInput(event.target);
  }, { signal });

  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-work-form-raw]')) return;
    handleFieldChange(event.target);
  }, { signal });

  root.addEventListener('toggle', (event) => {
    if (event.target === advanced && advanced.open && !rawDirty) syncRaw();
  }, { capture: true, signal });

  root.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('[data-field-drag-handle]');
    if (!handle) return;
    draggedId = handle.closest('[data-work-form-field-card]').dataset.fieldId;
    handle.closest('[data-work-form-field-card]').classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedId);
  }, { signal });

  root.addEventListener('dragover', (event) => {
    const card = event.target.closest('[data-work-form-field-card]');
    if (!draggedId || !card || card.dataset.fieldId === draggedId) return;
    const source = fieldById(draggedId);
    const target = fieldById(card.dataset.fieldId);
    if (!source || !target || (source.repeat || '') !== (target.repeat || '')) return;
    event.preventDefault();
    root.querySelectorAll('.is-drop-before, .is-drop-after').forEach((node) => node.classList.remove('is-drop-before', 'is-drop-after'));
    const rect = card.getBoundingClientRect();
    dropPosition = event.clientY > rect.top + (rect.height / 2) ? 'after' : 'before';
    card.classList.add(dropPosition === 'after' ? 'is-drop-after' : 'is-drop-before');
    event.dataTransfer.dropEffect = 'move';
  }, { signal });

  root.addEventListener('drop', (event) => {
    const card = event.target.closest('[data-work-form-field-card]');
    if (!draggedId || !card) return;
    event.preventDefault();
    prepareVisualMutation();
    tryReorder(draggedId, card.dataset.fieldId, dropPosition);
  }, { signal });

  root.addEventListener('dragend', () => {
    draggedId = '';
    root.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after').forEach((node) => {
      node.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    });
  }, { signal });

  render();

  return {
    applyRaw,
    destroy() {
      controller.abort();
    },
    discardRaw,
    getFields() {
      return cloneFields(fields);
    },
    hasPendingRawChanges() {
      return rawDirty;
    },
    reset() {
      fields = [];
      rawDirty = false;
      setFeedback();
      setRawFeedback();
      render();
      emitChange();
    },
    setFields(nextFields = []) {
      fields = canonicalFields(nextFields);
      rawDirty = false;
      setFeedback();
      setRawFeedback();
      render();
      emitChange();
    },
    validate
  };
}
