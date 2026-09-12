import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

export const newCorrelationId = (): string => randomUUID();

export const makePublicId = (kind: 'TASK' | 'ANN', sequence: number, now = new Date()): string => {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `MH-${kind}-${date}-${String(sequence).padStart(3, '0')}`;
};
