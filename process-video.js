'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULTS = {
  noiseTolerance: 'auto',
  duration: 0.5,
  margin: 0.12,
  minClip: 0.25,
  mergeGap: 0.25,
};

function spawnCapture(cmd, args, { collectStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    if (collectStdout) {
      child.stdout.on('data', (d) => { stdout += d.toString(); });
    }
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`${cmd} exited with code ${code}`);
        err.stderr = stderr.slice(-4000);
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function getVideoDuration(inputFile) {
  const { stdout } = await spawnCapture('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputFile,
  ], { collectStdout: true });
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error('Could not read video duration');
  }
  return duration;
}

async function getVideoInfo(inputFile) {
  const { stdout } = await spawnCapture('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputFile,
  ], { collectStdout: true });
  return JSON.parse(stdout);
}

async function detectVolume(inputFile) {
  const { stderr } = await spawnCapture('ffmpeg', [
    '-i', inputFile,
    '-vn',
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ]);
  const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)/);
  const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)/);
  const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -40;
  const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : -20;
  // Quiet talking-head audio often sits well below -30 dB. Aim between
  // the noise floor and the peaks so speech is kept and dead air is cut.
  const suggested = Math.round(Math.max(meanVolume + 8, maxVolume - 20));
  return { meanVolume, maxVolume, suggested };
}

async function detectSilence(inputFile, noiseTolerance, duration) {
  const { stderr } = await spawnCapture('ffmpeg', [
    '-i', inputFile,
    '-vn',
    '-af', `silencedetect=noise=${noiseTolerance}dB:d=${duration}`,
    '-f', 'null',
    '-',
  ]);

  const silences = [];
  let current = {};
  for (const line of stderr.split('\n')) {
    if (line.includes('silence_start:')) {
      const match = line.match(/silence_start:\s*([\d.]+)/);
      if (match) current.start = parseFloat(match[1]);
    } else if (line.includes('silence_end:')) {
      const match = line.match(/silence_end:\s*([\d.]+)/);
      if (match) {
        current.end = parseFloat(match[1]);
        if (Number.isFinite(current.start) && Number.isFinite(current.end)) {
          silences.push({ start: current.start, end: current.end });
        }
        current = {};
      }
    }
  }
  return silences;
}

function calculateKeepPeriods(silences, totalDuration, margin, minClip = DEFAULTS.minClip, mergeGap = DEFAULTS.mergeGap) {
  const raw = [];
  let currentTime = 0;

  for (const silence of silences) {
    let startSilence = silence.start + margin;
    let endSilence = silence.end - margin;
    if (startSilence > silence.end) startSilence = silence.start;
    if (endSilence < silence.start) endSilence = silence.end;

    if (startSilence > currentTime + 0.04) {
      raw.push({ start: currentTime, end: Math.min(startSilence, totalDuration) });
    }
    currentTime = Math.max(currentTime, endSilence);
  }

  if (currentTime < totalDuration - 0.04) {
    raw.push({ start: currentTime, end: totalDuration });
  }

  const merged = [];
  for (const period of raw) {
    if (period.end - period.start < minClip) continue;
    const prev = merged[merged.length - 1];
    if (prev && period.start - prev.end <= mergeGap) {
      prev.end = period.end;
    } else {
      merged.push({ ...period });
    }
  }
  return merged;
}

function padIndex(i, width) {
  return String(i).padStart(width, '0');
}

function formatSeconds(s) {
  if (!Number.isFinite(s)) return 'n/a';
  const ms = Math.round(s * 1000);
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${m}:${String(sec).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

async function exportClip(inputFile, outputFile, period) {
  await spawnCapture('ffmpeg', [
    '-y',
    '-ss', String(period.start),
    '-to', String(period.end),
    '-i', inputFile,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputFile,
  ]);
}

async function concatClips(clipPaths, outputFile, workDir) {
  const listFile = path.join(workDir, 'concat.txt');
  const body = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, body);
  await spawnCapture('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    outputFile,
  ]);
}

function emptyDir(dir) {
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Cut silent portions from a video, export keep-clips, and concatenate.
 */
async function processVideo(inputFile, outputRoot, options = {}) {
  const duration = Number(options.duration ?? DEFAULTS.duration);
  const margin = Number(options.margin ?? DEFAULTS.margin);
  const minClip = Number(options.minClip ?? DEFAULTS.minClip);
  const mergeGap = Number(options.mergeGap ?? DEFAULTS.mergeGap);
  const onProgress = options.onProgress || (() => {});

  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const timings = {};
  const mark = (key, ms) => { timings[key] = ms; };

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input not found: ${inputFile}`);
  }
  fs.mkdirSync(outputRoot, { recursive: true });

  const inputBase = path.parse(inputFile).name.replace(/\s+/g, '_');
  const jobDir = path.join(outputRoot, inputBase);
  const clipsDir = path.join(jobDir, 'clips');
  emptyDir(jobDir);
  fs.mkdirSync(clipsDir, { recursive: true });

  onProgress('probe');
  let t = Date.now();
  const [totalDuration, info, volume] = await Promise.all([
    getVideoDuration(inputFile),
    getVideoInfo(inputFile),
    detectVolume(inputFile),
  ]);
  mark('probeMs', Date.now() - t);

  const requestedNoise = options.noiseTolerance ?? DEFAULTS.noiseTolerance;
  const autoNoise = requestedNoise === 'auto' || requestedNoise === '' || requestedNoise === null || requestedNoise === undefined;
  const noiseTolerance = autoNoise ? volume.suggested : Number(requestedNoise);

  const videoStream = (info.streams || []).find((s) => s.codec_type === 'video') || {};
  const audioStream = (info.streams || []).find((s) => s.codec_type === 'audio') || {};

  onProgress(`detect-silence (${noiseTolerance} dB${autoNoise ? ', auto' : ''})`);
  t = Date.now();
  const silences = await detectSilence(inputFile, noiseTolerance, duration);
  mark('detectSilenceMs', Date.now() - t);

  const keepPeriods = calculateKeepPeriods(silences, totalDuration, margin, minClip, mergeGap);
  if (keepPeriods.length === 0) {
    throw new Error('Video would be completely silent/empty after cuts.');
  }

  const clipPaths = [];
  const clipMeta = [];
  const width = String(keepPeriods.length).length;
  onProgress('export-clips');
  t = Date.now();
  for (let i = 0; i < keepPeriods.length; i++) {
    const period = keepPeriods[i];
    const name = `clip_${padIndex(i + 1, Math.max(2, width))}_${period.start.toFixed(2)}s-${period.end.toFixed(2)}s.mp4`;
    const outPath = path.join(clipsDir, name);
    onProgress(`export-clip ${i + 1}/${keepPeriods.length}`);
    await exportClip(inputFile, outPath, period);
    clipPaths.push(outPath);
    clipMeta.push({
      file: path.relative(outputRoot, outPath),
      index: i + 1,
      start: period.start,
      end: period.end,
      duration: period.end - period.start,
      bytes: fs.statSync(outPath).size,
    });
  }
  mark('exportClipsMs', Date.now() - t);

  onProgress('concat');
  t = Date.now();
  const concatFile = path.join(jobDir, `${inputBase}_nosilence.mp4`);
  await concatClips(clipPaths, concatFile, jobDir);
  mark('concatMs', Date.now() - t);

  const outputDuration = await getVideoDuration(concatFile);
  const wallMs = Date.now() - wallStart;
  const inputBytes = fs.statSync(inputFile).size;
  const outputBytes = fs.statSync(concatFile).size;
  const keptSeconds = keepPeriods.reduce((sum, p) => sum + (p.end - p.start), 0);
  const removedSeconds = Math.max(0, totalDuration - keptSeconds);

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    inputFile: path.basename(inputFile),
    inputPath: inputFile,
    outputFile: path.relative(outputRoot, concatFile),
    settings: {
      noiseTolerance,
      noiseMode: autoNoise ? 'auto' : 'manual',
      duration,
      margin,
      minClip,
      mergeGap,
    },
    source: {
      durationSeconds: totalDuration,
      durationLabel: formatSeconds(totalDuration),
      bytes: inputBytes,
      width: videoStream.width || null,
      height: videoStream.height || null,
      fps: videoStream.r_frame_rate || null,
      videoCodec: videoStream.codec_name || null,
      audioCodec: audioStream.codec_name || null,
      meanVolume: volume.meanVolume,
      maxVolume: volume.maxVolume,
    },
    result: {
      durationSeconds: outputDuration,
      durationLabel: formatSeconds(outputDuration),
      bytes: outputBytes,
      clipCount: keepPeriods.length,
      silenceCount: silences.length,
      keptSeconds,
      removedSeconds,
      removedPercent: totalDuration ? (removedSeconds / totalDuration) * 100 : 0,
      realtimeFactor: totalDuration && wallMs ? totalDuration / (wallMs / 1000) : null,
    },
    timings: {
      ...timings,
      totalMs: wallMs,
      totalLabel: formatSeconds(wallMs / 1000),
    },
    silences,
    keepPeriods,
    clips: clipMeta,
  };

  const reportPath = path.join(jobDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outputRoot, 'last-run.json'), JSON.stringify(report, null, 2));

  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input) {
    console.error('Usage: node process-video.js <input.mp4> [outputDir] [noiseDb] [minSilence] [margin]');
    process.exit(1);
  }
  const outputRoot = args[1] || path.join(__dirname, 'output');
  const options = {
    noiseTolerance: args[2] !== undefined ? (args[2] === 'auto' ? 'auto' : Number(args[2])) : DEFAULTS.noiseTolerance,
    duration: args[3] !== undefined ? Number(args[3]) : DEFAULTS.duration,
    margin: args[4] !== undefined ? Number(args[4]) : DEFAULTS.margin,
    onProgress: (step) => console.log(`[progress] ${step}`),
  };
  try {
    const report = await processVideo(path.resolve(input), path.resolve(outputRoot), options);
    console.log(JSON.stringify({
      ok: true,
      outputFile: report.outputFile,
      clips: report.result.clipCount,
      inputDuration: report.source.durationLabel,
      outputDuration: report.result.durationLabel,
      totalMs: report.timings.totalMs,
    }, null, 2));
  } catch (err) {
    console.error(err.message);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULTS,
  processVideo,
  detectSilence,
  detectVolume,
  calculateKeepPeriods,
  getVideoDuration,
  formatSeconds,
};
