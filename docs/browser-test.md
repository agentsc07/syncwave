# Browser test log

First time the production build was driven in a real browser (Playwright, `npm run build` then `PORT=3600 npm start`, throwaway demo folder via `DEMO_DIR` with two synthetic 4-stem sine-tone songs). The scripts were kept outside the repo.

## Setup
- Chromium desktop 1280x800 and Chromium with iPhone 14 emulation; WebKit with iPhone 14 emulation (playback flow only).
- Chromium flags: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required`.
- Two or three browser contexts (host, guests joining by code and by `#/r/ID` deep link).

## Flows and results
| Flow | Result |
|---|---|
| Landing page, no console errors | Pass |
| Create room, "Tap to start" gate, room view, QR / invite card | Pass |
| Join by code, join by deep link; device list with status chips | Pass |
| Host uploads 10 s wav, both devices ready, Play, pause, resume, seek, restart, next | Pass (Chromium desktop, Chromium mobile, WebKit mobile). Both devices showed the same position within one 100 ms poll step while playing; no console errors |
| Orchestra: demo library lists the demo, add, Orchestra on, Auto-assign (host Vocals+Other, guest Drums+Bass), play | Pass |
| Auto-calibrate with fake mic | UI flow runs (arming, step 1/2, analysing, result). The fake sine mic gives "low confidence": sensible error text and a per-device table with "unchanged (retry)" |
| Radar, full-screen radar, Space map, Lights on/off | Pass after fixes below |
| PWA: manifest (200, application/manifest+json), service worker registers and activates, `offline.html` renders, app shell loads while offline | Pass |
| Network lost banner and recovery (`setOffline`) | Pass after fix below |

## Bugs found and fixed
1. Seek bar and total time unusable for uploaded songs (`--:--`, slider disabled): the server never has `durationMs` for uploads. The UI now falls back to the decoded length (`AudioEngine.decodedDurationMs` in `client/src/lib/engine.ts`, used in `client/src/ui/Room.tsx`).
2. Sliders invisible in WebKit/Safari (native track transparent on the dark theme): custom range track and thumb styles in `client/src/styles.css`.
3. Tab labels wrapped ("Devices 2" on two lines) on a phone: `nowrap` plus fluid font size (`styles.css`).
4. Lights overlay: its "tap to exit lights" hint was drawn at 4% opacity (invisible). Background layer split from the text (`client/src/ui/LightShow.tsx`, `styles.css`).
5. Space map: all devices start at the same spot, so the host chip was hidden under the guest; duplicates are now stacked (`client/src/ui/SpatialMap.tsx`). The "Stereo" label overflowed its badge (`styles.css`).
6. Radar: devices with about 0 ms offset sat 24 px apart and their labels overlapped; minimum radius raised when several devices are shown (`client/src/ui/Radar.tsx`).
7. Connection loss was not noticed while the browser was offline (the WebSocket can stay half-open; no banner appeared within 2.5 s) and the status chip kept showing a green "Ready". Added `online`/`offline` listeners and a 12 s receive watchdog with immediate reconnect on `online` (`client/src/lib/net.ts`); the chip shows "Reconnecting" while the link is down (`client/src/ui/status.tsx`).
8. Invite card hint hardcoded port 3000; it now uses the current port (`client/src/ui/QrJoin.tsx`).

## Not verified
- Real audio output: headless browsers cannot be heard. "Playing" was judged from the engine's reported position, the status chips and the UI, not from sound. Whether each device actually plays its assigned stem was not heard.
- Real clock-sync accuracy across devices and networks: all browsers ran on one machine and one clock, so "+0.0 ms" proves nothing about real-world sync. The simulation and eval protocol cover that, not this test.
- Auto-calibrate with a real speaker and microphone (the fake mic only exercises the failure path).
- Real phones: iOS silent switch, wake lock, install to home screen, background tab behaviour. WebKit here is desktop WebKit with iPhone emulation, not iOS Safari.
- Firefox, Android Chrome; live share and announce (tab capture needs a real picker and HTTPS).
- Stem separation through the real separator service (only the demo library path was used).
