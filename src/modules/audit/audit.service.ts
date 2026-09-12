import { newId } from '../../common/ids.js';
import type { OperationsStore } from '../../domain/ports.js';
import type { AuditLog } from '../../domain/types.js';

export class AuditService {
  public constructor(private readonly store: OperationsStore) {}

  public async write(
    input: Omit<AuditLog, 'id' | 'createdAt'> & { createdAt?: Date }
  ): Promise<AuditLog> {
    return this.store.addAuditLog({
      ...input,
      id: newId(),
      createdAt: input.createdAt ?? new Date()
    });
  }
}
