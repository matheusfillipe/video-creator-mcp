import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  TRANSPORT: z.enum(["http", "stdio"]).default("http"),
  PORT: z.coerce.number().int().positive().max(65535).default(3100),
  MCP_API_KEY: z.string().min(1).optional(),
  STORAGE_TYPE: z.enum(["local", "s3"]).default("local"),
  STORAGE_PATH: z.string().default("./output"),
  PUBLIC_URL: z.string().default(""),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_KEY: z.string().default(""),
  // MinIO-convention vars (as injected by the homelab minio/infra secret). When
  // MINIO_BUCKET is present these take precedence and storage is forced to s3.
  MINIO_ENDPOINT: z.string().optional(),
  MINIO_USE_SSL: z.string().optional(),
  MINIO_REGION: z.string().optional(),
  MINIO_BUCKET: z.string().optional(),
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),
  MINIO_PUBLIC_BASE: z.string().optional(),
  MEDIA_CACHE_DIR: z.string().optional(),
  WORKDIR: z.string().default("/tmp/video-creator-jobs"),
  RENDER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  RENDER_SEGMENT_CONCURRENCY: z.coerce.number().int().positive().default(3),
  YTDLP_PATH: z.string().default("yt-dlp"),
  YTDLP_COOKIES: z.string().default(""),
  YTDLP_FORMAT: z.string().default("best[height<=720][ext=mp4]/best[height<=720]/best"),
  ALLOW_PRIVATE_NETWORK: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
});

export interface S3Config {
  endpoint: string | undefined;
  bucket: string | undefined;
  region: string;
  accessKey: string;
  secretKey: string;
}

export interface StorageConfig {
  type: "local" | "s3";
  path: string;
  publicUrl: string;
  s3: S3Config;
}

export interface YtDlpConfig {
  path: string;
  cookies: string;
  format: string;
}

export interface Config {
  transport: "http" | "stdio";
  port: number;
  apiKey: string | undefined;
  storage: StorageConfig;
  mediaCacheDir: string;
  workDir: string;
  renderConcurrency: number;
  renderSegmentConcurrency: number;
  ytdlp: YtDlpConfig;
  allowPrivateNetwork: boolean;
}

type ParsedEnv = z.infer<typeof EnvSchema>;

function buildStorage(env: ParsedEnv): StorageConfig {
  if (env.MINIO_BUCKET) {
    const scheme = env.MINIO_USE_SSL === "false" ? "http" : "https";
    return {
      type: "s3",
      path: env.STORAGE_PATH,
      publicUrl: (env.MINIO_PUBLIC_BASE ?? "").replace(/\/+$/, ""),
      s3: {
        endpoint: `${scheme}://${env.MINIO_ENDPOINT ?? ""}`,
        bucket: env.MINIO_BUCKET,
        region: env.MINIO_REGION ?? "us-east-1",
        accessKey: env.MINIO_ACCESS_KEY ?? "",
        secretKey: env.MINIO_SECRET_KEY ?? "",
      },
    };
  }
  return {
    type: env.STORAGE_TYPE,
    path: env.STORAGE_PATH,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    s3: {
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  return {
    transport: parsed.TRANSPORT,
    port: parsed.PORT,
    apiKey: parsed.MCP_API_KEY,
    storage: buildStorage(parsed),
    mediaCacheDir:
      parsed.MEDIA_CACHE_DIR ?? join(homedir(), ".cache", "video-creator-mcp", "media"),
    workDir: parsed.WORKDIR,
    renderConcurrency: parsed.RENDER_CONCURRENCY,
    renderSegmentConcurrency: parsed.RENDER_SEGMENT_CONCURRENCY,
    ytdlp: { path: parsed.YTDLP_PATH, cookies: parsed.YTDLP_COOKIES, format: parsed.YTDLP_FORMAT },
    allowPrivateNetwork: parsed.ALLOW_PRIVATE_NETWORK,
  };
}

export const config = loadConfig();
