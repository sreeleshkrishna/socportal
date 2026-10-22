import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';

export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>; // throws an error named "NoSuchKey" when the object does not exist
}

const s3Client = () =>
  new S3Client({
    endpoint: config.s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
  });

export function createS3Store(): ObjectStore {
  const s3 = s3Client();
  const Bucket = config.s3Bucket;
  return {
    async put(key, body) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: 'application/octet-stream' }));
    },
    async get(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
  };
}

export function createFsStore(dir = config.evidenceDir): ObjectStore {
  const root = path.resolve(dir);
  const fileFor = (key: string) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('invalid object key');
    return p;
  };
  return {
    async put(key, body) {
      const p = fileFor(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    async get(key) {
      try {
        return await readFile(fileFor(key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        throw e;
      }
    },
  };
}

export const createStore = (): ObjectStore => (config.evidenceStore === 'fs' ? createFsStore() : createS3Store());

// Creates the bucket if needed; retries because the storage container may still be starting
export async function ensureBucket(): Promise<void> {
  if (config.evidenceStore === 'fs') return;
  const s3 = s3Client();
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: config.s3Bucket }));
      }
      return;
    } catch (e) {
      console.warn(`[evidence] storage not ready (attempt ${attempt}): ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error('[evidence] could not reach object storage; uploads will fail until it is available');
}