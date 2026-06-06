import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type StorageConfig, config } from "../config.js";

export interface Storage {
  readonly type: "local" | "s3";
  save(buffer: Buffer, filename: string, contentType?: string): Promise<string>;
}

function createS3Storage(storage: StorageConfig): Storage {
  const { endpoint, bucket, region, accessKey, secretKey } = storage.s3;
  if (!endpoint || !bucket) {
    throw new Error("S3_ENDPOINT and S3_BUCKET are required when STORAGE_TYPE=s3");
  }
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  return {
    type: "s3",
    async save(buffer, filename, contentType = "video/mp4") {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: filename,
          Body: buffer,
          ContentType: contentType,
        }),
      );
      return `${storage.publicUrl}/${filename}`;
    },
  };
}

function createLocalStorage(storage: StorageConfig): Storage {
  return {
    type: "local",
    async save(buffer, filename) {
      await mkdir(storage.path, { recursive: true });
      await writeFile(join(storage.path, filename), buffer);
      return `${storage.publicUrl}/${filename}`;
    },
  };
}

export function createStorage(storage: StorageConfig = config.storage): Storage {
  return storage.type === "s3" ? createS3Storage(storage) : createLocalStorage(storage);
}

let singleton: Storage | undefined;

export function storage(): Storage {
  singleton ??= createStorage();
  return singleton;
}
