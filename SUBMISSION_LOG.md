# SUBMISSION_LOG

## Task list
- [x] Step 0: read docs, run sim + tests, git init, .gitignore, first commit, private GitHub repo
- [ ] Step 1B: acoustic auto-calibration
- [ ] Step 1A: Orchestra mode (Demucs stems)
- [ ] Step 2: product polish (landing/join flow, status, error states, PWA)
- [ ] Step 3: evaluation protocol + analysis script + side-by-side numbers
- [ ] Step 4: deploy (Render + Hugging Face Space for Demucs)
- [ ] Step 5: README rewrite, docs/report.md, docs/demo-script.md, links at top

## Log

### 2026-10-26 — Step 0 baseline
- Baseline: 4 server test files pass (room 10, ws 2, live 1, live-math 1); client builds; sim 5 devices / 600 s / jitter 10 ms: median 1.10 ms, worst 10.87 ms (targets <10 / <20).
- **Problem found: project folder is under iCloud Desktop sync.** macOS had evicted ("dataless") 366 node_modules files and `client/src/main.tsx`; reading them blocks forever, so every test importing express hung and `npm test` never finished. `brctl download` is denied in this sandbox.
- Fix (nothing deleted): moved the evicted `node_modules` and `main.tsx` into `_holding/`, ran a fresh `npm install`, rewrote the 5-line `main.tsx`. `_holding/` is git-ignored.
- **Risk remains**: iCloud can evict files again, including `.git` objects. Recommend moving the project out of Desktop (e.g. `~/dev/syncwave`) or turning off Desktop & Documents sync. I have not moved it myself.
- Decision: `.gitignore` also ignores `_holding/`, `.env*`, `*.key`.
- Decision: GitHub repo `agentsc07/syncwave` created as **private**; will ask before making it public.
