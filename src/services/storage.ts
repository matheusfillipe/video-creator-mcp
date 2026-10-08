import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type StorageConfig, config } from "../config.js";
import { contentTypeForFilename } from "../lib/mime.js";

export type Visibility = "public" | "private";

// A signed link lives 7 days, the longest S3 signatures allow; enough for review and publishing.
const PRIVATE_LINK_SECONDS = 7 * 24 * 3600;

export interface Storage {
  readonly type: "local" | "s3";
  save(
    buffer: Buffer,
    filename: string,
    contentType?: string,
    visibility?: Visibility,
  ): Promise<string>;
}

function createS3Storage(storage: StorageConfig): Storage {
  const { endpoint, bucket, privateBucket, region, accessKey, secretKey } = storage.s3;
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
    async save(buffer, filename, contentType, visibility = "public") {
      if (visibility === "private" && !privateBucket) {
        throw new Error("private storage needs MINIO_PRIVATE_BUCKET (or S3_PRIVATE_BUCKET)");
      }
      const target = visibility === "private" ? (privateBucket as string) : bucket;
      await client.send(
        new PutObjectCommand({
          Bucket: target,
          Key: filename,
          Body: buffer,
          // Default to the type implied by the extension so a .png/.json/.wav isn't served as
          // video/mp4 (which browsers, with nosniff, then refuse to render).
          ContentType: contentType ?? contentTypeForFilename(filename),
        }),
      );
      if (visibility === "private") {
        return getSignedUrl(client, new GetObjectCommand({ Bucket: target, Key: filename }), {
          expiresIn: PRIVATE_LINK_SECONDS,
        });
      }
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
