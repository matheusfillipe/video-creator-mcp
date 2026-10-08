import { describe, expect, it } from "vitest";
import type { StorageConfig } from "../../src/config.js";
import { createStorage } from "../../src/services/storage.js";

const s3Config = (privateBucket?: string): StorageConfig => ({
  type: "s3",
  path: "./output",
  publicUrl: "https://s3.example.org/video-mcp",
  s3: {
    endpoint: "https://s3.example.org",
    bucket: "video-mcp",
    privateBucket,
    region: "us-east-1",
    accessKey: "ak",
    secretKey: "sk",
  },
});

describe("s3 storage", () => {
  it("refuses a private save when no private bucket is configured", async () => {
    await expect(
      createStorage(s3Config()).save(Buffer.from("x"), "a.mp4", "video/mp4", "private"),
    ).rejects.toThrow(/MINIO_PRIVATE_BUCKET/);
  });
});
