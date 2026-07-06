import { escapeHtml } from './utils.js';

function memberRoleLabel(member) {
  return member.worker_class === 'leader' ? 'Leader' : 'Normal worker';
}

function memberNameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function namesFromText(value) {
  return String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function selectedIds(picker) {
  return picker?._selectedMemberIds instanceof Set ? picker._selectedMemberIds : new Set();
}

function pendingNames(picker) {
  return namesFromText(picker?.dataset.pendingMemberNames || '');
}

function idsFromNames(members, names) {
  const ids = [];
  const remainingNames = new Set(names.map(memberNameKey));

  for (const member of members || []) {
    const key = memberNameKey(member.name);
    if (remainingNames.has(key)) {
      ids.push(String(member.id));
      remainingNames.delete(key);
    }
  }

  return ids;
}

function selectedMembersForPicker(picker) {
  const ids = selectedIds(picker);
  return (picker?._teamMembers || [])
    .filter((member) => ids.has(String(member.id)));
}

function selectedLabelsForPicker(picker) {
  const members = selectedMembersForPicker(picker);
  if (members.length) return members.map((member) => member.name);
  return pendingNames(picker);
}

function emitChange(picker) {
  picker?._onTeamMembersChange?.({
    ids: selectedTeamMemberIds(picker),
    members: selectedTeamMembers(picker),
    labels: selectedTeamMemberLabels(picker)
  });
}

function renderSelectedMembers(picker) {
  const selected = selectedMembersForPicker(picker);
  const selectedContainer = picker.querySelector('[data-team-selected-members]');
  if (!selectedContainer) return;

  const fallbackNames = selected.length ? [] : pendingNames(picker);
  selectedContainer.innerHTML = selected.length || fallbackNames.length
    ? [
      ...selected.map((member) => `
        <button type="button" class="team-member-chip" data-remove-team-member="${member.id}">
          ${escapeHtml(member.name)}
          <span aria-hidden="true">&times;</span>
        </button>
      `),
      ...fallbackNames.map((name, index) => `
        <button type="button" class="team-member-chip" data-remove-pending-member-index="${index}">
          ${escapeHtml(name)}
          <span aria-hidden="true">&times;</span>
        </button>
      `)
    ].join('')
    : '<span class="team-member-empty">No members selected yet.</span>';

  selectedContainer.querySelectorAll('[data-remove-team-member]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedIds(picker).delete(String(button.dataset.removeTeamMember));
      renderTeamMemberChoices(picker);
      renderSelectedMembers(picker);
      emitChange(picker);
    });
  });

  selectedContainer.querySelectorAll('[data-remove-pending-member-index]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextNames = pendingNames(picker);
      nextNames.splice(Number(button.dataset.removePendingMemberIndex), 1);
      picker.dataset.pendingMemberNames = nextNames.join(', ');
      renderSelectedMembers(picker);
      emitChange(picker);
    });
  });
}

function renderTeamMemberChoices(picker) {
  const query = picker.querySelector('[data-team-member-search]')?.value.trim().toLowerCase() || '';
  const matches = (picker._teamMembers || []).filter((member) => (
    !query
    || member.name.toLowerCase().includes(query)
    || (member.worker_class || 'normal').toLowerCase().includes(query)
  ));
  const options = picker.querySelector('[data-team-member-options]');
  if (!options) return;

  options.innerHTML = matches.length
    ? matches.map((member) => `
      <label class="team-member-option">
        <input
          type="checkbox"
          value="${member.id}"
          data-team-member-choice
          ${selectedIds(picker).has(String(member.id)) ? 'checked' : ''}
        />
        <span>
          <strong>${escapeHtml(member.name)}</strong>
          <small>${escapeHtml(memberRoleLabel(member))}</small>
        </span>
      </label>
    `).join('')
    : '<div class="team-member-no-results">No members match this search.</div>';

  options.querySelectorAll('[data-team-member-choice]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      picker.dataset.pendingMemberNames = '';
      if (checkbox.checked) {
        selectedIds(picker).add(String(checkbox.value));
      } else {
        selectedIds(picker).delete(String(checkbox.value));
      }
      renderSelectedMembers(picker);
      emitChange(picker);
    });
  });
}

function applyInitialSelection(picker, initialIds = [], initialNames = []) {
  const ids = initialIds.map(String).filter(Boolean);
  const names = initialNames.map(String).filter(Boolean);
  const matchedIds = ids.length ? ids : idsFromNames(picker._teamMembers || [], names);

  picker._selectedMemberIds = new Set(matchedIds);
  picker.dataset.pendingMemberNames = matchedIds.length ? '' : names.join(', ');
}

export function teamMemberPickerMarkup({
  legend = 'Members',
  searchLabel = 'Search members',
  searchPlaceholder = 'Type a member name'
} = {}) {
  return `
    <fieldset class="team-member-picker" data-team-member-picker>
      <legend>${escapeHtml(legend)}</legend>
      <label class="team-member-search">
        ${escapeHtml(searchLabel)}
        <input data-team-member-search type="search" placeholder="${escapeHtml(searchPlaceholder)}" autocomplete="off" />
      </label>
      <div class="team-selected-members" data-team-selected-members aria-live="polite"></div>
      <div class="team-member-options" data-team-member-options></div>
    </fieldset>
  `;
}

export function setupTeamMemberPicker(picker, {
  members = [],
  initialIds = [],
  initialNames = [],
  emitInitial = true,
  onChange = () => {}
} = {}) {
  if (!picker) return;

  picker._teamMembers = members || [];
  picker._onTeamMembersChange = onChange;

  if (!(picker._selectedMemberIds instanceof Set)) {
    applyInitialSelection(picker, initialIds, initialNames);
  }

  if (picker.dataset.teamMemberPickerReady !== 'true') {
    picker.dataset.teamMemberPickerReady = 'true';
    picker.querySelector('[data-team-member-search]')?.addEventListener('input', () => {
      renderTeamMemberChoices(picker);
    });
  }

  renderTeamMemberChoices(picker);
  renderSelectedMembers(picker);
  if (emitInitial) emitChange(picker);
}

export function updateTeamMemberPickerMembers(picker, members = []) {
  if (!picker) return;

  picker._teamMembers = members || [];
  if (!selectedIds(picker).size && pendingNames(picker).length) {
    const matchedIds = idsFromNames(picker._teamMembers, pendingNames(picker));
    if (matchedIds.length) {
      picker._selectedMemberIds = new Set(matchedIds);
      picker.dataset.pendingMemberNames = '';
    }
  }
  renderTeamMemberChoices(picker);
  renderSelectedMembers(picker);
  emitChange(picker);
}

export function setTeamMemberPickerSelectionFromNames(picker, value) {
  if (!picker) return;
  applyInitialSelection(picker, [], namesFromText(value));
  renderTeamMemberChoices(picker);
  renderSelectedMembers(picker);
  emitChange(picker);
}

export function selectedTeamMemberIds(picker) {
  return [...selectedIds(picker)];
}

export function selectedTeamMembers(picker) {
  return selectedMembersForPicker(picker);
}

export function selectedTeamMemberLabels(picker) {
  return selectedLabelsForPicker(picker);
}
