# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What this project is

A real-time AIS vessel tracking web app for San Diego harbor. It:
- Connects to AISStream.io to receive live ship position broadcasts
- Displays vessel positions as rotating arrow markers on a Leaflet map
- Lets the user draw a geofence polygon; when a tracked vessel is slow inside that zone, it fires a push notification via ntfy.sh to the user's phone
- Runs 24/7 as a macOS background service (launchd)

---

## Runtime environment

- **macOS**, Node.js v22 (via nvm at `/Users/shayanirenberg/.nvm/versions/node/v22.19.0/bin/node`)
- Server managed by **launchd**, plist at `~/Library/LaunchAgents/com.vessel-tracker.plist`
- Server runs on **port 3000**, serves `http://localhost:3000`
- Logs at `vessel-tracker/logs/server.log` and `server-error.log`

### Service management commands
```bash
launchctl load   ~/Library/LaunchAgents/com.vessel-tracker.plist   # start
launchctl unload ~/Library/LaunchAgents/com.vessel-tracker.plist   # stop
tail -f ~/ais/vessel-tracker/logs/server.log                        # live logs
lsof -ti:3000                                                        # check if running
```

---

## Configuration (`.env`)

`.env` holds the API key and MMSI list (gitignored). The server parses it manually at startup (no dotenv package). Values are exposed to the browser only via the `/api/defaults` endpoint (localhost-only, acceptable risk).

### Tracked vessels
| MMSI | Name | Status |
|------|------|--------|
| 366889830 | LEGACY | Confirmed active in San Diego harbor (32.762°N, 117.237°W) |
| 368173590 | unknown | San Diego area |
| 368068510 | unknown | San Diego area |

### Bounding box
San Diego harbor: `[[32.5, -117.5], [32.9, -116.9]]` (`[[minLat, minLon], [maxLat, maxLon]]`).
Defined as `DEFAULT_BBOX` in `public/index.html`. AISStream requires vessels to be within this box even when filtering by MMSI.

---

## Architecture

```
Browser tab
  │  WebSocket ws://localhost:3000
  ▼
server.js (Node.js, port 3000)
  │  Per-client WebSocket connection
  ▼
wss://stream.aisstream.io/v0/stream  (AISStream — AIS data source)

server.js also:
  ├── Serves static files from ./public/
  ├── Exposes GET /api/defaults (seeds browser with .env values)
  └── HTTP POST → https://ntfy.sh/shaya-vessel-alerts  (push notifications)
```

**Key constraint**: AISStream does not support browser-direct connections (no CORS). The Node.js server is a mandatory relay. Each browser tab gets its own dedicated AISStream WebSocket connection (per-client isolation, not shared).

---

## File structure

```
vessel-tracker/
├── server.js                    Backend relay — see detailed notes below
├── package.json                 One runtime dep: ws ^8
├── .env                         Gitignored credentials
├── .gitignore                   Excludes node_modules/ and .env
├── test-connection.js           Integration test — connects relay, sends configure, waits for position reports
├── public/
│   └── index.html               Entire frontend: HTML + inline <style> + inline <script>, no build step
├── logs/
│   ├── server.log               launchd captures stdout here
│   └── server-error.log         launchd captures stderr here
└── ~/Library/LaunchAgents/
    └── com.vessel-tracker.plist  launchd service (KeepAlive=true, RunAtLoad=true)
```

---

## server.js — detailed notes

### Startup sequence
1. Parses `.env` into `process.env` (skips keys already set by the OS environment)
2. Starts HTTP server on `PORT` (default 3000)
3. Attaches WebSocket server to the same HTTP server

### Per-browser-client lifecycle
Each browser tab that connects gets a closure with:
- `aisWs` — the AISStream WebSocket for this client
- `config` — current API key, MMSI list, bounding box
- `reconnectTimer` — scheduled reconnect after AISStream drops
- `reconfTimer` — 300ms debounce for rapid reconfigure messages
- `heartbeatTimer` / `pongTimer` — keepalive mechanism
- `alive` — set to false on client disconnect; prevents reconnect loops

### Message types (browser → server)
| `type` | Action |
|--------|--------|
| `configure` | Set config and connect to AISStream for the first time |
| `reconfigure` | Debounced (300ms) config update + AISStream reconnect |
| `ping` | Keepalive — server replies `{type:"pong"}` |
| `notify` | Fire ntfy.sh push notification with `title` and `body` |

### Message types (server → browser)
| `type` | Meaning |
|--------|---------|
| `status` | `"connected"`, `"reconnecting"`, or `"disconnected"` |
| `error` | AISStream returned an error (e.g., bad API key) |
| `pong` | Keepalive reply |
| *(raw AIS JSON)* | Forwarded verbatim; browser detects via `msg.MessageType === "PositionReport"` |

### AISStream subscription format
```json
{
  "APIKey": "...",
  "BoundingBoxes": [[[32.5, -117.5], [32.9, -116.9]]],
  "FiltersShipMMSI": ["366889830", "368173590", "368068510"],
  "FilterMessageTypes": ["PositionReport"]
}
```
**Must be sent within 3 seconds of WebSocket open** or AISStream closes the connection.

### Heartbeat / keepalive (critical for 24/7 operation)
Without this, connections silently die when vessels are moored and no data flows — NAT tables drop idle TCP connections after ~30–60 s with no FIN/RST, so `socket.on('close')` never fires.

- Every **20 seconds**: server sends a WebSocket `ping` frame to AISStream
- AISStream must reply with `pong` within **8 seconds**
- If no pong: `socket.terminate()` → triggers `close` → schedules reconnect
- `ws` library automatically responds to incoming pings from AISStream (built-in)

### Reconnection
- AISStream drop → `close` event → wait 3 s → `connectToAIS()`
- Rapid reconfigure messages are debounced 300ms to avoid race conditions
- `disconnectAIS()` always calls `removeAllListeners()` before `terminate()` to prevent stale event handlers from old connections firing on new ones
- Stale-connection guard: every event handler checks `if (socket !== aisWs) return`

### Process stability
```js
process.on('uncaughtException',  (err) => console.error(...));
process.on('unhandledRejection', (err) => console.error(...));
```
Prevents a single bad AIS message or transient network error from crashing the Node process. launchd's `KeepAlive` would restart it, but this avoids unnecessary restarts.

---

## public/index.html — detailed notes

Single self-contained file. No build step, no bundler.

### CDN dependencies (loaded at bottom of `<body>`)
- `leaflet@1.9.4` — map rendering
- `leaflet.draw@1.0.4` — polygon draw tool
- `@turf/turf@6` — point-in-polygon test for geofence alerts

### localStorage keys
| Key | Default | Purpose |
|-----|---------|---------|
| `ais_apiKey` | `""` | AISStream API key |
| `ais_mmsiList` | `[]` | JSON array of MMSI strings |
| `ais_maxVessels` | `5` | UI cap on MMSI list length |
| `ais_speedThreshold` | `2.0` | Knots threshold for alerts |
| `ais_alertCooldown` | `30` | Per-vessel cooldown in minutes |
| `ais_geofence` | `null` | `[[lat,lon],...]` of drawn polygon vertices |
| `ais_theme` | `"system"` | `"dark"` or `"light"` |
| `ais_mapStyle` | `null` | Selected tile layer name (`"Dark"`, `"Light"`, `"Standard"`, `"Voyager"`, `"Topographic"`) |

### Boot sequence
1. Inline `<script>` at top of `<body>` sets `data-theme` immediately (prevents flash)
2. `DOMContentLoaded` → `await seedFromDefaults()` fetches `/api/defaults`, seeds `localStorage` if empty
3. `initMap()` — Leaflet map with selectable tile layers (Dark/Light/Standard/Voyager/Topographic), Leaflet.draw toolbar, loads saved geofence from `localStorage`
4. `initUI()` — wires all settings inputs from current `cfg`, sets up event listeners
5. `initWS()` — connects WebSocket to relay, sends `configure` message
6. `setInterval(checkStale, 60_000)` — marks vessels grey after 10 min with no update

### Map tile layers
Uses Leaflet's `L.control.layers()` to provide a base layer switcher in the top-right corner. Available styles:

| Name | Source | Notes |
|------|--------|-------|
| Dark | CartoDB Dark Matter | Default for dark app theme |
| Light | CartoDB Positron | Default for light app theme |
| Standard | OpenStreetMap | Classic OSM tiles |
| Voyager | CartoDB Voyager | Colorful, neutral basemap |
| Topographic | OpenTopoMap | Elevation contours, max zoom 17 |

- Default selection matches the app theme (dark→Dark, light→Light) unless the user has a saved preference in `ais_mapStyle`
- Layer choice persists in `localStorage`; once manually selected it overrides theme-based auto-switching
- Theme toggle (☀/☾) auto-switches map style only if no manual preference is saved

### WebSocket keepalive (browser side)
- `startWSKeepAlive()` runs `setInterval` every 25 s
- Sends `{type:"ping"}` to relay; relay replies `{type:"pong"}`
- If `ws.readyState` is `CLOSED` during the interval, calls `initWS()` immediately
- `document.addEventListener('visibilitychange', ...)` — when tab comes back to foreground, immediately checks if WS is open and reconnects if not (fixes Chrome background tab throttling)

### Vessel markers
- `L.divIcon` with inline SVG — no image files
- Arrow SVG points north by default, rotated via CSS `transform:rotate(Xdeg)` where X = COG degrees
- Heading priority: `TrueHeading` (if not 511) → `Cog` (if not 360) → circle (no data)
- Speed = 0 → always circle regardless of heading
- Colors: green (above threshold), red (at/below threshold), grey (stale)
- Permanent tooltips (`L.tooltip` with `permanent: true`) show vessel name
- Stale vessels get " (stale)" appended to tooltip

### Geofence
- Only one polygon at a time; drawing a new one clears the old
- Persisted as `[[lat, lon], ...]` in `localStorage` key `ais_geofence`
- Restored by creating `L.polygon` and adding to `drawnItems` FeatureGroup (so the delete tool works)
- `layer.toGeoJSON()` used for Turf.js — returns proper GeoJSON with `[lon, lat]` coordinate order
- Turf.js call: `turf.booleanPointInPolygon(turf.point([lon, lat]), geofenceGeoJSON)`

### Alert logic (in `checkAlert(mmsi)`)
```
if no geofence → return
if vessel stale → return
if vessel not inside polygon (turf) → return
if vessel.sog > cfg.speedThreshold → return
if now - lastAlertTime[mmsi] < cooldownMs → return
→ send {type:"notify"} to relay → relay POSTs to ntfy.sh
→ push to alertLog (max 5 entries shown in status bar)
→ flash status bar (CSS animation)
```

### Theme
- CSS custom properties on `:root` and `[data-theme="light"]`
- Applied to `<html data-theme="...">` before first paint to prevent flash
- Toggled by the sun/moon button in the header

---

## Integration test

```bash
node test-connection.js
```

Connects to the local relay, sends a `configure` with a broad US bounding box (`24–50°N, 60–130°W`), waits up to 45 s for position reports. Exits 0 if data received, 1 if only connected but no data (vessels offline), or errors immediately if the API key is rejected.

---

## Known behaviors / gotchas

- **Duplicate AIS connections in logs on browser refresh**: normal. The old connection's `close` event fires and it tears down cleanly within seconds.
- **AISStream bounding box is mandatory even with MMSI filter**: both filters are ANDed. A vessel outside the box won't appear even if its MMSI is listed.
- **`Sog` is already in knots**: do not divide by 10.
- **`TrueHeading` of 511**: AIS code for "not available". Handled in `effectiveRotation()`.
- **`Cog` of 360**: AIS code for "not available". Handled in `effectiveRotation()`.
- **Ship names from AIS** are often padded with spaces or `@` characters. The app uses `.trim()` on `ShipName`.
- **AISStream free tier**: may disconnect sessions periodically. The 20 s heartbeat + 3 s reconnect handles this transparently.
- **ntfy.sh**: free, no account needed. Anyone who knows the topic name can subscribe. If privacy is a concern, use a longer random topic string.

---

## What NOT to change without understanding the implications

1. **`HEARTBEAT_MS` / `PONG_TIMEOUT_MS`** — tuned to prevent NAT table expiry (~30–60 s on most routers) while not hammering AISStream. Don't raise `HEARTBEAT_MS` above 25 s.
2. **The `if (socket !== aisWs) return` guard** in every AIS socket event handler — prevents stale event handlers from firing on new connections during rapid reconnects. Do not remove.
3. **`removeAllListeners()` before `terminate()`** in `disconnectAIS()` — same reason as above.
4. **The subscription must be sent within 3 seconds of `open`** — AISStream closes the socket otherwise. The current code sends it synchronously in the `open` handler, which is correct.
5. **Turf.js coordinate order** — `turf.point([lon, lat])`, not `[lat, lon]`. Leaflet uses `[lat, lon]`; GeoJSON / Turf use `[lon, lat]`. The conversion happens in `checkAlert()`.
