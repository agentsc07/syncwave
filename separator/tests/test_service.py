import os
import sys
import threading
import time
from pathlib import Path

import pytest

os.environ["SEPARATOR_NO_AUTOSTART"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import app as svc  # noqa: E402

TOKEN = "s3cret"


class Fake:
    def __init__(self, fail=False, delay=0.0):
        self.calls = 0
        self.fail = fail
        self.delay = delay
        self.gate = None

    def __call__(self, src, out_dir, on_progress):
        self.calls += 1
        if self.gate:
            self.gate.wait(5)
        if self.fail:
            raise RuntimeError("boom")
        out_dir.mkdir(parents=True)
        for s in svc.STEMS:
            (out_dir / f"{s}.mp3").write_bytes(b"ID3" + s.encode())
        on_progress(0.5)


def make(tmp_path, fake=None, dur=10.0, max_dur=480):
    fake = fake or Fake()
    mgr = svc.JobManager(tmp_path, fake, max_duration=max_dur, probe_fn=lambda p: dur)
    return TestClient(svc.create_app(mgr)), fake


def wait_done(c, jid, headers, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        j = c.get(f"/jobs/{jid}", headers=headers).json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.02)
    raise AssertionError("timeout")


@pytest.fixture(autouse=True)
def token(monkeypatch):
    monkeypatch.setenv("SEPARATOR_TOKEN", TOKEN)


AUTH = {"Authorization": f"Bearer {TOKEN}"}


def up(c, data=b"audio-1", headers=AUTH, path="/jobs"):
    return c.post(path, files={"file": ("a.wav", data)}, headers=headers)


def test_health_no_auth(tmp_path):
    c, _ = make(tmp_path)
    r = c.get("/health")
    assert r.status_code == 200 and r.json()["ok"]


def test_auth_required(tmp_path):
    c, _ = make(tmp_path)
    assert up(c, headers={}).status_code == 401
    assert up(c, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert c.get("/jobs/x").status_code == 401
    assert up(c, headers={"x-token": TOKEN}).status_code == 202


def test_full_flow_and_stem_download(tmp_path):
    c, fake = make(tmp_path)
    r = up(c)
    assert r.status_code == 202
    jid = r.json()["jobId"]
    j = wait_done(c, jid, AUTH)
    assert j["status"] == "done" and j["progress"] == 1.0
    assert set(j["stems"]) == set(svc.STEMS)
    s = c.get(f"/jobs/{jid}/stems/vocals.mp3", headers=AUTH)
    assert s.status_code == 200 and s.content == b"ID3vocals"
    assert c.get(f"/jobs/{jid}/stems/guitar.mp3", headers=AUTH).status_code == 404
    assert c.get(f"/jobs/{jid}/stems/vocals.mp3").status_code == 401


def test_cache_hit_is_instant_and_skips_separation(tmp_path):
    c, fake = make(tmp_path)
    wait_done(c, up(c).json()["jobId"], AUTH)
    r = up(c).json()
    assert r["status"] == "done" and r["cached"] is True
    assert fake.calls == 1
    assert up(c, data=b"different").json()["status"] in ("queued", "running", "done")


def test_duplicate_inflight_shares_job(tmp_path):
    fake = Fake()
    fake.gate = threading.Event()
    c, _ = make(tmp_path, fake)
    a = up(c).json()["jobId"]
    b = up(c).json()["jobId"]
    assert a == b
    fake.gate.set()
    wait_done(c, a, AUTH)
    assert fake.calls == 1


def test_error_job(tmp_path):
    c, _ = make(tmp_path, Fake(fail=True))
    j = wait_done(c, up(c).json()["jobId"], AUTH)
    assert j["status"] == "error" and "boom" in j["error"] and j["stems"] is None
    # failure is not cached: retry runs again
    assert up(c).json()["cached"] is False


def test_too_long_rejected(tmp_path):
    c, fake = make(tmp_path, dur=9999, max_dur=480)
    j = wait_done(c, up(c).json()["jobId"], AUTH)
    assert j["status"] == "error" and "too long" in j["error"]
    assert fake.calls == 0


def test_single_worker_serial(tmp_path):
    fake = Fake()
    fake.gate = threading.Event()
    c, _ = make(tmp_path, fake)
    a = up(c, b"A").json()["jobId"]
    b = up(c, b"B").json()["jobId"]
    time.sleep(0.2)
    sa = c.get(f"/jobs/{a}", headers=AUTH).json()["status"]
    sb = c.get(f"/jobs/{b}", headers=AUTH).json()["status"]
    assert (sa, sb) == ("running", "queued")
    fake.gate.set()
    wait_done(c, b, AUTH)


def test_empty_and_unknown(tmp_path):
    c, _ = make(tmp_path)
    assert up(c, data=b"").status_code == 400
    assert c.get("/jobs/nope", headers=AUTH).status_code == 404
    assert up(c, path="/separate").status_code == 202
