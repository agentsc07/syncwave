# SyncWave: 2-minute demo script (screen recording)

**Cast and kit:** 4 phones (A host, B, C, D), one of them (D) paired to a Bluetooth speaker; a laptop showing the projector view (sync radar). One pre-separated demo song ready in the Demo library. Screen-record phone A (host) plus a wide shot of the 4 phones on a table; show the laptop radar as an inset.

**Before recording (not on camera):** open the deployed URL and `/healthz` 2 minutes earlier so Render is awake; confirm the demo song is listed; phones charged, silent switch off, screen-timeout long; calibrate once in a dry run so you know the Bluetooth phone is the worst case. Room quiet.

| Time | Shot | Say / show |
| --- | --- | --- |
| 0:00–0:10 | Wide: one phone playing a song alone. | "One phone: thin and quiet. Here is what four of them can do." |
| 0:10–0:25 | Phone A: landing page, tap **Start a room**, QR + code appear. B, C, D scan the QR and tap **Join**. | "No app, no account. Scan, tap join." Show the device list filling with status chips (ready). |
| 0:25–0:35 | Phone A: **Orchestra** tab → **Demo library** → pick "Meaning" or "More Than That"; stems show ready instantly. | "Demucs, an AI model, has already split this song into vocals, drums, bass and other." |
| 0:35–0:50 | Toggle **Orchestra** on, tap **Auto-assign**. Hold up phones: A vocals, B drums, C bass, D other. | "Each phone gets its own part, assigned by where it sits in the room." |
| 0:50–1:05 | Press **Play**. Wide shot, camera listens. | "Four phones, four parts, one song, no echo." |
| 1:05–1:15 | Laptop: **Sync radar**, all dots green. | "Live offset per device in milliseconds: single digits." (Read the real numbers off the screen; do not say a number you do not see.) |
| 1:15–1:25 | Phone A: drag the vocals phone and the drums phone to swap sides on the map; assignment follows. Then tap **Everyone plays everything**. | "Reassign live, or fall back to the full song everywhere." |
| 1:25–1:45 | Pause. Show phone D (Bluetooth): it is audibly late when the full song plays. Tap **Auto-calibrate**: each phone chirps in turn, progress "Calibrating 2/4". | "Bluetooth adds an unknown delay the browser cannot see. Each phone plays a chirp; the host microphone measures it." |
| 1:45–1:55 | Results table: delay per device, trim set automatically, sync score green. | "Phone D was N ms late; trim set automatically. Score green." (Fill N from the screen.) |
| 1:55–2:00 | Press **Play** again; the echo is gone; close on the wide shot. | "Clock sync, Web Audio scheduling, Demucs and acoustic calibration. SyncWave." |

**If something fails live:** audio locked → tap **Tap to unlock audio**; Orchestra not ready → say "falling back to everyone plays everything" and continue; calibration "low confidence" → move the host phone closer, quiet the room, retry once; if it still fails, show the manual trim slider as the fallback.

**Recording tips:** record at 1080p, 30 fps; keep the radar visible during play; capture a separate 20-second take of the before/after Bluetooth gap with an external microphone for the report (see `docs/eval-protocol.md`, condition C).
