import {
  createSite as createBackendSite,
  createUser as createBackendUser,
  createWorkerInvitation,
  reissueWorkerInvitation,
  revokeWorkerInvitation,
  createWorkForm as createBackendWorkForm,
  getUsers as getBackendUsers,
  updateSite as updateBackendSite,
  updateUser as updateBackendUser,
  updateUserStatus as updateBackendUserStatus,
  updateWorkForm as updateBackendWorkForm
} from './api-client.js';
import { createSiteMapPicker, currentPosition } from './site-map-picker.js';
import { setButtonBusy } from './ui-feedback.js';
import { createWorkFormBuilder, workFormBuilderMarkup } from './work-form-builder.js';
import { renderWorkFormFields } from './work-form-fields.js';
import { escapeHtml, roundCoordinate, formatDateTime } from './utils.js';
import { defaultStaffDepartmentId } from './app-shell-state.js';
import { createWorkerInvitationDialog } from './worker-invitation-dialog.js';
import { setTranslatableText } from './i18n.js';
import { listTemplateDrafts, removeTemplateDraft, saveTemplateDraft, templateDraftScope } from './report-template-drafts.js';

export function createStaffSitesModule({
  els,
  state,
  reportOnly = false,
  loadSites,
  fillSiteSelects,
  refreshWorkForms,
  refreshSupervisorAuditHistory,
  refreshSupervisorMap,
  renderStatusBanner,
  showEditPanel,
  closeEditPanel,
  editValue,
  editNumber,
  confirmAction = async () => false
}) {
  let sessionGeneration = 0;
  let createTemplateDraft = null;
  let editTemplateDraft = null;
  let templateEditBuilder = null;
  let editTemplateReadOnly = false;
  let createTemplateReadOnly = false;
  let templateMutationInFlight = false;
  const completedTemplateDraftIds = new Set();
  const unsafeTemplateDraftEditors = new WeakSet();
  const templateDraftReceipts = new Map();
  let templateDraftWriteCount = 0;
  let restoringTemplateDraft = false;
  let templateDraftTimer = null;
  let templateDraftWrites = Promise.resolve();
  let templateDraftListGeneration = 0;
  let templateEditorsLocked = false;
  const templateDisabledControls = new Map();
  const sameTemplateUser = (user) => Boolean(templateDraftScope(state.user) && templateDraftScope(user)
    && String(state.user.id) === String(user.id) && String(state.user.departmentId) === String(user.departmentId)
    && Boolean(state.user.isGlobalAdmin) === Boolean(user.isGlobalAdmin));
  const invitationDialog = createWorkerInvitationDialog(els);
  const workFormBuilder = createWorkFormBuilder(els.workFormFieldBuilder, {
    onChange: () => {
      refreshOpenDraftWorkFormPreview();
      scheduleTemplateDraft();
    },
    confirmAction
  });

  function captureCreateTemplateDraft() {
    if (!reportOnly || !createTemplateDraft || !templateDraftScope(state.user)) return null;
    return {
      ...createTemplateDraft, name: els.workFormNameInput.value,
      description: els.workFormDescriptionInput.value,
      builder: workFormBuilder.getDraftState(), savedAt: new Date().toISOString()
    };
  }

  function captureEditTemplateDraft() {
    if (!editTemplateDraft || !templateEditBuilder || editTemplateReadOnly) return null;
    return { ...editTemplateDraft, name: document.getElementById('editWorkFormName').value,
      description: document.getElementById('editWorkFormDescription').value,
      builder: templateEditBuilder.getDraftState(), savedAt: new Date().toISOString() };
  }

  function draftContents(draft) {
    return JSON.stringify([draft.name, draft.description, draft.builder, draft.publicationState || '']);
  }

  function templateDraftCaptures() {
    return [[captureCreateTemplateDraft(), createTemplateDraft, els.templateCreateDraftStatus],
      [captureEditTemplateDraft(), editTemplateDraft, els.templateEditDraftStatus]]
      .filter(([draft]) => draft && (draft.storeRevision || draft.name || draft.description || draft.builder.fields.length || draft.builder.rawDirty));
  }

  function hasUnsavedTemplateInput() {
    return Boolean(reportOnly && (templateDraftWriteCount || templateDraftCaptures()
      .some(([draft]) => templateDraftReceipts.get(draft.id) !== draftContents(draft))));
  }

  function scheduleTemplateDraft() {
    if (restoringTemplateDraft || (!createTemplateDraft && !editTemplateDraft) || !reportOnly) return;
    window.clearTimeout(templateDraftTimer);
    for (const [draft, , status] of templateDraftCaptures()) {
      if (templateDraftReceipts.get(draft.id) !== draftContents(draft)) setTranslatableText(status, 'Saving Template draft...');
    }
    templateDraftTimer = window.setTimeout(() => { void flushTemplateDrafts().catch(() => {}); }, 150);
  }

  async function flushTemplateDrafts() {
    window.clearTimeout(templateDraftTimer);
    templateDraftTimer = null;
    const user = state.user;
    const generation = sessionGeneration;
    const captures = templateDraftCaptures();
    if (!captures.length) return;
    for (const [draft, editor, status] of captures) {
      if (templateDraftReceipts.get(draft.id) === draftContents(draft)) continue;
      const current = () => generation === sessionGeneration && (editor === createTemplateDraft || editor === editTemplateDraft);
      templateDraftWriteCount += 1;
      const write = templateDraftWrites.catch(() => {}).then(async () => {
        let saved;
        let unsafeConflict = false;
        if (unsafeTemplateDraftEditors.has(editor)) draft.publicationState = 'uncertain';
        try {
          saved = await saveTemplateDraft({ ...draft, id: editor.id, storeRevision: editor.storeRevision || 0 }, user);
        } catch (error) {
          if (error.code !== 'TEMPLATE_DRAFT_CONFLICT') throw error;
          unsafeConflict = error.conflictReason === 'removed' || error.publicationState === 'uncertain';
          editor.id = crypto.randomUUID();
          editor.storeRevision = 0;
          if (unsafeConflict) {
            unsafeTemplateDraftEditors.add(editor);
            editor.publicationState = 'uncertain';
            draft.publicationState = 'uncertain';
          }
          saved = await saveTemplateDraft({ ...draft, id: editor.id, storeRevision: 0 }, user);
        }
        if (saved?.storeRevision) editor.storeRevision = saved.storeRevision;
        templateDraftReceipts.set(editor.id, draftContents(draft));
        if (unsafeConflict && current()) {
          if (editor === createTemplateDraft) createTemplateReadOnly = true;
          if (editor === editTemplateDraft) editTemplateReadOnly = true;
          enforceReadOnlyTemplateEditors();
          const error = new Error('This draft was removed or saved in another editor. Your recovery copy is read-only; check the Template list before editing again.');
          error.code = 'TEMPLATE_DRAFT_PUBLICATION_UNCERTAIN';
          throw error;
        }
      }).finally(() => { if (generation === sessionGeneration) templateDraftWriteCount -= 1; });
      templateDraftWrites = write;
      try {
        await write;
        if (!current()) continue;
        const latest = editor === createTemplateDraft ? captureCreateTemplateDraft() : captureEditTemplateDraft();
        if (latest && templateDraftReceipts.get(editor.id) === draftContents(latest)) {
          setTranslatableText(status, 'Template draft saved on this device.');
        }
        void renderTemplateDrafts();
      } catch (error) {
        if (current()) setTranslatableText(status, error.code === 'TEMPLATE_DRAFT_PUBLICATION_UNCERTAIN'
          ? error.message : 'Template draft could not be saved. Keep this page open and try again.');
        throw error;
      }
    }
    await templateDraftWrites;
  }

  async function renderTemplateDrafts() {
    const generation = ++templateDraftListGeneration;
    const user = state.user;
    if (!reportOnly || !templateDraftScope(user)) {
      els.templateDraftsPanel.hidden = true;
      els.templateDraftsList.innerHTML = '';
      return;
    }
    try {
      const drafts = (await listTemplateDrafts(user, state.departmentFocusId))
        .filter((draft) => !completedTemplateDraftIds.has(draft.id));
      if (generation !== templateDraftListGeneration || !sameTemplateUser(user)) return;
      els.templateDraftsList.innerHTML = '';
      els.templateDraftsPanel.hidden = !drafts.length;
      for (const draft of drafts) {
        const card = document.createElement('article');
        card.className = 'record-card';
        card.innerHTML = `<div class="report-draft-summary"><h4 data-no-i18n>${escapeHtml(draft.name || 'Untitled Report Template')}</h4><p class="record-meta"><span>Saved on this device</span> · <span data-no-i18n>${escapeHtml(formatDateTime(draft.savedAt))}</span></p></div>`;
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.className = 'secondary';
        resume.textContent = 'Continue Template draft';
        resume.addEventListener('click', async () => {
          if (!sameTemplateUser(user) || templateEditorsLocked || templateMutationInFlight) return;
          const editorGeneration = sessionGeneration;
          lockTemplateEditors(true);
          try {
            await flushTemplateDrafts();
            if (editorGeneration !== sessionGeneration || !sameTemplateUser(user)) return;
            const latest = (await listTemplateDrafts(user)).find((item) => item.id === draft.id);
            if (editorGeneration !== sessionGeneration || !sameTemplateUser(user) || !latest) return;
            if (latest.formId || latest.publicationState) {
              lockTemplateEditors(false);
              await openReportTemplateEditor(state.workForms.find((form) => String(form.id) === latest.formId), latest);
              return;
            }
            restoringTemplateDraft = true;
            resetWorkFormCreate();
            createTemplateDraft = latest;
            createTemplateReadOnly = false;
            els.workFormNameInput.value = latest.name;
            els.workFormDescriptionInput.value = latest.description;
            workFormBuilder.restoreDraftState(latest.builder);
            templateDraftReceipts.set(latest.id, draftContents(captureCreateTemplateDraft()));
            setCreatePanelOpen(els.addWorkFormButton, els.workFormCreatePanel, els.workFormNameInput, true);
            setTranslatableText(els.templateCreateDraftStatus, 'Template draft saved on this device.');
          } catch (error) {
            renderStatusBanner(error.message || 'Could not restore Template draft.', true);
          } finally {
            restoringTemplateDraft = false;
            if (editorGeneration === sessionGeneration) lockTemplateEditors(false);
          }
        });
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'ghost';
        discard.textContent = 'Discard Template draft';
        discard.addEventListener('click', async () => {
          if (templateEditorsLocked || templateMutationInFlight || !sameTemplateUser(user)) return;
          if (!await confirmAction({ title: 'Discard Template draft?', message: 'This removes only the unfinished editing copy on this device. Published Templates and Reports are unchanged.', confirmLabel: 'Discard draft', tone: 'danger' })) return;
          if (!sameTemplateUser(user) || templateEditorsLocked || templateMutationInFlight) return;
          const editorGeneration = sessionGeneration;
          lockTemplateEditors(true);
          try {
            const active = templateDraftCaptures().find(([item]) => item.id === draft.id);
            await flushTemplateDrafts();
            if (editorGeneration !== sessionGeneration || !sameTemplateUser(user)) return;
            // Delete only the revision the user saw (or this editor just saved),
            // never silently adopt another tab's newer content as deletion intent.
            const latest = active && active[1].id === draft.id
              ? { ...active[0], storeRevision: active[1].storeRevision } : draft;
            await removeTemplateDraft(latest, user);
            if (editorGeneration !== sessionGeneration || !sameTemplateUser(user)) return;
            if (createTemplateDraft?.id === latest.id) {
              createTemplateDraft = null;
              createTemplateReadOnly = false;
              resetWorkFormCreate();
              els.templateCreateDraftStatus.textContent = '';
              setCreatePanelOpen(els.addWorkFormButton, els.workFormCreatePanel, els.workFormNameInput, false);
            }
            if (editTemplateDraft?.id === latest.id) clearTemplateEdit();
            void renderTemplateDrafts();
          } catch (error) {
            if (editorGeneration === sessionGeneration && sameTemplateUser(user)) {
              renderStatusBanner(error.message || 'Could not discard Template draft.', true);
              void renderTemplateDrafts();
            }
          }
          finally { if (editorGeneration === sessionGeneration) lockTemplateEditors(false); }
        });
        const actions = document.createElement('div');
        actions.className = 'form-actions';
        actions.append(resume, discard);
        card.append(actions);
        els.templateDraftsList.append(card);
      }
    } catch {
      if (generation === templateDraftListGeneration) {
        els.templateDraftsPanel.hidden = false;
        setTranslatableText(els.templateDraftsList, 'Template drafts are unavailable on this device.');
      }
    }
  }

  function setCreatePanelOpen(
    button,
    panel,
    focusTarget,
    isOpen,
    { restoreFocus = true } = {}
  ) {
    if (!button || !panel) return;
    const focusWasInside = panel.contains(document.activeElement);
    panel.hidden = !isOpen;
    button.setAttribute('aria-expanded', String(isOpen));
    button.disabled = isOpen;

    if (isOpen) {
      window.requestAnimationFrame(() => focusTarget?.focus());
    } else if (restoreFocus && focusWasInside) {
      window.requestAnimationFrame(() => button.focus());
    }
  }

  function clearCreateFeedback(target) {
    if (!target) return;
    target.textContent = '';
    target.classList.add('hidden');
    target.removeAttribute('data-tone');
    target.setAttribute('role', 'status');
    target.setAttribute('aria-live', 'polite');
  }

  function shouldRestoreCreateFocus(panel) {
    const activeElement = document.activeElement;
    return panel.contains(activeElement)
      || activeElement === document.body
      || activeElement === document.documentElement;
  }

  function roundCoordinateInput(input) {
    if (input.value.trim() === '') return NaN;
    const rounded = roundCoordinate(input.value);
    if (Number.isFinite(rounded)) {
      input.value = rounded.toFixed(6);
    }
    return rounded;
  }

  function departmentSelectOptions() {
    const departments = state.user?.isGlobalAdmin
      ? (state.departments || [])
      : (state.departments || []).filter((department) => (
        String(department.id) === String(state.user?.departmentId)
      ));

    return departments
      .map((department) => ({
        value: department.id,
        label: department.name
      }));
  }

  function activeWorkerTeamMembers() {
    return (state.staffUsers || [])
      .filter((user) => (
        user.role === 'worker'
        && (user.status || 'active') === 'active'
        && matchesDepartmentFocus(user)
      ))
      .map((user) => ({
        id: user.id,
        name: user.name,
        worker_class: user.worker_class || user.workerClass || 'normal',
        department_id: user.department_id || user.departmentId
      }));
  }

  function isDayworkForm(form) {
    const purpose = String(form?.template_purpose || form?.templatePurpose || '').trim().toLowerCase();
    if (['report', 'daywork'].includes(purpose)) return purpose === 'daywork';
    return `${form?.name || ''} ${form?.description || ''}`.toLowerCase().includes('daywork');
  }

  function isHiddenDayworkHelperField(form, field) {
    return isDayworkForm(form) && field?.repeat === 'teams' && field?.id === 'team_people';
  }

  function staffCreateDepartmentId() {
    return state.user?.isGlobalAdmin
      ? Number(els.staffDepartmentSelect.value)
      : Number(state.user?.departmentId);
  }

  function syncStaffCreateRoleControls() {
    const isWorker = els.staffRoleSelect.value === 'worker';
    const usesInvitation = reportOnly && isWorker;
    const canAssignGlobalAdmin = Boolean(state.user?.isGlobalAdmin && !isWorker);
    const globalAdminLabel = els.staffGlobalAdminInput.closest('label');

    els.staffWorkerClassSelect.disabled = !isWorker;
    globalAdminLabel?.classList.toggle('hidden', !state.user?.isGlobalAdmin);
    if (!canAssignGlobalAdmin) els.staffGlobalAdminInput.checked = false;
    els.staffGlobalAdminInput.disabled = !canAssignGlobalAdmin;
    els.staffPasswordInput.closest('label').classList.toggle('hidden', usesInvitation);
    els.staffPasswordInput.required = !usesInvitation;
    els.staffPasswordInput.disabled = usesInvitation;
    if (usesInvitation) els.staffPasswordInput.value = '';
    els.staffInvitationHelp.hidden = !usesInvitation;
    if (els.staffUserSubmitButton.getAttribute('aria-busy') !== 'true') {
      setTranslatableText(els.staffUserSubmitButton, usesInvitation ? 'Create invitation' : 'Create user');
    }
  }

  function renderStaffCreateControls() {
    const options = departmentSelectOptions();
    els.staffDepartmentSelect.innerHTML = options
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');
    els.staffDepartmentSelect.value = defaultStaffDepartmentId(
      state.user,
      state.departments,
      state.departmentFocusId
    );
    els.staffDepartmentSelect.disabled = !state.user?.isGlobalAdmin;

    syncStaffCreateRoleControls();
  }

  function resetStaffUserCreate() {
    els.staffUserForm.reset();
    renderStaffCreateControls();
  }

  function resetWorkFormCreate() {
    els.workFormBuilderForm.reset();
    els.workFormBuilderForm.querySelectorAll('input, select, textarea, button').forEach((control) => {
      control.disabled = false;
      templateDisabledControls.delete(control);
    });
    workFormBuilder.reset();
    const advancedDetails = els.workFormCreatePanel.querySelector('[data-work-form-advanced]');
    if (advancedDetails) advancedDetails.open = false;
    hideDraftWorkFormPreview();
    clearCreateFeedback(els.workFormBuilderActionFeedback);
  }

  function openStaffUserCreate() {
    setCreatePanelOpen(
      els.addStaffUserButton,
      els.staffUserCreatePanel,
      els.staffNameInput,
      true
    );
  }

  function cancelStaffUserCreate() {
    resetStaffUserCreate();
    setCreatePanelOpen(
      els.addStaffUserButton,
      els.staffUserCreatePanel,
      els.staffNameInput,
      false
    );
  }

  function openWorkFormCreate() {
    if (templateEditorsLocked) return;
    if (reportOnly && !createTemplateDraft) {
      createTemplateReadOnly = false;
      createTemplateDraft = {
        kind: 'report-template-editor', schemaVersion: 1, id: crypto.randomUUID(),
        ...templateDraftScope(state.user), departmentId: String(state.user.departmentId),
        purpose: 'report', formId: null, baseVersion: null
      };
    }
    setCreatePanelOpen(
      els.addWorkFormButton,
      els.workFormCreatePanel,
      els.workFormNameInput,
      true
    );
  }

  function lockTemplateEditors(locked) {
    templateEditorsLocked = locked;
    if (locked) {
      document.querySelectorAll('#workFormBuilderForm input, #workFormBuilderForm select, #workFormBuilderForm textarea, #workFormBuilderForm button, #templateEditForm input, #templateEditForm select, #templateEditForm textarea, #templateEditForm button').forEach((control) => {
        if (!templateDisabledControls.has(control)) templateDisabledControls.set(control, control.disabled);
        control.disabled = true;
      });
    } else {
      for (const [control, disabled] of templateDisabledControls) control.disabled = disabled;
      templateDisabledControls.clear();
      enforceReadOnlyTemplateEditors();
    }
  }

  function enforceReadOnlyTemplateEditors() {
    if (createTemplateReadOnly) els.workFormBuilderForm.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = true; });
    if (editTemplateReadOnly) els.templateEditForm.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = true; });
    // Closing a read-only recovery copy never publishes it.
    if (!templateEditorsLocked) els.cancelWorkFormCreateButton.disabled = false;
  }

  async function prepareForNavigation() {
    if (!reportOnly || state.user?.role !== 'supervisor') return { safe: true };
    if (templateMutationInFlight || templateEditorsLocked) return { safe: false, message: 'Wait for the Template operation to finish before leaving or updating.' };
    lockTemplateEditors(true);
    try {
      await flushTemplateDrafts();
      return { safe: true };
    } catch {
      lockTemplateEditors(false);
      return { safe: false, message: 'Your Template changes are not saved on this device. Keep this page open and try again before leaving or updating.' };
    }
  }

  async function cancelWorkFormCreate() {
    if (reportOnly) {
      if (templateEditorsLocked) return;
      const generation = sessionGeneration;
      lockTemplateEditors(true);
      try {
        await flushTemplateDrafts();
        if (generation !== sessionGeneration) return;
        createTemplateDraft = null;
        createTemplateReadOnly = false;
      } catch {
        return;
      } finally {
        if (generation === sessionGeneration) lockTemplateEditors(false);
      }
    }
    resetWorkFormCreate();
    els.templateCreateDraftStatus.textContent = '';
    setCreatePanelOpen(
      els.addWorkFormButton,
      els.workFormCreatePanel,
      els.workFormNameInput,
      false
    );
  }

  function resetSession() {
    sessionGeneration += 1;
    createTemplateDraft = null;
    createTemplateReadOnly = false;
    clearTemplateEdit();
    templateMutationInFlight = false;
    templateDraftListGeneration += 1;
    window.clearTimeout(templateDraftTimer);
    templateDraftTimer = null;
    templateDraftWriteCount = 0;
    templateDraftWrites = Promise.resolve();
    lockTemplateEditors(false);
    els.templateCreateDraftStatus.textContent = '';
    els.templateDraftsList.innerHTML = '';
    els.templateDraftsPanel.hidden = true;
    invitationDialog.clear();
    resetStaffUserCreate();
    resetWorkFormCreate();
    if (els.workFormDraftPreview) els.workFormDraftPreview.innerHTML = '';
    els.staffSearchInput.value = '';
    els.siteSearchInput.value = '';
    state.staffUsers = [];
    state.workForms = [];
    els.staffUsersCount.textContent = '0';
    els.staffUsersList.innerHTML = '';
    els.workFormsCount.textContent = '0';
    els.workFormsList.innerHTML = '';
    els.supervisorSitesCount.textContent = '0';
    els.supervisorSitesList.innerHTML = '';
    els.siteForm.reset();
    els.siteLatitudeInput.value = '';
    els.siteLongitudeInput.value = '';
    siteMapPicker.reset({ clearExisting: true });
    setButtonBusy(els.staffUserSubmitButton, false);
    setButtonBusy(els.workFormSubmitButton, false);
    els.cancelStaffUserCreateButton.disabled = false;
    els.cancelWorkFormCreateButton.disabled = false;
    setCreatePanelOpen(
      els.addStaffUserButton,
      els.staffUserCreatePanel,
      els.staffNameInput,
      false,
      { restoreFocus: false }
    );
    setCreatePanelOpen(
      els.addWorkFormButton,
      els.workFormCreatePanel,
      els.workFormNameInput,
      false,
      { restoreFocus: false }
    );
    closeEditPanel();
  }

  function matchesDepartmentFocus(item) {
    if (!state.departmentFocusId) return true;
    return String(item.department_id ?? item.departmentId) === String(state.departmentFocusId);
  }

  const siteMapPicker = createSiteMapPicker({
    mapElement: els.siteMap,
    latitudeInput: els.siteLatitudeInput,
    longitudeInput: els.siteLongitudeInput,
    radiusInput: els.siteRadiusInput,
    statusElement: els.siteMapStatus,
    getExistingSites: () => state.sites.filter(matchesDepartmentFocus)
  });

  function refreshSiteMapIfVisible() {
    if (els.siteMap?.closest('details')?.open && els.siteMap.getClientRects().length) {
      siteMapPicker.refresh();
    }
  }

  function siteSelectOptions() {
    return [
      { value: '', label: 'No site' },
      ...state.sites.filter(matchesDepartmentFocus).map((site) => ({
        value: site.id,
        label: `${site.name} (#${site.id})`
      }))
    ];
  }

  function renderSupervisorSites() {
    els.supervisorSitesList.innerHTML = '';
    const query = els.siteSearchInput.value.trim().toLowerCase();
    const departmentSites = state.sites.filter(matchesDepartmentFocus);
    const sites = departmentSites.filter((site) => {
      const text = [
        site.id,
        site.name,
        site.address,
        site.latitude,
        site.longitude,
        site.allowed_radius_m || site.allowedRadiusM
      ].join(' ').toLowerCase();
      return !query || text.includes(query);
    });
    els.supervisorSitesCount.textContent = query ? `${sites.length}/${departmentSites.length}` : String(departmentSites.length);

    if (!sites.length) {
      els.supervisorSitesList.innerHTML = '<div class="empty-state">No sites found yet.</div>';
      refreshSiteMapIfVisible();
      return;
    }

    sites.forEach((site) => {
      const node = document.createElement('article');
      node.className = 'record-card';
      node.innerHTML = `
        <div class="record-header">
          <div>
            <h3 class="record-title">${escapeHtml(site.name)}</h3>
            <p class="record-meta">ID ${escapeHtml(site.id)} | ${escapeHtml(site.address || 'No address added')}</p>
          </div>
          <span class="badge synced">${escapeHtml(site.allowed_radius_m || site.allowedRadiusM || 100)}m</span>
        </div>
        <p class="record-detail">Lat ${escapeHtml(site.latitude ?? '-')}, Lng ${escapeHtml(site.longitude ?? '-')}</p>
        <div class="record-actions"></div>
      `;
      const actions = node.querySelector('.record-actions');
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'ghost';
      editButton.textContent = 'Edit site';
      editButton.addEventListener('click', async () => {
        await handleSiteEdit(site);
      });
      actions.append(editButton);
      els.supervisorSitesList.appendChild(node);
    });
    refreshSiteMapIfVisible();
  }

  async function renderStaffUsers({ preserveOnError = false, reportError = true } = {}) {
    if (state.user?.role !== 'supervisor') return false;
    const requestUserId = state.user.id;
    const requestGeneration = sessionGeneration;
    const isCurrentSession = () => (
      requestGeneration === sessionGeneration
      && state.user?.role === 'supervisor'
      && String(state.user.id) === String(requestUserId)
    );
    try {
      renderStaffCreateControls();
      const staffUsers = await getBackendUsers();
      if (!isCurrentSession()) return false;
      state.staffUsers = staffUsers;
      renderFilteredStaffUsers();
      return true;
    } catch (error) {
      if (!isCurrentSession()) return false;
      if (!preserveOnError) {
        els.staffUsersCount.textContent = '-';
        els.staffUsersList.innerHTML = '<div class="empty-state">Staff users are unavailable.</div>';
      }
      if (reportError) renderStatusBanner(error.message || 'Could not load staff users.', true);
      return false;
    }
  }

  function renderFilteredStaffUsers() {
    const query = els.staffSearchInput.value.trim().toLowerCase();
    const departmentUsers = state.staffUsers
      .filter((user) => state.user?.isGlobalAdmin || !(user.is_global_admin || user.isGlobalAdmin))
      .filter(matchesDepartmentFocus);
    const users = departmentUsers.filter((user) => {
      const text = [
        user.id,
        user.name,
        user.email,
        user.role,
        user.worker_class || user.workerClass,
        user.status || 'active',
        user.password_setup_required ? 'invited password setup required' : '',
        user.invitation_status || '',
        user.department_name || user.departmentName,
        user.is_global_admin || user.isGlobalAdmin ? 'global admin' : ''
      ].join(' ').toLowerCase();
      return !query || text.includes(query);
    });
    els.staffUsersList.innerHTML = '';
    els.staffUsersCount.textContent = query ? `${users.length}/${departmentUsers.length}` : String(departmentUsers.length);

    if (!users.length) {
      els.staffUsersList.innerHTML = '<div class="empty-state">No users found yet.</div>';
      return;
    }

    users.forEach((user) => {
      const node = document.createElement('article');
      node.className = 'record-card';
      const status = user.status || 'active';
      const isGlobalAdmin = Boolean(user.is_global_admin || user.isGlobalAdmin);
      const workerClass = user.worker_class || user.workerClass || 'normal';
      const needsSetup = user.role === 'worker' && user.password_setup_required === true;
      const invitationStatus = {
        pending: 'Awaiting password setup', expired: 'Invitation expired', revoked: 'Invitation revoked'
      }[user.invitation_status] || 'No active invitation';
      node.innerHTML = `
        <div class="record-header">
          <div>
            <h3 class="record-title">${escapeHtml(user.name)}</h3>
            <p class="record-meta">ID ${escapeHtml(user.id)} | ${escapeHtml(user.email)} | ${escapeHtml(user.department_name || user.departmentName || 'No department')}</p>
          </div>
          <span class="badge ${status === 'active' ? 'synced' : 'rejected'}">${escapeHtml(status === 'active' ? needsSetup ? 'Password setup required' : `${user.role === 'worker' ? workerClass : user.role}${isGlobalAdmin ? ' global' : ''}` : 'resigned worker')}</span>
        </div>
        ${needsSetup ? `<p class="record-meta"><span>${invitationStatus}</span>${user.invitation_status === 'pending' && user.invitation_expires_at ? ` · <span>Expires</span>: <span data-no-i18n>${escapeHtml(formatDateTime(user.invitation_expires_at))}</span>` : ''}</p>` : ''}
        <div class="record-actions"></div>
      `;
      const actions = node.querySelector('.record-actions');
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'ghost';
      editButton.textContent = 'Edit user';
      editButton.addEventListener('click', async () => {
        await handleStaffUserEdit(user);
      });

      actions.append(editButton);
      if (needsSetup) {
        if (status === 'active') {
          const reissue = document.createElement('button');
          reissue.type = 'button';
          reissue.className = 'secondary';
          reissue.textContent = 'Create new setup link';
          reissue.addEventListener('click', () => { void handleInvitationAction(user, 'reissue', reissue); });
          actions.append(reissue);
        }
        if (['pending', 'expired'].includes(user.invitation_status)) {
          const revoke = document.createElement('button');
          revoke.type = 'button';
          revoke.className = 'ghost';
          revoke.textContent = 'Revoke setup link';
          revoke.addEventListener('click', () => { void handleInvitationAction(user, 'revoke', revoke); });
          actions.append(revoke);
        }
      }
      if (state.user?.isGlobalAdmin || !isGlobalAdmin) {
        const statusButton = document.createElement('button');
        statusButton.type = 'button';
        statusButton.className = status === 'active' ? 'secondary' : '';
        statusButton.textContent = status === 'active' ? 'Mark resigned' : 'Reactivate';
        statusButton.addEventListener('click', async () => {
          await handleUserStatusChange(user, status === 'active' ? 'resigned' : 'active', statusButton);
        });
        actions.append(statusButton);
      }
      els.staffUsersList.appendChild(node);
    });
  }

  async function handleWorkFormCreate(event) {
    event.preventDefault();

    if (reportOnly) return saveReportTemplateCreate();

    if (!workFormBuilder.validate({ focus: true })) return;
    const fields = workFormBuilder.getFields();
    if (els.workFormSubmitButton.getAttribute('aria-busy') === 'true') return;
    let created = false;
    let restoreFocus = false;
    setButtonBusy(els.workFormSubmitButton, true, 'Creating Report Template...');
    els.cancelWorkFormCreateButton.disabled = true;

    try {
      await createBackendWorkForm({
        name: els.workFormNameInput.value.trim(),
        description: els.workFormDescriptionInput.value.trim() || null,
        fields
      });
      created = true;
      restoreFocus = shouldRestoreCreateFocus(els.workFormCreatePanel);
      resetWorkFormCreate();
      setCreatePanelOpen(
        els.addWorkFormButton,
        els.workFormCreatePanel,
        els.workFormNameInput,
        false,
        { restoreFocus: false }
      );
      els.addWorkFormButton.disabled = true;
      renderStatusBanner('Report Template created.');
      const workFormsRefreshed = await refreshWorkForms();
      if (!workFormsRefreshed) {
        throw new Error('Report Template created, but the updated list could not load.');
      }
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      if (created) {
        renderStatusBanner(error.message || 'Report Template created, but the updated list could not load.', true);
      } else {
        renderStatusBanner(error.message || 'Could not create Report Template.', true, {
          local: els.workFormBuilderActionFeedback,
          tone: 'error'
        });
      }
    } finally {
      setButtonBusy(els.workFormSubmitButton, false);
      els.cancelWorkFormCreateButton.disabled = false;
      els.addWorkFormButton.disabled = !els.workFormCreatePanel.hidden;
      if (
        created
        && restoreFocus
        && els.workFormCreatePanel.hidden
        && shouldRestoreCreateFocus(els.workFormCreatePanel)
      ) {
        window.requestAnimationFrame(() => els.addWorkFormButton.focus());
      }
    }
  }

  function draftWorkForm() {
    return {
      id: 'draft',
      name: els.workFormNameInput.value.trim() || 'Untitled Report Template',
      description: els.workFormDescriptionInput.value.trim() || '',
      status: 'draft',
      fields: workFormBuilder.getFields()
    };
  }

  function renderWorkFormPreview(preview, form, idPrefix, emptyMessage = 'Add fields to preview this Report Template.') {
    if (!preview) return;

    if (!form.fields?.length) {
      preview.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
      return;
    }

    preview.innerHTML = `
      <div class="section-heading">
        <div>
          <p class="eyebrow">Worker preview</p>
          <h3>${escapeHtml(form.name)}</h3>
          ${form.description ? `<p class="record-meta">${escapeHtml(form.description)}</p>` : ''}
        </div>
      </div>
      <div class="form-preview-shell">
        <label>
          Site
          <select disabled>
            <option>${escapeHtml(state.sites[0]?.name || 'Worker selects site')}</option>
          </select>
        </label>
        <label>
          Report Date
          <input type="date" disabled />
        </label>
        <div class="dynamic-fields" data-work-form-preview-fields></div>
        <label>
          Photos
          <input type="file" accept="image/*" multiple disabled />
        </label>
        <button type="button" disabled>Submit Report</button>
      </div>
    `;

    renderWorkFormFields(preview.querySelector('[data-work-form-preview-fields]'), form, {
      idPrefix,
      container: preview,
      enhanceDayworkTeamMembers: isDayworkForm(form),
      teamMembers: activeWorkerTeamMembers()
    });
    preview.querySelectorAll('[data-work-form-preview-fields] [required]').forEach((control) => {
      control.removeAttribute('required');
    });
  }

  function renderDraftWorkFormPreview() {
    if (!els.workFormDraftPreview) return;
    renderWorkFormPreview(els.workFormDraftPreview, draftWorkForm(), 'previewWorkForm_draft');
  }

  function showDraftWorkFormPreview() {
    if (!els.workFormDraftPreview || !els.workFormPreviewButton) return;
    renderDraftWorkFormPreview();
    els.workFormDraftPreview.classList.remove('hidden');
    els.workFormPreviewButton.textContent = 'Hide preview';
  }

  function hideDraftWorkFormPreview() {
    if (!els.workFormDraftPreview || !els.workFormPreviewButton) return;
    els.workFormDraftPreview.classList.add('hidden');
    els.workFormPreviewButton.textContent = 'Preview draft';
  }

  function handleDraftWorkFormPreviewToggle() {
    if (!els.workFormDraftPreview) return;
    if (els.workFormDraftPreview.classList.contains('hidden')) {
      if (!workFormBuilder.validate({ focus: true })) return;
      showDraftWorkFormPreview();
      return;
    }
    hideDraftWorkFormPreview();
  }

  function refreshOpenDraftWorkFormPreview() {
    if (!els.workFormDraftPreview || els.workFormDraftPreview.classList.contains('hidden')) return;
    renderDraftWorkFormPreview();
  }

  function clearTemplateEdit() {
    templateEditBuilder?.destroy();
    templateEditBuilder = null;
    editTemplateDraft = null;
    editTemplateReadOnly = false;
    els.templateEditPanel.hidden = true;
    els.templateEditForm.innerHTML = '';
    els.templateEditForm.onsubmit = null;
    els.templateEditDraftStatus.textContent = '';
    els.templateEditNotice.textContent = '';
  }

  async function saveReportTemplateCreate() {
    if (templateEditorsLocked || templateMutationInFlight || createTemplateReadOnly || !createTemplateDraft
      || !workFormBuilder.validate({ focus: true })) return;
    if (!navigator.onLine) {
      renderStatusBanner('Connect before publishing the Template. Your private editing draft stays on this device.', true,
        { local: els.workFormBuilderActionFeedback, tone: 'error' });
      return;
    }
    const editor = createTemplateDraft;
    const user = state.user;
    const generation = sessionGeneration;
    const current = () => generation === sessionGeneration && editor === createTemplateDraft && sameTemplateUser(user);
    templateMutationInFlight = true;
    lockTemplateEditors(true);
    let sent = false;
    try {
      editor.publicationState = 'uncertain';
      await flushTemplateDrafts();
      if (!current() || createTemplateReadOnly) return;
      const captured = captureCreateTemplateDraft();
      sent = true;
      await createBackendWorkForm({ name: captured.name.trim(), description: captured.description.trim() || null,
        fields: captured.builder.fields });
      const cleared = await retireTemplateDraft({ ...captured, storeRevision: editor.storeRevision }, user);
      if (!current()) return;
      createTemplateDraft = null;
      resetWorkFormCreate();
      els.templateCreateDraftStatus.textContent = '';
      setCreatePanelOpen(els.addWorkFormButton, els.workFormCreatePanel, els.workFormNameInput, false);
      const refreshed = await refreshWorkForms();
      if (generation !== sessionGeneration) return;
      renderStatusBanner(!cleared ? 'Template saved, but its local draft could not be cleared. The recovery copy is read-only.'
        : refreshed ? 'Report Template created.' : 'Report Template created, but the updated list could not load.', !cleared || !refreshed);
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      if (!current()) return;
      if (error.code !== 'TEMPLATE_DRAFT_PUBLICATION_UNCERTAIN' && (!sent || (error.status >= 400 && error.status < 500))) {
        delete editor.publicationState;
        await flushTemplateDrafts().catch(() => {});
      } else createTemplateReadOnly = true;
      renderStatusBanner(createTemplateReadOnly
        ? 'The previous save may have reached the server. This draft is kept read-only; check the Template list before creating or editing again.'
        : error.message || 'Could not create Report Template. Your editing draft is kept.', true, {
        local: els.workFormBuilderActionFeedback, tone: 'error'
      });
    } finally {
      if (generation === sessionGeneration) {
        templateMutationInFlight = false;
        lockTemplateEditors(false);
      }
    }
  }

  async function closeTemplateEdit() {
    if (templateEditorsLocked || templateMutationInFlight) return;
    const generation = sessionGeneration;
    lockTemplateEditors(true);
    try {
      await flushTemplateDrafts();
      if (generation === sessionGeneration) clearTemplateEdit();
    } catch { /* Keep the editor and its error visible. */ }
    finally { if (generation === sessionGeneration) lockTemplateEditors(false); }
  }

  async function retireTemplateDraft(draft, user) {
    completedTemplateDraftIds.add(draft.id);
    try { await removeTemplateDraft(draft, user); return true; }
    catch { return false; }
    finally { if (sameTemplateUser(user)) void renderTemplateDrafts(); }
  }

  async function openReportTemplateEditor(form, restored = null) {
    if (templateEditorsLocked || templateMutationInFlight || !templateDraftScope(state.user)) return;
    const generation = sessionGeneration;
    const user = state.user;
    const current = () => generation === sessionGeneration && sameTemplateUser(user);
    lockTemplateEditors(true);
    try {
      await flushTemplateDrafts();
      if (!current()) return;
      const loaded = await refreshWorkForms();
      if (!current()) return;
      const formId = restored?.formId || String(form?.id || '');
      form = state.workForms.find((item) => String(item.id) === formId);
      if (!restored && (!loaded || !form || form.template_purpose !== 'report')) {
        renderStatusBanner('Connect to load the current Report Template before editing.', true);
        return;
      }
      clearTemplateEdit();
      editTemplateDraft = restored || {
        kind: 'report-template-editor', schemaVersion: 1, id: crypto.randomUUID(),
        ...templateDraftScope(user), departmentId: String(form.department_id),
        purpose: 'report', formId: String(form.id), baseVersion: Number(form.definition_version || 1)
      };
      editTemplateReadOnly = Boolean(restored && (!loaded || !form || form.template_purpose !== 'report'
        || String(form.department_id) !== restored.departmentId || form.status !== 'active'
        || Number(form.definition_version || 1) !== restored.baseVersion || restored.publicationState));
      els.templateEditForm.innerHTML = `
        <label>Template name<input id="editWorkFormName" required /></label>
        <label>Description<input id="editWorkFormDescription" /></label>
        ${workFormBuilderMarkup()}
        <button id="saveTemplateEditButton" type="submit">Save Report Template</button>`;
      document.getElementById('editWorkFormName').value = restored?.name ?? form?.name ?? '';
      document.getElementById('editWorkFormDescription').value = restored?.description ?? form?.description ?? '';
      templateEditBuilder = createWorkFormBuilder(els.templateEditForm.querySelector('[data-work-form-builder]'), {
        fields: form?.fields || [], confirmAction, onChange: scheduleTemplateDraft
      });
      restoringTemplateDraft = true;
      if (restored) templateEditBuilder.restoreDraftState(restored.builder);
      restoringTemplateDraft = false;
      if (!editTemplateReadOnly) templateDraftReceipts.set(editTemplateDraft.id, draftContents(captureEditTemplateDraft()));
      els.templateEditPanel.hidden = false;
      setTranslatableText(els.templateEditNotice, editTemplateReadOnly
        ? restored.publicationState
          ? 'The previous save may have reached the server. This draft is kept read-only; check the Template list before creating or editing again.'
          : 'The Template changed or is unavailable. Your editing draft is kept read-only. Open the current Template separately; your draft will not overwrite it.'
        : 'Changes stay private on this device until you save the Report Template.');
      setTranslatableText(els.templateEditDraftStatus, restored ? 'Template draft saved on this device.' : 'Changes save automatically on this device.');
      els.templateEditForm.onsubmit = saveReportTemplateEdit;
      if (editTemplateReadOnly) els.templateEditForm.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = true; });
      els.templateEditPanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) {
      if (current()) renderStatusBanner(error.message || 'Could not open Template draft.', true);
    } finally {
      restoringTemplateDraft = false;
      if (generation === sessionGeneration) lockTemplateEditors(false);
    }
  }

  async function saveReportTemplateEdit(event) {
    event.preventDefault();
    if (templateEditorsLocked || templateMutationInFlight || editTemplateReadOnly || !templateEditBuilder.validate({ focus: true })) return;
    if (!navigator.onLine) {
      setTranslatableText(els.templateEditNotice, 'Connect before publishing the Template. Your private editing draft stays on this device.');
      return;
    }
    const editor = editTemplateDraft;
    const user = state.user;
    const generation = sessionGeneration;
    const current = () => generation === sessionGeneration && editor === editTemplateDraft && sameTemplateUser(user);
    templateMutationInFlight = true;
    lockTemplateEditors(true);
    let sent = false;
    try {
      editor.publicationState = 'uncertain';
      await flushTemplateDrafts();
      if (!current() || editTemplateReadOnly) return;
      const captured = captureEditTemplateDraft();
      sent = true;
      await updateBackendWorkForm(editor.formId, {
        name: captured.name.trim(), description: captured.description.trim() || null,
        fields: captured.builder.fields, expected_definition_version: editor.baseVersion
      });
      const cleared = await retireTemplateDraft({ ...captured, storeRevision: editor.storeRevision }, user);
      if (!current()) return;
      clearTemplateEdit();
      const refreshed = await refreshWorkForms();
      if (generation !== sessionGeneration) return;
      renderStatusBanner(!cleared ? 'Template saved, but its local draft could not be cleared. The recovery copy is read-only.'
        : refreshed ? 'Report Template updated.' : 'Report Template updated, but the updated list could not load.', !cleared || !refreshed);
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      if (!current()) return;
      if (error.code !== 'TEMPLATE_DRAFT_PUBLICATION_UNCERTAIN' && (!sent || (error.status >= 400 && error.status < 500))) {
        delete editor.publicationState;
        await flushTemplateDrafts().catch(() => {});
      } else {
        editTemplateReadOnly = true;
      }
      if (error.code === 'report_template_edit_version_conflict') editTemplateReadOnly = true;
      setTranslatableText(els.templateEditNotice, editTemplateReadOnly
        ? 'This draft was not applied safely. It is kept read-only; check the current Template before editing again.'
        : error.message || 'Could not save Report Template. Your editing draft is kept.');
    } finally {
      if (generation === sessionGeneration) {
        templateMutationInFlight = false;
        lockTemplateEditors(false);
        if (editTemplateReadOnly) els.templateEditForm.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = true; });
      }
    }
  }

  async function handleWorkFormEdit(form) {
    if (reportOnly) return openReportTemplateEditor(form);
    let editBuilder;
    showEditPanel(
      `Edit Report Template: ${form.name}`,
      [
        { id: 'editWorkFormName', label: 'Template name', value: form.name },
        { id: 'editWorkFormDescription', label: 'Description', value: form.description || '' },
        {
          id: 'editWorkFormFields',
          type: 'custom',
          html: workFormBuilderMarkup()
        }
      ],
      'Save Report Template',
      async () => {
        if (!editBuilder.validate({ focus: true })) return;
        const fields = editBuilder.getFields();
        const submitButton = els.editPanelForm.querySelector('button[type="submit"]');
        if (submitButton?.getAttribute('aria-busy') === 'true') return;
        setButtonBusy(submitButton, true, 'Saving Report Template...');

        try {
          await updateBackendWorkForm(form.id, {
            name: editValue('editWorkFormName'),
            description: editValue('editWorkFormDescription') || null,
            fields
          });
          closeEditPanel();
          renderStatusBanner('Report Template updated.');
          await refreshWorkForms();
          await refreshSupervisorAuditHistory?.();
        } catch (error) {
          renderStatusBanner(error.message || 'Could not update Report Template.', true);
        } finally {
          setButtonBusy(submitButton, false);
        }
      }
    );
    editBuilder = createWorkFormBuilder(
      els.editPanelForm.querySelector('[data-work-form-builder]'),
      { fields: form.fields || [], confirmAction }
    );
  }

  function renderWorkFormsList() {
    void renderTemplateDrafts();
    els.workFormsList.innerHTML = '';
    const forms = state.workForms.filter(matchesDepartmentFocus);
    els.workFormsCount.textContent = String(forms.length);

    if (!forms.length) {
      els.workFormsList.innerHTML = '<div class="empty-state">No Report Templates found yet.</div>';
      return;
    }

    forms.forEach((form) => {
      const node = document.createElement('article');
      node.className = 'record-card record-form';
      node.innerHTML = `
        <div class="record-header">
          <div>
            <h3 class="record-title">${escapeHtml(form.name)}</h3>
            <p class="record-meta">${escapeHtml(form.description || 'No description')}</p>
          </div>
          <span class="badge ${form.status === 'active' ? 'synced' : 'rejected'}">${escapeHtml(form.status)}</span>
        </div>
        <p class="record-detail">${escapeHtml((form.fields || []).filter((field) => !isHiddenDayworkHelperField(form, field)).map((field) => {
          if (field.type === 'section') return `Section: ${field.label}`;
          if (field.type === 'time_range') return `${field.label} (time range)`;
          if (isDayworkForm(form) && field.type === 'formula') return `${field.label} (calculated)`;
          if (field.type === 'formula') return `${field.label} = ${field.formula || 'formula'}`;
          if (field.type === 'repeat') return `${field.label} (repeat ${field.min_rows ?? 0}-${field.max_rows ?? 12})`;
          if (field.repeat) return `> ${field.label}`;
          return field.label;
        }).join(' | '))}</p>
        <div class="record-actions"></div>
        <div class="work-form-preview hidden" data-work-form-preview></div>
      `;

      const previewButton = document.createElement('button');
      previewButton.type = 'button';
      previewButton.className = 'ghost';
      previewButton.textContent = 'Preview';
      previewButton.addEventListener('click', () => {
        const preview = node.querySelector('[data-work-form-preview]');
        const isOpening = preview.classList.contains('hidden');

        if (isOpening) {
          renderWorkFormPreview(preview, form, `previewWorkForm_${form.id}`);
        }

        preview.classList.toggle('hidden', !isOpening);
        previewButton.textContent = isOpening ? 'Hide preview' : 'Preview';
      });

      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'ghost';
      editButton.textContent = 'Edit';
      editButton.addEventListener('click', async () => {
        await handleWorkFormEdit(form);
      });

      const statusButton = document.createElement('button');
      statusButton.type = 'button';
      statusButton.className = form.status === 'active' ? 'secondary' : '';
      statusButton.textContent = form.status === 'active' ? 'Archive' : 'Activate';
      statusButton.addEventListener('click', async () => {
        if (statusButton.getAttribute('aria-busy') === 'true') return;
        const nextStatus = form.status === 'active' ? 'archived' : 'active';
        setButtonBusy(statusButton, true, 'Updating...');
        try {
          await updateBackendWorkForm(form.id, { status: nextStatus });
          renderStatusBanner(nextStatus === 'active' ? 'Report Template activated.' : 'Report Template archived.');
          await refreshWorkForms();
          await refreshSupervisorAuditHistory?.();
        } catch (error) {
          renderStatusBanner(error.message || 'Could not update Report Template.', true);
        } finally {
          setButtonBusy(statusButton, false);
        }
      });

      node.querySelector('.record-actions').append(previewButton, editButton, statusButton);
      els.workFormsList.appendChild(node);
    });
  }

  async function handleSiteCreate(event) {
    event.preventDefault();

    const latitude = roundCoordinateInput(els.siteLatitudeInput);
    const longitude = roundCoordinateInput(els.siteLongitudeInput);
    const allowedRadius = Number(els.siteRadiusInput.value);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(allowedRadius)) {
      renderStatusBanner('Site latitude, longitude, and radius must be valid numbers.', true);
      return;
    }

    try {
      await createBackendSite({
        name: els.siteNameInput.value.trim(),
        address: els.siteAddressInput.value.trim() || null,
        latitude,
        longitude,
        allowed_radius_m: allowedRadius
      });
      els.siteForm.reset();
      els.siteRadiusInput.value = '100';
      siteMapPicker.reset();
      state.sites = await loadSites();
      fillSiteSelects();
      renderSupervisorSites();
      refreshSupervisorMap?.();
      siteMapPicker.refresh();
      renderStatusBanner('Site created and added to worker Report options.');
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not create site.', true);
    }
  }

  async function useCurrentLocationForSite() {
    if (!navigator.geolocation) {
      renderStatusBanner('This browser does not support location capture.', true);
      return;
    }

    els.siteUseLocationButton.disabled = true;
    renderStatusBanner('Capturing current location for the site...');

    try {
      const position = await currentPosition();
      siteMapPicker.setCoordinates(position.coords.latitude, position.coords.longitude);
      renderStatusBanner('Current location added to the site form.');
    } catch {
      renderStatusBanner('Location permission was denied or timed out. Enter the site coordinates manually.', true);
    } finally {
      els.siteUseLocationButton.disabled = false;
    }
  }

  async function handleUserStatusChange(user, status, triggerButton) {
    if (triggerButton?.getAttribute('aria-busy') === 'true') return;
    const resigning = status === 'resigned';
    if (!await confirmAction({
      title: resigning ? 'Mark worker resigned?' : 'Reactivate worker?',
      message: resigning
        ? 'This blocks the Worker from signing in. Their previous records stay attached to the account.'
        : 'This restores account access for the Worker. Their previous records stay attached to the account.',
      confirmLabel: resigning ? 'Mark resigned' : 'Reactivate worker',
      tone: resigning ? 'danger' : 'default'
    })) return;

    setButtonBusy(triggerButton, true, 'Updating...');
    try {
      await updateBackendUserStatus(user.id, status);
      renderStatusBanner(status === 'resigned' ? 'Worker marked resigned.' : 'Worker reactivated.');
      await renderStaffUsers();
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not update worker status.', true);
    } finally {
      setButtonBusy(triggerButton, false);
    }
  }

  async function handleStaffUserEdit(user) {
    const isGlobalAdmin = Boolean(user.is_global_admin || user.isGlobalAdmin);
    const isSelf = String(user.id) === String(state.user?.id);
    if (isGlobalAdmin && !state.user?.isGlobalAdmin) {
      renderStatusBanner('Only global admins can edit global admin accounts.', true);
      return;
    }

    const fields = [
      { id: 'editUserName', label: 'Name', value: user.name || '' },
      { id: 'editUserEmail', label: 'Email', type: 'email', value: user.email || '' },
      {
        id: 'editUserRole',
        label: 'Role',
        type: 'select',
        value: user.role || 'worker',
        options: [
          { value: 'worker', label: 'Worker' },
          { value: 'supervisor', label: 'Supervisor' }
        ]
      },
      {
        id: 'editUserWorkerClass',
        label: 'Worker class',
        type: 'select',
        value: user.worker_class || user.workerClass || 'normal',
        options: [
          { value: 'normal', label: 'Normal worker' },
          { value: 'leader', label: 'Leader' }
        ]
      },
      ...(state.user?.isGlobalAdmin ? [{
        id: 'editUserDepartmentId',
        label: 'Department',
        type: 'select',
        value: user.department_id || user.departmentId || '',
        options: departmentSelectOptions()
      }] : []),
      ...(state.user?.isGlobalAdmin ? [{
        id: 'editUserGlobalAdmin',
        label: 'Global admin (Supervisor only)',
        type: 'select',
        value: user.is_global_admin || user.isGlobalAdmin ? 'true' : 'false',
        options: [
          { value: 'false', label: 'No' },
          { value: 'true', label: 'Yes' }
        ]
      }] : []),
      {
        id: 'editUserStatus',
        label: 'Status',
        type: 'select',
        value: user.status || 'active',
        options: [
          { value: 'active', label: 'Active' },
          { value: 'resigned', label: 'Resigned' }
        ]
      },
      ...(!user.password_setup_required ? [{ id: 'editUserPassword', label: 'New password (optional)', type: 'password', value: '' }] : [])
    ];

    showEditPanel(
      `Edit user: ${user.name}`,
      fields,
      'Save user',
      async () => {
        if (!await confirmAction({
          title: 'Save account changes?',
          message: 'Email, password, role, Department, status, or Global Admin changes can affect sign-in and data access immediately.',
          confirmLabel: 'Save account changes'
        })) return;

        const newPassword = user.password_setup_required ? '' : editValue('editUserPassword');
        const payload = {
          name: editValue('editUserName'),
          email: editValue('editUserEmail'),
          role: editValue('editUserRole'),
          worker_class: editValue('editUserRole') === 'worker' ? editValue('editUserWorkerClass') : null,
          status: editValue('editUserStatus')
        };

        if (state.user?.isGlobalAdmin) {
          payload.department_id = editNumber('editUserDepartmentId');
          payload.is_global_admin = (
            payload.role === 'supervisor'
            && editValue('editUserGlobalAdmin') === 'true'
          );
        }
        if (newPassword) {
          payload.password = newPassword;
        }

        try {
          const updated = await updateBackendUser(user.id, payload);
          if (state.user?.id === updated.id) {
            state.user = {
              ...state.user,
              name: updated.name,
              fullName: updated.name,
              role: updated.role,
              workerClass: updated.worker_class || updated.workerClass || null,
              status: updated.status,
              departmentId: updated.department_id || updated.departmentId || null,
              departmentName: updated.department_name || updated.departmentName || '',
              isGlobalAdmin: Boolean(updated.is_global_admin || updated.isGlobalAdmin)
            };
          }
          closeEditPanel();
          renderStatusBanner('Staff user updated.');
          await renderStaffUsers();
          await refreshSupervisorAuditHistory?.();
        } catch (error) {
          renderStatusBanner(error.message || 'Could not update staff user.', true);
        }
      }
    );

    const editRoleSelect = document.getElementById('editUserRole');
    const editWorkerClassSelect = document.getElementById('editUserWorkerClass');
    const editGlobalAdminSelect = document.getElementById('editUserGlobalAdmin');
    const syncStaffEditRoleControls = () => {
      const isWorker = editRoleSelect.value === 'worker';
      editWorkerClassSelect.disabled = !isWorker;
      editRoleSelect.disabled = isSelf || user.password_setup_required === true;
      if (!editGlobalAdminSelect) return;
      if (isWorker) editGlobalAdminSelect.value = 'false';
      editGlobalAdminSelect.disabled = isSelf || isWorker;
    };
    editRoleSelect.addEventListener('change', syncStaffEditRoleControls);
    syncStaffEditRoleControls();
  }

  async function handleSiteEdit(site) {
    showEditPanel(
      `Edit site: ${site.name}`,
      [
        { id: 'editSiteName', label: 'Site name', value: site.name },
        { id: 'editSiteAddress', label: 'Address', value: site.address || '' },
        { id: 'editSiteLatitude', label: 'Latitude', type: 'number', step: '0.000001', min: -90, max: 90, value: site.latitude },
        { id: 'editSiteLongitude', label: 'Longitude', type: 'number', step: '0.000001', min: -180, max: 180, value: site.longitude },
        { id: 'editSiteRadius', label: 'Allowed radius metres', type: 'number', min: 10, max: 5000, value: site.allowed_radius_m || site.allowedRadiusM || 100 }
      ],
      'Save site',
      async () => {
        if (!await confirmAction({
          title: 'Save Site changes?',
          message: 'Coordinates and radius changes affect future inside/outside attendance results for this Site.',
          confirmLabel: 'Save Site changes'
        })) return;
        try {
          await updateBackendSite(site.id, {
            name: editValue('editSiteName'),
            address: editValue('editSiteAddress') || null,
            latitude: editNumber('editSiteLatitude'),
            longitude: editNumber('editSiteLongitude'),
            allowed_radius_m: editNumber('editSiteRadius')
          });
          closeEditPanel();
          state.sites = await loadSites();
          fillSiteSelects();
          renderSupervisorSites();
          refreshSupervisorMap?.();
          renderStatusBanner('Site updated.');
          await refreshSupervisorAuditHistory?.();
        } catch (error) {
          renderStatusBanner(error.message || 'Could not update site.', true);
        }
      }
    );
  }

  async function handleInvitationAction(user, action, button) {
    if (button.getAttribute('aria-busy') === 'true' || state.user?.role !== 'supervisor') return;
    const generation = sessionGeneration;
    const supervisorId = state.user.id;
    const isCurrent = () => generation === sessionGeneration && state.user?.role === 'supervisor'
      && String(state.user.id) === String(supervisorId);
    const reissue = action === 'reissue';
    if (!await confirmAction({
      title: reissue ? 'Replace setup link?' : 'Revoke setup link?',
      message: reissue
        ? 'The previous link will stop working. Share the new link privately with this Worker.'
        : 'This Worker cannot finish password setup with the old link. You can create a new link later.',
      confirmLabel: reissue ? 'Create new setup link' : 'Revoke setup link'
    }) || !isCurrent()) return;
    setButtonBusy(button, true);
    try {
      const result = reissue ? await reissueWorkerInvitation(user.id) : await revokeWorkerInvitation(user.id);
      if (!isCurrent()) return;
      if (reissue) invitationDialog.show(result, els.addStaffUserButton);
      else renderStatusBanner('Setup link revoked.');
      const refreshed = await renderStaffUsers({ preserveOnError: true, reportError: false });
      if (isCurrent() && !refreshed) {
        renderStatusBanner(reissue
          ? 'New setup link created; the previous link is invalid. The Staff list could not refresh, but you can still copy the new link.'
          : 'Setup link revoked, but the Staff list could not refresh. Refresh Staff before making another change.', true);
      }
    } catch (error) {
      if (isCurrent()) renderStatusBanner(error.message || 'Could not update the invitation. Refresh Staff and try again.', true);
    } finally {
      if (isCurrent() && button.isConnected) setButtonBusy(button, false);
    }
  }

  async function handleStaffUserCreate(event) {
    event.preventDefault();
    if (els.staffUserSubmitButton.getAttribute('aria-busy') === 'true') return;
    let created = false;
    let restoreFocus = false;
    const generation = sessionGeneration;
    const supervisorId = state.user?.id;
    const isCurrent = () => generation === sessionGeneration && state.user?.role === 'supervisor'
      && String(state.user.id) === String(supervisorId);
    if (!isCurrent()) return;
    setButtonBusy(els.staffUserSubmitButton, true, 'Creating staff account...');
    els.cancelStaffUserCreateButton.disabled = true;

    try {
      const role = els.staffRoleSelect.value;
      const usesInvitation = reportOnly && role === 'worker';
      const worker = {
        name: els.staffNameInput.value.trim(),
        email: els.staffEmailInput.value.trim(),
        worker_class: els.staffWorkerClassSelect.value,
        department_id: staffCreateDepartmentId()
      };
      const result = usesInvitation ? await createWorkerInvitation(worker) : await createBackendUser({
        ...worker,
        password: els.staffPasswordInput.value,
        role,
        worker_class: role === 'worker' ? els.staffWorkerClassSelect.value : 'normal',
        department_id: staffCreateDepartmentId(),
        is_global_admin: Boolean(
          state.user?.isGlobalAdmin
          && role === 'supervisor'
          && els.staffGlobalAdminInput.checked
        )
      });
      if (!isCurrent()) return;
      created = true;
      restoreFocus = shouldRestoreCreateFocus(els.staffUserCreatePanel);
      resetStaffUserCreate();
      setCreatePanelOpen(
        els.addStaffUserButton,
        els.staffUserCreatePanel,
        els.staffNameInput,
        false,
        { restoreFocus: false }
      );
      els.addStaffUserButton.disabled = true;
      if (usesInvitation) invitationDialog.show(result, els.addStaffUserButton);
      renderStatusBanner(usesInvitation ? 'Worker invitation created. Share the setup link privately.' : 'Staff user created.');
      const staffUsersRefreshed = await renderStaffUsers({
        preserveOnError: true,
        reportError: false
      });
      if (!staffUsersRefreshed) {
        throw new Error('Staff user created, but the updated list could not load.');
      }
      if (!isCurrent()) return;
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      if (!isCurrent()) return;
      renderStatusBanner(
        error.message || (created
          ? 'Staff user created, but the updated list could not load.'
          : 'Could not create staff user.'),
        true
      );
    } finally {
      if (isCurrent()) {
        setButtonBusy(els.staffUserSubmitButton, false);
        syncStaffCreateRoleControls();
        els.cancelStaffUserCreateButton.disabled = false;
        els.addStaffUserButton.disabled = !els.staffUserCreatePanel.hidden;
        if (
          created
          && restoreFocus
          && els.staffUserCreatePanel.hidden
          && shouldRestoreCreateFocus(els.staffUserCreatePanel)
        ) {
          window.requestAnimationFrame(() => els.addStaffUserButton.focus());
        }
      }
    }
  }

  function bindEvents() {
    renderStaffCreateControls();
    els.addStaffUserButton.addEventListener('click', openStaffUserCreate);
    els.cancelStaffUserCreateButton.addEventListener('click', cancelStaffUserCreate);
    els.staffUserForm.addEventListener('submit', handleStaffUserCreate);
    els.siteForm.addEventListener('submit', handleSiteCreate);
    els.siteUseLocationButton.addEventListener('click', useCurrentLocationForSite);
    siteMapPicker.bindEvents();
    els.siteLatitudeInput.addEventListener('blur', () => roundCoordinateInput(els.siteLatitudeInput));
    els.siteLongitudeInput.addEventListener('blur', () => roundCoordinateInput(els.siteLongitudeInput));
    els.addWorkFormButton.addEventListener('click', openWorkFormCreate);
    els.cancelWorkFormCreateButton.addEventListener('click', cancelWorkFormCreate);
    if (reportOnly) setTranslatableText(els.cancelWorkFormCreateButton, 'Close and keep draft');
    els.workFormBuilderForm.addEventListener('submit', handleWorkFormCreate);
    els.workFormPreviewButton?.addEventListener('click', handleDraftWorkFormPreviewToggle);
    els.workFormNameInput?.addEventListener('input', refreshOpenDraftWorkFormPreview);
    els.workFormDescriptionInput?.addEventListener('input', refreshOpenDraftWorkFormPreview);
    els.workFormNameInput.addEventListener('input', scheduleTemplateDraft);
    els.workFormDescriptionInput.addEventListener('input', scheduleTemplateDraft);
    els.templateEditForm.addEventListener('input', scheduleTemplateDraft);
    els.closeTemplateEditButton.addEventListener('click', closeTemplateEdit);
    window.addEventListener('beforeunload', (event) => {
      if (!reportOnly || (!templateMutationInFlight && !hasUnsavedTemplateInput())) return;
      event.preventDefault();
      event.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushTemplateDrafts().catch(() => {});
    });
    els.siteSearchInput.addEventListener('input', renderSupervisorSites);
    els.staffSearchInput.addEventListener('input', renderFilteredStaffUsers);
    els.staffRoleSelect.addEventListener('change', syncStaffCreateRoleControls);
  }

  return {
    bindEvents,
    flushTemplateDrafts,
    prepareForNavigation,
    cancelNavigationPreparation: () => lockTemplateEditors(false),
    renderTemplateDrafts,
    refreshSiteMapIfVisible,
    resetSession,
    renderFilteredStaffUsers,
    renderStaffUsers,
    renderSupervisorSites,
    renderWorkFormsList,
    siteSelectOptions
  };
}
