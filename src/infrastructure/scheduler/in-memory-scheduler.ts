import type { JobScheduler } from '../../domain/ports.js';
import type { ScheduledJob } from '../../domain/types.js';

/**
 * Jobs remain durable in OperationsStore. This adapter is intentionally a no-op
 * dispatcher because AutomationService can poll due jobs in local/test mode.
 */
export class InMemoryScheduler implements JobScheduler {
  public readonly scheduled = new Map<string, ScheduledJob>();

  public async schedule(job: ScheduledJob): Promise<void> {
    this.scheduled.set(job.jobKey, structuredClone(job));
  }
}
