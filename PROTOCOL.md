# SyncWave contract (all agents build to this; do not deviate without editing this file)

Layout: `server/` (Node 20+, ESM, `express` + `ws`), `client/` (Vite + React + TS), `sim/` (Node ESM test harness). npm workspaces at root.
Server default port 3000 (env PORT). In prod server serves `client/dist` statically. In dev Vite proxies `/api`, `/media`, `/ws` to :3000.
Time: all timestamps are epoch-ms floats. "server time" = server `Date.now()`-based clock (use performance.now()-anchored for sub-ms).

## HTTP
- `POST /api/rooms` -> `{roomId, hostToken}` (roomId: 5 chars A-Z0-9, no ambiguous)
- `POST /api/rooms/:roomId/tracks` raw body (audio bytes), headers `x-filename`, `x-token` (hostToken or any joined deviceId) -> `{trackId}`; limit 100MB; server then broadcasts `state`.
- `GET /media/:trackId` -> the audio bytes (with Content-Type, Cache-Control public).
- `GET /api/rooms/:roomId` -> `{exists:boolean}`

## WebSocket `/ws` (JSON text frames, field `type`)
Client -> server:
- `ping {t0}`  -> server replies immediately `pong {t0,t1,t2}` (t1 recv, t2 send, server clock). Works before join.
- `join {roomId, name, deviceId, hostToken?}`  (deviceId: client-generated uuid, persisted in localStorage; hostToken marks host). Reply: `joined {deviceId, isHost}` then `state`.
- `ready {trackId}` device finished download+decode of trackId.
- Host-only (ignored otherwise): `play {}` `pause {}` `seek {positionMs}` `next {}` `volume {value}`(0..1) `setTrim {deviceId, ms}` `setChannel {deviceId, channel, x?, y?}` `lights {on}` `kick {deviceId}` `setTrack {trackId}`
- Host-only live audio: `liveStart {kind:'share'|'announce', bufferMs?}` (errors `live already active`; `share` also stops file playback, status 'stopped', track kept; `play` is refused with `live share active` while sharing), `liveStop {}`, `liveBuffer {ms}`. bufferMs is clamped: share 800..3000 (default 1500), announce 100..1000 (default 250). The live ends automatically if the source device disconnects or is removed.
- Any device: `setTrimSelf {ms}`, `report {offsetMs, driftMs, rtt}` (sync health shown on radar), `queueAdd {trackId}`, `queueVote {trackId}`, `leave {}`.
Server -> client:
- `state {…RoomState}` broadcast on every change (full snapshot, small).
- `pong`, `joined`, `error {message}`.

```ts
type Channel = 'stereo'|'left'|'right'|'center'|'rear-left'|'rear-right'|'sub'; // 'stereo' = full mix
interface Device { id:string; name:string; isHost:boolean; trimMs:number; channel:Channel; x:number; y:number /*0..1 room map*/;
  readyTrackId:string|null; offsetMs:number|null /*latest self-reported offset vs ideal*/; driftMs:number|null; rtt:number|null; lastSeen:number; connected:boolean }
interface Track { id:string; name:string; sizeBytes:number; votes:number; durationMs?:number }
interface Playback { status:'stopped'|'scheduled'|'playing'|'paused'; trackId:string|null;
  startServerTime:number|null; /* S: server time at which track position 0 plays (so position = serverNow - S). status 'scheduled' when S is in the future */
  pausedPositionMs:number }
interface RoomState { roomId:string; serverTime:number; devices:Device[]; tracks:Track[]; queue:string[] /*trackIds ordered by votes*/;
  playback:Playback; volume:number; lights:boolean; hostId:string;
  live:{kind:'share'|'announce'; sourceId:string /*deviceId*/; bufferMs:number}|null }
```
Server rules: `play` requires every connected device `readyTrackId===playback.trackId` else error `not all ready`; on play from stopped/paused sets S = now + 1500 - pausedPositionMs (status 'scheduled' -> 'playing' once S<=now... clients derive this themselves; server just stores S). `pause` stores pausedPositionMs = now - S. `seek` sets S = now+1000 - positionMs. `next` pops queue top (else next track in list) and sets playback to stopped with new trackId (clients preload; host presses play). Host leaves -> oldest connected device becomes host (host handoff). Rooms deleted 10 min after empty. Device disconnected >60s removed. Heartbeat via lastSeen on ping.
Late join = just read `state`; client computes position = serverNow - S.

## Client lib API (client/src/lib/*, UI imports only these)
- `clock.ts`: `class ClockSync { start(ws); stop(); serverNow():number /*ms*/; offsetMs:number; rtt:number; stability:number /*stddev ms of last offsets*/; onUpdate(cb) }` — 20 pings burst (~40ms apart), keep lowest-RTT 30%, median offset; repeat every 3s (burst of 8 after first).
- `engine.ts`: `class AudioEngine` — `unlock()` (call from user gesture), `load(trackUrl, trackId):Promise<void>` (fetch+decodeAudioData), `applyState(state, selfDevice)` (idempotent; schedules start on AudioContext clock: ctxTime = ctx.currentTime + (S - serverNow)/1000 - outputLatency - trim/1000; late join starts with offset into buffer), `setLocalVolume(v)`, `driftMs:number`, `getPositionMs()`, `analyser:AnalyserNode`, channel routing per `device.channel` (left/right/center via ChannelSplitter/gain; 'stereo' passthrough), drift loop every 2s: expected vs actual position; <40ms nudge playbackRate by ≤0.5% (BufferSource.playbackRate), >=40ms restart at correct offset. Emits `onReport({driftMs})`, `onBeat(cb)` (energy-based beat detector off analyser, fires at audio output time).
- `net.ts`: `class Session` wraps WebSocket (auto-reconnect, re-join), exposes `state` , `subscribe(cb)`, `send(msg)`, `deviceId`, `isHost`, `clock:ClockSync`, `engine:AudioEngine`; handles preload on new `playback.trackId`, sends `ready`, `report` every 2s, wake lock.
- UI components in `client/src/ui/`: `Home` (create/join), `Room` (host controls, device list, trim sliders, upload, queue), `Radar`, `SpatialMap`, `LightShow` (fullscreen beat flash), `QrJoin`. Routes by hash: `#/` home, `#/r/ROOMID` room, `#/r/ROOMID/radar`.

## Live audio (share / announce) — binary WebSocket frames
Only the current `live.sourceId` device (which must also be host) may send binary frames; the server relays each one verbatim to every *other* connected device in the room (never echoed back; dropped for receivers with >512 KB queued). Frames from anyone else, or while `live` is null, or shorter than the header, or with first byte != 1, are ignored. Client sets `ws.binaryType='arraybuffer'`.
Frame (little-endian), ~20 ms of audio each (960 frames @48k; max ws payload 64 KB):
`u8 version(=1) | u8 channels(1|2) | u16 frames | u32 seq | f64 captureServerTime(ms, SERVER clock = clock.serverNow(), first sample) | u32 sampleRate | Int16 interleaved PCM`  (header 20 bytes)
Playout: a receiver plays a chunk at server time `captureServerTime + live.bufferMs`, converted to the AudioContext clock with the same math as file playback (`planStart`: ctx = ctxNow + (S - serverNow)/1000 - outputLatency - trim). Chunks already past are dropped (partly-late ones are head-trimmed), duplicate/old `seq` ignored, missing `seq` leaves silence, and a chunk whose planned start is within 6 ms of the previous chunk's end is butted up to it (no clicks). Chunks are played at their native sampleRate (the browser resamples), so devices with different context rates stay consistent. The source device plays its own stream through the same path (share only). During `announce`, file playback keeps running but its gain is ducked to 0.25 on every device; the announcer's own device does not play the voice back (feedback). The `live` field changing (kind/source) resets the receiver's sequence tracking.

## Auto-calibration
Replaces hand-tuning Bluetooth trim (the sliders stay as a manual override). The host device is the microphone.
- State: `RoomState.calibration = {status:'idle'|'running'|'done'|'failed', phase:'idle'|'arming'|'step'|'analysing'|'done', runId, step, total, deviceId, results:{[deviceId]:{delayMs, score, trimMs?, error?}}, error}`; `Device.syncScore` (0..100, null until calibrated). `error`: `mic-denied`, `insecure-context`, `mic-error`, `mic-timeout`, `low-confidence`, `result-timeout`, `host-left`, `cancelled`.
- Host -> server: `calibrateStart {}` (refused while playing/live), `calibrateCancel {}`, `calibrateReady {runId}` (mic open; ends `arming`), `calibrationResult {runId, results:{[deviceId]:{delayMs, score, error?}}}` or `{runId, error}` (e.g. `mic-denied`). `play`/`liveStart` are refused with `calibrating` during a run.
- Server -> all: `calibrateStep {runId, step, total, deviceId, times:[3 server-ms], chirp:{f0,f1,durMs}}`. The named device plays a chirp (log sweep 2-8 kHz, 100 ms, Hann) so it is *audible* at each `times[k]` (ctx = ctxNow + (t - serverNow)/1000 - outputLatency, via `planStart`, trim NOT applied, channel routing bypassed). The host mic (echoCancellation/noiseSuppression/autoGainControl off) records on the AudioContext clock, host first, then the other connected devices one at a time; per step: 1.2 s lead + 3 chirps 1.5 s apart + 0.7 s tail. Timeouts: 10 s for `calibrateReady`, 15 s for `calibrationResult`; a disconnected target is skipped (`disconnected`); host leaving aborts.
- Analysis (`client/src/lib/calibrate.ts`): FFT normalised cross-correlation per repeat in a window [-200, +1000] ms around the intended arrival, earliest peak >= 70 % of max, parabolic sub-sample interpolation, PSR (peak / largest correlation outside +-30 ms) as confidence, repeats with PSR < 3.5 rejected (need 2 of 3), median delay. `delayMs = measured arrival - intended arrival` (positive = device is late). Score = 60 % residual jitter (0 ms -> 1, 5 ms -> 0) + 40 % PSR (3.5 -> 0, 12 -> 1), scaled by accepted repeats.
- **Trim convention** (matches `ctx = ... - trim/1000`: positive trim = start earlier): `trim_i = delay_i - delay_ref`, rounded to 0.1 ms and clamped to +-2000. `ref` = the host device's delay (else the median of the good delays). So late devices get positive trim, early devices negative. Aligning *relative to the host* cancels the mic's own input latency, which is common to all measurements. The new trim replaces the old one (calibration plays with trim 0). Devices that fail keep their trim.
