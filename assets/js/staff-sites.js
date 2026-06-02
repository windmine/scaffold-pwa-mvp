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
import { parseWorkFormFieldsInput, serialiseWorkFormFields } from './work-form-fields.js';
import { escapeHtml } from './utils.js';

export function createStaffSitesModule({
  els,
  state,
  loadSites,
  fillSiteSelects,
  refreshWorkForms,
  refreshSupervisorAuditHistory,
  renderStatusBanner,
  showEditPanel,
  closeEditPanel,
  editValue,
  editNumber
}) {
  function siteSelectOptions() {
    return [
      { value: '', label: 'No site' },
      ...state.sites.map((site) => ({
        value: site.id,
        label: `${site.name} (#${site.id})`
      }))
    ];
  }

  function renderSupervisorSites() {
    els.supervisorSitesList.innerHTML = '';
    const query = els.siteSearchInput.value.trim().toLowerCase();
    const sites = state.sites.filter((site) => {
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
    els.supervisorSitesCount.textContent = query ? `${sites.length}/${state.sites.length}` : String(state.sites.length);

    if (!sites.length) {
      els.supervisorSitesList.innerHTML = '<div class="empty-state">No sites found yet.</div>';
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
    const users = state.staffUsers.filter((user) => {
      const text = [
        user.id,
        user.name,
        user.email,
        user.role,
        user.status || 'active'
      ].join(' ').toLowerCase();
      return !query || text.includes(query);
    });
    els.staffUsersList.innerHTML = '';
    els.staffUsersCount.textContent = query ? `${users.length}/${state.staffUsers.length}` : String(state.staffUsers.length);

    if (!users.length) {
      els.staffUsersList.innerHTML = '<div class="empty-state">No users found yet.</div>';
      return;
    }

    users.forEach((user) => {
      const node = document.createElement('article');
      node.className = 'record-card';
      const status = user.status || 'active';
      node.innerHTML = `
        <div class="record-header">
          <div>
            <h3 class="record-title">${escapeHtml(user.name)}</h3>
            <p class="record-meta">ID ${escapeHtml(user.id)} | ${escapeHtml(user.email)}</p>
          </div>
          <span class="badge ${status === 'active' ? 'synced' : 'rejected'}">${escapeHtml(status === 'active' ? user.role : 'resigned worker')}</span>
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

      const statusButton = document.createElement('button');
      statusButton.type = 'button';
      statusButton.className = status === 'active' ? 'secondary' : '';
      statusButton.textContent = status === 'active' ? 'Mark resigned' : 'Reactivate';
      statusButton.addEventListener('click', async () => {
        await handleUserStatusChange(user, status === 'active' ? 'resigned' : 'active');
      });
      actions.append(editButton, statusButton);
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
      renderStatusBanner('Work form created.');
      await refreshWorkForms();
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not create work form.', true);
    }
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
          rows: 7,
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
    els.workFormsCount.textContent = String(state.workForms.length);

    if (!state.workForms.length) {
      els.workFormsList.innerHTML = '<div class="empty-state">No forms found yet.</div>';
      return;
    }

    state.workForms.forEach((form) => {
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
        <p class="record-detail">${escapeHtml((form.fields || []).map((field) => field.label).join(' | '))}</p>
        <div class="record-actions"></div>
      `;

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

      node.querySelector('.record-actions').append(editButton, statusButton);
      els.workFormsList.appendChild(node);
    });
  }

  async function handleSiteCreate(event) {
    event.preventDefault();

    const latitude = Number(els.siteLatitudeInput.value);
    const longitude = Number(els.siteLongitudeInput.value);
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
      state.sites = await loadSites();
      fillSiteSelects();
      renderSupervisorSites();
      renderStatusBanner('Site created and added to worker forms.');
      await refreshSupervisorAuditHistory?.();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not create site.', true);
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
    showEditPanel(
      `Edit user: ${user.name}`,
      [
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
          id: 'editUserStatus',
          label: 'Status',
          type: 'select',
          value: user.status || 'active',
          options: [
            { value: 'active', label: 'Active' },
            { value: 'resigned', label: 'Resigned' }
          ]
        },
        { id: 'editUserPassword', label: 'New password (optional)', type: 'password', value: '' }
      ],
      'Save user',
      async () => {
        if (!window.confirm(`Double check: save changes to user "${user.email}"?`)) return;

        const newPassword = editValue('editUserPassword');
        const payload = {
          name: editValue('editUserName'),
          email: editValue('editUserEmail'),
          role: editValue('editUserRole'),
          status: editValue('editUserStatus')
        };

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
              status: updated.status
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
        role: els.staffRoleSelect.value
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
    els.workFormBuilderForm.addEventListener('submit', handleWorkFormCreate);
    els.siteSearchInput.addEventListener('input', renderSupervisorSites);
    els.staffSearchInput.addEventListener('input', renderFilteredStaffUsers);
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
