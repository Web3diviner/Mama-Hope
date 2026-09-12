import { formatDateTime, getLocalParts, localDateTimeToUtc } from '../../common/time.js';
import type { OperationsStore } from '../../domain/ports.js';
import type { Task } from '../../domain/types.js';

export interface DailyReport {
  date: string;
  timezone: string;
  activeTaskCount: number;
  completed: Task[];
  submitted: Task[];
  dueToday: Task[];
  overdue: Task[];
  blockedCount: number;
  scheduledAnnouncementsCount: number;
  assigneeNamesByTask: Record<string, string[]>;
  blockedAssignments: Array<{ taskTitle: string; assigneeName: string; reason?: string }>;
}

export interface OfficialWorkload {
  userId: string;
  name: string;
  openAssignments: number;
  completedAssignments: number;
  overdueAssignments: number;
}

export interface WeeklyReport {
  startDate: string;
  endDate: string;
  timezone: string;
  createdTaskCount: number;
  completedTaskCount: number;
  completedOnTimeTaskCount: number;
  overdueTaskCount: number;
  completionRate: number;
  onTimeRate: number;
  workload: OfficialWorkload[];
  upcomingDeadlines: Task[];
}

const isoDate = (date: Date, timeZone: string): string => {
  const parts = getLocalParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

const parseLocalDate = (date: string): { year: number; month: number; day: number } | undefined => {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  if (!year || !month || !day || month > 12 || day > 31) return undefined;
  return { year, month, day };
};

const dayBounds = (date: string, timeZone: string): { start: Date; end: Date } => {
  const parsed = parseLocalDate(date);
  if (!parsed) throw new Error(`Invalid report date '${date}', use YYYY-MM-DD.`);
  const start = localDateTimeToUtc({ ...parsed, hour: 0, minute: 0 }, timeZone);
  const nextDay = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1));
  const end = localDateTimeToUtc(
    { year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1, day: nextDay.getUTCDate(), hour: 0, minute: 0 },
    timeZone
  );
  return { start, end };
};

export class ReportService {
  public constructor(
    private readonly store: OperationsStore,
    private readonly organizationTimezone: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async daily(date = isoDate(this.now(), this.organizationTimezone), timezone = this.organizationTimezone): Promise<DailyReport> {
    const { start, end } = dayBounds(date, timezone);
    const all = await this.store.listTasks();
    const completed = all.filter(
      (task) => task.completedAt && task.completedAt >= start && task.completedAt < end
    );
    const submitted = all.filter(
      (task) => task.status === 'SUBMITTED' && task.updatedAt >= start && task.updatedAt < end
    );
    const dueToday = all.filter(
      (task) => task.deadlineAt && task.deadlineAt >= start && task.deadlineAt < end && !['COMPLETED', 'CANCELLED'].includes(task.status)
    );
    const overdue = all.filter((task) => task.status === 'OVERDUE');
    const activeTaskCount = all.filter((task) => ['SCHEDULED', 'ACTIVE', 'SUBMITTED', 'OVERDUE'].includes(task.status)).length;
    const [assignments, officials] = await Promise.all([
      this.store.listTaskAssigneesForTasks(all.map((task) => task.id)),
      this.store.listOfficials()
    ]);
    const names = new Map(officials.map(({ user, profile }) => [user.id, profile.fullName]));
    const tasksById = new Map(all.map((task) => [task.id, task]));
    const assigneeNamesByTask: Record<string, string[]> = {};
    for (const assignment of assignments) {
      (assigneeNamesByTask[assignment.taskId] ??= []).push(names.get(assignment.userId) ?? 'Unknown official');
    }
    const blockedAssignments = assignments.filter((assignee) => assignee.status === 'BLOCKED').map((assignee) => ({
      taskTitle: tasksById.get(assignee.taskId)?.title ?? 'Unknown task',
      assigneeName: names.get(assignee.userId) ?? 'Unknown official',
      reason: assignee.blockedReason
    }));
    const blockedCount = blockedAssignments.length;
    const scheduledAnnouncementsCount = (await this.store.listAnnouncements({ status: 'SCHEDULED' })).filter(
      (announcement) => announcement.publishAt && announcement.publishAt >= start && announcement.publishAt < end
    ).length;
    return {
      date,
      timezone,
      activeTaskCount,
      completed,
      submitted,
      dueToday,
      overdue,
      blockedCount,
      scheduledAnnouncementsCount,
      assigneeNamesByTask,
      blockedAssignments
    };
  }

  public async weekly(
    startDate = this.currentWeekStart(this.now(), this.organizationTimezone),
    timezone = this.organizationTimezone
  ): Promise<WeeklyReport> {
    const { start } = dayBounds(startDate, timezone);
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1_000);
    const endDate = isoDate(new Date(end.getTime() - 1), timezone);
    const tasks = await this.store.listTasks();
    const created = tasks.filter((task) => task.createdAt >= start && task.createdAt < end);
    const completed = tasks.filter((task) => task.completedAt && task.completedAt >= start && task.completedAt < end);
    const completedOnTime = completed.filter((task) => !task.deadlineAt || (task.completedAt && task.completedAt <= task.deadlineAt));
    const overdue = tasks.filter((task) => task.status === 'OVERDUE' && task.deadlineAt && task.deadlineAt >= start && task.deadlineAt < end);
    const assignments = await this.store.listTaskAssigneesForTasks(tasks.map((task) => task.id));
    const byTask = new Map<string, typeof assignments>();
    for (const assignment of assignments) byTask.set(assignment.taskId, [...(byTask.get(assignment.taskId) ?? []), assignment]);
    const allAssignments = tasks.map((task) => ({ task, assignees: byTask.get(task.id) ?? [] }));
    const userIds = [...new Set(allAssignments.flatMap(({ assignees }) => assignees.map((assignee) => assignee.userId)))];
    const workload = await Promise.all(
      userIds.map(async (userId) => {
        const [user, official] = await Promise.all([this.store.getUser(userId), this.store.getOfficial(userId)]);
        const assignments = allAssignments.flatMap(({ task, assignees }) =>
          assignees.filter((assignee) => assignee.userId === userId).map((assignee) => ({ task, assignee }))
        );
        return {
          userId,
          name: official?.fullName ?? user?.displayName ?? 'Unknown official',
          openAssignments: assignments.filter(({ assignee }) => !['COMPLETED', 'SUBMITTED'].includes(assignee.status)).length,
          completedAssignments: assignments.filter(({ assignee }) => ['COMPLETED', 'SUBMITTED'].includes(assignee.status)).length,
          overdueAssignments: assignments.filter(({ assignee }) => assignee.status === 'OVERDUE').length
        };
      })
    );
    const upcomingEnd = new Date(end.getTime() + 7 * 24 * 60 * 60 * 1_000);
    const upcomingDeadlines = tasks.filter(
      (task) => task.deadlineAt && task.deadlineAt >= end && task.deadlineAt < upcomingEnd && !['COMPLETED', 'CANCELLED'].includes(task.status)
    );
    const dueAssignments = allAssignments.flatMap(({ task, assignees }) =>
      assignees
        .filter(() => task.deadlineAt && task.deadlineAt >= start && task.deadlineAt < end)
        .map((assignee) => ({ task, assignee }))
    );
    const completedAssignments = dueAssignments.filter(({ assignee }) => ['COMPLETED', 'SUBMITTED'].includes(assignee.status));
    const onTimeAssignments = completedAssignments.filter(({ task, assignee }) => {
      const actionAt = assignee.completedAt ?? assignee.submittedAt;
      return Boolean(task.deadlineAt && actionAt && actionAt <= task.deadlineAt);
    });
    return {
      startDate,
      endDate,
      timezone,
      createdTaskCount: created.length,
      completedTaskCount: completed.length,
      completedOnTimeTaskCount: completedOnTime.length,
      overdueTaskCount: overdue.length,
      completionRate: dueAssignments.length ? completedAssignments.length / dueAssignments.length : 0,
      onTimeRate: completedAssignments.length ? onTimeAssignments.length / completedAssignments.length : 0,
      workload: workload.sort((a, b) => b.openAssignments - a.openAssignments || a.name.localeCompare(b.name)),
      upcomingDeadlines
    };
  }

  public renderDaily(report: DailyReport): string {
    const lines = [
      `*Team Operations — ${report.date}*`,
      '',
      `${report.activeTaskCount} active tasks`,
      `${report.completed.length} completed`,
      `${report.submitted.length} submitted`,
      `${report.overdue.length} overdue`
    ];
    if (report.dueToday.length) {
      lines.push('', '*Due today*', ...report.dueToday.map((task) => `• ${task.title} — ${(report.assigneeNamesByTask[task.id] ?? []).join(', ') || 'unassigned'}${task.deadlineAt ? ` — ${formatDateTime(task.deadlineAt, report.timezone)}` : ''}`));
    }
    if (report.overdue.length) {
      lines.push('', '*Overdue*', ...report.overdue.map((task) => `• ${task.title} — ${(report.assigneeNamesByTask[task.id] ?? []).join(', ') || 'unassigned'}`));
    }
    if (report.blockedAssignments.length) {
      lines.push('', '*Blocked*', ...report.blockedAssignments.map((item) => `• ${item.assigneeName} on ${item.taskTitle}${item.reason ? ` — ${item.reason}` : ''}`));
    }
    if (report.scheduledAnnouncementsCount) lines.push('', `${report.scheduledAnnouncementsCount} announcement(s) scheduled for today.`);
    return lines.join('\n');
  }

  public renderWeekly(report: WeeklyReport): string {
    return [
      `*Weekly Team Operations — ${report.startDate} to ${report.endDate}*`,
      '',
      `${report.createdTaskCount} tasks created`,
      `${report.completedTaskCount} completed`,
      `${Math.round(report.completionRate * 100)}% assignment completion rate`,
      `${Math.round(report.onTimeRate * 100)}% on-time rate`,
      `${report.overdueTaskCount} overdue tasks`,
      '',
      '*Workload*',
      ...report.workload.map((person) => `• ${person.name}: ${person.openAssignments} open, ${person.completedAssignments} submitted/completed, ${person.overdueAssignments} overdue`),
      ...(report.upcomingDeadlines.length ? ['', '*Next week*', ...report.upcomingDeadlines.map((task) => `• ${task.title} — ${task.deadlineAt ? formatDateTime(task.deadlineAt, report.timezone) : 'deadline pending'}`)] : [])
    ].join('\n');
  }

  private currentWeekStart(date: Date, timezone: string): string {
    const local = getLocalParts(date, timezone);
    const daysSinceMonday = (local.weekday + 6) % 7;
    const start = new Date(Date.UTC(local.year, local.month - 1, local.day - daysSinceMonday));
    return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`;
  }
}
