# Separator (Demucs stem service) — startup

**Prerequisites:** Python 3.11, ffmpeg, ~4 GB RAM free. CPU only is fine (slow: ~1–3x realtime).

**Setup**
```
cd separator
python3.11 -m venv .venv && source .venv/bin/activate
pip install torch==2.2.2 torchaudio==2.2.2 --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
cp .env.example .env     # set SEPARATOR_TOKEN to a long random string
```

**Run:** `SEPARATOR_TOKEN=yourtoken uvicorn app:app --host 0.0.0.0 --port 7860` → http://localhost:7860/health

**Production:** deploy as a Hugging Face Docker Space (see `README.md`); add `SEPARATOR_TOKEN` as a Space secret.

**Stop:** Ctrl+C. **Tests:** `pip install -r requirements-dev.txt && pytest tests -q`

**Pre-separate demo songs:** `python make_demo_stems.py song.mp3 --out ../server/demo`

**Common problems**
- *First request very slow* — model loads on first job; free Spaces also sleep when idle (~1 min to wake).
- *401* — send `Authorization: Bearer <SEPARATOR_TOKEN>`.
- *Song rejected* — limit is 8 minutes / 60 MB.
