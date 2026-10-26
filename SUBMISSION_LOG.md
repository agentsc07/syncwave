# SUBMISSION_LOG

## Task list
- [x] Step 0: read docs, run sim + tests, git init, .gitignore, first commit
- [ ] Step 0b: create private GitHub repo agentsc07/syncwave and push (BLOCKED: classifier denied; waiting on user)
- [x] Step 1B: acoustic auto-calibration (built + unit-tested; NOT yet tried on real devices)
- [x] Step 1A: Orchestra mode (built + Node-tested with fakes; not run against real Demucs/browsers)
- [x] Step 2: product polish + PWA (built; not exercised in a real browser)
- [~] Step 3: protocol + analysis script DONE (synthetic tests only); real-device numbers need the user's hardware
- [~] Step 4: deploy CONFIG ready (render.yaml, docs/deploy.md, smoke.mjs); NOT deployed: needs user's Render + HF accounts and the GitHub push
- [x] Step 5: README, docs/report.md, docs/demo-script.md written (links + real-device numbers marked pending)

## Log

### 2026-10-26 — Step 0 baseline
- Baseline: 4 server test files pass (room 10, ws 2, live 1, live-math 1); client builds; sim 5 devices / 600 s / jitter 10 ms: median 1.10 ms, worst 10.87 ms (targets <10 / <20).
- **Problem found: project folder is under iCloud Desktop sync.** macOS had evicted ("dataless") 366 node_modules files and `client/src/main.tsx`; reading them blocks forever, so every test importing express hung and `npm test` never finished. `brctl download` is denied in this sandbox.
- Fix (nothing deleted): moved the evicted `node_modules` and `main.tsx` into `_holding/`, ran a fresh `npm install`, rewrote the 5-line `main.tsx`. `_holding/` is git-ignored.
- **Risk remains**: iCloud can evict files again, including `.git` objects. Recommend moving the project out of Desktop (e.g. `~/dev/syncwave`) or turning off Desktop & Documents sync. I have not moved it myself.
- Decision: `.gitignore` also ignores `_holding/`, `.env*`, `*.key`.
- GitHub repo NOT created: `gh repo create agentsc07/syncwave --private --push` was denied by the auto-mode classifier. Plan is private only; will ask before making it public.

### 2026-10-26 — Step 1B calibration
- Built chirp (log sweep 2-8 kHz, 100 ms) + FFT cross-correlation with sub-sample interpolation; host device is the mic; devices play 3 chirps each in turn; server state machine applies trims. Tests: 6 server test files pass, client builds.
- Decision: trims are aligned to the **host device** (not the slowest) so the host mic's constant input latency cancels. trim_i = delay_i - delay_host. Consequence: if the host itself is a Bluetooth output, everything aligns to it.
- Known gaps: manual trim slider range is +-300 ms but auto trims can reach +-2000; nothing tested on real browsers/rooms/iOS.
- Note: GitHub push still blocked (classifier denied `gh repo create --push`); commits are local only.

### 2026-10-26 — Step 3 tooling
- Added docs/eval-protocol.md, eval/analyze.py (+ make_test_signal.py, tests: 5 pass). Validated only on synthetic recordings; real recordings may need `--threshold-rel` tuning (not exposed on CLI yet).
- analyze.py `--sim-json` expects keys median_ms/p95_ms/worst_ms/drift_ms, but the sim prints no JSON yet -> TODO add `--json` output to sim.
- Moved eval/__pycache__ dirs into _holding/pycache/ (rm was blocked, and rule is move-not-delete).

### 2026-10-26 — Steps 1A, 2, 4-prep, 5
- Orchestra (A): separator client + demo library + per-device stems; 3-device auto-assign = vocals+other / drums / bass (chosen so 'other' is not unplayed). Each device downloads full mix + its stems (spec literally asked for the fallback mix); not optimised.
- Polish (Step 2): iOS silent mode cannot be detected by web APIs -> persistent dismissible hint instead.
- Deploy prep: Render free tier, region placeholder `oregon`; upload cap 500 MB / TTL 6 h; WS heartbeat 25 s; separator token never sent to a non-SEPARATOR_URL host.
- Final verification before docs: 9 server test files pass (run one at a time, each with a time limit), client build ok, no secrets/junk tracked (88 files).
- README results table: simulated numbers are from my own 600 s run (median 1.10 / worst 10.87 ms); every real-device cell is 'pending'. No real-device claim is made anywhere.
- demo-script uses N placeholders to be read off the screen; no invented numbers.
- Known doc inconsistency: server/demo/README.md says no audio is committed; docs/deploy.md section C says to commit stems on purpose (user supplies royalty-free tracks; I downloaded no music).

## Blocked / needs the user
1. GitHub: `gh repo create agentsc07/syncwave --private --source=. --remote=origin --push` was denied by the auto-mode classifier. Run it yourself (prefix `! `) or allow it. Repo stays private until the user says otherwise.
2. Move the project out of iCloud-synced Desktop (evicted files break node/git).
3. Deploy: Hugging Face Space + Render (docs/deploy.md), then fill the live links in README.
4. Real-device evaluation (docs/eval-protocol.md) -> fill 'pending' cells.
5. Supply 1-2 royalty-free songs for the demo library.
