import { createWorkerSite as createBackendWorkerSite } from './api-client.js';

function currentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    });
  });
}

export function createWorkerSitesModule({
  els,
  state,
  loadSites,
  fillSiteSelects,
  renderStatusBanner,
  handleSessionExpired,
  isBackendSessionError
}) {
  function setSubmitting(isSubmitting) {
    state.submittingWorkerSite = isSubmitting;
    els.workerSiteSubmitButton.disabled = isSubmitting;
    els.workerSiteUseLocationButton.disabled = isSubmitting;
  }

  async function useCurrentLocation() {
    if (!navigator.geolocation) {
      renderStatusBanner('This browser does not support location capture.', true);
      return;
    }

    els.workerSiteUseLocationButton.disabled = true;
    renderStatusBanner('Capturing current location for the new site...');

    try {
      const position = await currentPosition();
      els.workerSiteLatitudeInput.value = position.coords.latitude.toFixed(6);
      els.workerSiteLongitudeInput.value = position.coords.longitude.toFixed(6);
      renderStatusBanner('Current location added to the site form.');
    } catch {
      renderStatusBanner('Location permission was denied or timed out. Enter the site coordinates manually.', true);
    } finally {
      els.workerSiteUseLocationButton.disabled = state.submittingWorkerSite;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.user || state.submittingWorkerSite) return;

    const latitude = Number(els.workerSiteLatitudeInput.value);
    const longitude = Number(els.workerSiteLongitudeInput.value);
    const allowedRadius = Number(els.workerSiteRadiusInput.value);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(allowedRadius)) {
      renderStatusBanner('Site latitude, longitude, and radius must be valid numbers.', true);
      return;
    }

    setSubmitting(true);
    try {
      const createdSite = await createBackendWorkerSite({
        name: els.workerSiteNameInput.value.trim(),
        address: els.workerSiteAddressInput.value.trim() || null,
        latitude,
        longitude,
        allowed_radius_m: allowedRadius
      });

      els.workerSiteForm.reset();
      els.workerSiteRadiusInput.value = '100';
      state.sites = await loadSites();
      fillSiteSelects();

      if (createdSite?.id) {
        els.attendanceSite.value = String(createdSite.id);
        els.taskSite.value = String(createdSite.id);
        els.workFormSite.value = String(createdSite.id);
      }

      renderStatusBanner('Site added. You can select it now.');
    } catch (error) {
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      renderStatusBanner(error.message || 'Could not add site.', true);
    } finally {
      setSubmitting(false);
    }
  }

  function bindEvents() {
    els.workerSiteForm.addEventListener('submit', handleSubmit);
    els.workerSiteUseLocationButton.addEventListener('click', useCurrentLocation);
  }

  return {
    bindEvents
  };
}
