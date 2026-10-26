# SyncWave — Multi-Device Synced Speaker App

Oct 12, 2026 · @Sai Charan

## Overview

SyncWave turns every phone, laptop and tablet in a room into one speaker system: open a link, tap join, and every device plays the same audio within 10 ms of each other. No app install, no same-brand hardware.

**The problem.** One phone speaker cannot fill a room. Bluetooth speakers are one-at-a-time, and multi-room systems (Sonos, Chromecast groups) need matching hardware and setup. Meanwhile, a room of people is already carrying five to twenty speakers in their pockets.

**What makes it different.**

- **Zero install.** Any modern browser becomes a speaker by opening a URL or scanning a QR code.
- **Spatial, not just loud.** Devices can be assigned positions and play separate channels, so a desk of laptops becomes stereo or surround.
- **Visible sync.** A live sync-health view shows each device's offset in milliseconds, so the precision is provable, not claimed.

## Goals and non-goals

The goal is a live, in-browser speaker group that stays in sync for a full song across mixed devices, built solo with Claude Code.

**Goals**

- Five or more mixed devices (Android, iPhone, laptops) play in sync, median offset under 10 ms.
- Join in under 10 seconds from a QR scan, no account needed.
- Stay in sync for 10+ minutes without audible echo.
- A demo that convinces a room in under 2 minutes.

**Non-goals (for now)**

- Streaming from Spotify or YouTube; their terms and DRM block this. Users play their own files.
- Native apps; the browser is the product.
- Internet-scale rooms; the target is one physical space, up to about 20 devices.

## Users and scenarios

The core user is a host who wants more sound than one device gives, with guests who just tap a link.

| Scenario | Who | What SyncWave does |
| --- | --- | --- |
| Hostel or flat party | Host + friends | Every phone in the room becomes one loud, even speaker |
| Class or club event | Organiser | Laptops around a hall play announcements and music together |
| Outdoor gathering | Group with phones only | No Bluetooth speaker needed; volume scales with people |
| Desk surround | Solo user | Two laptops + a phone become left, right and centre |
| Silent disco | Group in headphones | Everyone hears the same beat at the same instant |

## Core features (MVP)

The MVP is six features; without any one of them, sync either fails or cannot be shown.

| Feature | What it does | Done when |
| --- | --- | --- |
| Rooms | Host creates a room; guests join by link or QR code, with a display name | A guest joins from a phone camera scan in under 10 s |
| Clock sync | Each device estimates its offset from the server clock, repeatedly | Offsets are stable to within 2 ms between re-syncs |
| Preloaded audio | Host uploads a file; every device downloads and decodes it fully before play | No device starts until all report ready |
| Scheduled playback | Host presses play; server picks a start time \~1.5 s ahead; each device starts at that instant on its corrected clock | Five devices start with median offset under 10 ms |
| Drift correction | Devices compare expected vs actual position every few seconds and nudge back | Offset stays under 10 ms over 10 minutes |
| Per-device trim | A slider per device adds or removes delay (for Bluetooth output or odd hardware) | A Bluetooth-connected phone can be pulled back into sync by hand |

Controls for the host: play, pause, seek, next, and a room-wide volume; guests get local volume and a leave button.

## Signature features

These are what make people stop and watch; build the first three before any of the rest.

| Feature | What the audience sees | Priority |
| --- | --- | --- |
| **Spatial mode** | Drag devices onto a room map (left, right, centre, rear); each plays its own channel, so laptops become stereo or 5.1-style surround | Must |
| **Sync radar** | A live screen showing every device as a dot with its offset in ms, going green when locked | Must |
| **Beat light show** | Every screen flashes colour on the beat, in sync; a wall of phones pulsing together is visible proof of sync | Must |
| **Auto-calibrate by ear** | The host's mic listens while each device plays a short chirp; the app measures the real acoustic delay and corrects it, including Bluetooth lag | Should |
| **Drop-in join** | A device joining mid-song lands at the exact current position, no restart | Should |
| **Guest queue** | Guests add songs from their own phone and vote; the top track plays next | Should |
| **Host handoff** | If the host leaves, another device takes control and playback continues | Could |
| **Hotspot mode** | Runs on a laptop over a phone hotspot with no internet at all | Could |
| **Announce** | Host speaks into the phone and it plays on every device (higher latency, walkie-talkie style) | Could |
| **Wave effect** | Deliberately offsets devices around the room so sound sweeps in a circle | Could |

## How sync works

Sync rests on one idea: every device agrees on a shared clock, then each starts the same pre-loaded audio at the same agreed instant and keeps checking itself.

1. **Clock offset (NTP-style).** A device sends a ping stamped t0; the server stamps receive t1 and send t2; the device stamps arrival t3. The offset and round-trip are:

```latex
\theta = \frac{(t_1 - t_0) + (t_2 - t_3)}{2}, \qquad \delta = (t_3 - t_0) - (t_2 - t_1)
```

2. **Filter the noise.** Send about 20 pings, keep the ones with the smallest round-trip (least Wi-Fi jitter), and take their median offset. Repeat every few seconds.
3. **Shared timeline.** The room stores one fact: track X started at server time S. Any device's correct position is (server now − S), so play, pause, seek and late joins all follow from that one number.
4. **Precise start.** Each device decodes the whole file into memory with the Web Audio API, then schedules playback at the agreed instant, converted to its own audio clock. Scheduling on the audio clock, not a JavaScript timer, is what gets accuracy down to milliseconds.
5. **Output latency.** Speakers add their own delay. Where the browser reports output latency, subtract it; otherwise rely on the trim slider or auto-calibrate.
6. **Drift correction.** Device clocks run at slightly different speeds, so positions slowly slide apart. Every few seconds each device compares expected and actual position: small drift → nudge the playback rate by a fraction of a percent until aligned; large drift (say over 40 ms) → re-seek.

**Why 10 ms.** Two speakers playing the same sound more than roughly 20–30 ms apart start to sound like an echo; under 10 ms they blend into one.

## Architecture and tech stack

A thin server keeps rooms and the clock; all audio timing happens inside each browser.

&#91;embedded content: architecture · browsers and one sync server\]

The server never streams audio live; devices download the file once, then only small control and ping messages flow.

- **Frontend:** React (Vite), Web Audio API for scheduled playback, Wake Lock API, a QR code library.
- **Backend:** Node.js with WebSockets (ws or Socket.IO) for rooms, control and clock pings; simple file storage for uploads.
- **Hosting:** a free-tier host for public rooms, or the laptop itself on local Wi-Fi or a phone hotspot for the class demo.
- **Testing:** a simulated-latency client to measure sync without real devices; Audacity for measuring real recordings.

## Success metrics and acceptance criteria

The project succeeds if five mixed devices hold under 10 ms median offset for a full 10-minute session.

| Metric | Target | How it is measured |
| --- | --- | --- |
| Start offset, 5 mixed devices | Median under 10 ms, worst under 20 ms | Record all devices with one external mic; measure onset gaps in Audacity |
| Drift over a session | Under 10 ms after 10 minutes | Same recording at minute 10; sync radar log |
| Join time | Under 10 s from QR scan to playing | Stopwatch, 5 trials |
| Late-join accuracy | Under 15 ms on landing | External recording |
| Browser coverage | Chrome Android, Safari iOS, Chrome and Firefox desktop | Manual test matrix |

- [ ] Room create and join by QR works on all four browsers
- [ ] Five devices start a song together under target
- [ ] Pause, seek and next stay in sync
- [ ] Spatial mode plays separate left and right channels
- [ ] Sync radar shows live offsets
- [ ] Beat light show runs in sync with audio

## Risks and open questions

Mobile browsers, not the sync maths, are the biggest risk.

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Autoplay rules | Browsers block sound until the user taps | Join flow ends with a "Tap to start" button that unlocks audio |
| Screen lock on phones | Audio or timers pause | Wake Lock API to keep the screen on; warn the user |
| iPhone quirks | Safari may mute web audio on silent mode or report latency poorly | Test early on a real iPhone; show a hint to turn silent off |
| Bluetooth output | Adds a large, varying delay (often 100 ms+) | Trim slider, then auto-calibrate |
| Wi-Fi jitter | Noisy clock estimates | Min-RTT filtering; local hotspot mode |
| Copyright | Can't stream from music services | Users play their own files only |

**Open questions**

- Host a public server on a free tier, or run on a laptop over local Wi-Fi for the demo?
- How many test devices can be borrowed for the class demo?

## Milestones and build plan

Build in six milestones; each ends in something that runs, so the project is demoable from milestone 3 on.

1. **Skeleton.** Server with WebSocket rooms, QR join page, device list. *Done when* three devices see each other in a room.
2. **Clock sync.** Ping-pong offset estimation with min-RTT filter; show each device's offset on screen. *Done when* offsets are stable to 2 ms.
3. **Synced play.** Upload, preload, scheduled start, pause and seek. *Done when* two laptops play together with no audible echo.
4. **Drift and trim.** Drift correction loop plus per-device slider. *Done when* five devices hold sync for 10 minutes.
5. **Wow layer.** Sync radar, spatial mode, beat light show.
6. **Stretch.** Auto-calibrate by ear, guest queue, drop-in join, host handoff.

**Working with Claude Code.** Give it this spec as the project brief; ask for a test harness first (a fake-latency client that simulates jitter), so sync quality can be measured without five real phones on every change.

## Demo script

Two minutes, five-plus devices, built so the audience does the proving.

1. Show one phone playing a song alone: thin and quiet.
2. Put the QR code on the projector; ask 4–5 people to scan and tap join.
3. Press play. The room fills with one sound; no echo.
4. Switch the projector to the sync radar: every dot green, offsets in single-digit ms.
5. Turn on the light show: every screen in the room flashes on the beat together.
6. Switch to spatial mode: left side of the room plays one channel, right side the other.
7. Close with a late joiner: a new phone joins mid-song and lands exactly in place.
