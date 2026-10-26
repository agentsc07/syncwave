# Deploying SyncWave (one Render service, free tier)

The deployed version is a **single Render web service**: Node server + built client + the pre-separated demo songs in `server/demo/`. Live Demucs separation is **not** deployed; it is run locally (see "Optional" below). Orchestra mode works in the deployed app through the **Demo library**.

## What you do vs what is automated

| You do | Automated |
| --- | --- |
| Push the repo to GitHub, connect it to Render | Render builds (`npm ci && npm run build`) and starts the server |
| Open the live URL on phones | HTTPS, WebSocket (wss), PWA install, mic permission all work on `https://` |

## 1. Push to GitHub

```
gh repo create agentsc07/syncwave --private --source=. --remote=origin --push
```

(Private is fine: Render connects through its GitHub app.)

## 2. Render

1. render.com -> **New -> Blueprint** -> pick `agentsc07/syncwave` -> it reads `render.yaml` -> **Apply**. (If it asks for a region, `oregon` is a placeholder; pick the one nearest you.)
2. Wait for the first deploy (about 3-5 min). Open `https://<service>.onrender.com/healthz` -> `ok`.
3. Smoke test from your laptop:
   ```
   node scripts/smoke.mjs https://<service>.onrender.com
   ```
   Expect `RESULT: PASS`.

## 3. Demo songs

Two CC BY 4.0 songs are committed under `server/demo/` (attribution in `server/demo/README.md`). To add more, separate them locally with `separator/make_demo_stems.py` (see `server/demo/README.md`), commit, push; Render redeploys.

## Free-tier caveats

- **Render sleeps** after ~15 min idle; the first request takes ~50 s. Open the URL and `/healthz` 2 minutes before a demo.
- **Uploaded files are temporary** (ephemeral disk; removed after 6 h, on restart, or when the 500 MB cap is hit). The UI says so. Demo songs are part of the build and are not affected.
- Rooms live in memory on a single instance; a restart closes all rooms.

## Post-deploy checklist (laptop + 2 phones)

- [ ] `/healthz` ok; page loads with HTTPS padlock; "Add to Home Screen" offered on the phone
- [ ] Create room on laptop, scan QR on a phone, join in under 10 s
- [ ] Upload a short song or add a Demo library song; every device shows ready; play; no echo
- [ ] Sync radar shows live offsets; Orchestra auto-assign gives different stems to different phones
- [ ] Auto-calibrate runs (needs mic permission on the host; quiet room)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Page spins ~50 s | Cold start; wait, then retry |
| Phone cannot use mic / tab capture | Must be `https://` (the Render URL is) - not a LAN IP |
| Old UI after a deploy | Close the app / hard refresh; the service worker updates on next load (a "Refresh" toast appears) |
| Demo library empty | `server/demo/<slug>/` needs `manifest.json` and all four `.mp3` files committed |
| Sockets drop when idle | Server pings every 25 s; check Render logs if it persists |

## Optional: live Demucs separation (run locally, not deployed)

`separator/` is a FastAPI + Demucs service. Run it on your own machine (`separator/startup.md`), then start SyncWave locally with:

```
SEPARATOR_URL=http://localhost:7860 SEPARATOR_TOKEN=<token> npm start
```

It can also be deployed as a Hugging Face Docker Space (`separator/README.md`), then set `SEPARATOR_URL` / `SEPARATOR_TOKEN` in Render's Environment. That path is untested and is not part of the default deploy.
