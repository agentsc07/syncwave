#!/usr/bin/env python3
"""Analyse an external recording of N devices playing the SyncWave click train at once.

Each click (and each marker burst) appears N times in the recording, once per device,
slightly offset. We matched-filter the recording with the click template (complex
analytic template, so |output| is the smooth envelope), pick peaks, group them into
events, keep the N strongest peaks of each event and refine each onset to sub-sample
precision with parabolic interpolation of the envelope peak.

Per click: spread = max - min onset across devices (ms).
Per device (rank order of arrival, optionally labelled with --chirp-ids): offset vs the
median device. NOTE: devices are identified by sorted arrival order, so a device that
swaps rank with another between events is mislabelled; the spread/drift numbers do not
depend on identity except the per-device columns.
Drift: marker bursts (start / mid / end). drift = max over devices of the change in
(offset - median offset) relative to the first marker, in ms.

Examples:
  python eval/analyze.py recordings/A_1.wav --devices 5 --name A_1 --plot
  python eval/analyze.py --compare recordings/C_1_before.wav recordings/C_1_after.wav --devices 5
  python eval/analyze.py recordings/A_1.wav --devices 5 --sim-json sim_A.json
"""
import argparse, csv, json, os, sys
import numpy as np
from scipy import signal
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------- templates
def _chirp(sr, dur, f0, f1):
    n = int(round(dur * sr))
    t = np.arange(n) / sr
    ph = 2 * np.pi * (f0 * t + (f1 - f0) / (2 * dur) * t * t)
    return np.sin(ph) * np.hanning(n)


def click_template(sr):
    """4 ms 1-6 kHz up-chirp, Hann windowed (sharp autocorrelation, phone-speaker friendly)."""
    return _chirp(sr, 0.004, 1000.0, 6000.0)


def marker_template(sr):
    """200 ms 4 kHz -> 500 Hz down-sweep; cross-correlates weakly with the click."""
    return _chirp(sr, 0.200, 4000.0, 500.0)


# ----------------------------------------------------------------- io
def read_wav(path, channel=None):
    sr, x = wavfile.read(path)
    if x.dtype.kind in "iu":
        x = x.astype(np.float64) / float(np.iinfo(x.dtype).max if x.dtype.kind == "i" else 128)
    else:
        x = x.astype(np.float64)
    if x.ndim == 2:
        x = x[:, channel] if channel is not None else x.mean(axis=1)
    return sr, x - np.mean(x)


# ----------------------------------------------------------------- detection
def envelope(x, template):
    """|x correlated with analytic template|: smooth matched-filter envelope, aligned so
    index i corresponds to a template starting at sample i."""
    tpl = signal.hilbert(template)
    tpl = tpl / np.linalg.norm(tpl.real)
    out = signal.oaconvolve(x, np.conj(tpl[::-1]), mode="full")
    return np.abs(out[len(tpl) - 1:len(tpl) - 1 + len(x)])


def parabolic(env, i):
    """Sub-sample peak position near integer index i."""
    if i <= 0 or i >= len(env) - 1:
        return float(i)
    a, b, c = env[i - 1], env[i], env[i + 1]
    d = a - 2 * b + c
    return float(i) if d == 0 else i + 0.5 * (a - c) / d


def find_events(env, sr, n_devices, threshold_rel=0.05, noise_mult=10.0, min_sep_ms=0.4, cluster_gap_s=0.15):
    """Return list of events; each is a sorted array of onset times (s), plus peak heights.
    Events with fewer than n_devices peaks are returned with fewer entries (caller decides)."""
    thr = max(noise_mult * np.median(env), threshold_rel * env.max())
    dist = max(1, int(min_sep_ms * 1e-3 * sr))
    pk, props = signal.find_peaks(env, height=thr, distance=dist)
    if len(pk) == 0:
        return []
    h = props["peak_heights"]
    gaps = np.diff(pk) > cluster_gap_s * sr
    bounds = np.concatenate([[0], np.where(gaps)[0] + 1, [len(pk)]])
    events = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        idx = np.arange(a, b)
        top = idx[np.argsort(h[idx])[::-1][:n_devices]]
        t = np.sort([parabolic(env, pk[i]) / sr for i in top])
        events.append(dict(times=np.array(t), strength=float(h[top].min())))
    return events


def keep_strong(events, ref, frac=0.4):
    """Drop weak events (noise / reverb / cross-template leakage). ref='max' for rare events
    (markers), 'median' for the regular click train."""
    if not events:
        return events
    s = np.array([e["strength"] for e in events])
    base = s.max() if ref == "max" else np.median(s)
    return [e for e, v in zip(events, s) if v >= frac * base]


def detect(x, sr, n_devices, **kw):
    clicks = find_events(envelope(x, click_template(sr)), sr, n_devices, **kw)
    marks = find_events(envelope(x, marker_template(sr)), sr, n_devices, **kw)
    return keep_strong(clicks, "median"), keep_strong(marks, "max")


# ----------------------------------------------------------------- metrics
def _rows(events, n_devices):
    ok = [e for e in events if len(e["times"]) == n_devices]
    t0 = np.array([e["times"][0] for e in ok])
    T = np.array([e["times"] for e in ok]) if ok else np.zeros((0, n_devices))
    spread = (T.max(1) - T.min(1)) * 1e3 if len(ok) else np.zeros(0)
    rel = (T - np.median(T, axis=1, keepdims=True)) * 1e3 if len(ok) else np.zeros((0, n_devices))
    return t0, spread, rel, len(events) - len(ok)


def filter_clicks_vs_markers(clicks, marks, tol=0.3):
    """Drop click-detector events that coincide with a marker (marker leakage)."""
    mt = np.array([m["times"].mean() for m in marks]) if marks else np.array([])
    out = []
    for c in clicks:
        if len(mt) and np.min(np.abs(mt - c["times"].mean())) < tol:
            continue
        out.append(c)
    return out


def analyze_signal(x, sr, n_devices=5, labels=None, **kw):
    clicks, marks = detect(x, sr, n_devices, **kw)
    clicks = filter_clicks_vs_markers(clicks, [m for m in marks if len(m["times"]) == n_devices])
    t, spread, rel, missed = _rows(clicks, n_devices)
    mt, mspread, mrel, mmissed = _rows(marks, n_devices)
    labels = labels or [f"dev{i + 1}" for i in range(n_devices)]
    res = dict(n_devices=n_devices, labels=labels, click_t=t, click_spread_ms=spread, click_rel_ms=rel,
               clicks_missed=missed, marker_t=mt, marker_spread_ms=mspread, marker_rel_ms=mrel,
               markers_missed=mmissed)
    if len(spread):
        res.update(median_ms=float(np.median(spread)), p95_ms=float(np.percentile(spread, 95)),
                   worst_ms=float(spread.max()), n_clicks=int(len(spread)),
                   device_median_offset_ms=np.median(rel, axis=0).tolist())
        if len(t) > 2:  # spread trend, ms per minute
            res["spread_trend_ms_per_min"] = float(np.polyfit(t, spread, 1)[0] * 60)
    else:
        res.update(median_ms=float("nan"), p95_ms=float("nan"), worst_ms=float("nan"), n_clicks=0,
                   device_median_offset_ms=[float("nan")] * n_devices)
    if len(mt) >= 2:
        d = np.abs(mrel - mrel[0]).max(axis=1)  # per marker, max device drift vs first marker
        el = (mt - mt[0]) / 60.0
        res.update(drift_per_marker_ms=d.tolist(), marker_elapsed_min=el.tolist(),
                   drift_ms=float(d[-1]), drift_ms_per_min=float(d[-1] / el[-1]) if el[-1] > 0 else float("nan"),
                   spread_change_ms=(mspread - mspread[0]).tolist())
    else:
        res.update(drift_per_marker_ms=[], marker_elapsed_min=[], drift_ms=float("nan"),
                   drift_ms_per_min=float("nan"), spread_change_ms=[])
    return res


def analyze_file(path, n_devices=5, labels=None, channel=None, **kw):
    sr, x = read_wav(path, channel)
    return analyze_signal(x, sr, n_devices, labels, **kw)


# ----------------------------------------------------------------- output
def f(v, nd=2):
    return "n/a" if v is None or (isinstance(v, float) and np.isnan(v)) else f"{v:.{nd}f}"


def summary_row(res):
    return dict(median_ms=res["median_ms"], p95_ms=res["p95_ms"], worst_ms=res["worst_ms"],
                drift_ms=res["drift_ms"], n_clicks=res["n_clicks"])


def summary_table(named, sim=None):
    """named: {label: result-or-summary dict}. Optional sim: dict of summary values added as a column."""
    cols = dict(named)
    if sim:
        cols["sim"] = sim
    metrics = [("median spread (ms)", "median_ms"), ("p95 spread (ms)", "p95_ms"),
               ("worst spread (ms)", "worst_ms"), ("drift at last marker (ms)", "drift_ms"),
               ("clicks used", "n_clicks")]
    lines = ["| metric | " + " | ".join(cols) + " |", "|---|" + "---|" * len(cols)]
    for title, k in metrics:
        cells = []
        for v in cols.values():
            x = v.get(k)
            cells.append("n/a" if x is None else (str(int(x)) if k == "n_clicks" else f(float(x))))
        lines.append(f"| {title} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def compare_table(before, after, sim=None):
    lines = ["| metric | before | after | change |", "|---|---|---|---|"]
    for title, k in [("median spread (ms)", "median_ms"), ("p95 spread (ms)", "p95_ms"),
                     ("worst spread (ms)", "worst_ms"), ("drift (ms)", "drift_ms")]:
        b, a = before[k], after[k]
        lines.append(f"| {title} | {f(b)} | {f(a)} | {f(a - b)} |")
    lines.append("")
    lines.append("| device | before median offset (ms) | after median offset (ms) |")
    lines.append("|---|---|---|")
    for lab, b, a in zip(before["labels"], before["device_median_offset_ms"], after["device_median_offset_ms"]):
        lines.append(f"| {lab} | {f(b)} | {f(a)} |")
    return "\n".join(lines)


def load_sim(path):
    with open(path) as fh:
        d = json.load(fh)
    d = d.get("summary", d)
    alias = {"median": "median_ms", "p95": "p95_ms", "worst": "worst_ms", "max_ms": "worst_ms",
             "drift": "drift_ms", "medianOffsetMs": "median_ms", "p95OffsetMs": "p95_ms",
             "worstOffsetMs": "worst_ms", "driftMs": "drift_ms"}
    return {alias.get(k, k): v for k, v in d.items() if isinstance(v, (int, float))}


def write_outputs(res, name, out_dir, sim=None, plot=False):
    os.makedirs(out_dir, exist_ok=True)
    n = res["n_devices"]
    csv_path = os.path.join(out_dir, f"{name}.csv")
    with open(csv_path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["kind", "t_s", "spread_ms"] + [f"{l}_offset_ms" for l in res["labels"]])
        for kind, t, s, r in [("click", res["click_t"], res["click_spread_ms"], res["click_rel_ms"]),
                              ("marker", res["marker_t"], res["marker_spread_ms"], res["marker_rel_ms"])]:
            for i in range(len(t)):
                w.writerow([kind, f"{t[i]:.4f}", f"{s[i]:.3f}"] + [f"{v:.3f}" for v in r[i]])
    md_path = os.path.join(out_dir, f"{name}_summary.md")
    md = f"## {name}\n\n" + summary_table({"real": summary_row(res)}, sim) + "\n"
    if res["drift_per_marker_ms"]:
        md += "\n| marker | minute | drift vs first (ms) |\n|---|---|---|\n"
        for i, (m, d) in enumerate(zip(res["marker_elapsed_min"], res["drift_per_marker_ms"])):
            md += f"| {i + 1} | {m:.2f} | {d:.2f} |\n"
    with open(md_path, "w") as fh:
        fh.write(md)
    out = [csv_path, md_path]
    if plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(1, 2, figsize=(11, 4))
        ax[0].plot(res["click_t"] / 60, res["click_spread_ms"], ".", ms=3)
        ax[0].axhline(10, color="r", ls="--", lw=1, label="10 ms target")
        ax[0].set(xlabel="minute", ylabel="spread (ms)", title=f"{name}: per-click spread")
        ax[0].legend()
        if len(res["marker_t"]):
            ax[1].plot(np.array(res["marker_t"]) / 60, res["marker_rel_ms"], "o-")
            ax[1].legend(res["labels"], fontsize=7)
        ax[1].set(xlabel="minute", ylabel="offset vs median (ms)", title="marker offsets")
        fig.tight_layout()
        p = os.path.join(out_dir, f"{name}.png")
        fig.savefig(p, dpi=120)
        plt.close(fig)
        out.append(p)
    return out


# ----------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording", nargs="?", help="wav file (mono or multichannel)")
    ap.add_argument("--devices", "-n", type=int, default=5, help="number of devices playing (default 5)")
    ap.add_argument("--chirp-ids", default=None, help="comma list of device labels in sorted arrival order")
    ap.add_argument("--name", default=None, help="output name (default: wav basename)")
    ap.add_argument("--out-dir", default=os.path.join(HERE, "results"))
    ap.add_argument("--channel", type=int, default=None, help="use one channel (default: mean of all)")
    ap.add_argument("--plot", action="store_true", help="write PNG plot (matplotlib)")
    ap.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"), help="print before/after table")
    ap.add_argument("--sim-json", default=None, help="sim summary json to show beside the real numbers")
    a = ap.parse_args(argv)
    labels = a.chirp_ids.split(",") if a.chirp_ids else None
    if labels:
        a.devices = len(labels)
    sim = load_sim(a.sim_json) if a.sim_json else None

    if a.compare:
        b = analyze_file(a.compare[0], a.devices, labels, a.channel)
        c = analyze_file(a.compare[1], a.devices, labels, a.channel)
        print(compare_table(b, c))
        if sim:
            print("\n" + summary_table({"before": summary_row(b), "after": summary_row(c)}, sim))
        name = a.name or f"compare_{os.path.splitext(os.path.basename(a.compare[0]))[0]}"
        for tag, r, p in (("before", b, a.compare[0]), ("after", c, a.compare[1])):
            write_outputs(r, f"{name}_{tag}", a.out_dir, sim, a.plot)
        return 0
    if not a.recording:
        ap.error("recording required (or --compare BEFORE AFTER)")
    res = analyze_file(a.recording, a.devices, labels, a.channel)
    name = a.name or os.path.splitext(os.path.basename(a.recording))[0]
    paths = write_outputs(res, name, a.out_dir, sim, a.plot)
    print(summary_table({"real": summary_row(res)}, sim))
    print(f"\nclicks used {res['n_clicks']}, skipped (wrong device count) {res['clicks_missed']}, "
          f"markers {len(res['marker_t'])}")
    print("per-device median offset (ms): " +
          ", ".join(f"{l}={f(v)}" for l, v in zip(res["labels"], res["device_median_offset_ms"])))
    if res["drift_per_marker_ms"]:
        print("drift per marker (ms): " + ", ".join(f"{d:.2f}" for d in res["drift_per_marker_ms"]))
    print("wrote: " + ", ".join(paths))
    return 0


if __name__ == "__main__":
    sys.exit(main())
