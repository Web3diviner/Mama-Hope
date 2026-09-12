import type { JobScheduler } from '../../domain/ports.js';
import type { ScheduledJob } from '../../domain/types.js';

/**
 * Scheduling is durable in the OperationsStore job ledger. AutomationService
 * polls and atomically claims due rows, so this adapter deliberately has no
 * separate queue, timer, or external service dependency.
 */
export class LedgerScheduler implements JobScheduler {
  public async schedule(_job: ScheduledJob): Promise<void> {
    // The service that created the job has already persisted it. The polling
    // loop will claim it at runAt, including after a process restart.
  }
}
