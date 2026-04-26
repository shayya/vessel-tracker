// Quick integration test — connects to the local relay and waits for AIS data.
// Usage: node test-connection.js
'use strict';

const { WebSocket } = require('ws');
const fs   = require('fs');
const path = require('path');

// Parse .env
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
})();

const API_KEY  = process.env.AIS_API_KEY  || '';
const MMSI_LIST = (process.env.AIS_MMSI_LIST || '').split(',').map(s => s.trim()).filter(Boolean);

// Use a broad US bounding box so we find the vessels regardless of location
const BBOX = [[24.0, -130.0], [50.0, -60.0]];

const TIMEOUT_MS = 45_000;
let gotConnected   = false;
let positionCount  = 0;

console.log(`\nVessel Tracker — connection test`);
console.log(`API key : ${API_KEY.slice(0, 8)}…`);
console.log(`MMSIs   : ${MMSI_LIST.join(', ')}`);
console.log(`Waiting up to ${TIMEOUT_MS / 1000}s for position reports…\n`);

const ws = new WebSocket('ws://localhost:3000');

const timer = setTimeout(() => {
  if (!gotConnected) {
    console.error('FAIL — never received "connected" status from relay server.');
    console.error('       Is the server running? (npm start)');
  } else if (positionCount === 0) {
    console.warn('WARN — connected to AISStream but no position reports received.');
    console.warn('       Vessels may be offline, in port with AIS off, or outside the bounding box.');
    console.warn('       The API key and relay are working correctly.');
  } else {
    console.log(`OK — received ${positionCount} position report(s). All systems go.`);
  }
  ws.close();
  process.exit(positionCount > 0 ? 0 : 1);
}, TIMEOUT_MS);

ws.on('open', () => {
  ws.send(JSON.stringify({
    type:        'configure',
    apiKey:      API_KEY,
    mmsiList:    MMSI_LIST,
    boundingBox: BBOX,
  }));
  console.log('[WS] Connected to relay — configure sent');
});

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }

  if (msg.type === 'snapshot') {
    console.log(`[SNAP] Received snapshot with ${msg.vessels.length} cached vessel(s)`);
    return;
  }

  if (msg.type === 'status') {
    if (msg.status === 'connected') {
      gotConnected = true;
      console.log('[AIS] Connected to AISStream ✓');
    } else {
      console.log(`[AIS] Status: ${msg.status}`);
    }
  } else if (msg.type === 'error') {
    console.error(`[AIS] Error: ${msg.message}`);
    clearTimeout(timer);
    ws.close();
    process.exit(1);
  } else if (msg.MessageType) {
    positionCount++;
    const meta = msg.MetaData;
    const posType = msg.MessageType;
    const pos = msg.Message?.[posType];
    const name = (meta?.ShipName || '').trim() || meta?.MMSI || '?';
    const mmsi = meta?.MMSI || '?';
    const sog = pos?.Sog;
    const lat = meta?.latitude;
    const lon = meta?.longitude;
    console.log(`[POS] ${name} — MMSI ${mmsi} — ${sog} kts @ ${lat?.toFixed(4)}, ${lon?.toFixed(4)} (${posType})`);
    if (positionCount >= 3) {
      console.log(`\nOK — received ${positionCount} position report(s). All systems go.\n`);
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (err) => {
  console.error(`[WS] Connection error: ${err.message}`);
  console.error('     Make sure the server is running: npm start');
  clearTimeout(timer);
  process.exit(1);
});

ws.on('close', () => clearTimeout(timer));
