'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { processVideo, DEFAULTS } = require('./process-video');

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/output', express.static('output'));

const MOVIES_DIR = path.join(__dirname, 'movies');
const OUTPUT_DIR = path.join(__dirname, 'output');

if (!fs.existsSync(MOVIES_DIR)) fs.mkdirSync(MOVIES_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

function getMostRecentFile(dir) {
  const files = fs.readdirSync(dir);
  let mostRecentFile = null;
  let mostRecentTime = 0;

  for (const file of files) {
    if (file.startsWith('.')) continue;
    const ext = path.extname(file).toLowerCase();
    if (['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(ext)) {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs > mostRecentTime) {
        mostRecentTime = stats.mtimeMs;
        mostRecentFile = filePath;
      }
    }
  }
  return mostRecentFile;
}

let busy = false;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, busy });
});

app.get('/api/last-run', (_req, res) => {
  const reportPath = path.join(OUTPUT_DIR, 'last-run.json');
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'No run yet. Process a video first.' });
  }
  res.json(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
});

app.post('/api/process', async (req, res) => {
  if (busy) {
    return res.status(409).json({ error: 'A process is already running.' });
  }

  try {
    busy = true;
    const rawNoise = req.body.noiseTolerance;
    const noiseTolerance = (rawNoise === 'auto' || rawNoise === '' || rawNoise === undefined || rawNoise === null)
      ? 'auto'
      : Number(rawNoise);
    const duration = Number(req.body.duration ?? DEFAULTS.duration);
    const margin = Number(req.body.margin ?? DEFAULTS.margin);
    const requested = req.body.file ? path.basename(String(req.body.file)) : null;

    let inputFile = requested ? path.join(MOVIES_DIR, requested) : getMostRecentFile(MOVIES_DIR);
    if (requested && !fs.existsSync(inputFile)) {
      return res.status(404).json({ error: `File not found in movies/: ${requested}` });
    }
    if (!inputFile) {
      return res.status(404).json({ error: 'No video files found in movies directory' });
    }

    console.log(`Processing: ${inputFile}`);
    console.log(`Settings: noiseTolerance=${noiseTolerance}dB, duration=${duration}s, margin=${margin}s`);

    const report = await processVideo(inputFile, OUTPUT_DIR, {
      noiseTolerance,
      duration,
      margin,
      onProgress: (step) => console.log(`[progress] ${step}`),
    });

    res.json({
      message: 'Video processed successfully. Clips and cut video are in output/.',
      inputFile: report.inputFile,
      outputFile: report.outputFile,
      clipCount: report.result.clipCount,
      cutCount: report.result.silenceCount,
      timings: report.timings,
      sourceDuration: report.source.durationLabel,
      outputDuration: report.result.durationLabel,
      removedPercent: report.result.removedPercent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'An error occurred during processing.' });
  } finally {
    busy = false;
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Drop videos in ${MOVIES_DIR}`);
  console.log(`Cuts land in ${OUTPUT_DIR}`);
});
