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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

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

// ─── Per-client WebSocket relay ───────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (clientWs) => {
  console.log('[Server] Browser client connected');

  let aisWs          = null;
  let config         = null;
  let reconnectTimer = null;
  let reconfTimer    = null;
  let heartbeatTimer = null;
  let pongTimer      = null;
  let alive          = true;

  function send(obj) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(obj));
    }
  }

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

  function connectToAIS() {
    if (!config || !alive) return;
    disconnectAIS();

    console.log('[AIS] Connecting to AISStream...');
    const socket = new WebSocket(AISSTREAM_URL);
    aisWs = socket;

    socket.on('open', () => {
      if (socket !== aisWs) return;
      console.log('[AIS] Connected — sending subscription');
      const sub = {
        APIKey:             config.apiKey,
        BoundingBoxes:      [config.boundingBox],
        FilterMessageTypes: ['PositionReport'],
      };
      if (config.trackOnly && config.mmsiList.length > 0) {
        sub.FiltersShipMMSI = config.mmsiList;
      }
      socket.send(JSON.stringify(sub));
      startHeartbeat(socket); // keep TCP alive + detect zombie connections
      send({ type: 'status', status: 'connected' });
    });

    // AISStream sends pings; ws library auto-responds with pong.
    // We also send our own pings (above) and need to clear the pong deadline.
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
          send({ type: 'error', message: String(msg.error) });
          return;
        }
      } catch {}
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(raw);
      }
    });

    socket.on('close', (code, reason) => {
      if (socket !== aisWs) return;
      stopHeartbeat();
      console.log(`[AIS] Disconnected (code ${code}) — reconnecting in ${RECONNECT_DELAY}ms`);
      aisWs = null;
      if (alive) {
        send({ type: 'status', status: 'reconnecting' });
        reconnectTimer = setTimeout(connectToAIS, RECONNECT_DELAY);
      }
    });

    socket.on('error', (err) => {
      if (socket !== aisWs) return;
      // 'close' will fire after 'error'; reconnect logic lives there
      console.error('[AIS] Error:', err.message);
    });
  }

  function applyConfig(msg, fallback) {
    return {
      apiKey:      msg.apiKey      != null ? String(msg.apiKey)      : (fallback?.apiKey      ?? ''),
      mmsiList:    Array.isArray(msg.mmsiList)    ? msg.mmsiList.map(String)    : (fallback?.mmsiList    ?? []),
      boundingBox: Array.isArray(msg.boundingBox) ? msg.boundingBox              : (fallback?.boundingBox ?? [[32.5, -117.5], [32.9, -116.9]]),
      trackOnly:   msg.trackOnly != null ? Boolean(msg.trackOnly) : (fallback?.trackOnly ?? true),
    };
  }

  clientWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'configure':
        config = applyConfig(msg, null);
        connectToAIS();
        break;

      case 'reconfigure':
        clearTimeout(reconfTimer);
        reconfTimer = setTimeout(() => {
          config = applyConfig(msg, config);
          connectToAIS();
        }, 300);
        break;

      case 'ping':
        send({ type: 'pong' });
        break;

      case 'notify':
        sendNtfy(String(msg.title || 'Vessel Alert'), String(msg.body || ''))
          .catch((err) => console.error('[ntfy] Failed:', err.message));
        break;
    }
  });

  clientWs.on('close', () => {
    console.log('[Server] Browser client disconnected');
    alive = false;
    disconnectAIS();
    clearTimeout(reconfTimer);
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
});

// Keep the process alive through transient errors so a single bad message
// doesn't kill the server and drop all tracked vessels.
process.on('uncaughtException',  (err) => console.error('[Process] Uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[Process] Unhandled rejection:', err));
