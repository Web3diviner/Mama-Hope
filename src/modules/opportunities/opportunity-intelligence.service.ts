import type { OperationsStore } from '../../domain/ports.js';
import type { OpportunityCandidate } from '../../domain/types.js';

export interface OpportunityInput {
  id: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  summary: string;
  category: string;
  eligibility?: string;
  deadlineAt?: Date;
  musicRelevance: number;
  regionalRelevance: number;
  youthRelevance: number;
  supportValue: number;
  sourceCredibility: number;
}

const bounded = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

export class OpportunityIntelligenceService {
  public constructor(private readonly store: OperationsStore, private readonly now: () => Date = () => new Date()) {}

  public async ingest(input: OpportunityInput): Promise<OpportunityCandidate> {
    const now = this.now();
    const daysRemaining = input.deadlineAt
      ? (input.deadlineAt.getTime() - now.getTime()) / 86_400_000
      : 30;
    const deadlineViability = daysRemaining < 3 ? 0 : daysRemaining < 7 ? 2 : daysRemaining < 14 ? 4 : 5;
    const totalScore = bounded(
      input.musicRelevance * 0.25
      + input.regionalRelevance * 0.2
      + input.youthRelevance * 0.1
      + input.supportValue * 0.1
      + input.sourceCredibility * 0.1
      + deadlineViability * 5
    );
    const candidate: OpportunityCandidate = {
      ...input,
      musicRelevance: bounded(input.musicRelevance),
      regionalRelevance: bounded(input.regionalRelevance),
      youthRelevance: bounded(input.youthRelevance),
      supportValue: bounded(input.supportValue),
      sourceCredibility: bounded(input.sourceCredibility),
      deadlineViability,
      totalScore,
      status: totalScore >= 85 ? 'SAVED' : totalScore >= 70 ? 'REVIEW' : totalScore >= 50 ? 'NEW' : 'IGNORED',
      createdAt: now,
      updatedAt: now
    };
    return this.store.saveOpportunityCandidate(candidate);
  }

  public list(minScore?: number): Promise<OpportunityCandidate[]> {
    return this.store.listOpportunityCandidates(minScore);
  }
}