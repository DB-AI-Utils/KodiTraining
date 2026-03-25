import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Use ffprobe-static if available (local dev), otherwise system ffprobe (Docker container)
try {
  const { default: ffprobeStatic } = await import('ffprobe-static');
  await fs.access(ffprobeStatic.path);
  ffmpeg.setFfprobePath(ffprobeStatic.path);
} catch {
  // System ffprobe will be used
}

/**
 * Combine two videos side-by-side using hstack filter.
 * Supports chunked processing via startTime/duration, inline VFR
 * normalization via normalizeVfr, and pre-mixed audio via audioPath.
 */
export function combinePair(videoA, videoB, outputPath, onProgress, config = {}) {
  const {
    crf = 18,
    preset = 'veryfast',
    maxWidth = null,
    audioBitrate = '192k',
    startTime = null,
    duration = null,
    normalizeVfr = false,
    audioPath = null
  } = config;

  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    command.input(videoA);
    if (startTime !== null) {
      command.inputOptions(['-ss', `${startTime}`, '-t', `${duration}`]);
    }
    command.input(videoB);
    if (startTime !== null) {
      command.inputOptions(['-ss', `${startTime}`, '-t', `${duration}`]);
    }
    if (audioPath) {
      command.input(audioPath);
      if (startTime !== null) {
        command.inputOptions(['-ss', `${startTime}`, '-t', `${duration}`]);
      }
    }

    const vfr = normalizeVfr ? 'fps=30,' : '';
    const filterParts = [
      `[0:v]${vfr}scale=-2:720,setsar=1[left]`,
      `[1:v]${vfr}scale=-2:720,setsar=1[right]`,
      '[left][right]hstack=inputs=2[v]'
    ];

    if (maxWidth) {
      filterParts[2] = '[left][right]hstack=inputs=2[vstacked]';
      filterParts.push(`[vstacked]scale=${maxWidth}:-2[v]`);
    }

    command.complexFilter(filterParts.join(';'));

    const audioMap = audioPath ? '2:a' : '1:a';
    command
      .outputOptions([
        '-map', '[v]',
        '-map', audioMap,
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', `${crf}`,
        '-c:a', 'aac',
        '-b:a', audioBitrate
      ]);

    command.output(outputPath);

    command.on('progress', (progress) => {
      if (onProgress && progress.percent) {
        onProgress(Math.round(progress.percent));
      }
    });

    command.on('end', () => resolve());
    command.on('error', (err) => {
      reject(new Error(`Failed to combine videos: ${err.message}`));
    });

    command.run();
  });
}

/**
 * Pre-mix audio from two video files into a single lossless FLAC file.
 * Uses apad+atrim to handle unpredictable audio truncation from either camera.
 * Separated from the video filter graph because amix stalls when one audio
 * input EOF's mid-stream inside a complex filter with video filters.
 */
export function premixAudio(videoA, videoB, outputPath, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    const dur = Math.ceil(duration);

    command.input(videoA);
    command.input(videoB);

    command.complexFilter([
      `[0:a]aresample=async=1:first_pts=0,apad,atrim=0:${dur}[a0]`,
      `[1:a]aresample=async=1:first_pts=0,apad,atrim=0:${dur}[a1]`,
      '[a0][a1]amix=inputs=2:duration=first:normalize=0[a]'
    ].join(';'));

    command
      .outputOptions(['-map', '[a]'])
      .audioCodec('flac')
      .output(outputPath);

    command.on('progress', (progress) => {
      if (onProgress && progress.percent) {
        onProgress(Math.round(progress.percent));
      }
    });

    command.on('end', () => resolve());
    command.on('error', (err) => {
      reject(new Error(`Failed to pre-mix audio: ${err.message}`));
    });

    command.run();
  });
}

/**
 * Parse timemark string (HH:MM:SS.ms) to seconds
 */
function parseTimemark(timemark) {
  if (!timemark) return 0;
  const parts = timemark.split(':');
  if (parts.length !== 3) return 0;
  const hours = parseFloat(parts[0]) || 0;
  const minutes = parseFloat(parts[1]) || 0;
  const seconds = parseFloat(parts[2]) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Concatenate multiple videos using concat demuxer
 * @param {string[]} inputPaths - Array of video paths to concatenate
 * @param {string} outputPath - Path for output video
 * @param {Function} onProgress - Progress callback (percent: 0-100)
 * @param {Object} options - Concatenation options
 * @param {boolean} options.reencode - Re-encode videos (needed for VFR cameras), default false
 * @returns {Promise<void>}
 */
export async function concatenateVideos(inputPaths, outputPath, onProgress, options = {}) {
  const { reencode = false } = options;

  if (!inputPaths || inputPaths.length === 0) {
    throw new Error('No input videos provided for concatenation');
  }

  // Calculate total duration for accurate progress when re-encoding
  let totalDuration = 0;
  if (reencode && onProgress) {
    for (const inputPath of inputPaths) {
      try {
        const duration = await getVideoDuration(inputPath);
        totalDuration += duration;
      } catch (err) {
        // If we can't get duration, progress will be less accurate
        console.warn(`Could not get duration for ${inputPath}: ${err.message}`);
      }
    }
  }

  // Create temporary file list for concat demuxer
  const tempListPath = join(tmpdir(), `ffmpeg-concat-${Date.now()}.txt`);
  const fileListContent = inputPaths
    .map(path => `file '${path.replace(/'/g, "'\\''")}'`)
    .join('\n');

  try {
    // Write the file list
    await fs.writeFile(tempListPath, fileListContent, 'utf8');

    // Concatenate videos
    return new Promise((resolve, reject) => {
      const command = ffmpeg();

      command
        .input(tempListPath)
        .inputOptions([
          '-f', 'concat',
          '-safe', '0'
        ]);

      if (reencode) {
        // Re-encode with VFR→CFR normalization (no frame rate change, just constant timing)
        // Using -vsync cfr instead of fps=30 - much faster, keeps original ~20fps
        command
          .videoCodec('libx264')
          .outputOptions([
            '-vsync', 'cfr',
            '-preset', 'veryfast',
            '-crf', '18'
          ])
          .audioCodec('aac')
          .audioBitrate('192k');
      } else {
        // Stream copy for already-processed files
        command.outputOptions(['-c', 'copy']);
      }

      command.output(outputPath);

      // Handle progress updates
      command.on('progress', (progress) => {
        if (onProgress) {
          let percent;
          if (totalDuration > 0 && progress.timemark) {
            // Calculate accurate progress based on timemark
            const currentTime = parseTimemark(progress.timemark);
            percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));
          } else if (progress.percent) {
            // Fallback to FFmpeg's percent, but cap at 100
            percent = Math.min(100, Math.round(progress.percent));
          }
          if (percent !== undefined) {
            onProgress(percent);
          }
        }
      });

      // Handle completion
      command.on('end', async () => {
        // Clean up temp file
        try {
          await fs.unlink(tempListPath);
        } catch (err) {
          // Ignore cleanup errors
        }
        resolve();
      });

      // Handle errors
      command.on('error', async (err) => {
        // Clean up temp file
        try {
          await fs.unlink(tempListPath);
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }
        reject(new Error(`Failed to concatenate videos: ${err.message}`));
      });

      // Start processing
      command.run();
    });
  } catch (err) {
    // Clean up temp file if it was created
    try {
      await fs.unlink(tempListPath);
    } catch (cleanupErr) {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to prepare concatenation: ${err.message}`);
  }
}

/**
 * Apply final compression to a video
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path for output video
 * @param {Object} config - Compression configuration
 * @param {number} config.crf - Constant Rate Factor (default: 28)
 * @param {string} config.preset - Encoding preset (default: 'slow')
 * @param {number} config.maxWidth - Maximum width for scaling (optional)
 * @param {string} config.audioBitrate - Audio bitrate (default: '96k')
 * @param {Function} onProgress - Progress callback (percent: 0-100)
 * @returns {Promise<void>}
 */
export function compressVideo(inputPath, outputPath, config = {}, onProgress) {
  // Apply defaults
  const {
    crf = 28,
    preset = 'slow',
    maxWidth = null,
    audioBitrate = '96k'
  } = config;

  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    command.input(inputPath);

    // Video codec settings
    command
      .videoCodec('libx264')
      .outputOptions([
        `-crf`, `${crf}`,
        `-preset`, preset
      ]);

    // Scale if maxWidth is provided
    if (maxWidth) {
      command.videoFilter(`scale=${maxWidth}:-2`);
    }

    // Audio codec settings
    command
      .audioCodec('aac')
      .audioBitrate(audioBitrate);

    command.output(outputPath);

    // Handle progress updates
    command.on('progress', (progress) => {
      if (onProgress && progress.percent) {
        onProgress(Math.round(progress.percent));
      }
    });

    // Handle completion
    command.on('end', () => {
      resolve();
    });

    // Handle errors
    command.on('error', (err) => {
      reject(new Error(`Failed to compress video: ${err.message}`));
    });

    // Start processing
    command.run();
  });
}

/**
 * Get the duration of a video file in seconds
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<number>} Duration in seconds
 */
export function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to get video duration: ${err.message}`));
        return;
      }

      const duration = metadata.format.duration;
      if (duration === undefined || duration === null) {
        reject(new Error('Could not determine video duration'));
        return;
      }

      resolve(parseFloat(duration));
    });
  });
}

export function getVideoDimensions(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to get video dimensions: ${err.message}`));
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('No video stream found'));
        return;
      }

      resolve({ width: videoStream.width, height: videoStream.height });
    });
  });
}

export function padVideo(inputPath, outputPath, paddingDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    command.input(inputPath);

    command
      .complexFilter([
        `[0:v]tpad=stop_mode=clone:stop_duration=${paddingDuration}[v]`,
        `[0:a]apad=pad_dur=${paddingDuration}[a]`
      ])
      .outputOptions([
        '-map', '[v]',
        '-map', '[a]'
      ])
      .output(outputPath);

    command.on('progress', (progress) => {
      if (onProgress && progress.percent) {
        onProgress(Math.round(progress.percent));
      }
    });

    command.on('end', () => resolve());
    command.on('error', (err) => {
      reject(new Error(`Failed to pad video: ${err.message}`));
    });

    command.run();
  });
}


