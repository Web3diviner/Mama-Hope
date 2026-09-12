import type { OperationsStore } from '../../domain/ports.js';
import type { CalendarEvent } from '../../domain/types.js';

export interface CreateCalendarEventInput {
  id: string;
  externalId?: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt?: Date;
  timezone: string;
  source: CalendarEvent['source'];
  relevanceScore?: number;
}

const stageFor = (startsAt: Date, now: Date): CalendarEvent['preparationStage'] => {
  const daysUntil = (startsAt.getTime() - now.getTime()) / 86_400_000;
  if (daysUntil <= 0) return 'EVENT_DAY';
  if (daysUntil <= 1) return 'PUBLISH';
  if (daysUntil <= 3) return 'REVIEW';
  if (daysUntil <= 7) return 'EXECUTION';
  if (daysUntil <= 14) return 'PLANNING';
  if (daysUntil <= 30) return 'EVALUATION';
  return 'AWARENESS';
};

export class EventIntelligenceService {
  public constructor(private readonly store: OperationsStore, private readonly now: () => Date = () => new Date()) {}

  public async create(input: CreateCalendarEventInput): Promise<CalendarEvent> {
    const now = this.now();
    const event: CalendarEvent = {
      ...input,
      relevanceScore: Math.max(0, Math.min(100, input.relevanceScore ?? 0)),
      preparationStage: stageFor(input.startsAt, now),
      createdAt: now,
      updatedAt: now
    };
    return this.store.saveCalendarEvent(event);
  }

  public list(from?: Date, to?: Date): Promise<CalendarEvent[]> {
    return this.store.listCalendarEvents(from, to);
  }

  public preparationStage(startsAt: Date): CalendarEvent['preparationStage'] {
    return stageFor(startsAt, this.now());
  }
}