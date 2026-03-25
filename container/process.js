import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { combinePair, concatenateVideos, compressVideo, getVideoDuration, premixAudio } from './services/ffmpeg.js';

const JOB_ID = process.env.JOB_ID;
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION;

if (!JOB_ID || !S3_BUCKET || !S3_REGION) {
  console.error('Missing required env vars: JOB_ID, S3_BUCKET, S3_REGION');
  process.exit(1);
}

const s3 = new S3Client({ region: S3_REGION });
const INPUT_DIR = '/tmp/input';
const OUTPUT_DIR = '/tmp/output';

let lastProgressUpdate = 0;
const PROGRESS_INTERVAL = 5000;

async function logMemory(label) {
  try {
    const current = await fs.readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8');
    const max = await fs.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8');
    const mb = (parseInt(current) / 1024 / 1024).toFixed(0);
    const maxVal = parseInt(max);
    const maxMb = maxVal > 2 ** 62 ? 'max' : (maxVal / 1024 / 1024).toFixed(0);
    const nodeRss = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    console.log(`[memory] ${label}: cgroup=${mb}MB/${maxMb}MB node_rss=${nodeRss}MB`);
  } catch (err) {
    const nodeRss = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    console.log(`[memory] ${label}: cgroup=N/A (${err.code}) node_rss=${nodeRss}MB`);
  }
}

async function reportProgress(percent, phase, error = null) {
  const now = Date.now();
  if (!error && now - lastProgressUpdate < PROGRESS_INTERVAL && percent < 100) return;
  lastProgressUpdate = now;

  const progress = { percent: Math.round(percent), phase };
  if (error) progress.error = error;

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: `jobs/${JOB_ID}/progress.json`,
    Body: JSON.stringify(progress),
    ContentType: 'application/json',
  }));
}

async function downloadFile(key, destPath) {
  const res = await s3.send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  }));

  await fs.mkdir(join(destPath, '..'), { recursive: true });
  const writeStream = createWriteStream(destPath);
  await pipeline(res.Body, writeStream);
}

async function main() {
  try {
    console.log(`Starting job ${JOB_ID}`);
    await reportProgress(0, 'downloading');

    // Download job manifest
    const jobRes = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: `jobs/${JOB_ID}/job.json`,
    }));
    const job = JSON.parse(await jobRes.Body.transformToString());
    const { order, config = {} } = job;
    const { concatenateFirst = false } = config;

    // Create directories
    await fs.mkdir(join(INPUT_DIR, 'a'), { recursive: true });
    await fs.mkdir(join(INPUT_DIR, 'b'), { recursive: true });
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // List and download input files
    const listA = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `jobs/${JOB_ID}/input/a/`,
    }));
    const listB = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `jobs/${JOB_ID}/input/b/`,
    }));

    const filesA = (listA.Contents || []).filter(o => o.Key.endsWith('.mp4'));
    const filesB = (listB.Contents || []).filter(o => o.Key.endsWith('.mp4'));
    const totalFiles = filesA.length + filesB.length;
    let downloadedCount = 0;

    const localFilesA = [];
    for (const obj of filesA) {
      const filename = obj.Key.split('/').pop();
      const localPath = join(INPUT_DIR, 'a', filename);
      await downloadFile(obj.Key, localPath);
      localFilesA.push(localPath);
      downloadedCount++;
      await reportProgress((downloadedCount / totalFiles) * 10, 'downloading');
    }

    const localFilesB = [];
    for (const obj of filesB) {
      const filename = obj.Key.split('/').pop();
      const localPath = join(INPUT_DIR, 'b', filename);
      await downloadFile(obj.Key, localPath);
      localFilesB.push(localPath);
      downloadedCount++;
      await reportProgress((downloadedCount / totalFiles) * 10, 'downloading');
    }

    console.log(`Downloaded ${totalFiles} files`);
    await reportProgress(10, 'processing');

    // Sort files by the order specified in job manifest
    const sortByOrder = (paths, orderIds) => {
      return orderIds.map(id => {
        const match = paths.find(p => p.includes(id));
        if (!match) throw new Error(`File not found for ID: ${id}`);
        return match;
      });
    };

    const orderedA = sortByOrder(localFilesA, order.a);
    const orderedB = sortByOrder(localFilesB, order.b);

    if (concatenateFirst) {
      await processConcatenateFirst(orderedA, orderedB, config);
    } else {
      await processPairByPair(orderedA, orderedB, config);
    }

    // Upload result
    await reportProgress(95, 'uploading');
    const finalPath = join(OUTPUT_DIR, 'final.mp4');

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `jobs/${JOB_ID}/output/final.mp4`,
      Body: createReadStream(finalPath),
    }));

    await reportProgress(100, 'done');
    console.log(`Job ${JOB_ID} completed successfully`);

  } catch (err) {
    console.error(`Job ${JOB_ID} failed:`, err);
    await reportProgress(0, 'error', err.message).catch(() => {});
    process.exit(1);
  }
}

async function processConcatenateFirst(orderedA, orderedB, config) {
  // Step 1: Concatenate Camera A (stream copy if multiple segments)
  let inputA;
  if (orderedA.length === 1) {
    inputA = orderedA[0];
  } else {
    inputA = join(OUTPUT_DIR, 'concat_a.mp4');
    console.log(`[stage] Concatenating ${orderedA.length} Camera A segments`);
    await concatenateVideos(orderedA, inputA, (percent) => {
      reportProgress(10 + (percent / 100) * 5, 'processing');
    }, { reencode: false });
  }

  // Step 2: Concatenate Camera B (stream copy if multiple segments)
  let inputB;
  if (orderedB.length === 1) {
    inputB = orderedB[0];
  } else {
    inputB = join(OUTPUT_DIR, 'concat_b.mp4');
    console.log(`[stage] Concatenating ${orderedB.length} Camera B segments`);
    await concatenateVideos(orderedB, inputB, (percent) => {
      reportProgress(15 + (percent / 100) * 5, 'processing');
    }, { reencode: false });
  }

  // Get durations for chunking
  const durationA = await getVideoDuration(inputA);
  const durationB = await getVideoDuration(inputB);
  const maxDuration = Math.max(durationA, durationB);
  console.log(`[stage] Durations: A=${durationA.toFixed(1)}s, B=${durationB.toFixed(1)}s`);

  // Step 3: Pre-mix audio (lossless WAV, handles truncated audio from either camera)
  const mixedAudioPath = join(OUTPUT_DIR, 'mixed_audio.flac');
  console.log(`[stage] Pre-mixing audio from both cameras`);
  await premixAudio(inputA, inputB, mixedAudioPath, maxDuration, (percent) => {
    reportProgress(20 + (percent / 100) * 5, 'processing');
  });
  await logMemory('after audio premix');

  // Step 4: Combine side-by-side in chunks (fps=30 normalizes VFR inline)
  const CHUNK_SECONDS = 600;
  const numChunks = Math.ceil(maxDuration / CHUNK_SECONDS);
  console.log(`[stage] Combining side-by-side in ${numChunks} chunks of ${CHUNK_SECONDS}s`);

  await logMemory('before chunks');
  let partialPath = null;

  for (let i = 0; i < numChunks; i++) {
    const chunkStart = i * CHUNK_SECONDS;
    const chunkPath = join(OUTPUT_DIR, `chunk_${i}.mp4`);
    console.log(`[stage] Encoding chunk ${i + 1}/${numChunks} (${chunkStart}s-${chunkStart + CHUNK_SECONDS}s)`);
    await combinePair(inputA, inputB, chunkPath, (percent) => {
      const overall = 25 + ((i + percent / 100) / numChunks) * 65;
      reportProgress(overall, 'processing');
    }, { ...config, startTime: chunkStart, duration: CHUNK_SECONDS, normalizeVfr: true, audioPath: mixedAudioPath });
    await logMemory(`after chunk ${i + 1}/${numChunks}`);

    if (partialPath === null) {
      partialPath = chunkPath;
    } else {
      const concatOut = join(OUTPUT_DIR, `partial_${i}.mp4`);
      console.log(`[stage] Merging chunk ${i + 1} into partial output`);
      await concatenateVideos([partialPath, chunkPath], concatOut, null, { reencode: false });
      await fs.unlink(partialPath);
      await fs.unlink(chunkPath);
      partialPath = concatOut;
      await logMemory(`after merge ${i + 1}/${numChunks}`);
    }
  }

  // Rename final partial to final.mp4
  const finalPath = join(OUTPUT_DIR, 'final.mp4');
  await fs.rename(partialPath, finalPath);
}

async function processPairByPair(orderedA, orderedB, config) {
  const numPairs = orderedA.length;
  const totalSteps = numPairs + 2;
  let step = 0;

  const pairsDir = join(OUTPUT_DIR, 'pairs');
  await fs.mkdir(pairsDir, { recursive: true });
  const pairPaths = [];

  for (let i = 0; i < numPairs; i++) {
    const pairPath = join(pairsDir, `pair_${i + 1}.mp4`);
    await combinePair(orderedA[i], orderedB[i], pairPath, (percent) => {
      const overall = 10 + ((step + percent / 100) / totalSteps) * 80;
      reportProgress(overall, 'processing');
    });
    pairPaths.push(pairPath);
    step++;
  }

  const combinedPath = join(OUTPUT_DIR, 'combined.mp4');
  await concatenateVideos(pairPaths, combinedPath, (percent) => {
    const overall = 10 + ((step + percent / 100) / totalSteps) * 80;
    reportProgress(overall, 'processing');
  });
  step++;

  const finalPath = join(OUTPUT_DIR, 'final.mp4');
  await compressVideo(combinedPath, finalPath, config, (percent) => {
    const overall = 10 + ((step + percent / 100) / totalSteps) * 80;
    reportProgress(overall, 'processing');
  });
}

main();
