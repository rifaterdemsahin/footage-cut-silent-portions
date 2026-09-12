const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const MOVIES_DIR = path.join(__dirname, 'movies');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ensure directories exist
if (!fs.existsSync(MOVIES_DIR)) fs.mkdirSync(MOVIES_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

function getMostRecentFile(dir) {
    const files = fs.readdirSync(dir);
    if (files.length === 0) return null;

    let mostRecentFile = null;
    let mostRecentTime = 0;

    for (const file of files) {
        if (file.startsWith('.')) continue; // skip hidden files like .DS_Store
        
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

app.post('/api/process', async (req, res) => {
    try {
        const { noiseTolerance = -30, duration = 0.5, margin = 0.1 } = req.body;
        
        const inputFile = getMostRecentFile(MOVIES_DIR);
        if (!inputFile) {
            return res.status(404).json({ error: 'No video files found in movies directory' });
        }

        const inputFileName = path.basename(inputFile);
        const outputFile = path.join(OUTPUT_DIR, `cut_${Date.now()}_${inputFileName}`);

        console.log(`Processing: ${inputFile}`);
        console.log(`Settings: noiseTolerance=${noiseTolerance}dB, duration=${duration}s, margin=${margin}s`);

        // Step 1: Detect Silence
        const silenceTimestamps = await detectSilence(inputFile, noiseTolerance, duration);
        console.log('Detected silence periods:', silenceTimestamps);

        // Step 2: Get total duration of the video
        const totalDuration = await getVideoDuration(inputFile);
        console.log('Total duration:', totalDuration);

        // Step 3: Calculate kept periods
        const keepPeriods = calculateKeepPeriods(silenceTimestamps, totalDuration, parseFloat(margin));
        console.log('Periods to keep:', keepPeriods);

        if (keepPeriods.length === 0) {
            return res.status(400).json({ error: 'Video would be completely silent/empty after cuts.' });
        }

        if (keepPeriods.length === 1 && keepPeriods[0].start === 0 && keepPeriods[0].end === totalDuration) {
            // No silence detected
            fs.copyFileSync(inputFile, outputFile);
            return res.json({ message: 'No silence detected, video copied.', inputFile: inputFileName, outputFile: path.basename(outputFile) });
        }

        // Step 4: Cut and concatenate
        await processVideo(inputFile, outputFile, keepPeriods);

        res.json({
            message: 'Video processed successfully.',
            inputFile: inputFileName,
            outputFile: path.basename(outputFile),
            cutCount: silenceTimestamps.length
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'An error occurred during processing.' });
    }
});

function detectSilence(inputFile, noiseTolerance, duration) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', inputFile,
            '-af', `silencedetect=noise=${noiseTolerance}dB:d=${duration}`,
            '-f', 'null',
            '-'
        ]);

        let output = '';
        ffmpeg.stderr.on('data', (data) => {
            output += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error('Failed to run silence detection'));
            }

            const silences = [];
            let currentSilence = {};

            const lines = output.split('\n');
            for (const line of lines) {
                if (line.includes('silence_start:')) {
                    const match = line.match(/silence_start: ([\d.]+)/);
                    if (match) currentSilence.start = parseFloat(match[1]);
                } else if (line.includes('silence_end:')) {
                    const match = line.match(/silence_end: ([\d.]+)/);
                    if (match) {
                        currentSilence.end = parseFloat(match[1]);
                        silences.push({ ...currentSilence });
                        currentSilence = {};
                    }
                }
            }
            resolve(silences);
        });
    });
}

function getVideoDuration(inputFile) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputFile
        ]);

        let output = '';
        ffprobe.stdout.on('data', (data) => output += data.toString());

        ffprobe.on('close', (code) => {
            if (code !== 0) return reject(new Error('Failed to get video duration'));
            resolve(parseFloat(output.trim()));
        });
    });
}

function calculateKeepPeriods(silences, totalDuration, margin) {
    const keep = [];
    let currentTime = 0;

    for (const silence of silences) {
        let startSilence = silence.start + margin;
        let endSilence = silence.end - margin;

        if (startSilence > silence.end) startSilence = silence.start;
        if (endSilence < silence.start) endSilence = silence.end;

        if (startSilence > currentTime) {
            keep.push({ start: currentTime, end: startSilence });
        }
        currentTime = endSilence;
    }

    if (currentTime < totalDuration) {
        keep.push({ start: currentTime, end: totalDuration });
    }

    return keep;
}

function processVideo(inputFile, outputFile, keepPeriods) {
    return new Promise((resolve, reject) => {
        // Prepare complex filter string
        let filterComplex = '';
        let concatInputs = '';

        keepPeriods.forEach((period, i) => {
            filterComplex += `[0:v]trim=start=${period.start}:end=${period.end},setpts=PTS-STARTPTS[v${i}]; `;
            filterComplex += `[0:a]atrim=start=${period.start}:end=${period.end},asetpts=PTS-STARTPTS[a${i}]; `;
            concatInputs += `[v${i}][a${i}]`;
        });

        filterComplex += `${concatInputs}concat=n=${keepPeriods.length}:v=1:a=1[outv][outa]`;

        const args = [
            '-i', inputFile,
            '-filter_complex', filterComplex,
            '-map', '[outv]',
            '-map', '[outa]',
            '-y',
            outputFile
        ];

        console.log('Running FFmpeg with args length:', args.length);
        
        const ffmpeg = spawn('ffmpeg', args);
        
        let errLog = '';
        ffmpeg.stderr.on('data', (data) => errLog += data.toString());

        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                console.error('FFmpeg error:', errLog);
                return reject(new Error('Failed to process video'));
            }
            resolve();
        });
    });
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
