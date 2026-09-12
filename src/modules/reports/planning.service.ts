import type { OperationsStore } from '../../domain/ports.js';
import type { DailyOperationsSnapshot } from '../../domain/types.js';
import { newId } from '../../common/ids.js';
import type { JobScheduler } from '../../domain/ports.js';
import { getLocalParts, localDateTimeToUtc } from '../../common/time.js';

export class PlanningService {
  public constructor(
    private readonly store: OperationsStore,
    private readonly timezone: string,
    private readonly organizationName: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async scheduleNext(scheduler: JobScheduler, timezone: string): Promise<void> {
    const now = this.now();
    const local = getLocalParts(now, timezone);
    const targetDayOffset = local.hour < 6 ? 0 : 1;
    const targetDay = new Date(Date.UTC(local.year, local.month - 1, local.day + targetDayOffset));
    const runAt = localDateTimeToUtc({
      year: targetDay.getUTCFullYear(),
      month: targetDay.getUTCMonth() + 1,
      day: targetDay.getUTCDate(),
      hour: 6,
      minute: 0
    }, timezone);
    const job = await this.store.createJob({
      id: newId(),
      jobKey: `system:daily-planning:${targetDay.getUTCFullYear()}-${String(targetDay.getUTCMonth() + 1).padStart(2, '0')}-${String(targetDay.getUTCDate()).padStart(2, '0')}`,
      jobType: 'DAILY_PLANNING',
      entityType: 'SYSTEM',
      entityId: '00000000-0000-0000-0000-000000000000',
      runAt,
      payload: {},
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now
    });
    if (job.status === 'PENDING') await scheduler.schedule(job);
  }

  public async dailySnapshot(): Promise<DailyOperationsSnapshot> {
    const now = this.now();
    const local = getLocalParts(now, this.timezone);
    const nextWeek = new Date(now.getTime() + 7 * 86_400_000);
    const [upcomingEvents, activeTasks, scheduledAnnouncements, opportunityCandidates, activityRecords, draftCheckins] = await Promise.all([
      this.store.listCalendarEvents(now, nextWeek),
      this.store.listTasks(),
      this.store.listAnnouncements({ status: 'SCHEDULED' }),
      this.store.listOpportunityCandidates(50),
      this.store.listMemberActivity(undefined, new Date(now.getTime() - 21 * 86_400_000)),
      this.store.listMemberCheckins(undefined, new Date(now.getTime() - 30 * 86_400_000))
    ]);
    return {
      date: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
      upcomingEvents,
      activeTasks: activeTasks.filter((task) => ['SCHEDULED', 'ACTIVE', 'SUBMITTED', 'OVERDUE'].includes(task.status)),
      scheduledAnnouncements,
      opportunityCandidates,
      activeMemberCount: new Set(activityRecords.map((activity) => activity.userId)).size,
      activityRecords,
      draftCheckins: draftCheckins.filter((checkin) => checkin.status === 'DRAFT')
    };
  }

  public render(snapshot: DailyOperationsSnapshot): string {
    const overdue = snapshot.activeTasks.filter((task) => task.status === 'OVERDUE');
    const dueSoon = snapshot.activeTasks.filter((task) => task.deadlineAt).sort((a, b) => a.deadlineAt!.getTime() - b.deadlineAt!.getTime()).slice(0, 3);
    const hour = getLocalParts(this.now(), this.timezone).hour;
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const lines = [
      `${greeting} 💚`,
      '',
      `Here’s today’s ${this.organizationName} operations update:`,
      '',
      `• ${snapshot.upcomingEvents.length} upcoming event(s) in the next 7 days.`,
      `• ${snapshot.activeTasks.length} active task(s), including ${snapshot.activeTasks.filter((task) => task.status === 'OVERDUE').length} overdue.`,
      `• ${snapshot.scheduledAnnouncements.length} announcement(s) scheduled.`,
      `• ${snapshot.opportunityCandidates.length} opportunity candidate(s) scoring 50 or higher.`,
      `• ${snapshot.activeMemberCount} member(s) active in the last 21 days.`,
      `• ${snapshot.draftCheckins.length} private check-in draft(s) awaiting review.`
    ];
    if (overdue.length) lines.push('', '*Needs attention*', ...overdue.slice(0, 3).map((task) => `• ${task.title} is overdue.`));
    if (dueSoon.length) lines.push('', '*Coming up*', ...dueSoon.map((task) => `• ${task.title} — ${task.deadlineAt!.toLocaleString('en-NG', { timeZone: this.timezone })}`));
    if (snapshot.opportunityCandidates.length) lines.push('', '*Opportunities to review*', ...snapshot.opportunityCandidates.slice(0, 3).map((item) => `• ${item.title} — score ${item.totalScore}`));
    if (snapshot.upcomingEvents.length) lines.push('', '*Upcoming events*', ...snapshot.upcomingEvents.slice(0, 3).map((event) => `• ${event.title} — ${event.preparationStage.toLowerCase()}`));
    return lines.join('\n');
  }

  public async run(): Promise<string> {
    await this.draftInactiveMemberCheckins();
    const snapshot = await this.dailySnapshot();
    const summary = this.render(snapshot);
    await this.store.savePlanningRun({
      id: newId(),
      runAt: this.now(),
      status: 'SUCCEEDED',
      summary,
      createdAt: this.now()
    });
    return summary;
  }

  private async draftInactiveMemberCheckins(): Promise<void> {
    const now = this.now();
    const inactiveBefore = new Date(now.getTime() - 14 * 86_400_000);
    const recentCheckins = await this.store.listMemberCheckins(undefined, new Date(now.getTime() - 30 * 86_400_000));
    const alreadyChecked = new Set(recentCheckins.map((checkin) => `${checkin.groupId}:${checkin.userId}`));
    let drafted = 0;
    for (const group of (await this.store.listGroups()).filter((item) => item.active && item.type === 'COMMUNITY')) {
      const activity = await this.store.listMemberActivity(group.id, new Date(now.getTime() - 30 * 86_400_000));
      const latestByUser = new Map<string, Date>();
      for (const item of activity) {
        const last = item.lastMeaningfulAt ?? item.lastMessageAt;
        if (last && (!latestByUser.get(item.userId) || latestByUser.get(item.userId)! < last)) latestByUser.set(item.userId, last);
      }
      for (const member of (await this.store.listGroupMembers(group.id)).filter((item) => item.active)) {
        if (drafted >= 10 || alreadyChecked.has(`${group.id}:${member.userId}`)) continue;
        const user = await this.store.getUser(member.userId);
        if (!user?.active || user.role !== 'COMMUNITY_MEMBER') continue;
        const lastActive = latestByUser.get(user.id) ?? user.createdAt;
        if (lastActive > inactiveBefore) continue;
        const name = user.displayName ?? user.phoneE164 ?? 'there';
        await this.store.saveMemberCheckin({
          id: newId(),
          userId: user.id,
          groupId: group.id,
          message: `Hey ${name} 💚\n\nYou’ve been a little quiet in the community recently, so I wanted to check in. I hope everything is alright with you.\n\nNo pressure at all — just making sure you’re good.`,
          status: 'DRAFT',
          createdAt: now
        });
        drafted += 1;
      }
    }
  }
}
