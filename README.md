# SyncWave

SyncWave turns every phone, laptop and tablet in a room into one speaker system. Open a link, tap join, and every device plays the same audio within about 10 ms of the others. No app install, no matching hardware, and the browser is the product.

How it works: a thin Node server keeps rooms and a reference clock. Each device estimates its offset from the server clock (NTP-style pings, lowest-RTT 30%, median), downloads and decodes the host's audio file, then schedules playback on its own Web Audio clock at an agreed server time (about 1.5 s after the host presses play). A drift loop nudges playback rate or re-seeks to stay locked. See `spec.md` for the full design and `PROTOCOL.md` for the wire contract.

## Quick start

Requires Node 20+.

```
npm install
npm run build     # builds the client into client/dist
npm start         # server on http://localhost:3000, serves client/dist
```

Development: `npm run dev:server` and `npm run dev:client` (Vite proxies `/api`, `/media`, `/ws` to :3000). Set `PORT` to change the server port.

### Open it on phones (LAN)

1. Put the laptop and phones on the same Wi-Fi.
2. Find the laptop's LAN IP (macOS: `ipconfig getifaddr en0`; Linux: `hostname -I`; Windows: `ipconfig`).
3. On the host device open `http://<LAN-IP>:3000`, create a room, and upload a track.
4. Guests open the same URL (or scan the room QR code) and tap join, then "Tap to start" to unlock audio.
5. When every device shows ready, the host presses play.

Notes: iPhones may mute web audio in silent mode (flip the switch off). Keep screens on (Wake Lock is requested). Browsers only allow some APIs (wake lock, mic) on secure origins; plain `http://<LAN-IP>` works for playback but use HTTPS or `localhost` if a feature refuses to start.

### Live share and Announce

Host-only, in the Play tab. **Share tab/system audio** (desktop Chrome/Edge) captures a tab or the system via `getDisplayMedia` (the video is discarded; in the picker choose a tab and tick "Share tab audio"), and **Announce (mic)** captures the microphone (works on phones too). Audio is sent in ~20 ms chunks through the server to all devices, each stamped with server time, and every device (including the host) plays it `delay` later: 1.5 s by default for share (slider 0.8-3 s, which also absorbs Wi-Fi jitter) and about 0.25 s for announce. While announcing, the music is ducked to 25 percent on every device. Starting a share stops file playback. Share sends about 1.5 Mbit/s per receiver (48 kHz stereo 16-bit).

`getUserMedia` / `getDisplayMedia` only work on secure origins. `http://localhost:3000` is fine; **phones opening `http://<LAN-IP>:3000` cannot use the mic or tab capture** (they can still listen). To use the host controls from a phone, serve over HTTPS:

```
brew install mkcert && mkcert -install            # one-time (other OSes: see mkcert docs)
mkcert -key-file key.pem -cert-file cert.pem localhost <LAN-IP>
SSL_KEY=key.pem SSL_CERT=cert.pem npm start       # https://<LAN-IP>:3000, wss for the socket
# dev: SSL_KEY=key.pem SSL_CERT=cert.pem on both `npm run dev:server` and `npm run dev:client`
```

Other devices must trust the mkcert root CA (or tap through the certificate warning; phones that never trusted it may still refuse some APIs). Tip for share on the host laptop: Chrome mutes the shared tab locally (`suppressLocalAudioPlayback`), so you only hear the delayed copy; if you share system audio, mute the source app instead to avoid hearing it twice.

### Hotspot mode (no internet)

Turn on a phone hotspot (or use a travel router), join the laptop and all other devices to it, then run `npm start` on the laptop and use the laptop's IP on that network exactly as above. Nothing needs the internet: the client is served by the server and audio is downloaded from it once. Hotspots have more jitter than a router, which is what the min-RTT filter is for.

## Simulator (no real devices needed)

`sim/` runs N fake devices against the real server over real WebSockets. Each device has injected one-way latency and jitter on both send and receive, a random clock skew, and clock/audio drift in ppm. Each runs the PROTOCOL.md estimator (20-ping burst, keep lowest-RTT 30%, median, then 8-ping bursts every 3 s), schedules a start, and runs the drift-correction loop (check every 2 s, rate nudge up to 0.5% under 40 ms, re-seek at 40 ms or more) over simulated time. It prints offset error against the spec targets and exits non-zero on failure.

```
npm run sim -- --devices 5 --duration 600 --jitter 10
```

Options: `--devices N` (5), `--duration S` simulated seconds (600), `--jitter MS` max per-device jitter (10), `--latency-min/--latency-max MS` one-way base latency (5/40), `--asym F` up/down latency asymmetry fraction (0.1, the main irreducible error source), `--skew MS` (5000), `--drift PPM` (50), `--server-url URL` (default: spawns `server/src/index.js` on a free port and polls until reachable), `--realtime` (wait real time between re-syncs instead of compressing simulated time), `--max-median` (10) and `--max-worst` (20).

Targets: median offset under 10 ms and worst under 20 ms (spec acceptance criteria). Exit code 0 pass, 1 fail, 2 error. Limits: the sim models audio timing and the clock estimator, not real browser/OS audio output latency, so it validates the algorithm and server, not hardware.

## Test matrix

| Area | Check | Pass |
| --- | --- | --- |
| Sim | `npm run sim -- --devices 5 --duration 600 --jitter 10` | median < 10 ms, worst < 20 ms |
| Sim stress | `--devices 20 --jitter 15 --latency-max 60` | exits 0 |
| Browsers | Chrome Android, Safari iOS, Chrome desktop, Firefox desktop | join, play, pause, seek, next all work |
| Join | QR scan to playing, 5 trials | under 10 s |
| Start sync | 5 mixed devices, one external mic, onset gaps in Audacity | median < 10 ms, worst < 20 ms |
| Drift | same recording at minute 10, plus sync radar | < 10 ms |
| Late join | join mid-song, external recording | lands within 15 ms |
| Spatial | assign left/right/center | separate channels audible |
| Bluetooth | trim slider on a Bluetooth phone | can be pulled into sync by hand |
| Host handoff | host leaves | another device takes over, playback continues |
| Hotspot | run over a phone hotspot with no internet | all of the above still work |


## Auto-calibration
Host: Devices tab -> **Auto-calibrate** (pause music first, keep the room quiet, needs HTTPS or localhost for the microphone). Each device plays a short 2-8 kHz chirp three times in turn while the host's mic records; cross-correlation measures each device's real acoustic delay and sets every trim so all devices line up with the host's device (positive trim = play earlier). Each device gets a 0-100 sync score (green/amber/red) shown in the device list and on the radar. The manual trim sliders remain as an override. Limits: sound travel time (about 3 ms per metre) is part of the measurement, so place the host device where you want the best sound; a noisy room or a quiet speaker gives a "low confidence" result, which leaves that device's trim unchanged. Covered by synthetic tests only (`server/test/calibrate.test.js`, `calibration.test.js`); not yet validated in real rooms.

## Orchestra mode

Split a song into vocals / drums / bass / other and let every phone play only its own part (stems start at the same scheduled instant, so the sync model is unchanged).

1. **Stem source.** Either *Separate this song into stems* (Orchestra tab, host) which sends the track to the Demucs service in `separator/`, or pick a song from the **Demo library** (pre-separated, instant, see `server/demo/README.md`).
2. **Configure the separator** on the SyncWave server: `SEPARATOR_URL=https://<space>.hf.space SEPARATOR_TOKEN=<secret> npm start`. Unset = separation disabled (the UI says so; demos and everything else still work). Separation takes minutes on a free CPU; results are cached by the track's SHA-256, so repeats are instant.
3. **Turn Orchestra on.** *Auto-assign* follows the Space map left to right (vocals, drums, bass, other; 2 devices: vocals+other vs drums+bass; more devices than stems share round-robin) and reassigns when devices join, leave or move. Tap stem chips to assign by hand, *Everyone plays everything* to go back to the full song, four sliders mix the stems.
4. **Fallback.** Orchestra off, or stems not ready: everyone plays the full mix. Play is only allowed once every device has decoded its assigned stems.

Each device downloads the full mix plus its own stems (about 4 MB per stem at 128 kbps). Wire protocol: `PROTOCOL.md` "Orchestra mode".
