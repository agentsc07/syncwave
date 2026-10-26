# Demo library (instant Orchestra demo)

Each folder here is one pre-separated song the host can add to a room with one tap ("Demo library" in the Orchestra tab), with no separation wait:

```
server/demo/<slug>/vocals.mp3  drums.mp3  bass.mp3  other.mp3  manifest.json
```

The server reads this folder on every `GET /api/demo`. A folder counts only when `manifest.json` and all four `.mp3` files exist. Set `DEMO_DIR=/other/path` to use another folder. Demo songs have no full-mix file: "everyone plays everything" means every device plays all four stems.

## Included songs and attribution

Both songs are from **"The Public Domain EP" by Hussalonia**, uploaded by the artist to the Internet Archive:
<https://archive.org/details/The_Public_Domain_EP>. Licence: **Creative Commons Attribution 4.0 International (CC BY 4.0)**, <https://creativecommons.org/licenses/by/4.0/>. The artist's description says the songs "have been released without an enforced copyright" and may be sampled, distributed, covered or used privately or commercially.

| Folder | Original track | Changes made (as required by CC BY) |
| --- | --- | --- |
| `meaning/` | "01 Meaning" | Cut to a 70 s excerpt (from 0:05) with fade-in/out; split into vocals/drums/bass/other with Demucs htdemucs; re-encoded to MP3 |
| `more-than-that/` | "03 More Than That" | Cut to a 70 s excerpt (from 0:05) with fade-in/out; split into vocals/drums/bass/other with Demucs htdemucs; re-encoded to MP3 |

The stems are AI-separated and imperfect (some bleed between stems). Not endorsed by the artist.

## Adding more songs

Needs Python 3.10-3.11, ffmpeg, torch + demucs (see `separator/startup.md`). Use only music you may redistribute (CC0 / CC BY / your own), and record the attribution in this file:

```
cd separator
python make_demo_stems.py ~/Music/song1.mp3 --out ../server/demo
```

Each song is about 4.5 MB for a 70 s excerpt; keep to a few songs so the repo stays small.
