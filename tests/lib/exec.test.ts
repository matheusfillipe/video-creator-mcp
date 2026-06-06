import { describe, expect, it } from "vitest";
import { ExecError, run } from "../../src/lib/exec.js";

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
});
