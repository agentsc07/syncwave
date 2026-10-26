# Deploying SyncWave (Hugging Face Space + Render, all free tier)

Nothing here has been deployed for you. Layout: **Render** runs the SyncWave server and the web client (`render.yaml`); a **Hugging Face Space** runs the Demucs stem separator (`separator/`). The app works without the Space (only "Separate this song" is disabled; demo songs still work).

## What you do vs what is automated

| You | Automated |
|---|---|
| Create the HF Space, add the secret, push `separator/` files | HF builds the Docker image and downloads the model |
| Push this repo to GitHub, connect it to Render, set 2 secrets | Render builds (`npm ci && npm run build`), starts, health-checks `/healthz`, issues HTTPS, redeploys on each push |
| Pre-separate demo songs and commit them | Server serves them from `server/demo/` |
| Wake both services before a demo | Server heartbeat keeps WebSockets alive; old uploads are evicted |

GitHub private repo: fine. During Render's "Connect GitHub" step install the Render GitHub app and grant it access to this repo (Only select repositories). A private repo cannot be used with a bare "Public Git Repository" URL.

## A. Hugging Face separator

1. Generate a secret and keep it: `openssl rand -hex 32`
2. huggingface.co -> New Space -> name `syncwave-separator`, SDK **Docker** (Blank), hardware **CPU basic (free)**, visibility Public (the token protects the API).
3. Space -> Settings -> Variables and secrets -> **New secret**: `SEPARATOR_TOKEN` = the value from step 1.
4. Copy the files and push (use an HF access token with write scope as the password):
   ```
   git clone https://huggingface.co/spaces/<hf-user>/syncwave-separator hf-space
   cp -R separator/{app.py,Dockerfile,requirements.txt,README.md,.dockerignore} hf-space/
   cd hf-space && git add . && git commit -m "separator" && git push
   ```
5. First build takes about 5-10 min (installs torch, downloads htdemucs). Watch the Space "Logs" tab.
6. Verify: `curl https://<hf-user>-syncwave-separator.hf.space/health` -> `{"ok":true,...}`

Details: `separator/README.md`.

## B. Render web service

1. Push this repo to GitHub (private is fine). `.env`, `*.pem`, `uploads/` are git-ignored.
2. render.com -> **New +** -> **Blueprint** -> connect GitHub, pick the repo (install the Render GitHub app if asked) -> Render reads `render.yaml`.
3. When prompted for the `sync: false` values set:
   - `SEPARATOR_URL` = `https://<hf-user>-syncwave-separator.hf.space` (no trailing slash)
   - `SEPARATOR_TOKEN` = the same secret as the Space
   Leave both empty to deploy without separation; add later under Service -> Environment.
4. Click **Apply**. First build takes about 3-5 min. The service is live when the dashboard says "Live".
5. Verify: `curl https://<service>.onrender.com/healthz` -> `{"ok":true,...}`, then `node scripts/smoke.mjs https://<service>.onrender.com` (Node 22+, or `node --experimental-websocket ...` on 20) should print `RESULT: PASS`.
6. Open the URL on two phones: create a room on one, scan the QR on the other, upload/pick a demo, press play.

## C. Pre-separated demo songs

The free Render disk is ephemeral, so anything uploaded at runtime vanishes on restart/redeploy. Demo songs must live in the repo.

1. Use only music you have the right to use: your own tracks, or royalty-free / CC0 / Creative Commons-licensed (search "Free Music Archive CC0", "Pixabay Music", "Incompetech"). Check the license allows redistribution. Do not commit commercial songs to a public or shared repo.
2. Locally (Python 3.10-3.11, ffmpeg, torch + demucs; see `separator/README.md` "Run locally"):
   ```
   cd separator
   python make_demo_stems.py ~/Music/song1.mp3 --out ../server/demo
   ```
3. Check size: `du -sh server/demo`. Each song is about 16 MB (4 stems x ~4 MB); keep to 2-3 songs (GitHub warns at 50 MB per file, repo should stay small).
4. Commit and push: `git add server/demo && git commit -m "demo stems" && git push` (Render redeploys automatically). `server/demo/README.md` says no audio is committed by default; this step changes that on purpose.
5. Verify: `curl https://<service>.onrender.com/api/demo` lists the songs.

## D. Free-tier caveats

- **Render** sleeps after ~15 min idle; cold start about 50 s. Rooms are in memory, so a restart ends all rooms. Single instance only.
- **HF Space** sleeps after inactivity; waking takes about a minute. A separation of a 4 min song takes 5-10 min on free CPU.
- Uploaded files are temporary (also capped by `MAX_UPLOAD_MB`, default 500, oldest evicted first; `UPLOAD_TTL`, default 6 h).
- **Wake-up step, 2 minutes before a demo:**
  ```
  curl -s https://<service>.onrender.com/healthz
  curl -s https://<hf-user>-syncwave-separator.hf.space/health
  ```
  Repeat until both return JSON.

## E. HTTPS

Render and HF provide HTTPS automatically, so the mic (Announce, auto-calibrate), tab capture, wake lock and PWA install all work on phones with no mkcert. The client uses `wss://` automatically.

## F. Post-deploy smoke test

- [ ] `/healthz` returns ok
- [ ] `node scripts/smoke.mjs <url>` prints PASS
- [ ] Two phones join one room, both show ready, play starts together
- [ ] Upload a short mp3; guest can play it
- [ ] Demo library lists songs; Orchestra auto-assign splits stems across phones
- [ ] "Separate this song" starts and progress moves (or says not configured)
- [ ] Announce (mic) asks for permission on the phone
- [ ] Leave phones idle 3 min: sockets stay connected (heartbeat)

| Symptom | Fix |
|---|---|
| First request takes ~50 s or times out | Render cold start; wait and retry, use the wake-up step |
| Render deploy fails at build | Check logs; Node must be 20 (`NODE_VERSION`); run `npm ci && npm run build` locally |
| Health check failing | Service must listen on `PORT` (it does); check logs for a crash; path is `/healthz` |
| "Stem separation is not configured" | `SEPARATOR_URL` / `SEPARATOR_TOKEN` unset; set in Render Environment, redeploy |
| "separator rejected the token" | Token differs from the Space secret; re-set both |
| "separator unreachable" | Space asleep or still building; curl its `/health`, wait a minute |
| Demos list empty | `server/demo/<slug>/` not committed (needs manifest.json + 4 mp3s) |
| Uploaded track 404s later | Ephemeral disk / eviction; re-upload |
| 429 too many uploads/rooms | Per-IP limits (`UPLOAD_RATE`, `ROOM_RATE`); wait or raise |
| Socket drops on phone | Screen lock; keep screen on; page reconnects |
| Mic denied | Must be HTTPS (it is) and permission allowed for the site |
