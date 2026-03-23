import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../../aws-config.json');

let configCache = null;

async function getConfig() {
  if (configCache) return configCache;
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    if (config.bucket && config.region) {
      configCache = config;
      return configCache;
    }
  } catch {
    // Config file doesn't exist or is invalid
  }
  return null;
}

export function invalidateConfigCache() {
  configCache = null;
}

function getS3Client(config) {
  return new S3Client({ region: config.region });
}

function getECSClient(config) {
  return new ECSClient({ region: config.region });
}

export async function isConfigured() {
  const config = await getConfig();
  return !!config;
}

export async function uploadInputFiles(jobId, order) {
  const config = await getConfig();
  if (!config) throw new Error('AWS not configured');

  const s3 = getS3Client(config);
  const uploadsDir = join(__dirname, '../../uploads');

  for (const fileId of order.a) {
    const files = await fs.readdir(join(uploadsDir, 'a'));
    const filename = files.find(f => f.startsWith(fileId));
    if (!filename) throw new Error(`File not found: ${fileId}`);

    const fileContent = await fs.readFile(join(uploadsDir, 'a', filename));
    await s3.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: `jobs/${jobId}/input/a/${filename}`,
      Body: fileContent,
    }));
  }

  for (const fileId of order.b) {
    const files = await fs.readdir(join(uploadsDir, 'b'));
    const filename = files.find(f => f.startsWith(fileId));
    if (!filename) throw new Error(`File not found: ${fileId}`);

    const fileContent = await fs.readFile(join(uploadsDir, 'b', filename));
    await s3.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: `jobs/${jobId}/input/b/${filename}`,
      Body: fileContent,
    }));
  }

  const jobManifest = {
    jobId,
    order,
    timestamp: new Date().toISOString(),
  };

  await s3.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: `jobs/${jobId}/job.json`,
    Body: JSON.stringify(jobManifest),
    ContentType: 'application/json',
  }));
}

export async function runTask(jobId, processingConfig) {
  const config = await getConfig();
  if (!config) throw new Error('AWS not configured');

  const s3 = getS3Client(config);

  // Add processing config to job manifest
  const getRes = await s3.send(new GetObjectCommand({
    Bucket: config.bucket,
    Key: `jobs/${jobId}/job.json`,
  }));
  const jobManifest = JSON.parse(await getRes.Body.transformToString());
  jobManifest.config = processingConfig;

  await s3.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: `jobs/${jobId}/job.json`,
    Body: JSON.stringify(jobManifest),
    ContentType: 'application/json',
  }));

  // Discover default VPC subnets
  const ec2 = new EC2Client({ region: config.region });
  const subnetsRes = await ec2.send(new DescribeSubnetsCommand({
    Filters: [{ Name: 'default-for-az', Values: ['true'] }],
  }));
  const subnetIds = subnetsRes.Subnets.map(s => s.SubnetId);

  const ecs = getECSClient(config);
  const result = await ecs.send(new RunTaskCommand({
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: subnetIds,
        assignPublicIp: 'ENABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name: 'kodi-training',
        environment: [
          { name: 'JOB_ID', value: jobId },
          { name: 'S3_BUCKET', value: config.bucket },
          { name: 'S3_REGION', value: config.region },
        ],
      }],
    },
  }));

  if (!result.tasks || result.tasks.length === 0) {
    const failure = result.failures?.[0];
    throw new Error(`Failed to start ECS task: ${failure?.reason || 'unknown'}`);
  }

  return result.tasks[0].taskArn;
}

export async function getProgress(jobId) {
  const config = await getConfig();
  if (!config) throw new Error('AWS not configured');

  const s3 = getS3Client(config);

  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: `jobs/${jobId}/progress.json`,
    }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err.name === 'NoSuchKey') {
      return { percent: 0, phase: 'starting' };
    }
    throw err;
  }
}

export async function checkTaskStatus(taskArn) {
  const config = await getConfig();
  if (!config) throw new Error('AWS not configured');

  const ecs = getECSClient(config);
  const res = await ecs.send(new DescribeTasksCommand({
    cluster: config.cluster,
    tasks: [taskArn],
  }));

  if (!res.tasks || res.tasks.length === 0) {
    return { status: 'UNKNOWN' };
  }

  const task = res.tasks[0];
  return {
    status: task.lastStatus,
    stoppedReason: task.stoppedReason,
    exitCode: task.containers?.[0]?.exitCode,
  };
}

export async function stopTask(taskArn) {
  const config = await getConfig();
  if (!config) throw new Error('AWS not configured');

  const ecs = getECSClient(config);
  await ecs.send(new StopTaskCommand({
    cluster: config.cluster,
    task: taskArn,
    reason: 'Cancelled by user',
  }));
}

export async function downloadResult(jobId) {
  const config = await getConfig();
  if (!config) throw new Error('AWS not configured');

  const s3 = getS3Client(config);
  const outputDir = join(__dirname, '../../output');
  await fs.mkdir(outputDir, { recursive: true });

  const finalPath = join(outputDir, 'final.mp4');
  const res = await s3.send(new GetObjectCommand({
    Bucket: config.bucket,
    Key: `jobs/${jobId}/output/final.mp4`,
  }));

  const writeStream = createWriteStream(finalPath);
  await pipeline(res.Body, writeStream);

  return finalPath;
}

export async function deleteJobFiles(jobId) {
  const config = await getConfig();
  if (!config) return;

  const s3 = getS3Client(config);
  const listRes = await s3.send(new ListObjectsV2Command({
    Bucket: config.bucket,
    Prefix: `jobs/${jobId}/`,
  }));

  if (!listRes.Contents || listRes.Contents.length === 0) return;

  await s3.send(new DeleteObjectsCommand({
    Bucket: config.bucket,
    Delete: {
      Objects: listRes.Contents.map(obj => ({ Key: obj.Key })),
    },
  }));
}

export async function getPresignedDownloadUrl(jobId, expiresIn = 3600) {
  const config = await getConfig();
  if (!config) throw new Error('AWS not configured');

  const s3 = getS3Client(config);
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: `jobs/${jobId}/output/final.mp4`,
  });

  return getSignedUrl(s3, command, { expiresIn });
}

export async function deleteAllJobs() {
  const config = await getConfig();
  if (!config) return;

  const s3 = getS3Client(config);
  let continuationToken;

  do {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: 'jobs/',
      ContinuationToken: continuationToken,
    }));

    if (listRes.Contents && listRes.Contents.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: {
          Objects: listRes.Contents.map(obj => ({ Key: obj.Key })),
        },
      }));
    }

    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);
}
