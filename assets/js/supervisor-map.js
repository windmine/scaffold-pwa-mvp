import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { setDateInputValue } from './date-inputs.js';
import { dateInputValue, escapeHtml, formatDateTime } from './utils.js';

const MAP_DEFAULT_CENTRE = [-36.8485, 174.7633];
const MAP_DEFAULT_ZOOM = 11;

function hasCoordinates(value) {
  return value?.latitude != null
    && value?.latitude !== ''
    && value?.longitude != null
    && value?.longitude !== ''
    && Number.isFinite(Number(value.latitude))
    && Number.isFinite(Number(value.longitude));
}

function recordCoordinates(record) {
  if (!hasCoordinates(record?.location)) return null;
  return [Number(record.location.latitude), Number(record.location.longitude)];
}

function siteRadius(site) {
  const radius = Number(site?.allowed_radius_m ?? site?.allowedRadiusM ?? 100);
  return Number.isFinite(radius) ? radius : 100;
}

function siteCoordinates(site) {
  return [Number(site.latitude), Number(site.longitude)];
}

function markerColour(record) {
  if (record.withinSiteRadius === false) return '#f06b62';
  if (record.withinSiteRadius === true) return '#3ec98f';
  return '#c8a96a';
}

function workerColour(workerId) {
  const colours = ['#2488ff', '#b881ff', '#ff9f43', '#20c7c9', '#ec6fa7', '#95c84b'];
  const source = String(workerId ?? 'worker');
  const hash = Array.from(source).reduce((total, char) => total + char.charCodeAt(0), 0);
  return colours[hash % colours.length];
}

function siteIcon() {
  return L.divIcon({
    className: 'location-map-site-marker',
    html: '<span>SITE</span>',
    iconSize: [58, 28],
    iconAnchor: [29, 42],
    tooltipAnchor: [0, -34]
  });
}

function recordIcon(record) {
  const radiusClass = record.withinSiteRadius == null
    ? 'unknown'
    : record.withinSiteRadius ? 'inside' : 'outside';
  const actionClass = record.action === 'check_out' ? 'checkout' : 'checkin';
  const label = record.action === 'check_out' ? 'OUT' : 'IN';

  return L.divIcon({
    className: `location-map-point ${radiusClass} ${actionClass}`,
    html: `<span>${label}</span>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    tooltipAnchor: [0, -24]
  });
}

function uniqueOptions(records, valueKey, labelKey) {
  const values = new Map();
  records.forEach((record) => {
    const value = record[valueKey];
    if (value == null || value === '') return;
    values.set(String(value), record[labelKey] || String(value));
  });
  return Array.from(values.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
}

export function createSupervisorMapModule({
  els,
  state,
  loadAttendanceRecords,
  normaliseAttendanceRecord,
  onDecision,
  onEdit,
  refreshRecords,
  renderStatusBanner
}) {
  let map = null;
  let siteLayer = null;
  let recordLayer = null;
  let routeLayer = null;
  let selectedRecordId = null;
  let locationRecords = [];
  let hasLoadedLocationRecords = false;
  let locationRecordsRequest = null;
  const markerByRecordId = new Map();

  function reviewAttendanceRecords() {
    return (state.supervisorRecords.reviewRecords || [])
      .filter((record) => (
        record.type === 'attendance'
        && recordCoordinates(record)
        && (
          !state.departmentFocusId
          || String(record.departmentId ?? state.user?.departmentId) === String(state.departmentFocusId)
        )
      ));
  }

  function attendanceRecords() {
    return hasLoadedLocationRecords ? locationRecords : reviewAttendanceRecords();
  }

  async function refreshLocationRecords() {
    if (!loadAttendanceRecords) return;
    if (locationRecordsRequest) return await locationRecordsRequest;

    locationRecordsRequest = loadAttendanceRecords()
      .then((records) => {
        locationRecords = records
          .map((record) => normaliseAttendanceRecord ? normaliseAttendanceRecord(record) : record)
          .filter((record) => (
            record
            && record.type === 'attendance'
            && recordCoordinates(record)
            && (
              !state.departmentFocusId
              || String(record.departmentId ?? state.user?.departmentId) === String(state.departmentFocusId)
            )
          ));
        hasLoadedLocationRecords = true;
      })
      .finally(() => {
        locationRecordsRequest = null;
      });

    return await locationRecordsRequest;
  }

  function ensureLocationRecordsLoaded() {
    if (!els.locationMapDetails.open || hasLoadedLocationRecords || locationRecordsRequest || !loadAttendanceRecords) return;

    refreshLocationRecords()
      .then(() => renderPanel())
      .catch((error) => {
        renderStatusBanner(error.message || 'Could not load attendance map records.', true);
      });
  }

  function selectedSite(record) {
    return state.sites.find((site) => String(site.id) === String(record.siteId));
  }

  function visibleSites(records) {
    const selectedSiteId = els.locationMapSiteFilter.value;
    const recordSiteIds = new Set(
      records
        .map((record) => record.siteId)
        .filter((siteId) => siteId != null && siteId !== '')
        .map(String)
    );
    const limitToRecordSites = !selectedSiteId && recordSiteIds.size > 0;

    return state.sites.filter((site) => (
      hasCoordinates(site)
      && (!state.departmentFocusId || String(site.department_id ?? site.departmentId) === String(state.departmentFocusId))
      && (!selectedSiteId || String(site.id) === selectedSiteId)
      && (!limitToRecordSites || recordSiteIds.has(String(site.id)))
    ));
  }

  function filters() {
    return {
      workerId: els.locationMapWorkerFilter.value,
      siteId: els.locationMapSiteFilter.value,
      status: els.locationMapStatusFilter.value,
      dateFrom: els.locationMapDateFrom.value,
      dateTo: els.locationMapDateTo.value,
      outsideOnly: els.locationMapOutsideOnly.checked,
      showRoutes: els.locationMapRouteToggle.checked
    };
  }

  function filteredRecords() {
    const activeFilters = filters();
    return attendanceRecords().filter((record) => {
      const recordDate = dateInputValue(record.createdAt);
      if (activeFilters.workerId && String(record.userId) !== activeFilters.workerId) return false;
      if (activeFilters.siteId && String(record.siteId) !== activeFilters.siteId) return false;
      if (activeFilters.status && record.status !== activeFilters.status) return false;
      if (activeFilters.dateFrom && recordDate < activeFilters.dateFrom) return false;
      if (activeFilters.dateTo && recordDate > activeFilters.dateTo) return false;
      if (activeFilters.outsideOnly && record.withinSiteRadius !== false) return false;
      return true;
    });
  }

  function replaceSelectOptions(select, options, emptyLabel) {
    const currentValue = select.value;
    select.innerHTML = [
      `<option value="">${escapeHtml(emptyLabel)}</option>`,
      ...options.map(([value, label]) => (
        `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`
      ))
    ].join('');
    select.value = Array.from(select.options).some((option) => option.value === currentValue)
      ? currentValue
      : '';
  }

  function renderFilterOptions(records) {
    replaceSelectOptions(
      els.locationMapWorkerFilter,
      uniqueOptions(records, 'userId', 'userName'),
      'All workers'
    );
    replaceSelectOptions(
      els.locationMapSiteFilter,
      uniqueOptions(records, 'siteId', 'siteName'),
      'All sites'
    );
  }

  function ensureMap() {
    if (map || !els.locationMapDetails.open) return;

    map = L.map(els.locationReviewMap, {
      zoomControl: true,
      preferCanvas: false
    }).setView(MAP_DEFAULT_CENTRE, MAP_DEFAULT_ZOOM);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    siteLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    recordLayer = L.layerGroup().addTo(map);
  }

  function renderSummary(records) {
    const outsideCount = records.filter((record) => record.withinSiteRadius === false).length;
    const pendingCount = records.filter((record) => record.status === 'pending').length;
    const workerCount = new Set(records.map((record) => record.userId)).size;
    els.locationMapSummary.innerHTML = `
      <div class="summary-item"><span>Visible points</span><strong>${records.length}</strong></div>
      <div class="summary-item"><span>Workers</span><strong>${workerCount}</strong></div>
      <div class="summary-item"><span>Outside site</span><strong>${outsideCount}</strong></div>
      <div class="summary-item"><span>Pending</span><strong>${pendingCount}</strong></div>
    `;
    els.locationMapCount.textContent = `${records.length} point${records.length === 1 ? '' : 's'}`;
  }

  function renderSiteBoundaries(records) {
    visibleSites(records).forEach((site) => {
      const centre = siteCoordinates(site);
      const radius = siteRadius(site);
      L.circle(centre, {
        radius,
        color: '#ffffff',
        opacity: 0.96,
        fillOpacity: 0,
        weight: 9,
        className: 'location-site-boundary-halo',
        interactive: false
      }).addTo(siteLayer);
      L.circle(centre, {
        radius,
        color: '#f7c948',
        fillColor: '#f7c948',
        fillOpacity: 0.16,
        opacity: 1,
        weight: 4,
        className: 'location-site-boundary'
      })
        .bindTooltip(`${site.name}: ${radius}m boundary`)
        .addTo(siteLayer);
      L.marker(centre, { icon: siteIcon(), zIndexOffset: 90 })
        .bindTooltip(site.name)
        .addTo(siteLayer);
    });
  }

  function renderRoutes(records) {
    if (!filters().showRoutes) return;

    const recordsByWorker = new Map();
    records.forEach((record) => {
      const workerRecords = recordsByWorker.get(record.userId) || [];
      workerRecords.push(record);
      recordsByWorker.set(record.userId, workerRecords);
    });

    recordsByWorker.forEach((workerRecords, workerId) => {
      const points = workerRecords
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map(recordCoordinates);
      if (points.length < 2) return;

      L.polyline(points, {
        color: workerColour(workerId),
        dashArray: '7 7',
        opacity: 0.8,
        weight: 3
      }).addTo(routeLayer);
    });
  }

  function renderSelectedRecord(record) {
    selectedRecordId = record?.id ?? null;
    if (!record) {
      els.locationMapSelection.innerHTML = '<div class="empty-state">Select an attendance point or history row to review it.</div>';
      return;
    }

    const site = selectedSite(record);
    const distance = record.distanceFromSiteM == null
      ? 'Not calculated'
      : `${record.distanceFromSiteM}m from site centre`;
    const radiusResult = record.withinSiteRadius == null
      ? 'Unknown'
      : record.withinSiteRadius ? 'Inside boundary' : 'Outside boundary';
    const radiusResultClass = record.withinSiteRadius == null
      ? ''
      : record.withinSiteRadius ? 'site-inside' : 'site-outside';
    const canMutate = (
      state.supervisorRecords.queueMode === 'live'
      && record.backendRecordId
      && record.durability !== 'local_only'
      && !record.readOnly
    );
    const canDecide = canMutate && record.status === 'pending';

    els.locationMapSelection.innerHTML = `
      <div class="record-header">
        <div>
          <h3 class="record-title">${escapeHtml(record.userName)}</h3>
          <p class="record-meta">${escapeHtml(record.action === 'check_out' ? 'Check out' : 'Check in')} | ${escapeHtml(formatDateTime(record.createdAt))}</p>
        </div>
        <span class="badge ${escapeHtml(record.status)}">${escapeHtml(record.status)}</span>
      </div>
      <div class="record-extra">
        <p><strong>Site:</strong> ${escapeHtml(record.siteName)}</p>
        <p><strong>Boundary:</strong> <span class="${radiusResultClass}">${escapeHtml(radiusResult)}</span> - ${escapeHtml(distance)}${site ? ` / ${escapeHtml(siteRadius(site))}m allowed` : ''}</p>
        <p><strong>GPS:</strong> ${escapeHtml(record.location.latitude)}, ${escapeHtml(record.location.longitude)}${record.location.accuracy == null ? '' : ` (${escapeHtml(record.location.accuracy)}m accuracy)`}</p>
        <p><strong>Notes:</strong> ${escapeHtml(record.notes || 'No notes added.')}</p>
      </div>
      ${canMutate ? `
        <div class="record-actions">
          <button type="button" class="ghost" data-map-edit>Edit record</button>
          ${canDecide ? '<button type="button" data-map-decision="approved">Approve</button><button type="button" class="secondary" data-map-decision="rejected">Reject</button>' : ''}
        </div>
      ` : '<div class="empty-state">Read-only while the durable Review Queue is offline.</div>'}
    `;

    els.locationMapSelection.querySelector('[data-map-edit]')?.addEventListener('click', async () => {
      await onEdit(record);
    });
    els.locationMapSelection.querySelectorAll('[data-map-decision]').forEach((button) => {
      button.addEventListener('click', async () => {
        await onDecision(record, button.dataset.mapDecision);
        await refreshLocationRecords();
        renderPanel();
      });
    });

    els.locationMapHistory.querySelectorAll('[data-location-record-id]').forEach((row) => {
      row.classList.toggle('selected', row.dataset.locationRecordId === String(record.id));
    });
  }

  function selectRecord(record, { openPopup = false } = {}) {
    renderSelectedRecord(record);
    const marker = markerByRecordId.get(String(record.id));
    if (marker && map) {
      const mapWidth = els.locationReviewMap.getBoundingClientRect().width;
      map.panTo(marker.getLatLng());
      if (openPopup && mapWidth >= 520) {
        marker.openTooltip();
      } else {
        marker.closeTooltip();
      }
    }
  }

  function renderRecordMarkers(records) {
    markerByRecordId.clear();
    records.forEach((record) => {
      const marker = L.marker(recordCoordinates(record), {
        icon: recordIcon(record),
        zIndexOffset: 100
      })
        .bindTooltip(`${record.userName}: ${record.action === 'check_out' ? 'check out' : 'check in'} at ${record.siteName}`)
        .on('click', () => selectRecord(record))
        .addTo(recordLayer);
      markerByRecordId.set(String(record.id), marker);
    });
  }

  function renderHistory(records) {
    const chronological = [...records].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    els.locationMapHistory.innerHTML = chronological.length
      ? chronological.map((record) => `
          <button
            type="button"
            class="location-history-row${String(record.id) === String(selectedRecordId) ? ' selected' : ''}"
            data-location-record-id="${escapeHtml(record.id)}"
          >
            <span class="location-history-dot" style="--location-colour: ${markerColour(record)}"></span>
            <span>
              <strong>${escapeHtml(record.userName)} - ${escapeHtml(record.action === 'check_out' ? 'Check out' : 'Check in')}</strong>
              <small>${escapeHtml(record.siteName)} | ${escapeHtml(formatDateTime(record.createdAt))}</small>
            </span>
            <span class="badge ${escapeHtml(record.status)}">${escapeHtml(record.status)}</span>
          </button>
        `).join('')
      : '<div class="empty-state">No attendance locations match these filters.</div>';

    els.locationMapHistory.querySelectorAll('[data-location-record-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const record = records.find((item) => String(item.id) === row.dataset.locationRecordId);
        if (record) selectRecord(record, { openPopup: true });
      });
    });
  }

  function fitMap(records) {
    if (!map) return;
    const bounds = L.latLngBounds();
    records.forEach((record) => bounds.extend(recordCoordinates(record)));

    visibleSites(records).forEach((site) => {
      const centre = siteCoordinates(site);
      bounds.extend(L.latLng(centre).toBounds(siteRadius(site) * 2));
    });

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.18), { maxZoom: 17 });
    } else {
      map.setView(MAP_DEFAULT_CENTRE, MAP_DEFAULT_ZOOM);
    }
  }

  function renderMapLayers(records) {
    ensureMap();
    if (!map) return;

    siteLayer.clearLayers();
    recordLayer.clearLayers();
    routeLayer.clearLayers();
    renderSiteBoundaries(records);
    renderRoutes(records);
    renderRecordMarkers(records);
    fitMap(records);
    window.setTimeout(() => {
      map.invalidateSize();
      fitMap(records);
    }, 40);
  }

  function renderPanel() {
    ensureLocationRecordsLoaded();
    const records = attendanceRecords();
    renderFilterOptions(records);
    const visibleRecords = filteredRecords();
    renderSummary(visibleRecords);
    renderHistory(visibleRecords);
    renderMapLayers(visibleRecords);

    const selected = visibleRecords.find((record) => String(record.id) === String(selectedRecordId));
    renderSelectedRecord(selected || null);
  }

  function clearFilters() {
    els.locationMapWorkerFilter.value = '';
    els.locationMapSiteFilter.value = '';
    els.locationMapStatusFilter.value = '';
    setDateInputValue(els.locationMapDateFrom, '');
    setDateInputValue(els.locationMapDateTo, '');
    els.locationMapOutsideOnly.checked = false;
    els.locationMapRouteToggle.checked = true;
    selectedRecordId = null;
    renderPanel();
  }

  async function refresh() {
    try {
      await refreshRecords();
      await refreshLocationRecords();
      renderPanel();
    } catch (error) {
      renderStatusBanner(error.message || 'Could not refresh location review.', true);
    }
  }

  function bindEvents() {
    [
      els.locationMapWorkerFilter,
      els.locationMapSiteFilter,
      els.locationMapStatusFilter,
      els.locationMapDateFrom,
      els.locationMapDateTo,
      els.locationMapOutsideOnly,
      els.locationMapRouteToggle
    ].forEach((element) => {
      element.addEventListener('input', renderPanel);
      element.addEventListener('change', renderPanel);
    });
    els.clearLocationMapFiltersButton.addEventListener('click', clearFilters);
    els.refreshLocationMapButton.addEventListener('click', refresh);
    els.locationMapDetails.addEventListener('toggle', () => {
      if (els.locationMapDetails.open) renderPanel();
    });
  }

  return {
    bindEvents,
    renderPanel
  };
}
