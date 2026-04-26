// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_CENTER  = [32.7157, -117.1611];
const DEFAULT_ZOOM    = 12;
const DEFAULT_BBOX    = [[32.5, -117.5], [32.9, -116.9]];
const STALE_MS        = 10 * 60 * 1000; // 10 minutes

const NAV_STATUS = {
  0:'Under way (engine)', 1:'At anchor', 2:'Not under command',
  3:'Restricted maneuverability', 4:'Constrained by draught',
  5:'Moored', 6:'Aground', 7:'Engaged in fishing',
  8:'Under way (sailing)', 9:'Reserved (HSC)', 10:'Reserved (WIG)',
  11:'Reserved', 12:'Reserved', 13:'Reserved', 14:'AIS-SART', 15:'Not defined',
};

const LS = {
  apiKey:         'ais_apiKey',
  mmsiList:       'ais_mmsiList',
  maxVessels:     'ais_maxVessels',
  speedThreshold: 'ais_speedThreshold',
  alertCooldown:  'ais_alertCooldown',
  geofence:       'ais_geofence',
  theme:          'ais_theme',
  trackOnly:      'ais_trackOnly',
  mapStyle:       'ais_mapStyle',
  seamarks:       'ais_seamarksOverlay',
  geoHidden:      'ais_geofenceHidden',
};

// ─── App state ────────────────────────────────────────────────────────────────
let map, drawnItems, drawControl;
let ws = null;
let wsTimer = null;
let geofenceLayer   = null;
let geofenceGeoJSON = null;
let activePopup     = null; // track which sidebar popup is open

const vessels      = new Map(); // mmsi → { marker, name, sog, cog, heading, navStatus, time, lat, lon, lastUpdate, stale }
const alertTimes   = new Map(); // mmsi → timestamp of last alert
const alertLog     = [];        // [{time, text}] up to 5

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  return {
    apiKey:         localStorage.getItem(LS.apiKey)         || '',
    mmsiList:       JSON.parse(localStorage.getItem(LS.mmsiList) || '[]'),
    maxVessels:     parseInt(localStorage.getItem(LS.maxVessels)     || '5'),
    speedThreshold: parseFloat(localStorage.getItem(LS.speedThreshold) || '2.0'),
    alertCooldown:  parseInt(localStorage.getItem(LS.alertCooldown)  || '30'),
    trackOnly:      localStorage.getItem(LS.trackOnly) === 'true',
  };
}

let cfg = loadSettings();

function saveSettings() {
  localStorage.setItem(LS.apiKey,         cfg.apiKey);
  localStorage.setItem(LS.mmsiList,       JSON.stringify(cfg.mmsiList));
  localStorage.setItem(LS.maxVessels,     String(cfg.maxVessels));
  localStorage.setItem(LS.speedThreshold, String(cfg.speedThreshold));
  localStorage.setItem(LS.alertCooldown,  String(cfg.alertCooldown));
  localStorage.setItem(LS.trackOnly,      String(cfg.trackOnly));
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function currentTheme() { return document.documentElement.getAttribute('data-theme'); }

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(LS.theme, t);
  document.getElementById('sidebar-theme').textContent = t === 'dark' ? '☀' : '☾';
  // Auto-switch map style to match theme (respects manual override if saved)
  if (map) {
    const saved = localStorage.getItem(LS.mapStyle);
    if (!saved) {
      const layerId = t === 'light' ? 'Light' : 'Dark';
      switchTileLayer(layerId);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(timeStr) {
  try {
    const m = String(timeStr).match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    if (!m) return timeStr;
    const d = new Date(m[1] + 'T' + m[2] + 'Z');
    if (isNaN(d)) return timeStr;
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' AM', 'AM').replace(' PM', 'PM');
    return `${date}, ${time}`;
  } catch { return timeStr; }
}

// ─── Vessel icons ─────────────────────────────────────────────────────────────
function effectiveRotation(heading, cog) {
  if (heading !== undefined && heading !== null && heading !== 511) return heading;
  if (cog     !== undefined && cog     !== null && cog     !== 360) return cog;
  return null;
}

function makeIcon(sog, cog, heading, stale, tracked) {
  const rotation = effectiveRotation(heading, cog);
  let color;
  if (stale) {
    color = '#64748b';
  } else if (tracked) {
    const slow = sog <= cfg.speedThreshold;
    color = slow ? '#ef4444' : '#22c55e';
  } else {
    color = '#3b82f6'; // blue for non-tracked vessels
  }

  const sz = tracked ? { w: 24, h: 36 } : { w: 16, h: 24 };
  const circR = tracked ? 6 : 5;

  if (sog === 0 || rotation === null) {
    const d = circR * 2;
    return L.divIcon({
      className: '',
      html: `<div style="width:${d}px;height:${d}px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.85);box-shadow:0 1px 4px rgba(0,0,0,0.6);"></div>`,
      iconSize:   [d, d],
      iconAnchor: [circR, circR],
    });
  }

  const svg = `<svg viewBox="0 0 20 30" xmlns="http://www.w3.org/2000/svg" width="${sz.w}" height="${sz.h}">
    <path d="M10 2 L18 27 L10 21 L2 27 Z" fill="${color}" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;

  return L.divIcon({
    className: '',
    html: `<div style="width:${sz.w}px;height:${sz.h}px;transform:rotate(${rotation}deg);transform-origin:${sz.w/2}px ${sz.h/2}px;">${svg}</div>`,
    iconSize:   [sz.w, sz.h],
    iconAnchor: [sz.w/2, sz.h/2],
  });
}

// ─── Popup content ────────────────────────────────────────────────────────────
function popupHTML(v) {
  const nav     = NAV_STATUS[v.navStatus] ?? `Status ${v.navStatus}`;
  const hdg     = (v.heading !== undefined && v.heading !== 511) ? `${v.heading}°` : 'N/A';
  const updated = v.time ? fmtTime(v.time) : 'N/A';
  return `
    <div style="font-family:'Inter',sans-serif;">
      <div style="font-size:14px;font-weight:600;color:#06b6d4;margin-bottom:8px;">${esc(v.name)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;line-height:1.6;">
        <tr><td style="color:#94a3b8;padding-right:8px;width:90px;">MMSI</td><td>${esc(v.mmsi)}</td></tr>
        <tr><td style="color:#94a3b8;">Speed</td><td>${v.sog !== undefined ? v.sog.toFixed(1)+' kts' : 'N/A'}</td></tr>
        <tr><td style="color:#94a3b8;">Course</td><td>${v.cog !== undefined ? v.cog+'°' : 'N/A'}</td></tr>
        <tr><td style="color:#94a3b8;">Heading</td><td>${hdg}</td></tr>
        <tr><td style="color:#94a3b8;">Nav Status</td><td>${esc(nav)}</td></tr>
        <tr><td style="color:#94a3b8;">Last Update</td><td>${esc(updated)}</td></tr>
      </table>
    </div>`;
}

// ─── Vessel management ────────────────────────────────────────────────────────
function upsertVessel(data) {
  const { mmsi, name, lat, lon, sog, cog, heading, navStatus, time, classB } = data;
  const isTracked = cfg.mmsiList.includes(mmsi);

  if (vessels.has(mmsi)) {
    const v = vessels.get(mmsi);
    const nameChanged = name && name !== mmsi && name !== v.name;
    v.name      = name || v.name;
    if (sog !== undefined) v.sog = sog;
    if (cog !== undefined) v.cog = cog;
    if (heading !== undefined) v.heading = heading;
    if (navStatus !== undefined) v.navStatus = navStatus;
    v.time      = time || v.time;
    if (lat !== undefined) v.lat = lat;
    if (lon !== undefined) v.lon = lon;
    v.lastUpdate = Date.now();
    v.stale     = false;
    v.classB    = classB || v.classB;

    v.marker.setLatLng([v.lat, v.lon]);
    v.marker.setIcon(makeIcon(v.sog, v.cog, v.heading, false, isTracked));
    v.marker.setPopupContent(popupHTML(v));
    v.marker.getTooltip().setContent(v.name);

    if (nameChanged) renderMMSIList();
  } else {
    const v = { mmsi, name: name || mmsi, sog: sog ?? 0, cog: cog ?? 0, heading, navStatus, time, lat: lat ?? 0, lon: lon ?? 0, lastUpdate: Date.now(), stale: false, classB: classB || false };
    const marker = L.marker([v.lat, v.lon], { icon: makeIcon(v.sog, v.cog, v.heading, false, isTracked) });
    marker.bindTooltip(v.name, { permanent: isTracked, direction: 'right', className: 'vessel-label', offset: [10, 0] });
    marker.bindPopup(popupHTML(v), { minWidth: 220, maxWidth: 300 });
    marker.addTo(map);
    v.marker = marker;
    vessels.set(mmsi, v);
  }
}

function removeVesselFromMap(mmsi) {
  const v = vessels.get(mmsi);
  if (v) { map.removeLayer(v.marker); vessels.delete(mmsi); }
}

// ─── Stale check ──────────────────────────────────────────────────────────────
function checkStale() {
  const now = Date.now();
  vessels.forEach((v, mmsi) => {
    const wasStale = v.stale;
    v.stale = (now - v.lastUpdate) > STALE_MS;
    if (v.stale !== wasStale) {
      v.marker.setIcon(makeIcon(v.sog, v.cog, v.heading, v.stale, cfg.mmsiList.includes(mmsi)));
      v.marker.getTooltip().setContent(v.stale ? `${v.name} (stale)` : v.name);
    }
  });
  updateSidebarStatus();
}

// ─── Geofence ─────────────────────────────────────────────────────────────────
function loadGeofence() {
  const raw = localStorage.getItem(LS.geofence);
  if (!raw) return;
  try {
    const coords  = JSON.parse(raw);
    const polygon = L.polygon(coords, { color: '#3388ff', fillOpacity: 0.2, weight: 2 });
    drawnItems.addLayer(polygon);
    geofenceLayer   = polygon;
    geofenceGeoJSON = polygon.toGeoJSON();
    updateZoneStatus();
  } catch { localStorage.removeItem(LS.geofence); }
}

function clearGeofence() {
  drawnItems.clearLayers();
  geofenceLayer   = null;
  geofenceGeoJSON = null;
  localStorage.removeItem(LS.geofence);
  localStorage.removeItem(LS.geoHidden);
  updateZoneStatus();
}

function updateZoneStatus() {
  const el = document.getElementById('zone-status');
  const btn = document.getElementById('toggle-zone-vis');
  if (geofenceLayer) {
    el.textContent = 'Zone active ✓';
    el.classList.add('active');
    btn.disabled = false;
    applyGeofenceVis(btn);
  } else {
    el.textContent = 'No zone drawn';
    el.classList.remove('active');
    btn.disabled = true;
    btn.classList.remove('hidden');
  }
}

function applyGeofenceVis(btn) {
  if (!geofenceLayer) return;
  if (localStorage.getItem(LS.geoHidden) === '1') {
    geofenceLayer.setStyle({ opacity: 0, fillOpacity: 0 });
    btn.classList.add('hidden');
  } else {
    geofenceLayer.setStyle({ opacity: 1, fillOpacity: 0.2 });
    btn.classList.remove('hidden');
  }
}

function toggleGeofenceVis() {
  const hidden = localStorage.getItem(LS.geoHidden) !== '1';
  localStorage.setItem(LS.geoHidden, hidden ? '1' : '0');
  applyGeofenceVis(document.getElementById('toggle-zone-vis'));
}

// ─── Alert logic ──────────────────────────────────────────────────────────────
function checkAlert(mmsi) {
  if (!geofenceGeoJSON) return;
  if (!cfg.mmsiList.includes(mmsi)) return;
  const v = vessels.get(mmsi);
  if (!v || v.stale) return;

  const inside = turf.booleanPointInPolygon(turf.point([v.lon, v.lat]), geofenceGeoJSON);
  if (!inside) return;
  if (v.sog > cfg.speedThreshold) return;

  const now         = Date.now();
  const cooldownMs  = cfg.alertCooldown * 60 * 1000;
  if (now - (alertTimes.get(mmsi) || 0) < cooldownMs) return;

  alertTimes.set(mmsi, now);

  const body = `⚠️ ${v.name} (${mmsi}) at ${v.sog.toFixed(1)} kts in alert zone. Pos: ${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}. Time: ${v.time || ''}`;
  sendToServer({ type: 'notify', title: 'Vessel Alert', body });
  pushAlertLog(v.name, v.sog, mmsi);
}

function pushAlertLog(name, sog, mmsi) {
  alertLog.unshift({ time: new Date().toLocaleTimeString(), text: `${name} (${mmsi}) at ${sog.toFixed(1)} kts` });
  if (alertLog.length > 5) alertLog.pop();
  renderAlertLog();
}

function renderAlertLog() {
  document.getElementById('alert-log').innerHTML =
    alertLog.map(e => `<div class="alert-entry"><time>${esc(e.time)}</time>${esc(e.text)}</div>`).join('');
}

// ─── Sidebar status widget ────────────────────────────────────────────────────
function setStatus(status, text) {
  const dot = document.getElementById('status-dot');
  dot.className = 'status-dot ' + status;
  updateSidebarStatus();
}

function updateSidebarStatus() {
  const tracked = cfg.mmsiList.length;
  const active  = [...vessels.values()].filter(v => !v.stale).length;
  document.getElementById('sidebar-count').textContent = `● ${tracked}`;
  document.getElementById('sidebar-active').textContent = `${active} live`;
}

// ─── Sidebar popup management ─────────────────────────────────────────────────
function togglePopup(id) {
  const popup = document.getElementById(id);
  if (activePopup === id) {
    popup.classList.remove('open');
    activePopup = null;
    updateSidebarActiveBtn(null);
  } else {
    // Close any open popup
    document.querySelectorAll('.sidebar-popup.open').forEach(p => p.classList.remove('open'));
    popup.classList.add('open');
    activePopup = id;
    updateSidebarActiveBtn(id);
  }
}

function updateSidebarActiveBtn(popupId) {
  document.querySelectorAll('.sidebar-btn').forEach(b => b.classList.remove('active'));
  if (!popupId) return;
  const btnMap = { 'popup-maptype': 'sidebar-maptype', 'popup-fleets': 'sidebar-fleets' };
  const btnId = btnMap[popupId];
  if (btnId) document.getElementById(btnId).classList.add('active');
}

function closeAllPopups() {
  document.querySelectorAll('.sidebar-popup.open').forEach(p => p.classList.remove('open'));
  activePopup = null;
  updateSidebarActiveBtn(null);
}

// ─── Geofence draw from sidebar ───────────────────────────────────────────────
function startGeofenceDraw() {
  closeAllPopups();
  new L.Draw.Polygon(map, drawControl.options.draw.polygon).enable();
}

// ─── WebSocket to relay server ────────────────────────────────────────────────
function sendToServer(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

let wsKeepAliveTimer = null;

function startWSKeepAlive() {
  clearInterval(wsKeepAliveTimer);
  wsKeepAliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else if (!ws || ws.readyState === WebSocket.CLOSED) {
      initWS();
    }
  }, 25_000);
}

function initWS() {
  clearTimeout(wsTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    sendToServer({ type:'configure', apiKey: cfg.apiKey, mmsiList: cfg.mmsiList, boundingBox: DEFAULT_BBOX });
    setStatus('connected');
    startWSKeepAlive();
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'pong') {
      return;
    } else if (msg.type === 'status') {
      setStatus(msg.status);
    } else if (msg.type === 'error') {
      setStatus('disconnected', `Error: ${msg.message}`);
    } else if (msg.type === 'snapshot') {
      msg.vessels.forEach(v => upsertVessel(v));
      updateSidebarStatus();
    } else if (msg.MessageType) {
      handleAisMessage(msg);
    }
  };

  ws.onclose = () => {
    clearInterval(wsKeepAliveTimer);
    setStatus('disconnected');
    wsTimer = setTimeout(initWS, 3000);
  };

  ws.onerror = () => {};
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearTimeout(wsTimer);
      initWS();
    }
  }
});

function reconfigure() {
  sendToServer({ type:'reconfigure', apiKey: cfg.apiKey, mmsiList: cfg.mmsiList, boundingBox: DEFAULT_BBOX, trackOnly: cfg.trackOnly });
}

// ─── AIS message handler ──────────────────────────────────────────────────────
function handleAisMessage(msg) {
  const meta = msg.MetaData;
  if (!meta) return;

  const mmsi = String(meta.MMSI);
  const name = (meta.ShipName || '').trim() || mmsi;
  const lat  = meta.latitude;
  const lon  = meta.longitude;
  const time = meta.time_utc;

  switch (msg.MessageType) {
    case 'PositionReport': {
      const pos = msg.Message?.PositionReport;
      if (!pos) return;
      upsertVessel({
        mmsi, name, lat, lon, time,
        sog:       pos.Sog,
        cog:       pos.Cog,
        heading:   pos.TrueHeading,
        navStatus: pos.NavigationalStatus,
        classB:    false,
      });
      break;
    }
    case 'StandardClassBPositionReport': {
      const pos = msg.Message?.StandardClassBPositionReport;
      if (!pos) return;
      upsertVessel({
        mmsi, name, lat, lon, time,
        sog:       pos.Sog,
        cog:       pos.Cog,
        heading:   pos.TrueHeading,
        navStatus: undefined,
        classB:    true,
      });
      break;
    }
    case 'ExtendedClassBPositionReport': {
      const pos = msg.Message?.ExtendedClassBPositionReport;
      if (!pos) return;
      upsertVessel({
        mmsi, name, lat, lon, time,
        sog:       pos.Sog,
        cog:       pos.Cog,
        heading:   pos.TrueHeading,
        navStatus: undefined,
        classB:    true,
      });
      break;
    }
    case 'ShipStaticData': {
      const data = msg.Message?.ShipStaticData;
      if (!data) return;
      upsertVessel({
        mmsi, name, lat, lon, time,
        sog: undefined, cog: undefined, heading: undefined, navStatus: undefined,
        classB: false,
      });
      break;
    }
    case 'StaticDataReport': {
      const data = msg.Message?.StaticDataReport;
      if (!data) return;
      upsertVessel({
        mmsi, name, lat, lon, time,
        sog: undefined, cog: undefined, heading: undefined, navStatus: undefined,
        classB: true,
      });
      break;
    }
    default:
      return;
  }

  checkAlert(mmsi);
  updateSidebarStatus();
}

// ─── Settings UI ──────────────────────────────────────────────────────────────
function renderMMSIList() {
  const el = document.getElementById('mmsi-list');
  if (cfg.mmsiList.length === 0) {
    el.innerHTML = '<div class="mmsi-empty">No vessels tracked</div>';
    return;
  }
  el.innerHTML = cfg.mmsiList.map(mmsi => {
    const v    = vessels.get(mmsi);
    const name = (v && v.name !== mmsi) ? v.name : '—';
    return `<div class="mmsi-item">
      <div class="mmsi-item-info">
        <span class="mmsi-name">${esc(name)}</span>
        <span class="mmsi-num">${esc(mmsi)}</span>
      </div>
      <button class="mmsi-remove" data-mmsi="${esc(mmsi)}" title="Remove">×</button>
    </div>`;
  }).join('');

  el.querySelectorAll('.mmsi-remove').forEach(btn => {
    btn.addEventListener('click', () => doRemoveMMSI(btn.dataset.mmsi));
  });
}

function doAddMMSI() {
  const input = document.getElementById('mmsi-input');
  const mmsi  = input.value.trim();
  if (!/^\d{9}$/.test(mmsi))              { alert('MMSI must be exactly 9 digits.'); return; }
  if (cfg.mmsiList.includes(mmsi))        { alert('Already tracking this MMSI.'); return; }
  if (cfg.mmsiList.length >= cfg.maxVessels) { alert(`Max vessel count (${cfg.maxVessels}) reached.`); return; }
  cfg.mmsiList.push(mmsi);
  saveSettings();
  renderMMSIList();
  updateSidebarStatus();
  const v = vessels.get(mmsi);
  if (v) {
    v.marker.setIcon(makeIcon(v.sog, v.cog, v.heading, v.stale, true));
    v.marker.unbindTooltip();
    v.marker.bindTooltip(v.name, { permanent: true, direction: 'right', className: 'vessel-label', offset: [10, 0] });
  }
  input.value = '';
}

function doRemoveMMSI(mmsi) {
  cfg.mmsiList = cfg.mmsiList.filter(m => m !== mmsi);
  saveSettings();
  if (cfg.trackOnly) {
    removeVesselFromMap(mmsi);
  } else {
    const v = vessels.get(mmsi);
    if (v) {
      v.marker.setIcon(makeIcon(v.sog, v.cog, v.heading, v.stale, false));
      v.marker.unbindTooltip();
      v.marker.bindTooltip(v.name, { permanent: false, direction: 'right', className: 'vessel-label', offset: [10, 0] });
    }
  }
  renderMMSIList();
  updateSidebarStatus();
}

function toggleTrackOnly() {
  cfg.trackOnly = !cfg.trackOnly;
  saveSettings();
  // Update checkbox in popup
  document.getElementById('show-all-vessels').checked = !cfg.trackOnly;
  if (cfg.trackOnly) {
    vessels.forEach((v, mmsi) => {
      if (!cfg.mmsiList.includes(mmsi)) removeVesselFromMap(mmsi);
    });
  }
  updateSidebarStatus();
}

function openSettings()  { closeAllPopups(); document.getElementById('settings-panel').classList.add('open'); document.getElementById('settings-overlay').classList.add('open'); map.invalidateSize(); }
function closeSettings() { document.getElementById('settings-panel').classList.remove('open'); document.getElementById('settings-overlay').classList.remove('open'); map.invalidateSize(); }

// ─── Tile layers ──────────────────────────────────────────────────────────────
const TILE_LAYERS = {
  'Light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 20,
  }),
  'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 20,
  }),
  'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri',
    maxZoom: 19,
  }),
};

let currentTileLayer = null;

function switchTileLayer(name) {
  const layer = TILE_LAYERS[name];
  if (!layer) return;
  if (currentTileLayer && map.hasLayer(currentTileLayer)) {
    map.removeLayer(currentTileLayer);
  }
  layer.addTo(map);
  currentTileLayer = layer;
  localStorage.setItem(LS.mapStyle, name);
  // Sync the radio button
  const radio = document.querySelector(`input[name="mapstyle"][value="${name}"]`);
  if (radio) radio.checked = true;
}

const SEAMARKS_LAYER = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a> contributors',
  maxZoom: 18,
  minZoom: 7,
  opacity: 1,
});

let seamarksActive = false;

function toggleSeamarks(on) {
  if (on && !seamarksActive) {
    SEAMARKS_LAYER.addTo(map);
    seamarksActive = true;
  } else if (!on && seamarksActive) {
    map.removeLayer(SEAMARKS_LAYER);
    seamarksActive = false;
  }
  localStorage.setItem(LS.seamarks, on ? '1' : '0');
  document.getElementById('sidebar-anchor').classList.toggle('active', on);
}

// ─── Map init ─────────────────────────────────────────────────────────────────
function initMap() {
  // Resolve initial layer — fall back to Light/Dark by theme if saved value was removed
  const saved   = localStorage.getItem(LS.mapStyle);
  const themeId = currentTheme();
  let layerId   = saved || (themeId === 'light' ? 'Light' : 'Dark');
  // If saved value is one of the removed layers, fall back
  if (!TILE_LAYERS[layerId]) {
    layerId = themeId === 'light' ? 'Light' : 'Dark';
    localStorage.removeItem(LS.mapStyle);
  }

  map = L.map('map').setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  switchTileLayer(layerId);

  // Restore seamarks
  if (localStorage.getItem(LS.seamarks) === '1') {
    SEAMARKS_LAYER.addTo(map);
    seamarksActive = true;
    document.getElementById('sidebar-anchor').classList.add('active');
  }

  L.control.scale({ position: 'bottomleft', imperial: true, metric: true, maxWidth: 150 }).addTo(map);

  drawnItems = new L.FeatureGroup().addTo(map);

  drawControl = new L.Control.Draw({
    position: 'topright',
    draw: {
      polygon:     { shapeOptions: { color: '#3388ff', fillOpacity: 0.2, weight: 2 } },
      polyline:    false,
      rectangle:   false,
      circle:      false,
      marker:      false,
      circlemarker: false,
    },
    edit: { featureGroup: drawnItems, remove: true, edit: false },
  });
  map.addControl(drawControl);

  map.on(L.Draw.Event.CREATED, (e) => {
    if (e.layerType !== 'polygon') return;
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    geofenceLayer   = e.layer;
    geofenceGeoJSON = e.layer.toGeoJSON();
    const coords = e.layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
    localStorage.setItem(LS.geofence, JSON.stringify(coords));
    updateZoneStatus();
  });

  map.on(L.Draw.Event.DELETED, () => {
    geofenceLayer   = null;
    geofenceGeoJSON = null;
    localStorage.removeItem(LS.geofence);
    updateZoneStatus();
  });

  loadGeofence();
}

// ─── Wire up all UI events ────────────────────────────────────────────────────
function initUI() {
  // Theme
  applyTheme(currentTheme());
  document.getElementById('sidebar-theme').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));

  // Settings panel
  document.getElementById('sidebar-settings').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', closeSettings);

  // Sidebar popups
  document.getElementById('sidebar-maptype').addEventListener('click', () => togglePopup('popup-maptype'));
  document.getElementById('sidebar-fleets').addEventListener('click', () => togglePopup('popup-fleets'));

  // Close popups on outside click
  document.addEventListener('click', (e) => {
    if (activePopup && !e.target.closest('.sidebar-popup') && !e.target.closest('.sidebar-btn')) {
      closeAllPopups();
    }
  });

  // Map type popup — radio buttons
  document.querySelectorAll('input[name="mapstyle"]').forEach(radio => {
    radio.addEventListener('change', () => switchTileLayer(radio.value));
  });
  // Sync radio to current layer
  const currentStyle = localStorage.getItem(LS.mapStyle) || (currentTheme() === 'light' ? 'Light' : 'Dark');
  const initialRadio = document.querySelector(`input[name="mapstyle"][value="${TILE_LAYERS[currentStyle] ? currentStyle : (currentTheme() === 'light' ? 'Light' : 'Dark')}"]`);
  if (initialRadio) initialRadio.checked = true;

  // Nautical chart checkbox
  const seamarksCheck = document.getElementById('seamarks-check');
  seamarksCheck.checked = seamarksActive;
  seamarksCheck.addEventListener('change', () => toggleSeamarks(seamarksCheck.checked));

  // Anchor button toggles seamarks directly
  document.getElementById('sidebar-anchor').addEventListener('click', () => {
    seamarksCheck.checked = !seamarksCheck.checked;
    toggleSeamarks(seamarksCheck.checked);
  });

  // Geofence draw
  document.getElementById('sidebar-draw').addEventListener('click', startGeofenceDraw);

  // Heart popup — "Show other vessels" toggle
  const showAllCheck = document.getElementById('show-all-vessels');
  showAllCheck.checked = !cfg.trackOnly;
  showAllCheck.addEventListener('change', () => {
    cfg.trackOnly = !showAllCheck.checked;
    saveSettings();
    if (cfg.trackOnly) {
      vessels.forEach((v, mmsi) => {
        if (!cfg.mmsiList.includes(mmsi)) removeVesselFromMap(mmsi);
      });
    }
    updateSidebarStatus();
  });

  // MMSI add (in popup)
  const mmsiInput = document.getElementById('mmsi-input');
  document.getElementById('mmsi-add-btn').addEventListener('click', doAddMMSI);
  mmsiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAddMMSI(); });

  // API key
  const apiInput = document.getElementById('api-key-input');
  apiInput.value = cfg.apiKey;
  apiInput.addEventListener('change', () => {
    cfg.apiKey = apiInput.value.trim();
    saveSettings();
    reconfigure();
  });

  // Speed threshold
  const speedIn = document.getElementById('speed-threshold');
  speedIn.value = cfg.speedThreshold;
  speedIn.addEventListener('change', () => {
    const v = parseFloat(speedIn.value);
    if (!isNaN(v) && v >= 0) {
      cfg.speedThreshold = v;
      saveSettings();
      vessels.forEach((vessel, mmsi) => vessel.marker.setIcon(makeIcon(vessel.sog, vessel.cog, vessel.heading, vessel.stale, cfg.mmsiList.includes(mmsi))));
    }
  });

  // Alert cooldown
  const coolIn = document.getElementById('alert-cooldown');
  coolIn.value = cfg.alertCooldown;
  coolIn.addEventListener('change', () => {
    const v = parseInt(coolIn.value);
    if (!isNaN(v) && v >= 1) { cfg.alertCooldown = v; saveSettings(); }
  });

  // Clear zone & toggle visibility
  document.getElementById('clear-zone-btn').addEventListener('click', clearGeofence);
  document.getElementById('toggle-zone-vis').addEventListener('click', toggleGeofenceVis);

  // Init displays
  renderMMSIList();
  updateZoneStatus();
  updateSidebarStatus();
}

// ─── Seed settings from server .env (only if not already saved locally) ───────
async function seedFromDefaults() {
  try {
    const res      = await fetch('/api/defaults');
    const defaults = await res.json();
    let changed = false;
    if (!cfg.apiKey && defaults.apiKey) {
      cfg.apiKey = defaults.apiKey;
      changed = true;
    }
    if (cfg.mmsiList.length === 0 && defaults.mmsiList.length > 0) {
      cfg.mmsiList = defaults.mmsiList;
      changed = true;
    }
    if (changed) saveSettings();
  } catch {}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await seedFromDefaults();
  initMap();
  initUI();
  setStatus('disconnected');
  initWS();
  setInterval(checkStale, 60_000);
});
