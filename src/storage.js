// Storage abstraction: local filesystem or S3/Minio
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { writeFile, mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

export function createStorage() {
  const type = process.env.STORAGE_TYPE || 'local';
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

  if (type === 's3') {
    const endpoint = process.env.S3_ENDPOINT;
    const bucket = process.env.S3_BUCKET;
    const region = process.env.S3_REGION || 'us-east-1';

    if (!endpoint || !bucket) {
      throw new Error('S3_ENDPOINT and S3_BUCKET required when STORAGE_TYPE=s3');
    }

    const s3 = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
    });

    return {
      type: 's3',
      async save(buffer, filename, contentType = 'video/mp4') {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: filename,
          Body: buffer,
          ContentType: contentType,
        }));
        const url = `${publicUrl}/${filename}`;
        console.log(`[storage] Uploaded to s3://${bucket}/${filename} → ${url}`);
        return url;
      },
    };
  }

  // Local filesystem
  const localPath = process.env.STORAGE_PATH || './output';

  return {
    type: 'local',
    async save(buffer, filename) {
      await mkdir(localPath, { recursive: true });
      const filePath = `${localPath}/${filename}`;
      await writeFile(filePath, buffer);
      const url = `${publicUrl}/${filename}`;
      console.log(`[storage] Saved to ${filePath} → ${url}`);
      return url;
    },
  };
}
