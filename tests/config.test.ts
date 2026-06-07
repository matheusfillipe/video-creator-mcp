import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig storage selection", () => {
  it("defaults to local storage", () => {
    const cfg = loadConfig({});
    expect(cfg.storage.type).toBe("local");
    expect(cfg.storage.path).toBe("./output");
  });

  it("uses MinIO vars when MINIO_BUCKET is set (homelab convention)", () => {
    const cfg = loadConfig({
      MINIO_ENDPOINT: "s3-api.t3ks.com",
      MINIO_USE_SSL: "true",
      MINIO_REGION: "us-east-1",
      MINIO_BUCKET: "video-mcp",
      MINIO_ACCESS_KEY: "ak",
      MINIO_SECRET_KEY: "sk",
      MINIO_PUBLIC_BASE: "https://s3-api.t3ks.com/video-mcp",
    });
    expect(cfg.storage.type).toBe("s3");
    expect(cfg.storage.s3.endpoint).toBe("https://s3-api.t3ks.com");
    expect(cfg.storage.s3.bucket).toBe("video-mcp");
    expect(cfg.storage.publicUrl).toBe("https://s3-api.t3ks.com/video-mcp");
  });

  it("honors explicit S3_* vars when no MinIO vars are set", () => {
    const cfg = loadConfig({
      STORAGE_TYPE: "s3",
      S3_ENDPOINT: "https://s3.example.com",
      S3_BUCKET: "renders",
      PUBLIC_URL: "https://cdn.example.com/renders/",
    });
    expect(cfg.storage.type).toBe("s3");
    expect(cfg.storage.s3.endpoint).toBe("https://s3.example.com");
    expect(cfg.storage.publicUrl).toBe("https://cdn.example.com/renders");
  });
});
