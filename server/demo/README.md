# Demo library (instant Orchestra demo)

Each folder here is one pre-separated song the host can add to a room with one tap ("Demo library" in the Orchestra tab), with no separation wait:

```
server/demo/<slug>/vocals.mp3
                   drums.mp3
                   bass.mp3
                   other.mp3
                   manifest.json     {slug, title, durationSec, ...}
```

No audio is committed to the repo. Produce the folders locally (needs Python 3.10-3.11, ffmpeg, torch + demucs, see `separator/README.md`):

```
cd separator
python make_demo_stems.py ~/Music/song1.mp3 "~/Music/My Song.wav" --out ../server/demo
```

This writes `server/demo/<slug>/` for every input (plus `index.json`, which the server ignores). Expect minutes per song on CPU. Use only music you have the right to use.

The server reads this folder on every `GET /api/demo`, so new songs show up without a restart. A folder only counts when `manifest.json` and all four `.mp3` files exist. Set `DEMO_DIR=/other/path` to use a different folder. Demo songs have no full-mix file: "everyone plays everything" means every device plays all four stems.

Not shipping audio also means there is no synthetic example here: a hand-made `.mp3` would need an encoder, and the app checks for real stems.
