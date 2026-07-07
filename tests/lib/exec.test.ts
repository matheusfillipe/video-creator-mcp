import { afterEach, describe, expect, it } from "vitest";
import { ExecError, run, sanitizedEnv } from "../../src/lib/exec.js";

describe("run", () => {
  it("captures and trims stdout", async () => {
    const result = await run("printf", ["hello world"]);
    expect(result.stdout).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("rejects with ExecError on non-zero exit", async () => {
    await expect(run("sh", ["-c", "exit 3"])).rejects.toBeInstanceOf(ExecError);
  });

  it("resolves a non-zero exit when allowNonZero is set", async () => {
    const result = await run("sh", ["-c", "echo oops >&2; exit 3"], { allowNonZero: true });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("oops");
  });

  it("rejects when the command does not exist", async () => {
    await expect(run("this-binary-does-not-exist-xyz", [])).rejects.toBeInstanceOf(Error);
  });

  it("does not leak the spawned env — a manim scene can't read the storage keys", async () => {
    const result = await run("sh", ["-c", 'echo "[$MINIO_SECRET_KEY|$MINIO_ACCESS_KEY|$PATH]"'], {
      env: undefined,
    });
    expect(result.stdout).toContain("[||");
    expect(result.stdout).not.toContain("supersecret");
    expect(result.stdout).not.toMatch(/\[[^|]/);
  });
});

describe("sanitizedEnv", () => {
  const secrets = {
    MINIO_SECRET_KEY: "a",
    MINIO_ACCESS_KEY: "b",
    SUNO_API_KEY: "c",
    DB_PASSWORD: "d",
    GITHUB_TOKEN: "e",
    AWS_CREDENTIAL_FILE: "f",
  };
  const kept = { MINIO_ENDPOINT: "x", MINIO_BUCKET: "y", YTDLP_COOKIES: "/z", PATH: "/bin" };

  afterEach(() => {
    for (const key of [...Object.keys(secrets), ...Object.keys(kept)]) delete process.env[key];
  });

  it("strips credential-shaped vars, keeps the rest", () => {
    Object.assign(process.env, secrets, kept);
    const env = sanitizedEnv();
    for (const key of Object.keys(secrets)) expect(env[key]).toBeUndefined();
    for (const [key, value] of Object.entries(kept)) expect(env[key]).toBe(value);
  });
});
