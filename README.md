# ✂️ Auto-cut silent portions

Cut dead air out of talking-head video, dump the speech as clips, and stitch a tight master.

🌐 **GitHub Pages:** [https://rifaterdemsahin.github.io/footage-cut-silent-portions/](https://rifaterdemsahin.github.io/footage-cut-silent-portions/)

> [!WARNING]
> GitHub Pages is **docs only** (HTML/CSS). FFmpeg runs on your machine. Use the local server below to actually cut video.

## 🧰 Prerequisites

- **Node.js** 18+
- **FFmpeg** + **FFprobe** (`brew install ffmpeg`)

## 💻 Local server

```bash
npm install
npm start
```

Open [http://localhost:4000](http://localhost:4000) in **Google Chrome**.

```bash
open -a "Google Chrome" http://localhost:4000
```

Put source files in `movies/`. Cuts and clips land in `output/`.

## 🎞️ Process `alpha.mp4` from the CLI

```bash
# copy / rename the take
cp "/path/to/output alpha.mp4" movies/alpha.mp4

# auto threshold (recommended for quiet mics)
node process-video.js movies/alpha.mp4 output auto 0.5 0.12
```

Outputs:

- `output/alpha/clips/clip_*.mp4` — speech footage
- `output/alpha/alpha_nosilence.mp4` — concatenated master
- `output/last-run.json` — timings for `performance.html`

## 📊 Last run (`alpha.mp4`)

|  |  |
|---|---|
| Source | 3:54 · 1920×1080 · 68 MB |
| Cut master | 1:08 · 16 MB · 25 clips |
| Silence removed | 71% |
| Wall time | **11.5 seconds** (~20× realtime) |
| Threshold | auto **−40 dB** (mean −48.4 dB, peak −20.6 dB) |

See [performance.html](https://rifaterdemsahin.github.io/footage-cut-silent-portions/performance.html) and [rationale.html](https://rifaterdemsahin.github.io/footage-cut-silent-portions/rationale.html).

## 🆚 Why not DaVinci Resolve?

Resolve is a full NLE. This repo is a **headless silence gate** so an agent can run, watch, and retry. Use Resolve *after* you have clips. The comparison and the **AI agent prompt** live on the [home page](https://rifaterdemsahin.github.io/footage-cut-silent-portions/).

## ⚙️ How it works

1. Measure loudness (`volumedetect`) and pick a threshold when set to `auto`.
2. `silencedetect` on audio only.
3. Keep regions get padding; tiny blips drop; close gaps merge.
4. Each keep region is encoded as a clip, then concatenated with stream copy.

## 🚀 Deploy docs

```bash
npm run deploy
```
