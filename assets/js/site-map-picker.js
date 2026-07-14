import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const DEFAULT_CENTRE = [-36.8485, 174.7633];
const DEFAULT_ZOOM = 11;
const SELECTED_ZOOM = 16;

function numericInputValue(input) {
  if (!input || input.value.trim() === '') return null;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : null;
}

function roundedCoordinate(value) {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? Number(coordinate.toFixed(6)) : null;
}

function hasCoordinates(site) {
  return site?.latitude != null
    && site?.latitude !== ''
    && site?.longitude != null
    && site?.longitude !== ''
    && Number.isFinite(Number(site.latitude))
    && Number.isFinite(Number(site.longitude));
}

function radiusValue(input) {
  const radius = numericInputValue(input);
  return radius && radius > 0 ? radius : 100;
}

function siteRadius(site) {
  const radius = Number(site?.allowed_radius_m ?? site?.allowedRadiusM ?? 100);
  return Number.isFinite(radius) && radius > 0 ? radius : 100;
}

function siteCoordinates(site) {
  return [Number(site.latitude), Number(site.longitude)];
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    });
  });
}

export function createSiteMapPicker({
  mapElement,
  latitudeInput,
  longitudeInput,
  radiusInput,
  statusElement,
  getExistingSites = () => []
}) {
  let map = null;
  let existingLayer = null;
  let selectedLayer = null;
  let marker = null;
  let radiusCircle = null;

  function selectedCoordinates() {
    const latitude = numericInputValue(latitudeInput);
    const longitude = numericInputValue(longitudeInput);
    if (latitude == null || longitude == null) return null;
    return { latitude, longitude };
  }

  function setStatus(message) {
    if (statusElement) statusElement.textContent = message;
  }

  function selectedIcon() {
    return L.divIcon({
      className: 'site-map-pin',
      html: '<span></span>',
      iconSize: [38, 38],
      iconAnchor: [19, 19]
    });
  }

  function existingSiteIcon() {
    return L.divIcon({
      className: 'site-existing-pin',
      html: '<span>SITE</span>',
      iconSize: [56, 28],
      iconAnchor: [28, 42],
      tooltipAnchor: [0, -34]
    });
  }

  function updateStatus() {
    const selected = selectedCoordinates();
    if (!selected) {
      setStatus('No map point selected.');
      return;
    }

    setStatus(
      `Selected ${selected.latitude.toFixed(6)}, ${selected.longitude.toFixed(6)} - ${radiusValue(radiusInput)}m radius.`
    );
  }

  function renderExistingSites() {
    if (!existingLayer) return;
    existingLayer.clearLayers();

    getExistingSites()
      .filter(hasCoordinates)
      .forEach((site) => {
        const centre = siteCoordinates(site);
        const radius = siteRadius(site);
        L.circle(centre, {
          radius,
          color: '#ffffff',
          opacity: 0.96,
          fillOpacity: 0,
          weight: 9,
          className: 'site-existing-boundary-halo',
          interactive: false
        }).addTo(existingLayer);
        L.circle(centre, {
          radius,
          color: '#f7c948',
          fillColor: '#f7c948',
          fillOpacity: 0.14,
          opacity: 1,
          weight: 4,
          className: 'site-existing-boundary'
        })
          .bindTooltip(`${site.name}: ${radius}m`)
          .addTo(existingLayer);
        L.marker(centre, { icon: existingSiteIcon(), zIndexOffset: 90 })
          .bindTooltip(site.name)
          .addTo(existingLayer);
      });
  }

  function updateRadiusPreview() {
    const selected = selectedCoordinates();
    if (!selected || !radiusCircle) {
      updateStatus();
      return;
    }

    radiusCircle.setRadius(radiusValue(radiusInput));
    updateStatus();
  }

  function setCoordinates(latitude, longitude, { pan = true } = {}) {
    const roundedLatitude = roundedCoordinate(latitude);
    const roundedLongitude = roundedCoordinate(longitude);
    if (roundedLatitude == null || roundedLongitude == null) return;

    latitudeInput.value = roundedLatitude.toFixed(6);
    longitudeInput.value = roundedLongitude.toFixed(6);

    ensureMap();
    if (!map || !selectedLayer) {
      updateStatus();
      return;
    }

    const point = [roundedLatitude, roundedLongitude];
    if (!marker) {
      marker = L.marker(point, {
        draggable: true,
        icon: selectedIcon()
      })
        .on('dragend', () => {
          const latLng = marker.getLatLng();
          setCoordinates(latLng.lat, latLng.lng, { pan: false });
        })
        .addTo(selectedLayer);
    } else {
      marker.setLatLng(point);
    }

    if (!radiusCircle) {
      radiusCircle = L.circle(point, {
        radius: radiusValue(radiusInput),
        color: '#f7c948',
        fillColor: '#f7c948',
        fillOpacity: 0.2,
        opacity: 1,
        weight: 5,
        className: 'site-selected-boundary'
      }).addTo(selectedLayer);
    } else {
      radiusCircle.setLatLng(point);
    }

    updateRadiusPreview();
    if (pan) map.setView(point, Math.max(map.getZoom(), SELECTED_ZOOM), { animate: false });
  }

  function fitMap() {
    ensureMap();
    if (!map) return;

    const bounds = L.latLngBounds();
    const selected = selectedCoordinates();
    if (selected) bounds.extend([selected.latitude, selected.longitude]);

    getExistingSites()
      .filter(hasCoordinates)
      .forEach((site) => {
        bounds.extend(L.circle(siteCoordinates(site), { radius: siteRadius(site) }).getBounds());
      });

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.18), { maxZoom: selected ? SELECTED_ZOOM : 14 });
    } else {
      map.setView(DEFAULT_CENTRE, DEFAULT_ZOOM);
    }
  }

  function ensureMap() {
    if (map || !mapElement) return;

    map = L.map(mapElement, {
      zoomControl: true,
      preferCanvas: false
    }).setView(DEFAULT_CENTRE, DEFAULT_ZOOM);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    existingLayer = L.layerGroup().addTo(map);
    selectedLayer = L.layerGroup().addTo(map);
    map.on('click', (event) => setCoordinates(event.latlng.lat, event.latlng.lng, { pan: false }));

    renderExistingSites();
    const selected = selectedCoordinates();
    if (selected) setCoordinates(selected.latitude, selected.longitude, { pan: false });
    updateStatus();
    window.setTimeout(() => map.invalidateSize(), 0);
  }

  function refresh() {
    ensureMap();
    renderExistingSites();
    const selected = selectedCoordinates();
    if (selected) setCoordinates(selected.latitude, selected.longitude, { pan: false });
    window.setTimeout(() => {
      map?.invalidateSize();
      fitMap();
    }, 0);
  }

  function reset() {
    selectedLayer?.clearLayers();
    marker = null;
    radiusCircle = null;
    updateStatus();
    window.setTimeout(() => fitMap(), 0);
  }

  function bindEvents() {
    if (!mapElement) return;

    [latitudeInput, longitudeInput].forEach((input) => {
      input.addEventListener('input', () => {
        const selected = selectedCoordinates();
        if (selected) setCoordinates(selected.latitude, selected.longitude, { pan: false });
        else reset();
      });
      input.addEventListener('change', () => {
        const selected = selectedCoordinates();
        if (selected) setCoordinates(selected.latitude, selected.longitude);
      });
    });

    radiusInput.addEventListener('input', updateRadiusPreview);
    radiusInput.addEventListener('change', updateRadiusPreview);

    mapElement.closest('details')?.addEventListener('toggle', (event) => {
      if (event.currentTarget.open) refresh();
    });
  }

  return {
    bindEvents,
    fitMap,
    refresh,
    reset,
    setCoordinates
  };
}
