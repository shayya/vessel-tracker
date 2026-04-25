# Vessel Tracker

Real-time AIS vessel tracker. Tracked vessels are plotted live on a Leaflet map; when a vessel enters a user-drawn geofence **and** its speed drops below a configurable threshold, you get an instant push notification on your phone via ntfy.sh.

---

## How it runs (always-on)

The server is managed by **macOS launchd** and starts automatically at login. You do not need to run anything manually.

```bash
# Stop the server
launchctl unload ~/Library/LaunchAgents/com.vessel-tracker.plist

# Start / restart the server
launchctl load ~/Library/LaunchAgents/com.vessel-tracker.plist

# Watch live logs
tail -f ~/ais/vessel-tracker/logs/server.log

# Check if it's running
lsof -ti:3000 && echo running || echo stopped
```

Open **http://localhost:3000** in any browser.

---

## Configuration

Credentials and tracked vessels are stored in `.env` (never committed to git):

```
AIS_API_KEY=<your AISStream.io key>
AIS_MMSI_LIST=366889830,368173590,368068510
```

On first load, the browser fetches `/api/defaults` from the server and seeds these values into `localStorage` automatically. Subsequent changes can be made in the Settings panel (⚙ gear icon) without editing the file.

---

## Prerequisites

- **Node.js 18+** — uses the built-in `fetch` API (no extra packages)
- An **AISStream.io API key** — free tier at <https://aisstream.io>
- The **ntfy app** on your phone — subscribe to topic `shaya-vessel-alerts`
  - iOS: App Store → ntfy
  - Android: Play Store → ntfy

---

## Install (first time only)

```bash
cd ~/ais/vessel-tracker
npm install
launchctl load ~/Library/LaunchAgents/com.vessel-tracker.plist
```

---

## Tracked vessels

| MMSI | Name | Notes |
|------|------|-------|
| 366889830 | LEGACY | Confirmed live in San Diego harbor |
| 368173590 | — | San Diego area |
| 368068510 | — | San Diego area |

The bounding box covers San Diego harbor: `32.5–32.9°N, 117.5–116.9°W`. Vessels outside this box will not appear even if their MMSI is in the list. To expand the area, update `DEFAULT_BBOX` near the top of `public/index.html`.

---

## Map controls

| Control | What it does |
|---------|-------------|
| Polygon tool (map toolbar, top-right) | Draw a geofence alert zone |
| Trash icon (map toolbar) | Delete the drawn zone |
| Click a vessel marker | Open popup with speed, course, nav status, last update |
| ⚙ gear icon (header) | Open Settings panel |
| ☀ / ☾ button (header) | Toggle dark / light theme |

---

## Alert logic

An ntfy push notification fires when **all four** conditions are simultaneously true:

1. A geofence polygon has been drawn on the map
2. The vessel's position is **inside** that polygon (Turf.js point-in-polygon)
3. The vessel's speed (`Sog`) is **≤ speed threshold** (default 2.0 kts)
4. The per-vessel **alert cooldown** has elapsed since the last alert (default 30 min)

Notifications go server-side to `https://ntfy.sh/shaya-vessel-alerts` with priority `high`.

---

## Marker colours

| Colour | Meaning |
|--------|---------|
| Green | Speed above threshold — moving normally |
| Red | Speed at or below threshold — slow / stopped |
| Grey | Stale — no position report in 10 minutes |
| Circle (any colour) | Speed = 0 kts, or no heading data available |

Arrow markers rotate to match **Course Over Ground (COG)**. If COG is unavailable, falls back to True Heading; if both are unavailable, a circle is shown.

---

## Architecture

```
Browser  ←──WS (port 3000)──→  server.js  ←──WS──→  wss://stream.aisstream.io
                                    │
                                    └──HTTP POST──→  https://ntfy.sh/shaya-vessel-alerts
```

AISStream does not support browser-direct WebSocket connections (CORS policy + API key exposure). `server.js` acts as a relay: one AISStream connection per browser tab, with full per-client isolation.

---

## File structure

```
vessel-tracker/
├── server.js                    Node.js relay + ntfy sender + static file server
├── package.json                 Single dependency: ws ^8
├── .env                         API key + MMSI list (gitignored)
├── .gitignore
├── test-connection.js           Integration test — run with: node test-connection.js
├── public/
│   └── index.html               Complete frontend (CSS + JS inlined, no build step)
├── logs/
│   ├── server.log               stdout from launchd
│   └── server-error.log         stderr from launchd
└── ~/Library/LaunchAgents/
    └── com.vessel-tracker.plist  macOS service definition (auto-start + KeepAlive)
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Safari can't connect to the server" | `launchctl load ~/Library/LaunchAgents/com.vessel-tracker.plist` |
| Status dot stays red after loading | Check `logs/server.log` — server may still be connecting |
| "Error: Api Key Is Not Valid" | Update `AIS_API_KEY` in `.env`, then reload the launchd agent |
| No vessels appearing | Vessels may be offline or outside the bounding box; check `logs/server.log` for position reports |
| Notifications not arriving | Confirm you subscribed to `shaya-vessel-alerts` in the ntfy app |
| Markers grey with "(stale)" | No position update in 10 min — vessel AIS may be switched off |
| Duplicate AISStream connections in log | Normal on browser refresh; old connection tears down within seconds |
