# SyncWave: 2-minute demo script (screen recording)

**Cast and kit:** 4 phones (A host, B, C, D), one of them (D) paired to a Bluetooth speaker; a laptop (host for the mic and tab share) showing the sync radar. The built-in demo songs are in the Play tab ("Demo songs"). Record phone A / the laptop screen plus a wide shot of the phones on a table.

**Before recording (not on camera):** open the deployed URL and `/healthz` 2 minutes earlier so Render is awake; phones charged, silent switch off, screen-timeout long; do one dry run of Auto-calibrate so you know the Bluetooth phone is the worst case. Room quiet. Use Chrome on the laptop (tab share needs desktop Chrome/Edge).

| Time | Shot | Say / show |
| --- | --- | --- |
| 0:00–0:10 | Wide: one phone playing a song alone. | "One phone: thin and quiet. Here is what four of them can do." |
| 0:10–0:25 | Laptop: landing page, **Start a room**, QR + code appear. A, B, C, D scan the QR and tap **Join**. | "No app, no account. Scan, tap join." Show the device list filling with status chips (ready). |
| 0:25–0:40 | Laptop: Play tab → **Demo songs** → "Meaning" → **Add to room**; wait for "4/4 devices ready", press **Play**. | "Every device downloads the song first, then all start at the same scheduled instant." |
| 0:40–0:50 | Wide shot, camera listens. | "Four phones, one song, no echo." |
| 0:50–1:05 | Laptop: **Sync radar**, dots green. | "Live offset per device in milliseconds." (Read the real numbers off the screen; do not say a number you do not see.) |
| 1:05–1:20 | Tap **Lights** on the laptop. Wide shot: every phone flashes on the beat together; downbeats flash bigger. | "The app analyses the song's beats once, so every screen flashes on the same beat." (If the room is bright, show the **Soft mode** toggle.) |
| 1:20–1:40 | Pause. Show phone D (Bluetooth) audibly late. Tap **Auto-calibrate**: each phone chirps in turn, progress "Calibrating 2/4". | "Bluetooth adds an unknown delay the browser cannot see. Each phone plays a chirp; the laptop microphone measures it." |
| 1:40–1:50 | Results table: delay per device, trim set automatically, sync score green. Press **Play** again; the echo is gone. | "Phone D was N ms late; trim set automatically." (Fill N from the screen.) |
| 1:50–2:00 | Hold the **Announce** button and speak into the laptop: it comes out of all the phones about 0.7 s later. | "And hold to talk: a walkie-talkie across every speaker. SyncWave." |

**Optional (Chrome desktop):** instead of the demo song, use **Share tab audio** on a YouTube/Spotify web tab you are allowed to play, to show live audio on every device (about 1.5 s delay).

**Not in the demo:** Orchestra mode (per-phone stems) is marked "coming soon".

**If something fails live:** audio locked → tap **Tap to unlock audio**; calibration "low confidence" → move the laptop closer, quiet the room, retry once, else show the manual trim slider; Announce silent → check the mic level meter on the host and that the page is on `https://`.

**Recording tips:** 1080p, 30 fps; keep the radar visible during play; capture a separate 20-second take of the Bluetooth before/after gap with an external microphone for the report (see `docs/eval-protocol.md`, condition C).
