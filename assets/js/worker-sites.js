import { createWorkerSite as createBackendWorkerSite } from './api-client.js';
import { createSiteMapPicker, currentPosition } from './site-map-picker.js';
import { roundCoordinate } from './utils.js';

export function createWorkerSitesModule({
  els,
  state,
  loadSites,
  fillSiteSelects,
  renderStatusBanner,
  handleSessionExpired,
  isBackendSessionError
}) {
  function roundCoordinateInput(input) {
    if (input.value.trim() === '') return NaN;
    const rounded = roundCoordinate(input.value);
    if (Number.isFinite(rounded)) {
      input.value = rounded.toFixed(6);
    }
    return rounded;
  }

  const siteMapPicker = createSiteMapPicker({
    mapElement: els.workerSiteMap,
    latitudeInput: els.workerSiteLatitudeInput,
    longitudeInput: els.workerSiteLongitudeInput,
    radiusInput: els.workerSiteRadiusInput,
    statusElement: els.workerSiteMapStatus,
    getExistingSites: () => state.sites
  });

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
      siteMapPicker.setCoordinates(position.coords.latitude, position.coords.longitude);
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

    const latitude = roundCoordinateInput(els.workerSiteLatitudeInput);
    const longitude = roundCoordinateInput(els.workerSiteLongitudeInput);
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
      siteMapPicker.reset();
      state.sites = await loadSites();
      fillSiteSelects();
      siteMapPicker.refresh();

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
    siteMapPicker.bindEvents();
    els.workerSiteLatitudeInput.addEventListener('blur', () => roundCoordinateInput(els.workerSiteLatitudeInput));
    els.workerSiteLongitudeInput.addEventListener('blur', () => roundCoordinateInput(els.workerSiteLongitudeInput));
  }

  return {
    bindEvents
  };
}
