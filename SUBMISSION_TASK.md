# Submission task: SyncWave (side project, needs AI features + product polish)

Context: SyncWave turns every phone/laptop in a room into one synced speaker system in the browser (NTP-style clock sync, Web Audio scheduling, drift correction; see README.md, spec.md, PROTOCOL.md). It works but isn't product quality yet, and it has no AI, while the course is Applied AI & Data Science. Add two AI/data features that make it clearly better, polish it, and deploy it.

## New features
A. **Orchestra mode (AI stem separation).** The host uploads a song; a Demucs (htdemucs) service splits it into vocals / drums / bass / other. The host assigns stems to devices (or auto-assign by position), so every phone plays a different part, in sync. Volume per stem, and "everyone plays everything" as the fallback. Pre-separate the demo tracks so the demo is instant.
B. **Acoustic auto-calibration.** The real error source is each device's output latency (Bluetooth speakers especially). Each device plays a short chirp in turn; the host mic records; cross-correlation measures each device's real acoustic offset; the per-device trim is set automatically. Show a "sync score" per device. This replaces the manual Bluetooth trim slider.

## Steps
0. Read README.md, spec.md, PROTOCOL.md. Run the sim and tests. This folder is **not a git repo yet**: `git init`, .gitignore (node_modules, uploads/, dist/, *.pem), first commit, push to github.com/agentsc07/syncwave (ask before public). Log the state in `SUBMISSION_LOG.md`.
1. Build B (calibration), then A (Orchestra).
2. **Product polish:** a clean landing → create/join flow (QR, room code), clear per-device status, error states (audio locked, silent mode on iPhone, lost connection), and a PWA manifest + service worker so it installs on phones like an app.
3. **Evaluation with real devices.** Give me an exact protocol: 4-5 devices, one external mic recording, measure onset gaps before and after auto-calibration (including one Bluetooth device), drift at minute 10, and late join. Write a script that computes the gaps from the recording. Report sim numbers and real numbers side by side.
4. **Deploy:** Node server + client on Render free tier (WebSockets work there; uploads are temporary, so say so in the UI). Demucs separation as a separate free Hugging Face Space (CPU) that the server calls; cache the stems. HTTPS is then automatic, which also unlocks mic and tab capture on phones.
5. Deliverables below. Demo script: 4 phones, one room, Orchestra mode (vocals on one phone, drums on another), then auto-calibration fixing a Bluetooth speaker.

## Rules
- Never delete files. Move anything unwanted into `_holding/` inside this repo.
- Never commit secrets (`*.pem`, `.env`, keys). Check `git status` and `.gitignore` before every commit.
- Push to `github.com/agentsc07/<repo>` with `gh`. Ask me before making the repo public or publishing a package.
- Ask me only when blocked on something only I can do (hardware, accounts, labelling, listening). Otherwise decide, and note the decision in `SUBMISSION_LOG.md`.
- Keep a task list. Commit small and often.

## Deliverables (every project)
1. `README.md` rewritten for a grader: one-line pitch, the problem, how it works (diagram), **results with numbers**, live links, how to run.
2. `docs/report.md`: one page. Problem, method, evaluation, limitations, next steps.
3. `docs/demo-script.md`: a 2-minute screen-recording script, shot by shot.
4. All deployed links working and listed at the top of the README.
