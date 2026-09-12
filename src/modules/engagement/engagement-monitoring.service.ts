import type { OperationsStore } from '../../domain/ports.js';
import type { MemberActivity, MemberCheckin } from '../../domain/types.js';

export class EngagementMonitoringService {
  public constructor(private readonly store: OperationsStore, private readonly now: () => Date = () => new Date()) {}

  public async recordMessage(userId: string, groupId: string, meaningful = true): Promise<MemberActivity> {
    const now = this.now();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const periodEnd = new Date(periodStart.getTime() + 7 * 86_400_000);
    const existing = (await this.store.listMemberActivity(groupId, periodStart))
      .find((activity) => activity.userId === userId && activity.periodStart.getTime() === periodStart.getTime());
    return this.store.recordMemberActivity({
      id: existing?.id ?? crypto.randomUUID(),
      userId,
      groupId,
      messageCount: (existing?.messageCount ?? 0) + 1,
      lastMessageAt: now,
      lastMeaningfulAt: meaningful ? now : existing?.lastMeaningfulAt,
      periodStart,
      periodEnd,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  public async draftCheckin(userId: string, groupId: string, memberName: string): Promise<MemberCheckin> {
    const checkin: MemberCheckin = {
      id: crypto.randomUUID(),
      userId,
      groupId,
      message: `Hey ${memberName} 💚\n\nYou’ve been a little quiet in the community recently, so I just wanted to check in.\n\nHope everything is alright with you.\n\nNo pressure at all. Just wanted to make sure you’re good.`,
      status: 'DRAFT',
      createdAt: this.now()
    };
    return this.store.saveMemberCheckin(checkin);
  }
}