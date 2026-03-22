const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const { execSync, spawn } = require('child_process');

let ffBinary = path.join(process.cwd(), 'ffmpeg.exe');
let ytdlpBin = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');

if (process.platform === 'win32') {
  try {
    // Resolve absolute path first
    if (!fs.existsSync(ytdlpBin)) {
      // Fallback: check if it's one level up if we are in some nested execution
      ytdlpBin = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
    }
    
    // Get short path to be absolutely safe with cmd.exe and spaces
    ffBinary = execSync(`for %I in ("${ffBinary}") do @echo %~sI`, { shell: 'cmd.exe' }).toString().trim().split('\n').pop().trim();
    ytdlpBin = execSync(`for %I in ("${ytdlpBin}") do @echo %~sI`, { shell: 'cmd.exe' }).toString().trim().split('\n').pop().trim();
  } catch (e) {
    console.error("Short path conversion failed:", e.message);
  }
}

// Setup FFmpeg in PATH
process.env.PATH = path.dirname(ffBinary) + path.delimiter + process.env.PATH;

const app = express();
const PORT = process.env.PORT || 3001;

// Wrapper for direct yt-dlp execution with simplified options
const runYtDlp = (url, options = {}, spawnOptions = {}) => {
  const args = [url];
  
  // Basic browser mimicking without problematic headers
  if (!options.userAgent) {
    options.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  }
  if (!options.referer) {
    options.referer = 'https://www.google.com/';
  }
  
  // Basic reliability options
  options.noCheckCertificate = true;
  options.retries = 2;
  options.fragmentRetries = 2;
  
  for (const [key, value] of Object.entries(options)) {
    if (value === true) {
      args.push(key.length === 1 ? `-${key}` : `--${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`);
    } else if (value !== false && value !== undefined) {
      args.push(key.length === 1 ? `-${key}` : `--${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`);
      if (Array.isArray(value)) {
        value.forEach(v => args.push(v.toString()));
      } else {
        args.push(value.toString());
      }
    }
  }
  
  console.log(`Executing: ${ytdlpBin} ${args.join(' ')}`);
  return spawn(ytdlpBin, args, { ...spawnOptions, env: { ...process.env, ...spawnOptions.env } });
};

app.use(cors());
app.use(express.json());

// Helper to format duration
const formatDuration = (seconds) => {
  if (!seconds) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

// GET /api/info?url=...
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  try {
    const subprocess = runYtDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      userAgent: req.headers['user-agent'],
    });

    let stdoutData = '';
    let stderrData = '';
    subprocess.stdout.on('data', d => stdoutData += d);
    subprocess.stderr.on('data', d => stderrData += d);

    const output = await new Promise((resolve, reject) => {
      subprocess.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(stdoutData));
          } catch (e) {
            reject(new Error('Failed to parse video info'));
          }
        } else {
          reject(new Error(stderrData || 'Failed to extract video info'));
        }
      });
      subprocess.on('error', reject);
    });

    const platform = output.extractor_key ? output.extractor_key.toLowerCase() : 'unknown';

    const has1080p = output.formats && output.formats.some(f => f.height >= 1080);
    const has720p = output.formats && output.formats.some(f => f.height >= 720);

    const formats = [];
    if (has1080p) formats.push({ id: '1080p', quality: '1080p', type: 'video', ext: 'mp4', size: 'Unknown' });
    if (has720p) formats.push({ id: '720p', quality: '720p', type: 'video', ext: 'mp4', size: 'Unknown' });
    formats.push({ id: 'bestaudio', quality: 'Audio Only', type: 'audio', ext: 'm4a', size: 'Unknown' });

    res.json({
      success: true,
      data: {
        url,
        platform,
        title: output.title || 'Unknown Title',
        thumbnail: output.thumbnail || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?auto=format&fit=crop&q=80&w=774',
        duration: formatDuration(output.duration),
        formats
      }
    });
  } catch (error) {
    const errorLog = `${new Date().toISOString()} - Info extraction failed: ${error.message}\n${error.stack}\n\n`;
    fs.appendFileSync(path.join(__dirname, 'error.log'), errorLog);
    console.error('Info extraction failed:', error.message);
    
    // Simplified error handling without cookie references
    res.status(500).json({ 
      success: false, 
      error: `Failed to extract video info: ${error.message}`
    });
  }
});

// GET /api/download?url=...&format=...
app.get('/api/download', async (req, res) => {
  const { url, format } = req.query;

  if (!url || !format) {
    return res.status(400).json({ success: false, error: 'URL and format are required' });
  }

  req.setTimeout(0);
  res.setTimeout(0);

  const isAudio = format.toLowerCase().includes('audio');

  try {
    let formatCode = 'best';
    let mergeOutputFormat = undefined;

    if (isAudio) {
      formatCode = 'bestaudio/best';
    } else if (format === '1080p') {
      // Prefer H.264 (avc1) and AAC for maximum compatibility, then fall back to best available 1080p
      // We now use MP4 container with temporary file merge to guarantee full audio duration.
      formatCode = 'bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
      mergeOutputFormat = 'mp4';
    } else if (format === '720p') {
      formatCode = 'best[vcodec^=avc1][height<=720]+bestaudio/best[height<=720]';
    }

    const extension = isAudio ? 'm4a' : 'mp4';

    // Define temporary file path for merging if needed
    const tempFilePath = format === '1080p' ? path.join(os.tmpdir(), `dl_${Date.now()}.${extension}`) : null;

    const options = {
      f: formatCode,
      o: tempFilePath || '-',
      noWarnings: true,
      ffmpegLocation: ffBinary,
      postprocessorArgs: 'ffmpeg:-movflags +faststart',
      userAgent: req.headers['user-agent'],
    };
    if (mergeOutputFormat) {
      options.mergeOutputFormat = mergeOutputFormat;
    }

    console.log(`Starting download for ${url} with format ${formatCode} (Dest: ${tempFilePath || 'stdout'})`);
    
    if (tempFilePath) {
      // For 1080p, download to file then send
      console.log(`Starting 1080p download/merge for ${url} (Dest: ${tempFilePath})`);
      
      const subprocess = runYtDlp(url, options, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderrData = '';
      subprocess.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

      subprocess.on('close', (code) => {
        if (code === 0 && fs.existsSync(tempFilePath)) {
          console.log(`Download finished, sending file: ${tempFilePath}`);
          res.download(tempFilePath, `video_1080p.${extension}`, (err) => {
            if (err) console.error("Error sending file:", err.message);
            // Clean up
            fs.unlink(tempFilePath, (unlinkErr) => {
              if (unlinkErr) console.error("Error deleting temp file:", unlinkErr);
            });
          });
        } else {
          const errorLog = `${new Date().toISOString()} - 1080p Merge failed with code ${code}\nStderr: ${stderrData}\n\n`;
          fs.appendFileSync(path.join(__dirname, 'error.log'), errorLog);
          console.error("1080p Download/Merge failed:", stderrData);
          if (!res.headersSent) res.status(500).send(`Merge failed: ${stderrData.split('\n')[0]}`);
          if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        }
      });

      subprocess.on('error', (err) => {
        const errorLog = `${new Date().toISOString()} - 1080p Process Error: ${err.message}\n\n`;
        fs.appendFileSync(path.join(__dirname, 'error.log'), errorLog);
        console.error("1080p Process Error:", err.message);
        if (!res.headersSent) res.status(500).end();
      });
    } else {
      // For other formats, stream directly
      res.setHeader('Content-Disposition', `attachment; filename="downloaded_media_${Date.now()}.${extension}"`);
      res.setHeader('Content-Type', isAudio ? 'audio/mp4' : 'video/mp4');

      const subprocess = runYtDlp(url, options, { stdio: ['ignore', 'pipe', 'pipe'] });
      
      subprocess.stdout.pipe(res);

      let stderrData = '';
      subprocess.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

      subprocess.on('error', (err) => {
        const errorLog = `${new Date().toISOString()} - Download Error: ${err.message}\nStderr: ${stderrData}\n\n`;
        fs.appendFileSync(path.join(__dirname, 'error.log'), errorLog);
        console.error("Download Error:", err.message);
        if (!res.headersSent) res.status(500).end();
      });

      subprocess.on('close', (code) => {
        if (code !== 0 && !res.headersSent) {
          const errorLog = `${new Date().toISOString()} - Download failed with code ${code}\nStderr: ${stderrData}\n\n`;
          fs.appendFileSync(path.join(__dirname, 'error.log'), errorLog);
          console.error(`Download failed with code ${code}. Stderr: ${stderrData}`);
          res.status(500).end();
        }
      });
    }
  } catch (error) {
    console.error("Download execution error:", error.message);
    if (!res.headersSent) res.status(500).send("Processing failed");
  }
});

app.listen(PORT, () => {
  console.log(`Universal Video Downloader server running on port ${PORT}`);
});
