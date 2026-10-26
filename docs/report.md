# SyncWave: report

**Applied AI & Data Science project.** SyncWave plays one audio stream on many phones and laptops at once, in the browser, and uses data-driven features to make the result better than plain synchronisation: acoustic delay measurement (auto-calibration), beat-synced lights, and, as a prototype that is switched off for now, source separation (Demucs).

## Problem

A room of people carries many small speakers but no easy way to use them together. Playing the same sound from several speakers needs them aligned to within about 10 ms (beyond roughly 20–30 ms it sounds like an echo). Three things stand in the way: device clocks disagree by seconds, networks add jitter, and every device has its own output latency, which is unknown to the browser and can exceed 100 ms for Bluetooth speakers. Existing multi-room products avoid this by requiring matching hardware.

## Method

**Synchronisation (baseline).** Each device estimates its offset from a server clock with NTP-style ping exchanges (20 pings, keep the lowest-RTT 30 %, median; repeated every 3 s). The room stores a single fact, "the track started at server time S", so position is server-now − S. Each device decodes the file fully, then schedules playback on the Web Audio clock at S minus the browser-reported output latency, and corrects drift every 2 s (rate nudge up to 0.5 % under 40 ms, re-seek above).

**Feature A: Orchestra mode (source separation): prototype, switched off in the UI ("coming soon").** Demucs htdemucs splits a song into four stems (vocals, drums, bass, other); the server can call a local separator service (cached by content hash), and assigns stems to devices by their positions on a room map. All stems of a device start at one scheduled instant from a shared anchor, so the sync model and drift correction are unchanged. The deployed version ships two pre-separated CC BY demo songs and does not run Demucs live, because CPU separation of a full song takes minutes; separating your own songs runs locally.

**Feature B: acoustic auto-calibration (signal processing).** The browser cannot see how late a speaker actually sounds. The server therefore asks each device in turn to play a 100 ms log-sweep chirp (2–8 kHz, Hann-windowed, three repeats) while the host's microphone records with echo cancellation and gain control off. A normalised cross-correlation (FFT) of the recording against the known chirp gives each arrival time, refined to sub-sample precision by parabolic interpolation. The earliest strong peak is used so a louder room reflection does not win; confidence is the peak-to-sidelobe ratio; the delay is the median of accepted repeats. Each trim is set relative to the host device (so the microphone's own latency cancels), and a 0–100 sync score combines repeat jitter and confidence.

## Evaluation

| Measurement | Simulated | Real devices |
| --- | --- | --- |
| Start offset, median / worst (5 devices, 600 s, 10 ms jitter) | 1.10 ms / 10.87 ms | pending |
| Offset in final 60 s | median 0.97 ms, worst 4.36 ms | pending |
| Calibration accuracy | within 0.5 ms on synthetic recordings (187.3 ms and −4.2 ms delays, with a 90 % echo and an overlapping chirp) | pending |
| Bluetooth device before → after calibration | n/a | pending |
| Late join, join time | n/a | pending |

Targets from the spec: median < 10 ms, worst < 20 ms, held for 10 minutes. The simulator runs the real server with N fake devices that have injected latency, jitter, clock skew and drift, so it tests the estimator, scheduling and drift loop; it does **not** model real audio-output hardware. The real-device protocol (4–5 devices incl. a Bluetooth speaker and an iPhone, one external recorder, conditions A–F) and an analysis script that computes onset gaps and drift from a recording are in `docs/eval-protocol.md` and `eval/analyze.py`; the script is tested on synthetic recordings only. **No real-device measurement has been made yet**, and no claim about real-world accuracy should be drawn from the simulated numbers.

Testing: 9 server test files, 9 separator tests (mocked model) and 5 analysis tests pass; one real Demucs run on a 15 s synthetic file produced four stems in about 20 s. The UI, PWA and audio capture have been built and type-checked but not exercised in a browser.

## Limitations

- No real-device results yet; browser audio behaviour (iOS Safari, AudioWorklet capture, decode of real MP3s) is unverified.
- Calibration cannot separate sound travel time (~3 ms/m) from device latency, so it aligns to the host's position; if the host is itself a Bluetooth output, everyone aligns to it. Latency that changes over time (Bluetooth) is measured once, not tracked.
- Calibration is validated only on synthetic data; noisy rooms yield "low confidence" and no change.
- Separation is slow on CPU (a 70 s excerpt took on the order of a minute on a laptop; full songs take minutes) so it is not deployed. Stems are lossy MP3 (128 kbps) and have some bleed between stems.
- Orchestra uses more memory and bandwidth per phone (full mix plus stems); removing a stem mid-play may click.
- Free Render tier: cold starts, ephemeral disk (uploads are temporary), single instance.
- Users play their own files; streaming services are out of scope.

## Next steps

1. Run the real-device protocol and replace the "pending" cells; tune the analysis threshold on real recordings.
2. Deploy the single Render service (done in config, not yet live) and optionally host the separator for live separation.
3. Track Bluetooth latency over time (periodic inaudible re-calibration) rather than measuring once.
4. Skip downloading the full mix on stem-only devices; fade stems on reassignment.
5. Use the sync score to warn about, or automatically re-calibrate, devices that drift out of range.
