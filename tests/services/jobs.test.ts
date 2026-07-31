import { describe, expect, it } from "vitest";
import { awaitJob, submitJob } from "../../src/services/jobs.js";

describe("awaitJob", () => {
  it("returns the finished job without the caller polling", async () => {
    const id = submitJob("test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { ok: true };
    });
    const job = await awaitJob(id, 5_000);
    expect(job?.state).toBe("done");
    expect(job?.result).toEqual({ ok: true });
  });

  it("surfaces a failure the same way", async () => {
    const id = submitJob("test", async () => {
      throw new Error("nope");
    });
    const job = await awaitJob(id, 5_000);
    expect(job?.state).toBe("error");
    expect(job?.error).toBe("nope");
  });

  it("gives back the job as it stands when the wait runs out", async () => {
    const id = submitJob("test", () => new Promise((resolve) => setTimeout(resolve, 3_000)));
    const job = await awaitJob(id, 300);
    expect(["queued", "running"]).toContain(job?.state);
  });

  it("is null for an id that never existed", async () => {
    expect(await awaitJob("nosuchjob", 100)).toBeNull();
  });
});
