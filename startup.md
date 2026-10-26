# SyncWave — startup

**Prerequisites:** Node 20+, npm. Phones/other devices on the same Wi-Fi (or a phone hotspot).

**Setup**
```
npm install
```

**Run (production, one process)**
```
npm run build && npm start      # http://localhost:3000  (PORT=3001 npm start to change)
```
**Run (dev, hot reload):** `npm run dev:server` and `npm run dev:client` in two terminals (client on :5173).

Open it on phones via your LAN IP, `http://<ip>:3000`. Mic / tab-capture need HTTPS: see README "Live share and Announce".

**Stop:** Ctrl+C. If the port is stuck: `lsof -nP -iTCP:3000 -sTCP:LISTEN` then `kill <PID>`.

**Tests:** `npm -w server test` · simulation: `npm run sim -- --devices 5 --duration 600 --jitter 10`

**Common problems**
- *Port 3000 in use* — see Stop above, or use another `PORT`.
- *Tests/build hang reading node_modules* — iCloud evicted files (project is under Desktop). Move the project out of iCloud or reinstall `node_modules`.
- *Phone shows QR but can't join* — you opened the host page via `localhost`; use the LAN IP.
- *No sound on iPhone* — tap "Tap to start" and turn the silent switch off.
- *Auto-calibrate says it needs HTTPS / mic denied* — the host's microphone only works on `https://` or `localhost`; allow the mic for the site. Pause music and keep the room quiet; "low confidence" means retry closer to the speakers.
