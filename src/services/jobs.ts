import { randomUUID } from "node:crypto";
import { runOnEngine } from "./engine.js";

export type JobState = "queued" | "running" | "done" | "error";

interface Job {
  id: string;
  label: string;
  state: JobState;
  result: unknown;
  error: string | undefined;
  createdAt: number;
  finishedAt: number | undefined;
}

export interface JobView {
  id: string;
  label: string;
  state: JobState;
  result: unknown;
  error: string | undefined;
  created_at: string;
  finished_at: string | undefined;
}

export interface JobSummary {
  id: string;
  label: string;
  state: JobState;
  created_at: string;
}

const JOB_TTL_MS = 3_600_000;
const jobs = new Map<string, Job>();

function prune(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

function toView(job: Job): JobView {
  return {
    id: job.id,
    label: job.label,
    state: job.state,
    result: job.result,
    error: job.error,
    created_at: new Date(job.createdAt).toISOString(),
    finished_at: job.finishedAt === undefined ? undefined : new Date(job.finishedAt).toISOString(),
  };
}

export function submitJob<T>(label: string, fn: () => Promise<T>): string {
  const now = Date.now();
  prune(now);
  const job: Job = {
    id: randomUUID().slice(0, 8),
    label,
    state: "queued",
    result: undefined,
    error: undefined,
    createdAt: now,
    finishedAt: undefined,
  };
  jobs.set(job.id, job);

  void runOnEngine(async () => {
    job.state = "running";
    try {
      job.result = await fn();
      job.state = "done";
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      job.state = "error";
    } finally {
      job.finishedAt = Date.now();
    }
  });

  return job.id;
}

export function getJob(id: string): JobView | null {
  const job = jobs.get(id);
  return job ? toView(job) : null;
}

export function listJobs(): JobSummary[] {
  return [...jobs.values()].map((job) => ({
    id: job.id,
    label: job.label,
    state: job.state,
    created_at: new Date(job.createdAt).toISOString(),
  }));
}
