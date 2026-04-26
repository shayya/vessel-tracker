'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

// Load .env before reading any process.env values
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) {
        const key = m[1], val = m[2].replace(/^["']|["']$/g, '');
        if (process.env[key] == null) process.env[key] = val;
      }
    }
  } catch {}
})();

const PORT             = process.env.PORT || 3000;
const AISSTREAM_URL    = 'wss://stream.aisstream.io/v0/stream';
const NTFY_TOPIC       = 'shaya-vessel-alerts';
const RECONNECT_DELAY  = 3_000;  // ms before retrying after a drop
const HEARTBEAT_MS     = 20_000; // ping AISStream this often to keep the TCP alive
const PONG_TIMEOUT_MS  = 8_000;  // if no pong within this window, assume zombie & reconnect
const DEFAULT_BBOX     = [[32.5, -117.5], [32.9, -116.9]];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ─── Shared upstream + cache ──────────────────────────────────────────────────

let aisWs             = null;
let reconnectTimer    = null;
let heartbeatTimer    = null;
let pongTimer         = null;

const vesselCache     = new Map(); // mmsi → CachedVessel
const clients         = new Set(); // browser WebSocket connections

// ─── Static file server ───────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Expose env-configured defaults to the browser (no secrets leak beyond localhost)
  if (urlPath === '/api/defaults' && req.method === 'GET') {
    const defaults = {
      apiKey:   process.env.AIS_API_KEY  || '',
      mmsiList: (process.env.AIS_MMSI_LIST || '')
        .split(',').map(s => s.trim()).filter(Boolean),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(defaults));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const publicDir = path.join(__dirname, 'public');
  const filePath  = path.join(publicDir, path.normalize(urlPath));

  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const code = err.code === 'ENOENT' ? 404 : 500;
      res.writeHead(code, { 'Content-Type': 'text/plain' });
      res.end(code === 404 ? 'Not Found' : 'Server Error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── Shared AISStream connection ──────────────────────────────────────────────

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  clearTimeout(pongTimer);
  heartbeatTimer = null;
  pongTimer      = null;
}

function startHeartbeat(socket) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.ping();
    pongTimer = setTimeout(() => {
      console.log('[AIS] Pong timeout — zombie connection, forcing reconnect');
      socket.terminate(); // triggers close → schedules reconnect
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_MS);
}

function disconnectAIS() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopHeartbeat();
  if (aisWs) {
    try { aisWs.removeAllListeners(); aisWs.terminate(); } catch {}
    aisWs = null;
  }
}

function broadcastToClients(raw) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

function sendToClient(client, obj) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(obj));
  }
}

function broadcastStatus(status) {
  for (const client of clients) {
    sendToClient(client, { type: 'status', status });
  }
}

function normalizeAISMessage(msg) {
  const meta = msg.MetaData;
  if (!meta) return null;

  const mmsi = String(meta.MMSI);
  const name = (meta.ShipName || '').trim() || mmsi;
  const lat  = meta.latitude;
  const lon  = meta.longitude;
  const time = meta.time_utc;

  switch (msg.MessageType) {
    case 'PositionReport': {
      const pos = msg.Message?.PositionReport;
      if (!pos) return null;
      return {
        mmsi, name, lat, lon, time,
        sog:       pos.Sog,
        cog:       pos.Cog,
        heading:   pos.TrueHeading,
        navStatus: pos.NavigationalStatus,
        shipType:  undefined,
        classB:    false,
        lastUpdate: Date.now(),
      };
    }
    case 'StandardClassBPositionReport': {
      const pos = msg.Message?.StandardClassBPositionReport;
      if (!pos) return null;
      return {
        mmsi, name, lat, lon, time,
        sog:       pos.Sog,
        cog:       pos.Cog,
        heading:   pos.TrueHeading,
        navStatus: undefined,
        shipType:  undefined,
        classB:    true,
        lastUpdate: Date.now(),
      };
    }
    case 'ExtendedClassBPositionReport': {
      const pos = msg.Message?.ExtendedClassBPositionReport;
      if (!pos) return null;
      return {
        mmsi, name, lat, lon, time,
        sog:       pos.Sog,
        cog:       pos.Cog,
        heading:   pos.TrueHeading,
        navStatus: undefined,
        shipType:  undefined,
        classB:    true,
        lastUpdate: Date.now(),
      };
    }
    case 'ShipStaticData': {
      const data = msg.Message?.ShipStaticData;
      if (!data) return null;
      return {
        mmsi, name, lat, lon, time,
        sog: undefined, cog: undefined, heading: undefined, navStatus: undefined,
        shipType:  data.Type,
        classB:    false,
        lastUpdate: Date.now(),
      };
    }
    case 'StaticDataReport': {
      const data = msg.Message?.StaticDataReport;
      if (!data) return null;
      return {
        mmsi, name, lat, lon, time,
        sog: undefined, cog: undefined, heading: undefined, navStatus: undefined,
        shipType:  data.Type,
        classB:    true,
        lastUpdate: Date.now(),
      };
    }
    default:
      return null;
  }
}

function connectToAIS() {
  disconnectAIS();

  const apiKey = process.env.AIS_API_KEY;
  if (!apiKey) {
    console.log('[AIS] No API key configured — will retry when a client provides one');
    return;
  }

  console.log('[AIS] Connecting to AISStream...');
  const socket = new WebSocket(AISSTREAM_URL);
  aisWs = socket;

  socket.on('open', () => {
    if (socket !== aisWs) return;
    console.log('[AIS] Connected — sending subscription');
    const sub = {
      APIKey:             apiKey,
      BoundingBoxes:      [DEFAULT_BBOX],
      FilterMessageTypes: [
        'PositionReport',
        'StandardClassBPositionReport',
        'ExtendedClassBPositionReport',
        'ShipStaticData',
        'StaticDataReport',
      ],
    };
    socket.send(JSON.stringify(sub));
    startHeartbeat(socket);
    broadcastStatus('connected');
  });

  socket.on('pong', () => {
    clearTimeout(pongTimer);
    pongTimer = null;
  });

  socket.on('message', (data) => {
    if (socket !== aisWs) return;
    const raw = data.toString();
    try {
      const msg = JSON.parse(raw);
      if (msg.error) {
        broadcastStatus('disconnected');
        for (const client of clients) {
          sendToClient(client, { type: 'error', message: String(msg.error) });
        }
        return;
      }
      // Normalize and upsert into cache
      const cached = normalizeAISMessage(msg);
      if (cached) {
        const existing = vesselCache.get(cached.mmsi);
        if (existing) {
          // Merge: keep position fields if the new message is static-only
          if (cached.sog !== undefined) {
            existing.sog = cached.sog;
            existing.cog = cached.cog;
            existing.heading = cached.heading;
            existing.navStatus = cached.navStatus;
            existing.lat = cached.lat;
            existing.lon = cached.lon;
          }
          if (cached.shipType !== undefined) existing.shipType = cached.shipType;
          if (cached.name && cached.name !== cached.mmsi) existing.name = cached.name;
          existing.classB = cached.classB;
          existing.time = cached.time;
          existing.lastUpdate = cached.lastUpdate;
        } else {
          vesselCache.set(cached.mmsi, cached);
        }
      }
    } catch {}
    // Broadcast raw message to all browser clients
    broadcastToClients(raw);
  });

  socket.on('close', (code, reason) => {
    if (socket !== aisWs) return;
    stopHeartbeat();
    console.log(`[AIS] Disconnected (code ${code}) — reconnecting in ${RECONNECT_DELAY}ms`);
    aisWs = null;
    broadcastStatus('reconnecting');
    reconnectTimer = setTimeout(connectToAIS, RECONNECT_DELAY);
  });

  socket.on('error', (err) => {
    if (socket !== aisWs) return;
    console.error('[AIS] Error:', err.message);
  });
}

// ─── Cache eviction (every 60s, drop entries older than 30 min) ───────────────

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [mmsi, v] of vesselCache) {
    if (v.lastUpdate < cutoff) vesselCache.delete(mmsi);
  }
}, 60_000);

// ─── Browser client WebSocket relay ───────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (clientWs) => {
  console.log('[Server] Browser client connected');
  clients.add(clientWs);

  // Send snapshot immediately — key speed win
  sendToClient(clientWs, { type: 'snapshot', vessels: [...vesselCache.values()] });

  // Send current status if upstream is connected
  if (aisWs && aisWs.readyState === WebSocket.OPEN) {
    sendToClient(clientWs, { type: 'status', status: 'connected' });
  }

  clientWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'configure':
        // If no upstream yet and we now have an API key, start it
        if (!aisWs && msg.apiKey) {
          process.env.AIS_API_KEY = String(msg.apiKey);
          connectToAIS();
        }
        break;

      case 'reconfigure':
        // No-op: the upstream sub never narrows. Keep for protocol compat.
        break;

      case 'ping':
        sendToClient(clientWs, { type: 'pong' });
        break;

      case 'notify':
        sendNtfy(String(msg.title || 'Vessel Alert'), String(msg.body || ''))
          .catch((err) => console.error('[ntfy] Failed:', err.message));
        break;
    }
  });

  clientWs.on('close', () => {
    console.log('[Server] Browser client disconnected');
    clients.delete(clientWs);
  });

  clientWs.on('error', (err) => {
    console.error('[Server] Client error:', err.message);
  });
});

// ─── ntfy.sh push notification ────────────────────────────────────────────────

async function sendNtfy(title, body) {
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method:  'POST',
    headers: {
      Title:          title,
      Priority:       'high',
      Tags:           'boat,warning',
      'Content-Type': 'text/plain',
    },
    body,
  });
  console.log(`[ntfy] Sent "${title}" — HTTP ${res.status}`);
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[Server] Vessel Tracker running at http://localhost:${PORT}`);
  console.log(`[Server] Heartbeat every ${HEARTBEAT_MS / 1000}s, pong timeout ${PONG_TIMEOUT_MS / 1000}s`);
  connectToAIS(); // start shared upstream immediately
});

// Keep the process alive through transient errors so a single bad message
// doesn't kill the server and drop all tracked vessels.
process.on('uncaughtException',  (err) => console.error('[Process] Uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[Process] Unhandled rejection:', err));
