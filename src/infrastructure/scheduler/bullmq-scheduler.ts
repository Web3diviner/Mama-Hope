import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import type { JobScheduler } from '../../domain/ports.js';
import type { ScheduledJob } from '../../domain/types.js';

export class BullMqScheduler implements JobScheduler {
  private readonly connection: Redis;
  private readonly queue: Queue<{ jobKey: string }>;
  private worker?: Worker<{ jobKey: string }>;

  public constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('mama-hope', { connection: this.connection });
  }

  public async schedule(job: ScheduledJob): Promise<void> {
    const delay = Math.max(0, job.runAt.getTime() - Date.now());
    // BullMQ reserves colons in custom job IDs, while durable ledger keys use
    // them for readability. Hashing keeps the queue ID valid and deterministic.
    const queueJobId = `mh-${createHash('sha256').update(`${job.jobKey}:${job.attempts}`).digest('hex')}`;
    const options: JobsOptions = {
      jobId: queueJobId,
      delay,
      attempts: job.maxAttempts,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 200,
      removeOnFail: 500
    };
    await this.queue.add(job.jobType, { jobKey: job.jobKey }, options);
  }

  public async start(handler: (jobKey: string) => Promise<void>): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker<{ jobKey: string }>(
      'mama-hope',
      async (job) => handler(job.data.jobKey),
      { connection: this.connection.duplicate(), concurrency: 5 }
    );
    await this.worker.waitUntilReady();
  }

  public async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
