const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// Direct path setup using escaped Windows backslashes
const ffmpegPath = 'C:\\Users\\test\\Downloads\\ffmpeg-8.1-full_build-shared\\ffmpeg-8.1-full_build-shared\\bin\\ffmpeg.exe';
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Set up temporary storage folder
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'input_' + Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max file size
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', environment: 'sandbox' });
});

// Transcode and pad audio endpoint
app.post('/api/transcode', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  const inputPath = req.file.path;
  const outputFilename = 'output_' + Date.now() + '.ogg';
  const outputPath = path.join(tempDir, outputFilename);

  console.log(`Processing audio: ${inputPath} -> ${outputPath}`);

  // Use ffmpeg to:
  // 1. Pad 2.0 seconds of silence to the beginning.
  // 2. Transcode to high-quality OGG (libvorbis)
  ffmpeg(inputPath)
    .audioFilters('adelay=2000|2000')
    .noVideo() // drop embedded album art
    // Strip ALL source tags — carried-over MP4/ID3 metadata in the Vorbis
    // comments makes Clone Hero black-screen.
    .outputOptions(['-map_metadata', '-1'])
    .audioCodec('libvorbis')
    .audioQuality(6) // High quality (equivalent to -qscale:a 6, which is ~192kbps)
    .toFormat('ogg')
    .on('start', (commandLine) => {
      console.log('Spawned FFmpeg with command: ' + commandLine);
    })
    .on('error', (err, stdout, stderr) => {
      console.error('FFmpeg process failed:', err.message);
      console.error('FFmpeg Standard Error Output:', stderr);
      // Clean up input file
      try { fs.unlinkSync(inputPath); } catch (e) {}
      res.status(500).json({ error: 'Audio transcoding failed.', details: err.message });
    }) // Fixed dangling Syntax Error brace here
    .on('end', () => {
      console.log('FFmpeg processing completed successfully.');

      // Send the processed .ogg file back
      res.download(outputPath, 'the_song.ogg', (err) => {
        // Cleanup both input and output files after download completes or fails
        try { fs.unlinkSync(inputPath); } catch (e) {}
        try { fs.unlinkSync(outputPath); } catch (e) {}

        if (err) {
          console.error('Error sending file:', err);
        }
      });
    })
    // fluent-ffmpeg only configures the command up to this point; nothing
    // actually spawns (no 'start'/'end'/'error' ever fires) until .save() runs it.
    .save(outputPath);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});