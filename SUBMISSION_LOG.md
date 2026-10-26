# SUBMISSION_LOG

## Task list
- [x] Step 0: read docs, run sim + tests, git init, .gitignore, first commit
- [ ] Step 0b: create private GitHub repo agentsc07/syncwave and push (BLOCKED: classifier denied; waiting on user)
- [x] Step 1B: acoustic auto-calibration (built + unit-tested; NOT yet tried on real devices)
- [ ] Step 1A: Orchestra mode (Demucs stems)
- [ ] Step 2: product polish (landing/join flow, status, error states, PWA)
- [~] Step 3: protocol + analysis script DONE (synthetic tests only); real-device numbers need the user's hardware
- [ ] Step 4: deploy (Render + Hugging Face Space for Demucs)
- [ ] Step 5: README rewrite, docs/report.md, docs/demo-script.md, links at top

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
