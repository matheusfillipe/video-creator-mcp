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
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
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
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
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
