import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { combinePair, concatenateVideos, compressVideo, getVideoDuration, padVideo } from './services/ffmpeg.js';

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
    const fileContent = await fs.readFile(finalPath);

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `jobs/${JOB_ID}/output/final.mp4`,
      Body: fileContent,
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
  const totalSteps = 3;
  let step = 0;

  // Step 1: Concatenate Camera A
  let concatAPath;
  if (orderedA.length === 1) {
    concatAPath = orderedA[0];
  } else {
    concatAPath = join(OUTPUT_DIR, 'concat_a.mp4');
    await concatenateVideos(orderedA, concatAPath, (percent) => {
      const overall = 10 + ((step + percent / 100) / totalSteps) * 80;
      reportProgress(overall, 'processing');
    }, { reencode: false });
  }
  step++;

  // Step 2: Concatenate Camera B
  let concatBPath;
  if (orderedB.length === 1) {
    concatBPath = orderedB[0];
  } else {
    concatBPath = join(OUTPUT_DIR, 'concat_b.mp4');
    await concatenateVideos(orderedB, concatBPath, (percent) => {
      const overall = 10 + ((step + percent / 100) / totalSteps) * 80;
      reportProgress(overall, 'processing');
    }, { reencode: false });
  }
  step++;

  // Check durations and pad if needed
  const durationA = await getVideoDuration(concatAPath);
  const durationB = await getVideoDuration(concatBPath);
  const durationDiff = Math.abs(durationA - durationB);

  let finalConcatA = concatAPath;
  let finalConcatB = concatBPath;

  if (durationDiff > 300) {
    const paddingAmount = durationDiff;
    if (durationA < durationB) {
      const paddedPath = join(OUTPUT_DIR, 'concat_a_padded.mp4');
      await padVideo(concatAPath, paddedPath, paddingAmount);
      finalConcatA = paddedPath;
    } else {
      const paddedPath = join(OUTPUT_DIR, 'concat_b_padded.mp4');
      await padVideo(concatBPath, paddedPath, paddingAmount);
      finalConcatB = paddedPath;
    }
  }

  // Step 3: Combine side-by-side
  const finalPath = join(OUTPUT_DIR, 'final.mp4');
  await combinePair(finalConcatA, finalConcatB, finalPath, (percent) => {
    const overall = 10 + ((step + percent / 100) / totalSteps) * 80;
    reportProgress(overall, 'processing');
  }, config);
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
