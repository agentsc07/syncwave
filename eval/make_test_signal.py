#!/usr/bin/env python3
"""Generate the SyncWave evaluation test signal.

Layout: a short chirp "click" every 2 s (at even seconds) plus a long, distinct
down-sweep "marker" burst at the start, the middle and the end, so drift can be read
at minute 0 / 5 / 10 (or 0 / 15 s / 29 s for the short version).

  python eval/make_test_signal.py            # eval/signals/test_10min.wav + test_30s.wav
  python eval/make_test_signal.py --out-dir /some/dir --sr 48000
"""
import argparse, json, os, sys
import numpy as np
from scipy.io import wavfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import click_template, marker_template  # noqa: E402


def build(duration, marker_times, sr=48000, click_period=2.0, click_amp=0.9, marker_amp=0.7):
    n = int(round(duration * sr))
    x = np.zeros(n, dtype=np.float64)
    ct, mt = click_template(sr), marker_template(sr)
    clicks = []
    t = click_period
    while t < duration - 0.1:
        clicks.append(t)
        i = int(round(t * sr))
        x[i:i + len(ct)] += click_amp * ct
        t += click_period
    for t in marker_times:
        i = int(round(t * sr))
        x[i:i + len(mt)] += marker_amp * mt
    meta = dict(sr=sr, duration_s=duration, click_period_s=click_period, marker_times_s=list(marker_times),
                n_clicks=len(clicks))
    return x, meta


def write(path, x, meta):
    wavfile.write(path, meta["sr"], (np.clip(x, -1, 1) * 32767).astype(np.int16))
    with open(os.path.splitext(path)[0] + ".json", "w") as f:
        json.dump(meta, f, indent=2)
    print(f"wrote {path} ({meta['duration_s']} s, {meta['n_clicks']} clicks, markers at {meta['marker_times_s']})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "signals"))
    ap.add_argument("--sr", type=int, default=48000)
    a = ap.parse_args()
    os.makedirs(a.out_dir, exist_ok=True)
    x, m = build(602.0, [1.0, 301.0, 601.0], a.sr)
    write(os.path.join(a.out_dir, "test_10min.wav"), x, m)
    x, m = build(30.0, [1.0, 15.0, 29.0], a.sr)
    write(os.path.join(a.out_dir, "test_30s.wav"), x, m)


if __name__ == "__main__":
    main()
