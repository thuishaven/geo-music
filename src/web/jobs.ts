import { randomBytes } from "node:crypto";
import type { PlaylistPlan } from "../pipeline.js";

/**
 * A build job. Builds take minutes (rate-limited lookups + deep country pulls),
 * far longer than a proxied HTTP request can be held open — so we run them in
 * the background and let the client poll for the result.
 */
export interface Job {
  status: "running" | "done" | "error";
  plan?: PlaylistPlan;
  error?: string;
  createdAt: number;
}

const jobs = new Map<string, Job>();

export function createJob(now: number): { id: string; job: Job } {
  const id = randomBytes(8).toString("hex");
  const job: Job = { status: "running", createdAt: now };
  jobs.set(id, job);
  // Best-effort cleanup of jobs older than an hour, so the map doesn't grow.
  for (const [key, j] of jobs) if (now - j.createdAt > 3_600_000) jobs.delete(key);
  return { id, job };
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}
