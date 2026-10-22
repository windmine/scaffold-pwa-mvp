import { escapeHtml } from './utils.js';

export function photoFieldLabel(field, fields) {
  const index = fields.findIndex((item) => item.id === field.id);
  const section = fields.slice(0, index).findLast((item) => item.type === 'section' && !item.repeat);
  return section ? `${section.label}: ${field.label}` : field.label;
}

export function locationText(value) {
  if (!value || typeof value !== 'object') return '';
  return `${value.latitude}, ${value.longitude} (accuracy ${value.accuracy} m; captured ${value.captured_at})`;
}

export function locationMapUrl(value) {
  if (!value || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) return '';
  return `https://www.openstreetmap.org/?mlat=${value.latitude}&mlon=${value.longitude}#map=18/${value.latitude}/${value.longitude}`;
}

export function evidenceFieldMarkup(field, inputId, attrs) {
  const label = `${field.label}${field.required ? ' *' : ''}`;
  if (field.type === 'photos') {
    return `<fieldset ${attrs}><legend>${escapeHtml(label)}</legend>
      <label>Add photos<input id="${escapeHtml(inputId)}" type="file" multiple accept="image/jpeg,image/png,image/webp" data-field-photos="${escapeHtml(field.id)}"></label>
      <p data-field-photo-count="${escapeHtml(field.id)}" role="status">0 photos attached here.</p>
      <p class="muted">Photos share the Report's 50-photo limit. Review or remove them in Photos below.</p></fieldset>`;
  }
  if (field.type === 'location') {
    return `<fieldset ${attrs} data-location-field><legend>${escapeHtml(label)}</legend>
      <input id="${escapeHtml(inputId)}" type="hidden" data-location-value>
      <p data-location-status role="status">No location captured.</p>
      <button type="button" data-location-capture>Capture location</button>
      <button type="button" class="ghost" data-location-clear>Clear location</button>
      <a data-location-map hidden target="_blank" rel="noopener noreferrer">View captured location on map</a>
      <p class="muted">Capture asks for device location permission. Map viewing needs internet.</p></fieldset>`;
  }
  return '';
}

export function showLocation(input, value) {
  const wrapper = input?.closest('[data-location-field]');
  if (!wrapper) return;
  input.value = value ? JSON.stringify(value) : '';
  wrapper.querySelector('[data-location-status]').textContent = locationText(value) || 'No location captured.';
  const link = wrapper.querySelector('[data-location-map]');
  link.hidden = !value;
  if (value) link.href = locationMapUrl(value);
  else link.removeAttribute('href');
}

export function refreshPhotoFieldCounts(container, metadata = []) {
  container?.querySelectorAll('[data-field-photo-count]').forEach((element) => {
    const count = metadata.filter((item) => item?.field_id === element.dataset.fieldPhotoCount).length;
    element.dataset.photoCount = String(count);
    element.textContent = `${count} photos attached here.`;
  });
}

export function setupEvidenceFields(container, { signal, onPhotoChange } = {}) {
  container.addEventListener('change', (event) => {
    if (event.target.matches('[data-field-photos]')) onPhotoChange?.(event);
  }, { signal });
  container.querySelectorAll('[data-location-field]').forEach((wrapper) => {
    const input = wrapper.querySelector('[data-location-value]');
    const status = wrapper.querySelector('[data-location-status]');
    const capture = wrapper.querySelector('[data-location-capture]');
    let generation = 0;
    wrapper.querySelector('[data-location-clear]').addEventListener('click', () => {
      generation += 1;
      delete wrapper.dataset.locationPending;
      capture.disabled = false;
      showLocation(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { signal });
    capture.addEventListener('click', () => {
      if (!navigator.geolocation) { status.textContent = 'Location capture is unavailable on this device.'; return; }
      const token = ++generation;
      wrapper.dataset.locationPending = 'true';
      capture.disabled = true;
      status.textContent = 'Capturing location…';
      const current = () => token === generation && !signal?.aborted && input.isConnected
        && !input.disabled && !container.inert;
      navigator.geolocation.getCurrentPosition((position) => {
        if (!current()) return;
        delete wrapper.dataset.locationPending;
        capture.disabled = false;
        const { latitude, longitude, accuracy } = position.coords;
        if (![latitude, longitude, accuracy].every(Number.isFinite) || Math.abs(latitude) > 90
          || Math.abs(longitude) > 180 || accuracy < 0 || accuracy > 1000000 || !Number.isFinite(position.timestamp)) {
          status.textContent = 'The device returned an invalid location. Existing location is retained.';
          return;
        }
        showLocation(input, { latitude, longitude, accuracy, captured_at: new Date(position.timestamp).toISOString() });
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, () => {
        if (!current()) return;
        delete wrapper.dataset.locationPending;
        capture.disabled = false;
        status.textContent = 'Could not capture location. Check device permission and try again. Existing location is retained.';
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }, { signal });
  });
}
