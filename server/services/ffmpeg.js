import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Combine two videos side-by-side using hstack filter
 * @param {string} videoA - Path to first video
 * @param {string} videoB - Path to second video
 * @param {string} outputPath - Path for output video
 * @param {Function} onProgress - Progress callback (percent: 0-100)
 * @returns {Promise<void>}
 */
export function combinePair(videoA, videoB, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    // Add input videos
    command.input(videoA);
    command.input(videoB);

    // Apply complex filter for side-by-side layout with audio merge
    const filterComplex = [
      '[0:v]scale=-2:720,setsar=1[left]',
      '[1:v]scale=-2:720,setsar=1[right]',
      '[left][right]hstack=inputs=2[v]',
      '[0:a][1:a]amerge=inputs=2[a]'
    ].join(';');

    command
      .complexFilter(filterComplex)
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
      reject(new Error(`Failed to combine videos: ${err.message}`));
    });

    // Start processing
    command.run();
  });
}

/**
 * Concatenate multiple videos using concat demuxer
 * @param {string[]} inputPaths - Array of video paths to concatenate
 * @param {string} outputPath - Path for output video
 * @param {Function} onProgress - Progress callback (percent: 0-100)
 * @returns {Promise<void>}
 */
export async function concatenateVideos(inputPaths, outputPath, onProgress) {
  if (!inputPaths || inputPaths.length === 0) {
    throw new Error('No input videos provided for concatenation');
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
        ])
        .outputOptions([
          '-c', 'copy'
        ])
        .output(outputPath);

      // Handle progress updates
      command.on('progress', (progress) => {
        if (onProgress && progress.percent) {
          onProgress(Math.round(progress.percent));
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
