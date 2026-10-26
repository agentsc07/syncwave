"""SyncWave stem separator: FastAPI wrapper around Demucs htdemucs (CPU).

Async job API (CPU separation takes minutes):
  POST /jobs                       multipart `file` -> {jobId, status, cached}
  GET  /jobs/{id}                  -> {status, progress, stems, error}
  GET  /jobs/{id}/stems/{name}.mp3 -> audio
  POST /separate                   convenience: same as POST /jobs (returns the job JSON)
  GET  /health                     (no auth)
Auth: env SEPARATOR_TOKEN; send `Authorization: Bearer <token>` (or `x-token` header,
or `token` query/form field). If SEPARATOR_TOKEN is unset, auth is disabled (local dev only).
"""
import hashlib
import hmac
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Dict, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

STEMS = ("vocals", "drums", "bass", "other")
MAX_DURATION_SEC = float(os.environ.get("MAX_DURATION_SEC", 480))
MAX_UPLOAD_BYTES = int(float(os.environ.get("MAX_UPLOAD_MB", 60)) * 1024 * 1024)
SEGMENT = os.environ.get("DEMUCS_SEGMENT", "7")  # seconds; keeps RAM low
MP3_BITRATE = os.environ.get("MP3_BITRATE", "128k")
MAX_CACHE_ENTRIES = int(os.environ.get("MAX_CACHE_ENTRIES", 20))

SeparateFn = Callable[[Path, Path, Callable[[float], None]], None]


def cache_dir() -> Path:
    d = Path(os.environ.get("CACHE_DIR", "/tmp/separator-cache"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, timeout=30)
    try:
        return float(out.stdout.strip())
    except ValueError:
        raise ValueError("could not read audio (unsupported or corrupt file)")


def demucs_separate(src: Path, out_dir: Path, on_progress: Callable[[float], None]) -> None:
    """Run htdemucs (4 stems) on CPU, then encode each stem to MP3 into out_dir."""
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        cmd = [sys.executable, "-m", "demucs", "-n", "htdemucs", "-d", "cpu", "-j", "1",
               "--segment", SEGMENT, "-o", tmp, str(src)]
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL)
        buf, tail = b"", b""
        while True:
            ch = proc.stderr.read(1)
            if not ch:
                break
            if ch in (b"\r", b"\n"):
                m = re.search(rb"(\d+)%", buf)
                if m:
                    on_progress(min(0.9, int(m.group(1)) / 100 * 0.9))
                if buf.strip():
                    tail = buf[-300:]
                buf = b""
            else:
                buf += ch
        if proc.wait() != 0:
            raise RuntimeError("demucs failed: " + tail.decode(errors="replace"))
        stem_dir = next(Path(tmp).glob("htdemucs/*"), None)
        if stem_dir is None:
            raise RuntimeError("demucs produced no output")
        for i, name in enumerate(STEMS):
            wav = stem_dir / f"{name}.wav"
            r = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame",
                 "-b:a", MP3_BITRATE, str(out_dir / f"{name}.mp3")],
                capture_output=True, timeout=300)
            if r.returncode != 0:
                raise RuntimeError("ffmpeg encode failed: " + r.stderr.decode(errors="replace")[:300])
            on_progress(0.9 + 0.1 * (i + 1) / len(STEMS))


class JobManager:
    """In-memory job table + single worker thread + SHA-256 disk cache."""

    def __init__(self, cache: Path, separate_fn: SeparateFn, max_duration: float = MAX_DURATION_SEC,
                 probe_fn: Callable[[Path], float] = probe_duration):
        self.cache = cache
        self.separate_fn = separate_fn
        self.max_duration = max_duration
        self.probe_fn = probe_fn
        self.jobs: Dict[str, dict] = {}
        self.active_by_sha: Dict[str, str] = {}
        self.q: "queue.Queue[Optional[str]]" = queue.Queue()
        self.lock = threading.Lock()
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    def cache_path(self, sha: str) -> Path:
        return self.cache / sha

    def _cached(self, sha: str) -> bool:
        p = self.cache_path(sha)
        return (p / "DONE").exists() and all((p / f"{s}.mp3").exists() for s in STEMS)

    def submit(self, sha: str, src: Path) -> dict:
        """src is a temp file the manager takes ownership of (moved/removed)."""
        with self.lock:
            if self._cached(sha):
                src.unlink(missing_ok=True)
                os.utime(self.cache_path(sha))
                return self._new_job(sha, "done", 1.0)
            if sha in self.active_by_sha:  # same audio already queued/running
                src.unlink(missing_ok=True)
                return self.jobs[self.active_by_sha[sha]]
            job = self._new_job(sha, "queued", 0.0)
            job["_src"] = src
            self.active_by_sha[sha] = job["jobId"]
            self.q.put(job["jobId"])
            return job

    def _new_job(self, sha: str, status: str, progress: float) -> dict:
        jid = uuid.uuid4().hex
        job = {"jobId": jid, "sha": sha, "status": status, "progress": progress,
               "error": None, "cached": status == "done", "created": time.time()}
        self.jobs[jid] = job
        return job

    def public(self, job: dict, base: str = "") -> dict:
        out = {"jobId": job["jobId"], "status": job["status"],
               "progress": round(job["progress"], 3), "cached": job["cached"],
               "error": job["error"], "sha256": job["sha"], "stems": None}
        if job["status"] == "done":
            out["stems"] = {s: f"{base}/jobs/{job['jobId']}/stems/{s}.mp3" for s in STEMS}
        return out

    def _run(self):
        while True:
            jid = self.q.get()
            if jid is None:
                return
            job = self.jobs[jid]
            src: Path = job.pop("_src")
            sha = job["sha"]
            job["status"] = "running"
            try:
                dur = self.probe_fn(src)
                if dur > self.max_duration:
                    raise ValueError(f"audio too long ({dur:.0f}s > {self.max_duration:.0f}s)")
                tmp_out = self.cache / f".tmp-{jid}"
                self.separate_fn(src, tmp_out, lambda p: job.__setitem__("progress", p))
                final = self.cache_path(sha)
                if final.exists():
                    shutil.rmtree(final)
                tmp_out.rename(final)
                (final / "DONE").write_text("ok")
                job["progress"], job["status"] = 1.0, "done"
                self._evict()
            except Exception as e:  # noqa: BLE001
                job["status"], job["error"] = "error", str(e)[:500]
                shutil.rmtree(self.cache / f".tmp-{jid}", ignore_errors=True)
            finally:
                src.unlink(missing_ok=True)
                with self.lock:
                    self.active_by_sha.pop(sha, None)

    def _evict(self):
        entries = [p for p in self.cache.iterdir() if p.is_dir() and not p.name.startswith(".")]
        entries.sort(key=lambda p: p.stat().st_mtime)
        for p in entries[:-MAX_CACHE_ENTRIES] if len(entries) > MAX_CACHE_ENTRIES else []:
            shutil.rmtree(p, ignore_errors=True)

    def stem_file(self, job: dict, name: str) -> Optional[Path]:
        if job["status"] != "done" or name not in STEMS:
            return None
        p = self.cache_path(job["sha"]) / f"{name}.mp3"
        return p if p.exists() else None


def create_app(manager: Optional[JobManager] = None) -> FastAPI:
    app = FastAPI(title="SyncWave separator")
    app.state.manager = manager or JobManager(cache_dir(), demucs_separate)

    def check_auth(request: Request, form_token: Optional[str] = None):
        expected = os.environ.get("SEPARATOR_TOKEN", "")
        if not expected:
            return
        got = ""
        h = request.headers.get("authorization", "")
        if h.lower().startswith("bearer "):
            got = h[7:].strip()
        got = got or request.headers.get("x-token", "") or form_token or request.query_params.get("token", "")
        if not hmac.compare_digest(got.encode(), expected.encode()):
            raise HTTPException(401, "unauthorized")

    async def accept_upload(request: Request, file: UploadFile, token: Optional[str]) -> dict:
        check_auth(request, token)
        m: JobManager = app.state.manager
        h = hashlib.sha256()
        size = 0
        fd, tmp = tempfile.mkstemp(suffix=Path(file.filename or "a.audio").suffix or ".audio",
                                   dir=m.cache)
        try:
            with os.fdopen(fd, "wb") as out:
                while chunk := await file.read(1 << 20):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "file too large")
                    h.update(chunk)
                    out.write(chunk)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        if size == 0:
            Path(tmp).unlink(missing_ok=True)
            raise HTTPException(400, "empty file")
        job = m.submit(h.hexdigest(), Path(tmp))
        return m.public(job, "")

    @app.get("/health")
    def health():
        m: JobManager = app.state.manager
        return {"ok": True, "model": "htdemucs", "queued": m.q.qsize(),
                "authRequired": bool(os.environ.get("SEPARATOR_TOKEN"))}

    @app.post("/jobs")
    async def post_jobs(request: Request, file: UploadFile = File(...), token: Optional[str] = Form(None)):
        return JSONResponse(await accept_upload(request, file, token), status_code=202)

    @app.post("/separate")
    async def post_separate(request: Request, file: UploadFile = File(...), token: Optional[str] = Form(None)):
        return JSONResponse(await accept_upload(request, file, token), status_code=202)

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str, request: Request):
        check_auth(request)
        m: JobManager = app.state.manager
        job = m.jobs.get(job_id)
        if not job:
            raise HTTPException(404, "no such job")
        return m.public(job, "")

    @app.get("/jobs/{job_id}/stems/{name}.mp3")
    def get_stem(job_id: str, name: str, request: Request):
        check_auth(request)
        m: JobManager = app.state.manager
        job = m.jobs.get(job_id)
        if not job:
            raise HTTPException(404, "no such job")
        p = m.stem_file(job, name)
        if not p:
            raise HTTPException(404, "stem not available")
        return FileResponse(p, media_type="audio/mpeg",
                            headers={"Cache-Control": "private, max-age=86400"})

    return app



app = create_app() if os.environ.get("SEPARATOR_NO_AUTOSTART") != "1" else None
