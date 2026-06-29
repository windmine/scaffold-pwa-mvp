import {
  createSite as createBackendSite,
  createUser as createBackendUser,
  createWorkForm as createBackendWorkForm,
  getUsers as getBackendUsers,
  updateSite as updateBackendSite,
  updateUser as updateBackendUser,
  updateUserStatus as updateBackendUserStatus,
  updateWorkForm as updateBackendWorkForm
} from './api-client.js';
import { createSiteMapPicker, currentPosition } from './site-map-picker.js';
import { parseWorkFormFieldsInput, renderWorkFormFields, serialiseWorkFormFields } from './work-form-fields.js';
import { escapeHtml, roundCoordinate } from './utils.js';

export function createStaffSitesModule({
  els,
  state,
  loadSites,
  fillSiteSelects,
  refreshWorkForms,
  refreshSupervisorAuditHistory,
  refreshSupervisorMap,
  renderStatusBanner,
  showEditPanel,
  closeEditPanel,
  editValue,
  editNumber
}) {
  function roundCoordinateInput(input) {
    if (input.value.trim() === '') return NaN;
    const rounded = roundCoordinate(input.value);
    if (Number.isFinite(rounded)) {
      input.value = rounded.toFixed(6);
    }
    return rounded;
  }

  function departmentSelectOptions() {
    return (state.departments || [])
      .map((department) => ({
        value: department.id,
        label: department.name
      }));
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
    if (els.siteMap?.closest('details')?.open) siteMapPicker.refresh();
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

  async function renderStaffUsers() {
    try {
      state.staffUsers = await getBackendUsers();
      renderFilteredStaffUsers();
    } catch (error) {
      els.staffUsersCount.textContent = '-';
      els.staffUsersList.innerHTML = '<div class="empty-state">Staff users are unavailable.</div>';
      renderStatusBanner(error.message || 'Could not load staff users.', true);
    }
  }

  function renderFilteredStaffUsers() {
    const query = els.staffSearchInput.value.trim().toLowerCase();
    const departmentUsers = state.staffUsers.filter(matchesDepartmentFocus);
    const users = departmentUsers.filter((user) => {
      const text = [
        user.id,
        user.name,
        user.email,
        user.role,
        user.worker_class || user.workerClass,
        user.status || 'active',
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
      const statusIsProtected = isGlobalAdmin && !state.user?.isGlobalAdmin;
      node.innerHTML = `
        <div class="record-header">
          <div>
            <h3 class="record-title">${escapeHtml(user.name)}</h3>
            <p class="record-meta">ID ${escapeHtml(user.id)} | ${escapeHtml(user.email)} | ${escapeHtml(user.department_name || user.departmentName || 'No department')}</p>
          </div>
          <span class="badge ${status === 'active' ? 'synced' : 'rejected'}">${escapeHtml(status === 'active' ? `${user.role === 'worker' ? workerClass : user.role}${isGlobalAdmin ? ' global' : ''}` : 'resigned worker')}</span>
        </div>
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
      if (!statusIsProtected) {
        const statusButton = document.createElement('button');
        statusButton.type = 'button';
        statusButton.className = status === 'active' ? 'secondary' : '';
        statusButton.textContent = status === 'active' ? 'Mark resigned' : 'Reactivate';
        statusButton.addEventListener('click', async () => {
          await handleUserStatusChange(user, status === 'active' ? 'resigned' : 'active');
        });
        actions.append(statusButton);
      }
      els.staffUsersList.appendChild(node);
    });
  }

  async function handleWorkFormCreate(event) {
    event.preventDefault();

    const fields = parseWorkFormFieldsInput(els.workFormFieldsInput.value);
    if (!fields.length) {
      renderStatusBanner('Add at least one form field.', true);
      return;
    }

    try {
      await createBackendWorkForm({
        name: els.workFormNameInput.value.trim(),
        description: els.workFormDescriptionInput.value.trim() || null,
        fields
      });
      els.workFormBuilderForm.reset();
      hideDraftWorkFormPreview();
      renderStatusBanner('Work form created.');
      await refreshWorkForms();
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not create work form.', true);
    }
  }

  function draftWorkForm() {
    return {
      id: 'draft',
      name: els.workFormNameInput.value.trim() || 'Untitled work form',
      description: els.workFormDescriptionInput.value.trim() || '',
      status: 'draft',
      fields: parseWorkFormFieldsInput(els.workFormFieldsInput.value)
    };
  }

  function renderWorkFormPreview(preview, form, idPrefix, emptyMessage = 'Add fields to preview this form.') {
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
          Work date
          <input type="date" disabled />
        </label>
        <div class="dynamic-fields" data-work-form-preview-fields></div>
        <label>
          Photos
          <input type="file" accept="image/*" multiple disabled />
        </label>
        <button type="button" disabled>Submit form</button>
      </div>
    `;

    renderWorkFormFields(preview.querySelector('[data-work-form-preview-fields]'), form, {
      idPrefix,
      container: preview
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
      showDraftWorkFormPreview();
      return;
    }
    hideDraftWorkFormPreview();
  }

  function refreshOpenDraftWorkFormPreview() {
    if (!els.workFormDraftPreview || els.workFormDraftPreview.classList.contains('hidden')) return;
    renderDraftWorkFormPreview();
  }

  async function handleWorkFormEdit(form) {
    showEditPanel(
      `Edit work form: ${form.name}`,
      [
        { id: 'editWorkFormName', label: 'Form name', value: form.name },
        { id: 'editWorkFormDescription', label: 'Description', value: form.description || '' },
        {
          id: 'editWorkFormFields',
          label: 'Fields',
          type: 'textarea',
          rows: 9,
          value: serialiseWorkFormFields(form.fields || [])
        }
      ],
      'Save form',
      async () => {
        if (!window.confirm(`Double check: save changes to form "${form.name}"?`)) return;
        const fields = parseWorkFormFieldsInput(editValue('editWorkFormFields'));
        if (!fields.length) {
          renderStatusBanner('Add at least one form field.', true);
          return;
        }

        try {
          await updateBackendWorkForm(form.id, {
            name: editValue('editWorkFormName'),
            description: editValue('editWorkFormDescription') || null,
            fields
          });
          closeEditPanel();
          renderStatusBanner('Work form updated.');
          await refreshWorkForms();
          await refreshSupervisorAuditHistory?.();
        } catch (error) {
          renderStatusBanner(error.message || 'Could not update work form.', true);
        }
      }
    );
  }

  function renderWorkFormsList() {
    els.workFormsList.innerHTML = '';
    const forms = state.workForms.filter(matchesDepartmentFocus);
    els.workFormsCount.textContent = String(forms.length);

    if (!forms.length) {
      els.workFormsList.innerHTML = '<div class="empty-state">No forms found yet.</div>';
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
        <p class="record-detail">${escapeHtml((form.fields || []).map((field) => {
          if (field.type === 'section') return `Section: ${field.label}`;
          if (field.type === 'time_range') return `${field.label} (time range)`;
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
        const nextStatus = form.status === 'active' ? 'archived' : 'active';
        if (!window.confirm(`Double check: ${nextStatus === 'archived' ? 'archive' : 'activate'} "${form.name}"?`)) return;
        try {
          await updateBackendWorkForm(form.id, { status: nextStatus });
          renderStatusBanner(nextStatus === 'active' ? 'Work form activated.' : 'Work form archived.');
          await refreshWorkForms();
          await refreshSupervisorAuditHistory?.();
        } catch (error) {
          renderStatusBanner(error.message || 'Could not update work form.', true);
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
      renderStatusBanner('Site created and added to worker forms.');
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

  async function handleUserStatusChange(user, status) {
    const label = status === 'resigned' ? 'mark this worker resigned' : 'reactivate this worker';
    if (!window.confirm(`Double check: ${label}? Their previous records will stay attached to this account.`)) return;

    try {
      await updateBackendUserStatus(user.id, status);
      renderStatusBanner(status === 'resigned' ? 'Worker marked resigned.' : 'Worker reactivated.');
      await renderStaffUsers();
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not update worker status.', true);
    }
  }

  async function handleStaffUserEdit(user) {
    const statusIsProtected = Boolean(
      (user.is_global_admin || user.isGlobalAdmin) && !state.user?.isGlobalAdmin
    );
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
      {
        id: 'editUserDepartmentId',
        label: 'Department',
        type: 'select',
        value: user.department_id || user.departmentId || '',
        options: departmentSelectOptions()
      },
      {
        id: 'editUserGlobalAdmin',
        label: 'Global admin',
        type: 'select',
        value: user.is_global_admin || user.isGlobalAdmin ? 'true' : 'false',
        options: [
          { value: 'false', label: 'No' },
          { value: 'true', label: 'Yes' }
        ]
      },
      ...(!statusIsProtected ? [{
        id: 'editUserStatus',
        label: 'Status',
        type: 'select',
        value: user.status || 'active',
        options: [
          { value: 'active', label: 'Active' },
          { value: 'resigned', label: 'Resigned' }
        ]
      }] : []),
      { id: 'editUserPassword', label: 'New password (optional)', type: 'password', value: '' }
    ];

    showEditPanel(
      `Edit user: ${user.name}`,
      fields,
      'Save user',
      async () => {
        if (!window.confirm(`Double check: save changes to user "${user.email}"?`)) return;

        const newPassword = editValue('editUserPassword');
        const payload = {
          name: editValue('editUserName'),
          email: editValue('editUserEmail'),
          role: editValue('editUserRole'),
          worker_class: editValue('editUserRole') === 'worker' ? editValue('editUserWorkerClass') : null,
          department_id: editNumber('editUserDepartmentId'),
          is_global_admin: editValue('editUserGlobalAdmin') === 'true'
        };

        if (!statusIsProtected) {
          payload.status = editValue('editUserStatus');
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
        if (!window.confirm(`Double check: save changes to site "${site.name}"?`)) return;
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

  async function handleStaffUserCreate(event) {
    event.preventDefault();
    try {
      await createBackendUser({
        name: els.staffNameInput.value.trim(),
        email: els.staffEmailInput.value.trim(),
        password: els.staffPasswordInput.value,
        role: els.staffRoleSelect.value,
        worker_class: els.staffRoleSelect.value === 'worker' ? els.staffWorkerClassSelect.value : 'normal',
        department_id: Number(els.staffDepartmentSelect.value),
        is_global_admin: els.staffGlobalAdminInput.checked
      });
      els.staffUserForm.reset();
      renderStatusBanner('Staff user created.');
      await renderStaffUsers();
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not create staff user.', true);
    }
  }

  function bindEvents() {
    els.staffUserForm.addEventListener('submit', handleStaffUserCreate);
    els.siteForm.addEventListener('submit', handleSiteCreate);
    els.siteUseLocationButton.addEventListener('click', useCurrentLocationForSite);
    siteMapPicker.bindEvents();
    els.siteLatitudeInput.addEventListener('blur', () => roundCoordinateInput(els.siteLatitudeInput));
    els.siteLongitudeInput.addEventListener('blur', () => roundCoordinateInput(els.siteLongitudeInput));
    els.workFormBuilderForm.addEventListener('submit', handleWorkFormCreate);
    els.workFormPreviewButton?.addEventListener('click', handleDraftWorkFormPreviewToggle);
    els.workFormNameInput?.addEventListener('input', refreshOpenDraftWorkFormPreview);
    els.workFormDescriptionInput?.addEventListener('input', refreshOpenDraftWorkFormPreview);
    els.workFormFieldsInput?.addEventListener('input', refreshOpenDraftWorkFormPreview);
    els.siteSearchInput.addEventListener('input', renderSupervisorSites);
    els.staffSearchInput.addEventListener('input', renderFilteredStaffUsers);
    els.staffRoleSelect.addEventListener('change', () => {
      els.staffWorkerClassSelect.disabled = els.staffRoleSelect.value !== 'worker';
    });
  }

  return {
    bindEvents,
    renderFilteredStaffUsers,
    renderStaffUsers,
    renderSupervisorSites,
    renderWorkFormsList,
    siteSelectOptions
  };
}
