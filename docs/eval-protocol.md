# SyncWave real-device evaluation protocol

Goal: measure the spec success metrics (spec.md, "Success metrics") with 4-5 real devices and one external recorder: start offset (median < 10 ms, worst < 20 ms), drift after 10 min (< 10 ms), late-join landing (< 15 ms), join time (< 10 s).

All analysis is done by `eval/analyze.py` from recordings of a known click train.

## 0. Prepare (once)

1. Install the analysis tools (any venv):
   `python3 -m venv .venv-eval && .venv-eval/bin/pip install -r eval/requirements.txt`
2. Generate the test signals:
   `.venv-eval/bin/python eval/make_test_signal.py`
   This writes `eval/signals/test_10min.wav` (602 s: a chirp click every 2 s at even seconds, plus a long down-sweep MARKER at 1 s, 301 s and 601 s = minute 0, 5, 10) and `eval/signals/test_30s.wav` (30 s, markers at 1, 15, 29 s), each with a `.json` sidecar.
   If the 58 MB wav is too big to upload, convert: `ffmpeg -i eval/signals/test_10min.wav -b:a 192k eval/signals/test_10min.mp3`. Use the same file in every condition.
3. Start the server (`npm run build && npm start`), note the LAN IP, create `mkdir recordings` in the project root (or `eval/recordings`; keep one place).
4. Devices (4-5, record exact models in `eval/devices.txt`): must include
   - D1: an iPhone (Safari) with the silent switch OFF, volume ~70%;
   - D2: an Android phone (Chrome);
   - D3: a laptop (Chrome or Firefox);
   - D4: a phone/tablet connected to a **Bluetooth speaker or earbuds** (the only Bluetooth device; used in condition C);
   - D5 (optional): another phone or tablet.
   Set the same media volume on all, disable auto-lock, put them on the same Wi-Fi (or hotspot, say which in the notes).
5. Recorder: one extra phone (not part of the room) with a voice-memo app set to WAV/lossless, or a USB mic into a laptop (Audacity, 48 kHz, mono or stereo). Disable noise suppression / auto-gain if the app allows. Export recordings as WAV (`ffmpeg -i in.m4a -ar 48000 recordings/X.wav` if needed).
6. Room layout: quiet room, devices in a circle of ~1.5 m radius around the recorder, all speakers pointing at it, so every device is about equally far from the mic (1 ms of error = 34 cm; keep distances within ~10 cm of each other, measure with a tape). The Bluetooth speaker's driver counts as its position. Recorder in the centre, ~20 cm above the table. Nobody talks or moves during a take.
7. Gain check: do a 30 s take with all devices; waveform must not clip, and each click must be clearly visible 5 times (Audacity zoomed). Fix levels before starting.

Notation: `<condition>_<trial>.wav`, e.g. `recordings/A_1.wav`. Do trials as fresh sessions where stated. Minimum 3 repetitions per condition (5 for F).

## Condition A: baseline start offset (calibration OFF, trims 0)

Purpose: sync quality from clock sync alone.

1. Fresh room. On every device set trim to 0 and make sure auto-calibration is OFF/never run (reload the page if unsure).
2. Host uploads `test_30s.wav`. All devices join, tap "Tap to start", wait until all show ready and the radar is green.
3. Start recorder (wait 3 s of silence), host presses Play, let the 30 s run, stop recorder after the track ends.
4. Save as `recordings/A_<trial>.wav`. Repeat 3x; for each trial close and rejoin all devices (new clock sync) and recreate the room.
5. Record per trial: date/time, network, devices present, radar offsets read at start (screenshot), anything odd (a device joined late, underruns).
6. Analyse: `python eval/analyze.py recordings/A_1.wav --devices 5 --name A_1 --plot`
   Fields to copy: median spread, p95, worst. Pass if median < 10 ms and worst < 20 ms.

## Condition B: after auto-calibration

1. Same setup as A (fresh room, same devices and positions). Run auto-calibrate (host mic listens while each device plays its chirp). The host phone must be at the recorder position for the calibration, then move it back to its circle spot (or use the recorder phone as host mic).
2. Note the trim each device ends up with (screenshot of the trims).
3. Record the 30 s take as in A, save `recordings/B_<trial>.wav`. 3 trials, re-calibrating each time.
4. Analyse each, and compare to A: `python eval/analyze.py --compare recordings/A_1.wav recordings/B_1.wav --devices 5`.

## Condition C: Bluetooth device before vs after calibration

Same as A/B but the table focuses on D4.

1. Fresh room with D4 on the Bluetooth speaker/earbuds (confirm audio comes out of the Bluetooth device, not the phone speaker). Trims 0, calibration OFF. Record 30 s: `recordings/C_<trial>_before.wav`.
2. Run auto-calibration (or, if it fails for Bluetooth, set the trim by hand from the A-style measurement and note "manual"). Record 30 s: `recordings/C_<trial>_after.wav`.
3. 3 trials. Do not move the Bluetooth device between before/after.
4. Analyse: `python eval/analyze.py --compare recordings/C_1_before.wav recordings/C_1_after.wav --chirp-ids D1,D2,D3,D5,D4 --name C_1`
   The per-device table shows the offset of the Bluetooth device. `--chirp-ids` labels devices in sorted arrival order, so on the "before" take the Bluetooth device is normally last (set the order from what you hear and see in Audacity; check the plot).
   Record the Bluetooth device's offset in ms before and after.

## Condition D: drift at minute 10

1. Fresh room, calibration as you normally would use (state which: ON/OFF), upload `test_10min.wav`.
2. Open the sync radar on the host (or a spare laptop) and enable the radar/log export. Start the recorder (single continuous take, ~11 min), press Play. Do not touch any device for 10 minutes. Do not let any screen lock.
3. After the track ends, export the sync radar log (JSON/CSV from the radar screen). If your build has no export button, copy the numbers shown each minute into `recordings/D_<trial>_radar.csv` with the columns `minute,device,offsetMs,driftMs`.
4. Save as `recordings/D_<trial>.wav` and the log as `recordings/D_<trial>_radar.json` (or `.csv`). 3 trials (so ~35 min total).
5. Analyse: `python eval/analyze.py recordings/D_1.wav --devices 5 --name D_1 --plot`
   Read "drift per marker": markers 1/2/3 are minute 0, 5, 10; the number for marker 3 is the drift after 10 min. Pass if < 10 ms. Also note the "spread trend (ms/min)" from `results/D_1.csv`.
   Compare with radar: the radar's reported driftMs near minute 10 against the measured value.

## Condition E: late join

1. Fresh room, 4 devices playing `test_10min.wav` (long enough to leave time for the join). Start recorder, press Play.
2. At about minute 1 (note the exact moment with a stopwatch), the 5th device (D5, or D4 if only four) joins by QR scan and taps "Tap to start". The song continues; do not pause.
3. Let it run until at least 20 s after the new device becomes audible, then stop. Keep going to cover several clicks after the landing (the join device should already be locked in).
4. Save `recordings/E_<trial>.wav`. Repeat 3x with different join times (e.g. minute 1, 2, 3), using a fresh room each time and a different device as the joiner (rotate the iPhone at least once).
5. Analyse: `python eval/analyze.py recordings/E_1.wav --devices 5 --name E_1`
   Clicks before the join have only N-1 devices and are reported as "skipped (wrong device count)". The first click after the join with 5 peaks gives the landing error: read it from `results/E_1.csv` (first `click` row; spread_ms = landing error vs the group). Also look at the next few rows to see whether the joiner settles. Pass if the first 5-device click spread is < 15 ms.
   To measure with the joiner only, run the analysis with `--devices 5` on the post-join part; if the joiner is not yet audible at a click, that click is skipped.

## Condition F: join time (stopwatch)

1. Room already created, host device playing the 30 s test signal on loop or a normal track. Joiner device with the browser closed (or at the home screen), camera ready.
2. Start the stopwatch the instant the QR code is scanned (camera recognises it), stop it at the first audible sound from the joiner that is in time with the group (or the radar going green, whichever the app shows later; state which).
3. 5 trials, rotating the joiner (iPhone, Android, laptop). Same network each time.
4. Enter the 5 times in `results/F_join_times.csv` (below). Pass if the median is < 10 s and each is below 15 s.

## Results templates (CSV)

Copy these to `eval/results/`; fill by hand from `analyze.py` output.

`eval/results/summary_real.csv`:

```
condition,trial,date,network,n_devices,calibration,median_ms,p95_ms,worst_ms,drift_10min_ms,landing_ms,bt_offset_ms,notes
A,1,,wifi,5,off,,,,,,,
A,2,,wifi,5,off,,,,,,,
A,3,,wifi,5,off,,,,,,,
B,1,,wifi,5,auto,,,,,,,
B,2,,wifi,5,auto,,,,,,,
B,3,,wifi,5,auto,,,,,,,
C,1,,wifi,5,before,,,,,,,
C,1,,wifi,5,after,,,,,,,
C,2,,wifi,5,before,,,,,,,
C,2,,wifi,5,after,,,,,,,
C,3,,wifi,5,before,,,,,,,
C,3,,wifi,5,after,,,,,,,
D,1,,wifi,5,auto,,,,,,,
D,2,,wifi,5,auto,,,,,,,
D,3,,wifi,5,auto,,,,,,,
E,1,,wifi,5,auto,,,,,,,
E,2,,wifi,5,auto,,,,,,,
E,3,,wifi,5,auto,,,,,,,
```

`eval/results/F_join_times.csv`:

```
trial,joiner_device,browser,network,qr_scan_to_sound_s,notes
1,,,,,
2,,,,,
3,,,,,
4,,,,,
5,,,,,
```

Side by side with the simulator: put the sim numbers for the same conditions into a JSON (`{"median_ms":..,"p95_ms":..,"worst_ms":..,"drift_ms":..}`; copy them from `npm run sim` output) and pass `--sim-json sim_A.json` to `analyze.py` to get a "real | sim" table.

## Reading the numbers (and limits)

- spread = max minus min onset across devices for the same click; median/p95/worst are over all clicks in the take (about 14 for the 30 s file, about 300 for the 10 min file). Report all three.
- Acoustic path differences (each device at a slightly different distance) add up to ~0.03 ms per cm; keep the layout within a few cm and state the measured spread of distances in the report.
- Two devices whose onsets differ by less than 0.4 ms cannot be told apart by the analyser; this only matters if they are essentially perfectly in sync, and in that case the spread is still right.
- `analyze.py` identifies devices by arrival order. Per-device tables are therefore only meaningful when device order does not change between clicks.
- If a click shows fewer than N peaks (device too quiet, dropout), it is skipped and counted under "skipped"; large skip counts mean a bad take (check gain and positions).
- Keep the raw WAVs and the CSVs; include a screenshot of the waveform of one take (Audacity, zoomed on one click) in the report as evidence.
