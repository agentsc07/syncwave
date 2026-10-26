#!/usr/bin/env python3
"""Pre-separate local audio files into demo/<slug>/{vocals,drums,bass,other}.mp3 + manifest.json.

Usage:  python make_demo_stems.py song1.mp3 "My Song.wav" [--out demo] [--force]
Needs the same deps as the service (torch, demucs, ffmpeg on PATH). Runs locally on CPU.
manifest.json: {slug, title, sourceFile, sha256, durationSec, stems:{name:{file,sizeBytes}}, model}
Also writes <out>/index.json listing all slugs.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("SEPARATOR_NO_AUTOSTART", "1")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import app as svc  # noqa: E402


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", Path(name).stem.lower()).strip("-")
    return s or "track"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=Path("demo"))
    ap.add_argument("--force", action="store_true", help="redo tracks that already have a manifest")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    rc = 0
    for f in a.files:
        if not f.is_file():
            print(f"skip (not a file): {f}", file=sys.stderr)
            rc = 1
            continue
        slug = slugify(f.name)
        d = a.out / slug
        if (d / "manifest.json").exists() and not a.force:
            print(f"[{slug}] already done (use --force to redo)")
            continue
        print(f"[{slug}] separating {f} ...", flush=True)
        dur = svc.probe_duration(f)
        tmp = a.out / f".tmp-{slug}"
        if tmp.exists():
            import shutil
            shutil.rmtree(tmp)
        last = [-1]

        def prog(p):
            pct = int(p * 100)
            if pct // 5 != last[0] // 5:
                last[0] = pct
                print(f"  {pct}%", flush=True)

        svc.demucs_separate(f, tmp, prog)
        d.mkdir(parents=True, exist_ok=True)
        for name in svc.STEMS:
            (tmp / f"{name}.mp3").replace(d / f"{name}.mp3")
        tmp.rmdir()
        manifest = {
            "slug": slug, "title": f.stem, "sourceFile": f.name,
            "sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
            "durationSec": round(dur, 2), "model": "htdemucs",
            "stems": {n: {"file": f"{n}.mp3", "sizeBytes": (d / f"{n}.mp3").stat().st_size}
                      for n in svc.STEMS},
        }
        (d / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(f"[{slug}] done -> {d}")
    slugs = sorted(p.parent.name for p in a.out.glob("*/manifest.json"))
    (a.out / "index.json").write_text(json.dumps({"tracks": slugs}, indent=2))
    return rc


if __name__ == "__main__":
    sys.exit(main())
