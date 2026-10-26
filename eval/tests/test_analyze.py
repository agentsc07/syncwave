import os, sys
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import analyze as A  # noqa: E402


def frac_delay_place(x, tpl, t, amp):
    """Add tpl at fractional time t (s) using FFT-free linear-phase fractional delay."""
    sr = SR
    i = int(np.floor(t * sr))
    fr = t * sr - i
    n = len(tpl)
    spec = np.fft.rfft(tpl, n + 8)
    k = np.fft.rfftfreq(n + 8)
    d = np.fft.irfft(spec * np.exp(-2j * np.pi * k * fr), n + 8)
    x[i:i + n + 8] += amp * d


SR = 48000


def synth(offsets_ms, ppm, duration=60.0, markers=(1.0, 31.0, 59.0), snr_noise=0.01, seed=0, sr=48000):
    global SR
    SR = sr
    rng = np.random.default_rng(seed)
    x = np.zeros(int(duration * sr) + 4000)
    ct, mt = A.click_template(sr), A.marker_template(sr)
    # decaying reverb-ish tail: sparse noise, energy ~ -3 dB re direct, 60 ms decay, starts 3 ms after direct
    rl = int(0.15 * sr)
    tail = rng.standard_normal(rl) * np.exp(-np.arange(rl) / (0.03 * sr)) * 0.03
    tail[: int(0.003 * sr)] = 0
    tail[0] = 1.0
    for d, (o, p) in enumerate(zip(offsets_ms, ppm)):
        amp = 0.6 + 0.4 * rng.random()
        times = [(t, ct, 0.9) for t in np.arange(2.0, duration - 0.5, 2.0) if min(abs(t - m) for m in markers) > 0.5]
        times += [(m, mt, 0.7) for m in markers]
        lay = np.zeros_like(x)
        for t, tpl, a in times:
            tt = t * (1 + p * 1e-6) + o * 1e-3  # device clock drift + static offset
            frac_delay_place(lay, tpl, tt, a)
        from scipy.signal import oaconvolve
        lay = oaconvolve(lay, tail)[: len(x)]
        x += amp * lay
    x += snr_noise * rng.standard_normal(len(x))
    return x


def truth_rel(offsets_ms, ppm, t):
    o = np.array(offsets_ms) + np.array(ppm) * 1e-6 * t * 1e3
    return o - np.median(o)


def test_static_offsets_recovered():
    offs = [0.0, 3.2, 7.45, 11.9, 1.1]
    x = synth(offs, [0] * 5)
    r = A.analyze_signal(x, SR, 5)
    assert r["n_clicks"] >= 25
    true_sorted = np.sort(truth_rel(offs, [0] * 5, 0))
    got = np.array(r["device_median_offset_ms"])
    assert np.max(np.abs(got - true_sorted)) < 0.3
    assert abs(r["median_ms"] - (max(offs) - min(offs))) < 0.3
    assert r["worst_ms"] < max(offs) - min(offs) + 0.6


def test_drift_with_ppm():
    offs = [0.0, 2.0, 4.0, 6.0, 1.0]
    ppm = [0.0, 20.0, -25.0, 30.0, 8.0]  # over 58 s -> up to ~1.7 ms differential
    x = synth(offs, ppm)
    r = A.analyze_signal(x, SR, 5)
    assert len(r["marker_t"]) == 3
    t = np.array(r["marker_t"])
    for tk in t:  # scenario sanity: no two devices closer than the 0.4 ms resolution limit
        assert np.diff(np.sort(truth_rel(offs, ppm, tk))).min() > 0.5
    true0 = np.sort(truth_rel(offs, ppm, t[0]))
    for k, tk in enumerate(t):
        # compare drift of every device by rank; order is stable here
        tr = np.sort(truth_rel(offs, ppm, tk))
        got = np.array(r["marker_rel_ms"][k])
        assert np.max(np.abs(got - tr)) < 0.3
    true_drift = np.max(np.abs(np.sort(truth_rel(offs, ppm, t[-1])) - true0))
    assert abs(r["drift_ms"] - true_drift) < 0.5


def test_long_session_5ppm_16k():
    """10-minute-style session at 16 kHz: a few ppm of clock drift -> a few ms."""
    offs = [0.0, 4.0, 8.0, 12.0, 2.0]
    ppm = [0.0, 5.0, -4.0, 3.0, 1.0]
    x = synth(offs, ppm, duration=602.0, markers=(1.0, 301.0, 601.0), snr_noise=0.005, sr=16000)
    r = A.analyze_signal(x, SR, 5)
    t = np.array(r["marker_t"])
    assert len(t) == 3
    true_drift = np.max(np.abs(np.sort(truth_rel(offs, ppm, t[-1])) - np.sort(truth_rel(offs, ppm, t[0]))))
    assert true_drift > 1.0
    assert abs(r["drift_ms"] - true_drift) < 0.5
    assert r["n_clicks"] > 250


def test_compare_and_sim_table():
    b = dict(median_ms=12.0, p95_ms=15.0, worst_ms=20.0, drift_ms=1.0, n_clicks=10,
             labels=["a", "b"], device_median_offset_ms=[-5.0, 5.0])
    a = dict(b, median_ms=2.0, p95_ms=3.0, worst_ms=4.0, device_median_offset_ms=[-1.0, 1.0])
    s = A.compare_table(b, a)
    assert "-10.00" in s
    t = A.summary_table({"real": b}, dict(median_ms=3.1, p95_ms=4.0, worst_ms=6.0, drift_ms=0.4))
    assert "| real | sim |" in t.replace("metric | ", "")


def test_cli_writes_outputs(tmp_path):
    from scipy.io import wavfile
    offs = [0.0, 5.0, 9.0]
    x = synth(offs, [0, 0, 0], duration=20.0, markers=(1.0, 10.0, 19.0), sr=48000)
    p = tmp_path / "rec.wav"
    wavfile.write(str(p), 48000, (x / np.abs(x).max() * 30000).astype(np.int16))
    rc = A.main([str(p), "--devices", "3", "--out-dir", str(tmp_path / "res"), "--name", "t", "--plot"])
    assert rc == 0
    for f in ("t.csv", "t_summary.md", "t.png"):
        assert (tmp_path / "res" / f).exists()
