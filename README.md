# Auto-Cut Silence Portions

This project allows you to automatically cut silent portions from your video files. It provides a simple web interface (`index.html`) where you can configure the silence detection settings, and a Node.js backend that uses `ffmpeg` to process the most recent video file in the `movies` folder.

## Prerequisites
- **Node.js**: Ensure you have Node.js installed.
- **FFmpeg**: This project requires FFmpeg and FFprobe to be installed on your system.

## Setup
1. Open terminal in this folder.
2. Install the dependencies by running:
   ```bash
   npm install
   ```

## Usage
1. Start the server by running:
   ```bash
   npm start
   ```
2. Open your web browser and go to `http://localhost:4000`
3. Place a video file in the `movies` folder.
4. On the web interface, adjust your desired settings:
   - **Silence Threshold (dB)**: Volume level to be considered silence (e.g., -30).
   - **Silence Duration**: The minimum duration of silence to detect (e.g., 0.5 seconds).
   - **Padding**: Extra time left around the cuts to make it sound natural (e.g., 0.1 seconds).
5. Click **"Find & Process Last Video"**.
6. The backend will find the most recently modified video in the `movies` folder, process it, and save the result into the `output` folder.

## How it works
- The backend first runs `ffmpeg` with the `silencedetect` filter to find the start and end timestamps of silent parts.
- It calculates the non-silent periods based on the duration, threshold, and padding settings.
- Finally, it uses a complex filter (`trim` and `concat`) to slice the video, remove the silences, and merge the remaining clips together into a new video file.
