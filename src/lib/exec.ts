import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  allowNonZero?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class ExecError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`${command} failed (exit ${exitCode}): ${stderr.slice(-500)}`);
    this.name = "ExecError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const STREAMING_TIMEOUT_MS = 600_000;

// Subprocesses (ffmpeg, chromium, yt-dlp, manim) run agent-controlled input — a manim scene is
// arbitrary Python, a rendered page is arbitrary JS — so they must not inherit credential-shaped
// env vars (the storage keys). Node keeps the full env for its own S3 client; only what it spawns
// is scrubbed.
const SECRET_ENV_RE = /SECRET|PASSWORD|TOKEN|CREDENTIAL|ACCESS_KEY|API_KEY|_KEY$/i;

export function sanitizedEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_RE.test(key)) clean[key] = value;
  }
  return clean;
}

// Only the tail of a subprocess's output is ever used (error messages, small probe markers), but a
// chatty ffmpeg over a long render can emit hundreds of MB. Retaining it all overflows Node's max
// string length ("RangeError: Invalid string length") and crashes the process, so cap what we keep.
const CAPTURE_TAIL_BYTES = 1 << 20;

function appendCapped(buffer: string, chunk: Buffer): string {
  const next = buffer + chunk.toString();
  return next.length > CAPTURE_TAIL_BYTES ? next.slice(next.length - CAPTURE_TAIL_BYTES) : next;
}

export function run(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, allowNonZero = false, cwd, env } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      cwd,
      env: env ?? sanitizedEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0 || allowNonZero) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
      } else {
        reject(new ExecError(command, exitCode, stderr || stdout));
      }
    });
  });
}

export type LineHandler = (line: string) => void;

export function spawnStreaming(
  command: string,
  args: string[],
  onStderrLine: LineHandler,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = STREAMING_TIMEOUT_MS, cwd, env } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      cwd,
      env: env ?? sanitizedEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) {
          onStderrLine(line);
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
      } else {
        reject(new ExecError(command, exitCode, stderr || stdout));
      }
    });
  });
}
