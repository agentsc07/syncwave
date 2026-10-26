---
title: SyncWave Separator
emoji: 🎛️
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# SyncWave stem separator

Demucs `htdemucs` (4 stems: vocals, drums, bass, other) on CPU behind a small FastAPI job API.
Stems are encoded to 128 kbps MP3. Results are cached on disk by SHA-256 of the uploaded audio, so a repeat upload returns instantly.

## API

All routes except `/health` need `Authorization: Bearer $SEPARATOR_TOKEN` (also accepted: `x-token` header, `token` form/query field). If `SEPARATOR_TOKEN` is unset, auth is off (local dev only).

| Route | Description |
|---|---|
| `GET /health` | `{ok, model, queued, authRequired}` |
| `POST /jobs` | multipart field `file` -> 202 `{jobId, status, progress, cached, stems}`; cache hit returns `status:"done"` at once. `POST /separate` is an alias |
| `GET /jobs/{id}` | `{status: queued\|running\|done\|error, progress 0..1, stems:{vocals,drums,bass,other: url}, error}` |
| `GET /jobs/{id}/stems/{name}.mp3` | the MP3 (needs the auth header too). Stem URLs in job JSON are relative paths (prefix with the Space URL; avoids http/https mixups behind the proxy) |

Limits: 8 min audio (`MAX_DURATION_SEC`), 60 MB upload (`MAX_UPLOAD_MB`), one separation at a time (single worker, `-j 1`, 7 s segments, so RAM stays well under 16 GB). The job table is in memory (lost on restart); the stem cache lives in `CACHE_DIR` (ephemeral on free Spaces, keeps the last 20 songs).

Expect roughly 1-3x realtime on the free 2 vCPU tier, so a 4 min song can take 5-10 min. Poll `GET /jobs/{id}` every few seconds.

## Deploy to Hugging Face Spaces (you do this, nothing here pushes for you)

1. Generate a secret: `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`.
2. huggingface.co -> New Space -> SDK **Docker** (blank template), hardware **CPU basic (free)**, name e.g. `syncwave-separator`. Visibility: public is fine (the token protects the API) or private (then the server must also send an HF token; public is simpler).
3. Space -> Settings -> **Variables and secrets** -> New secret: name `SEPARATOR_TOKEN`, value = the string from step 1.
4. Push only this folder's contents (the README front-matter must be at the repo root of the Space):
   ```
   git clone https://huggingface.co/spaces/<your-user>/syncwave-separator hf-space
   cp -R separator/{app.py,Dockerfile,requirements.txt,README.md,.dockerignore} hf-space/
   cd hf-space && git add . && git commit -m "separator" && git push
   ```
   (Use a Hugging Face access token with write scope as the password.)
5. Wait for the build (~5-10 min; it downloads the htdemucs weights). Then check:
   `curl https://<your-user>-syncwave-separator.hf.space/health`
6. On the SyncWave server (Render) set `SEPARATOR_URL=https://<your-user>-syncwave-separator.hf.space` and `SEPARATOR_TOKEN=<same secret>`.

Free Spaces sleep after inactivity; the first request wakes it (about a minute). Hence pre-separate demo tracks with `make_demo_stems.py`.

## Run locally

Needs Python 3.10-3.11 and ffmpeg.
```
cd separator
python3.11 -m venv .venv && source .venv/bin/activate
pip install torch==2.2.2 torchaudio==2.2.2          # CPU wheels (on Linux add: --index-url https://download.pytorch.org/whl/cpu)
pip install -r requirements.txt
cp .env.example .env   # then: export SEPARATOR_TOKEN=...   (or leave unset for no auth)
uvicorn app:app --port 7860
```
Try it:
```
curl -H "Authorization: Bearer $SEPARATOR_TOKEN" -F file=@song.mp3 localhost:7860/jobs
curl -H "Authorization: Bearer $SEPARATOR_TOKEN" localhost:7860/jobs/<jobId>
curl -H "Authorization: Bearer $SEPARATOR_TOKEN" -o vocals.mp3 localhost:7860/jobs/<jobId>/stems/vocals.mp3
```
Docker: `docker build -t separator . && docker run -p 7860:7860 -e SEPARATOR_TOKEN=dev separator`

## Tests (no model needed)

```
pip install -r requirements-dev.txt fastapi python-multipart
SEPARATOR_NO_AUTOSTART=1 pytest tests
```

## Pre-separate demo tracks

```
python make_demo_stems.py songs/a.mp3 songs/b.wav --out demo
```
Writes `demo/<slug>/{vocals,drums,bass,other}.mp3`, `manifest.json` per track and `demo/index.json`. Runs locally (needs torch + demucs). Commit/serve those files from the SyncWave server so the demo needs no separation.
