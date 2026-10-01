import type { ObjectId } from 'mongodb';
import { refundGeneration } from './quota';

/**
 * 3D model generations as background jobs, so the browser can show how far along one is.
 *
 *   POST /api/generate-3d        starts a job and answers at once with its id (metered)
 *   GET  /api/model-jobs/<id>    progress, and the result when done (NOT metered: keep it off
 *                                the /api/generate-3d prefix, which the quota counts by prefix)
 *
 * Progress is a percentage plus a plain step label. Labels never name the model behind it.
 * Between real updates the reported percentage creeps toward the end of the current step
 * (`creep`), so a long silent stretch still shows movement; it never passes that step's end,
 * and the percentage never goes backwards.
 *
 * Jobs live in memory, like render jobs: a server restart loses the ones in flight.
 */

export interface ModelJobResult {
  glbUrl: string;
  videoUrl?: string;
  engine: string;
  notice?: string;
}

interface Creep {
  /** Percentage the estimate approaches but never reaches. */
  to: number;
  /** Roughly how long this step takes; after this long the estimate is ~63% of the way there. */
  expectedMs: number;
  since: number;
}

interface ModelJob {
  id: string;
  userId: string;
  owner: ObjectId;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  percent: number;
  label: string;
  creep?: Creep;
  result?: ModelJobResult;
  error?: string;
}

export type ReportProgress = (percent: number, label?: string, creep?: { to: number; expectedMs: number }) => void;

const jobs = new Map<string, ModelJob>();

function forgetOldJobs() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}

function displayedPercent(job: ModelJob): number {
  let p = job.percent;
  const c = job.creep;
  if (c && c.to > p) p += (c.to - p) * (1 - Math.exp(-(Date.now() - c.since) / c.expectedMs));
  return p;
}

/** Starts `work` as a job owned by `user` and returns the job id straight away. */
export function startModelJob(user: { _id: ObjectId }, work: (report: ReportProgress) => Promise<ModelJobResult>): string {
  forgetOldJobs();
  const job: ModelJob = {
    id: `mj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: user._id.toHexString(),
    owner: user._id,
    status: 'running',
    createdAt: Date.now(),
    percent: 0,
    label: 'Starting',
  };
  jobs.set(job.id, job);

  const report: ReportProgress = (percent, label, creep) => {
    // Fold in whatever the creep had already shown, so a real update never moves the bar back.
    job.percent = Math.min(99, Math.max(displayedPercent(job), percent));
    if (label) job.label = label;
    job.creep = creep ? { ...creep, since: Date.now() } : undefined;
  };

  work(report)
    .then((result) => {
      job.result = result;
      job.percent = 100;
      job.creep = undefined;
      job.status = 'done';
    })
    .catch((err: any) => {
      job.status = 'error';
      job.error = err?.message || String(err);
      job.creep = undefined;
      console.error(`[model-jobs] ${job.id} failed:`, job.error);
      // The generation was counted when the job started; a failed one hands the slot back.
      refundGeneration(job.owner).catch(() => {});
    });

  return job.id;
}

/** The job as the browser sees it, or null if it is unknown or belongs to someone else. */
export function modelJobSnapshot(id: string, userId: string) {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) return null;
  return {
    status: job.status,
    percent: Math.round(job.status === 'done' ? 100 : displayedPercent(job)),
    label: job.label,
    result: job.result,
    error: job.error,
  };
}
