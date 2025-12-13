import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Set ffprobe path for fluent-ffmpeg
ffmpeg.setFfprobePath(ffprobeStatic.path);

/**
 * Combine two videos side-by-side using hstack filter
 * @param {string} videoA - Path to first video
 * @param {string} videoB - Path to second video
 * @param {string} outputPath - Path for output video
 * @param {Function} onProgress - Progress callback (percent: 0-100)
 * @param {Object} config - Optional compression config (for final output)
 * @param {number} config.crf - Constant Rate Factor (default: 18)
 * @param {string} config.preset - Encoding preset (default: 'veryfast')
 * @param {number} config.maxWidth - Maximum width for scaling (optional)
 * @param {string} config.audioBitrate - Audio bitrate (default: '192k')
 * @returns {Promise<void>}
 */
export function combinePair(videoA, videoB, outputPath, onProgress, config = {}) {
  const {
    crf = 18,
    preset = 'veryfast',
    maxWidth = null,
    audioBitrate = '192k'
  } = config;

  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    // Add input videos
    command.input(videoA);
    command.input(videoB);

    // Apply complex filter for side-by-side layout with audio merge
    // VFR normalization (-vsync cfr) happens at output, not in filter chain
    const filterParts = [
      '[0:v]scale=-2:720,setsar=1[left]',
      '[1:v]scale=-2:720,setsar=1[right]',
      '[left][right]hstack=inputs=2[v]',
      '[0:a][1:a]amerge=inputs=2[a]'
    ];

    // Add final scaling if maxWidth specified
    if (maxWidth) {
      filterParts[2] = '[left][right]hstack=inputs=2[vstacked]';
      filterParts.push(`[vstacked]scale=${maxWidth}:-2[v]`);
    }

    command.complexFilter(filterParts.join(';'));

    command
      .outputOptions([
        '-map', '[v]',
        '-map', '[a]',
        '-vsync', 'cfr',  // Normalize VFR from both cameras to constant frame rate
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', `${crf}`,
        '-c:a', 'aac',
        '-b:a', audioBitrate
      ]);

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
      reject(new Error(`Failed to combine videos: ${err.message}`));
    });

    // Start processing
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

/**
 * Pad a video with cloned frames and silent audio
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path for output video
 * @param {number} paddingDuration - Seconds of padding to add at the end
 * @param {Function} onProgress - Progress callback (percent: 0-100)
 * @returns {Promise<void>}
 */
export function padVideo(inputPath, outputPath, paddingDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    command.input(inputPath);

    // Use tpad filter to clone last frame at the end
    // apad pads audio with silence
    // Note: tpad stop_duration adds that many seconds AFTER the video ends
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
      reject(new Error(`Failed to pad video: ${err.message}`));
    });

    // Start processing
    command.run();
  });
}
