import { saveDraft } from './mock-api.js';
import { submitOfflineSubmission } from './offline-submissions.js';
import { fileToDataUrl, formatDateTime, uuid, escapeHtml } from './utils.js';

function distanceBetweenCoordinatesM(startLatitude, startLongitude, endLatitude, endLongitude) {
  const earthRadiusM = 6371000;
  const startLat = startLatitude * Math.PI / 180;
  const endLat = endLatitude * Math.PI / 180;
  const deltaLat = (endLatitude - startLatitude) * Math.PI / 180;
  const deltaLon = (endLongitude - startLongitude) * Math.PI / 180;
  const a = (
    Math.sin(deltaLat / 2) ** 2
    + Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLon / 2) ** 2
  );
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusM * c;
}

function getSiteDistanceCheck(site, location) {
  if (!site || !location || site.latitude == null || site.longitude == null) {
    return {
      distanceFromSiteM: null,
      withinSiteRadius: null
    };
  }

  const allowedRadius = Number(site.allowed_radius_m || site.allowedRadiusM || 100);
  const distanceFromSiteM = Math.round(
    distanceBetweenCoordinatesM(
      Number(site.latitude),
      Number(site.longitude),
      Number(location.latitude),
      Number(location.longitude)
    )
  );

  return {
    distanceFromSiteM,
    withinSiteRadius: distanceFromSiteM <= allowedRadius
  };
}

export function createWorkerAttendanceModule({
  els,
  state,
  photoViewer,
  findSiteByFormValue,
  renderStatusBanner,
  syncQueueIfPossible,
  renderWorkerSummary,
  renderHistory,
  handleSessionExpired,
  isBackendSessionError
}) {
  function updateActionState() {
    const hasSite = Boolean(els.attendanceSite.value);
    const hasLocation = Boolean(state.attendanceLocation);
    const ready = hasSite && hasLocation;
    const usesGuidedFlow = state.user?.role === 'worker' && state.user?.workerClass !== 'leader';

    const progressState = {
      site: { complete: hasSite, current: !hasSite },
      location: { complete: hasLocation, current: hasSite && !hasLocation },
      action: { complete: false, current: ready }
    };
    document.querySelectorAll('[data-attendance-step]').forEach((step) => {
      const stepState = progressState[step.dataset.attendanceStep] || {};
      step.classList.toggle('is-complete', Boolean(stepState.complete));
      step.classList.toggle('is-current', Boolean(stepState.current));
      if (stepState.current) {
        step.setAttribute('aria-current', 'step');
      } else {
        step.removeAttribute('aria-current');
      }
    });

    els.captureLocationButton.disabled = state.submittingAttendance || (usesGuidedFlow && !hasSite);
    els.checkInButton.disabled = state.submittingAttendance || (usesGuidedFlow && !ready);
    els.checkOutButton.disabled = state.submittingAttendance || (usesGuidedFlow && !ready);
    els.saveAttendanceDraftButton.disabled = state.submittingAttendance;

    if (els.attendanceActionHelp) {
      els.attendanceActionHelp.textContent = !hasSite
        ? 'Choose your site first.'
        : !hasLocation
          ? 'Now confirm your location.'
          : 'Ready. Tap the action you need.';
    }
  }

  function renderLocationPreview() {
    if (!state.attendanceLocation) {
      const hasSite = Boolean(els.attendanceSite.value);
      els.locationPreview.classList.add('is-empty');
      els.locationPreview.classList.remove('is-ready', 'is-outside');
      els.locationPreview.innerHTML = `
        <div class="location-preview-heading">
          <span class="location-preview-symbol" aria-hidden="true">${hasSite ? '2' : '1'}</span>
          <div>
            <strong>${hasSite ? 'Site selected' : 'Choose a site first'}</strong>
            <small>${hasSite ? 'Tap Step 2 to confirm your current location.' : 'Your location can be confirmed after Step 1.'}</small>
          </div>
        </div>
      `;
      updateActionState();
      return;
    }

    const loc = state.attendanceLocation;
    const site = findSiteByFormValue(els.attendanceSite.value);
    const siteCheck = getSiteDistanceCheck(site, loc);
    const allowedRadius = site ? Number(site.allowed_radius_m || site.allowedRadiusM || 100) : null;
    const radiusMessage = site && siteCheck.distanceFromSiteM != null
      ? `
        <div class="location-preview-status ${siteCheck.withinSiteRadius ? 'site-inside' : 'site-outside'}">
          <span>Site check</span>
          <strong>${siteCheck.withinSiteRadius ? 'Inside site area' : 'Outside site area'}</strong>
          <small>${siteCheck.distanceFromSiteM}m from ${escapeHtml(site.name)} &middot; ${allowedRadius}m allowed</small>
        </div>
      `
      : `
        <div class="location-preview-status">
          <span>Site check</span>
          <strong>Select a site to check distance</strong>
        </div>
      `;

    els.locationPreview.classList.remove('is-empty');
    els.locationPreview.classList.add('is-ready');
    els.locationPreview.classList.toggle('is-outside', siteCheck.withinSiteRadius === false);

    els.locationPreview.innerHTML = `
      <div class="location-preview-heading">
        <span class="location-preview-symbol" aria-hidden="true">&#10003;</span>
        <div>
          <strong>Captured location</strong>
          <small>Confirmed ${formatDateTime(loc.capturedAt)} &middot; accuracy about ${loc.accuracy}m</small>
        </div>
      </div>
      ${radiusMessage}
      <details class="location-technical-details">
        <summary>Location details</summary>
        <span>Latitude ${loc.latitude} &middot; Longitude ${loc.longitude}</span>
      </details>
    `;
    updateActionState();
  }

  async function persistDraft() {
    await saveDraft('attendance-form', {
      siteId: els.attendanceSite.value,
      notes: els.attendanceNotes.value,
      location: state.attendanceLocation,
      photoDataUrl: state.attendancePhotoDataUrl
    });
    renderStatusBanner('Attendance draft saved on this device.');
  }

  async function handleCaptureLocation() {
    if (!navigator.geolocation) {
      renderStatusBanner('Geolocation is not available in this browser.', false);
      return;
    }

    renderStatusBanner('Capturing current location...');
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        state.attendanceLocation = {
          latitude: Number(position.coords.latitude.toFixed(6)),
          longitude: Number(position.coords.longitude.toFixed(6)),
          accuracy: Math.round(position.coords.accuracy),
          capturedAt: new Date(position.timestamp).toISOString()
        };
        renderLocationPreview();
        await persistDraft();
        renderStatusBanner(`Location captured successfully with approximately ${state.attendanceLocation.accuracy}m accuracy.`);
      },
      (error) => {
        renderStatusBanner(`Could not get location: ${error.message}`, false);
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0
      }
    );
  }

  function setSubmitting(isSubmitting) {
    state.submittingAttendance = isSubmitting;
    updateActionState();
  }

  async function handlePhotoChange(event) {
    const file = event.target.files?.[0];
    state.attendancePhotoFile = file || null;
    state.attendancePhotoDataUrl = file ? await fileToDataUrl(file) : '';
    photoViewer.renderPreview(els.attendancePhotoPreview, state.attendancePhotoDataUrl, 'Attendance photo');
    await persistDraft();
  }

  function resetForm() {
    els.attendanceSite.value = '';
    els.attendanceNotes.value = '';
    els.attendancePhoto.value = '';
    state.attendancePhotoDataUrl = '';
    state.attendancePhotoFile = null;
    state.attendanceLocation = null;
    renderLocationPreview();
    photoViewer.renderPreview(els.attendancePhotoPreview, '', '');
  }

  async function submit(action) {
    if (!state.user) return;
    if (!els.attendanceSite.value) {
      renderStatusBanner('Please select a site first.');
      return;
    }
    if (!state.attendanceLocation) {
      renderStatusBanner('Please capture your location before submitting attendance.');
      return;
    }

    const site = findSiteByFormValue(els.attendanceSite.value);
    if (!site) {
      renderStatusBanner('Please select a valid site first.');
      return;
    }

    if (state.submittingAttendance) return;
    setSubmitting(true);

    try {
      const localRecord = {
        id: uuid(),
        type: 'attendance',
        userId: state.user.id,
        userName: state.user.fullName,
        siteId: site.id,
        siteName: site.name,
        action,
        notes: els.attendanceNotes.value.trim(),
        photoDataUrl: state.attendancePhotoDataUrl,
        location: state.attendanceLocation,
        createdAt: new Date().toISOString()
      };
      Object.assign(localRecord, getSiteDistanceCheck(site, localRecord.location));

      const result = await submitOfflineSubmission(localRecord, {
        draftKey: 'attendance-form',
        photoFiles: state.attendancePhotoFile ? [state.attendancePhotoFile] : []
      });

      resetForm();
      await syncQueueIfPossible(!result.offline);
      renderStatusBanner(result.message, result.offline);
      await renderWorkerSummary();
      await renderHistory();
    } catch (error) {
      if (isBackendSessionError(error)) {
        handleSessionExpired();
        return;
      }
      renderStatusBanner(error.message || 'Could not submit attendance.', true);
    } finally {
      setSubmitting(false);
    }
  }

  function restoreDraft(attendanceDraft) {
    if (!attendanceDraft) return;

    els.attendanceSite.value = attendanceDraft.siteId || '';
    els.attendanceNotes.value = attendanceDraft.notes || '';
    state.attendanceLocation = attendanceDraft.location || null;
    state.attendancePhotoDataUrl = attendanceDraft.photoDataUrl || '';
    els.attendanceDetails.open = Boolean(attendanceDraft.notes || attendanceDraft.photoDataUrl);
    renderLocationPreview();
    photoViewer.renderPreview(els.attendancePhotoPreview, state.attendancePhotoDataUrl, 'Attendance draft photo');
  }

  function bindEvents() {
    els.captureLocationButton.addEventListener('click', handleCaptureLocation);
    els.attendanceSite.addEventListener('change', renderLocationPreview);
    els.saveAttendanceDraftButton.addEventListener('click', persistDraft);
    els.checkInButton.addEventListener('click', () => submit('check_in'));
    els.checkOutButton.addEventListener('click', () => submit('check_out'));
    els.attendancePhoto.addEventListener('change', handlePhotoChange);
    renderLocationPreview();
  }

  return {
    bindEvents,
    renderLocationPreview,
    restoreDraft,
    submit
  };
}
