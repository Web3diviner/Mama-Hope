import type { Logger } from 'pino';
import { AppError } from '../../common/errors.js';
import type { JobScheduler, MediaStore, OperationsStore, WhatsAppGateway } from '../../domain/ports.js';
import type { ScheduledJob, TaskAssignee, User } from '../../domain/types.js';
import { AnnouncementService } from '../community/announcement.service.js';
import { MessageRenderer } from '../messaging/message-renderer.js';
import { TaskService } from '../tasks/task.service.js';
import { PlanningService } from '../reports/planning.service.js';

export class AutomationService {
  private lastRecoveryAt = 0;
  private readonly reportedFailedJobs = new Set<string>();
  public constructor(
    private readonly store: OperationsStore,
    private readonly scheduler: JobScheduler,
    private readonly gateway: WhatsAppGateway,
    private readonly mediaStore: MediaStore,
    private readonly renderer: MessageRenderer,
    private readonly tasks: TaskService,
    private readonly announcements: AnnouncementService,
    private readonly planning: PlanningService,
    private readonly superAdminJid: string,
    private readonly botJid: string,
    private readonly organizationTimezone: string,
    private readonly autoSendDailySummary: boolean,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async processDue(maxJobs = 100): Promise<number> {
    const now = this.now();
    if (now.getTime() - this.lastRecoveryAt >= 60_000) {
      const recovered = await this.store.recoverStaleJobs(new Date(now.getTime() - 5 * 60_000), now);
      if (recovered) this.logger.warn({ recovered }, 'Recovered interrupted scheduled jobs');
      await this.reportPermanentFailures(now);
      this.lastRecoveryAt = now.getTime();
    }
    const due = await this.store.listDueJobs(now);
    let processed = 0;
    for (const job of due.slice(0, maxJobs)) {
      await this.process(job.jobKey);
      processed += 1;
    }
    return processed;
  }

  private async reportPermanentFailures(now: Date): Promise<void> {
    if (!this.gateway.isConnected()) return;
    const failures = (await this.store.listFailedJobs(new Date(now.getTime() - 24 * 60 * 60_000)))
      .filter((job) => !this.reportedFailedJobs.has(job.jobKey));
    if (!failures.length) return;
    await this.gateway.sendText({
      chatJid: this.superAdminJid,
      text: `I need your attention: ${failures.length} scheduled operation${failures.length === 1 ? '' : 's'} failed after all retries.\n${failures.slice(0, 5).map((job) => `• ${job.jobType} — ${job.lastError ?? 'unknown error'}`).join('\n')}`,
      correlationId: failures[0]!.id
    });
    for (const job of failures) this.reportedFailedJobs.add(job.jobKey);
  }

  public async process(jobKey: string): Promise<void> {
    const job = await this.store.claimJob(jobKey, this.now());
    if (!job) return;
    try {
      await this.execute(job);
      await this.store.completeJob(job.jobKey, this.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown scheduled job error.';
      const retryAt = error instanceof AppError && error.statusCode < 500
        ? undefined
        : new Date(this.now().getTime() + this.retryDelayMs(job.attempts));
      await this.store.failJob(job.jobKey, message, retryAt);
      const retried = await this.store.getJobByKey(job.jobKey);
      if (retryAt && retried?.status === 'PENDING') {
        await this.scheduler.schedule(retried);
      } else if (retried?.status === 'FAILED' && job.jobType === 'ANNOUNCEMENT_PUBLISH') {
        const announcement = await this.store.getAnnouncement(job.entityId);
        if (announcement && announcement.status === 'SCHEDULED') {
          await this.store.saveAnnouncement({ ...announcement, status: 'FAILED', failureReason: message }, announcement.version);
        }
      }
      this.logger.error({ err: error, jobKey: job.jobKey, retryAt }, 'Scheduled operation failed');
    }
  }

  private async execute(job: ScheduledJob): Promise<void> {
    if (job.jobType === 'DAILY_PLANNING') {
      const summary = await this.planning.run();
      if (this.autoSendDailySummary) {
        if (!this.gateway.isConnected()) {
          throw new AppError('WHATSAPP_UNAVAILABLE', 'WhatsApp is disconnected.', 503);
        }
        await this.gateway.sendText({
          chatJid: this.superAdminJid,
          text: summary,
          correlationId: job.id
        });
      }
      await this.planning.scheduleNext(this.scheduler, this.organizationTimezone);
      return;
    }
    if (job.jobType === 'TASK_RECURRENCE') {
      await this.tasks.createRecurringInstance(job);
      return;
    }
    switch (job.jobType) {
      case 'TASK_PUBLISH':
        await this.publishTask(job);
        return;
      case 'TASK_REMINDER':
        await this.remindTask(job);
        return;
      case 'TASK_DEADLINE':
        await this.markTaskOverdue(job);
        return;
      case 'ANNOUNCEMENT_PUBLISH':
        await this.publishAnnouncement(job);
        return;
      default: {
        const exhaustive: never = job.jobType;
        throw new AppError('UNKNOWN_JOB_TYPE', `Unsupported scheduled job: ${exhaustive}`, 400);
      }
    }
  }

  private async publishTask(job: ScheduledJob): Promise<void> {
    const task = await this.store.getTask(job.entityId);
    if (!task || task.status === 'CANCELLED' || task.publishedMessageId) return;
    const group = await this.store.getGroup(task.groupId);
    if (!group?.active) throw new AppError('UNKNOWN_GROUP', 'Task group is no longer active.', 400);
    const assignees = await this.store.listTaskAssignees(task.id);
    const rendered = await this.renderer.taskAssignment(task, group, assignees);
    const media = await Promise.all(task.attachmentIds.map(async (attachmentId) => {
      const attachment = await this.store.getAttachment(attachmentId);
      if (!attachment?.storageKey) {
        throw new AppError('MEDIA_DELIVERY_NOT_CONFIGURED', 'A task attachment is not available in managed storage.', 503);
      }
      return {
        kind: attachment.kind,
        data: await this.mediaStore.get(attachment.storageKey),
        mimeType: attachment.mimeType,
        fileName: attachment.fileName
      };
    }));
    const receipt = await this.gateway.sendText({
      chatJid: group.whatsappJid,
      text: rendered.text,
      mentions: rendered.mentions,
      attachmentIds: task.attachmentIds,
      media,
      correlationId: job.id
    });
    await this.tasks.recordPublishReceipt(task.id, receipt.id, receipt.sentAt);
    await this.notifyIfDelayed(job, `The assignment “${task.title}”`, receipt.sentAt);
  }

  private async remindTask(job: ScheduledJob): Promise<void> {
    const task = await this.store.getTask(job.entityId);
    if (!task || !['ACTIVE', 'OVERDUE'].includes(task.status)) return;
    const group = await this.store.getGroup(task.groupId);
    if (!group?.active) throw new AppError('UNKNOWN_GROUP', 'Task group is no longer active.', 400);
    const pending = (await this.store.listTaskAssignees(task.id)).filter(
      (assignee) => !['SUBMITTED', 'COMPLETED'].includes(assignee.status)
    );
    if (pending.length === 0) return;
    const minutesBefore = Number(job.payload.minutesBefore ?? 0);
    const rendered = await this.renderer.taskReminder(task, group, pending, minutesBefore);
    await this.gateway.sendText({
      chatJid: group.whatsappJid,
      text: rendered.text,
      mentions: rendered.mentions,
      correlationId: job.id
    });
  }

  private async markTaskOverdue(job: ScheduledJob): Promise<void> {
    const outcome = await this.tasks.markOverdue(job.entityId);
    if (outcome.overdueAssignees.length === 0) return;
    const group = await this.store.getGroup(outcome.task.groupId);
    if (!group?.active) throw new AppError('UNKNOWN_GROUP', 'Task group is no longer active.', 400);
    const rendered = await this.renderer.taskDeadline(outcome.task, outcome.overdueAssignees);
    await this.gateway.sendText({
      chatJid: group.whatsappJid,
      text: rendered.text,
      mentions: rendered.mentions,
      correlationId: job.id
    });
  }

  private async publishAnnouncement(job: ScheduledJob): Promise<void> {
    const announcement = await this.store.getAnnouncement(job.entityId);
    if (!announcement || announcement.status === 'CANCELLED' || announcement.publishedMessageId) return;
    if (announcement.expiresAt && announcement.expiresAt <= this.now()) {
      await this.store.saveAnnouncement(
        { ...announcement, status: 'FAILED', failureReason: 'The announcement expired before it could be published.' },
        announcement.version
      );
      return;
    }
    const group = await this.store.getGroup(announcement.groupId);
    if (!group?.active) throw new AppError('UNKNOWN_GROUP', 'Announcement group is no longer active.', 400);
    const mentions = await this.resolveAnnouncementMentions(announcement.groupId, group.whatsappJid, announcement.mentionStrategy, announcement.interestTags, group.mentionAllMaxParticipants);
    const rendered = await this.renderer.announcement(announcement, group, mentions);
    const media = await Promise.all(
      announcement.attachmentIds.map(async (attachmentId) => {
        const attachment = await this.store.getAttachment(attachmentId);
        if (!attachment?.storageKey) {
          throw new AppError('MEDIA_DELIVERY_NOT_CONFIGURED', 'A scheduled attachment is not available in managed storage.', 503);
        }
        return {
          kind: attachment.kind,
          data: await this.mediaStore.get(attachment.storageKey),
          mimeType: attachment.mimeType,
          fileName: attachment.fileName
        };
      })
    );
    const receipt = await this.gateway.sendText({
      chatJid: group.whatsappJid,
      text: rendered.text,
      mentions: rendered.mentions,
      attachmentIds: announcement.attachmentIds,
      media,
      correlationId: job.id
    });
    await this.announcements.recordPublishReceipt(announcement.id, receipt.id, receipt.sentAt);
    await this.notifyIfDelayed(job, `Announcement ${announcement.publicId}`, receipt.sentAt);
  }

  private async notifyIfDelayed(job: ScheduledJob, label: string, deliveredAt: Date): Promise<void> {
    const delayMinutes = Math.floor((deliveredAt.getTime() - job.runAt.getTime()) / 60_000);
    if (delayMinutes < 2 || !this.gateway.isConnected()) return;
    await this.gateway.sendText({
      chatJid: this.superAdminJid,
      text: `${label} was delayed by ${delayMinutes} minute${delayMinutes === 1 ? '' : 's'} while delivery was unavailable. It has now been sent.`,
      correlationId: job.id
    });
  }

  private async resolveAnnouncementMentions(
    groupId: string,
    groupJid: string,
    strategy: 'NONE' | 'RELEVANT_MEMBERS' | 'OFFICIALS_ONLY' | 'EVERYONE',
    interestTags: string[],
    maximumEveryone: number
  ): Promise<string[]> {
    if (strategy === 'NONE') return [];
    if (strategy === 'EVERYONE' && this.gateway.listGroupParticipants) {
      const live = (await this.gateway.listGroupParticipants(groupJid)).filter((participant) => participant.jid !== this.botJid);
      if (live.length > maximumEveryone) {
        throw new AppError('MENTION_THRESHOLD_EXCEEDED', `This group has ${live.length} participants; its every-member mention threshold is ${maximumEveryone}.`, 400);
      }
      return live.map((participant) => participant.jid);
    }
    const members = (await this.store.listGroupMembers(groupId)).filter((member) => member.active);
    if (strategy === 'EVERYONE' && members.length > maximumEveryone) {
      throw new AppError(
        'MENTION_THRESHOLD_EXCEEDED',
        `This group has ${members.length} active members; its every-member mention threshold is ${maximumEveryone}.`,
        400
      );
    }
    const resolved = await Promise.all(
      members.map(async (member) => ({
        member,
        user: await this.store.getUser(member.userId),
        official: await this.store.getOfficial(member.userId)
      }))
    );
    const normalizedTags = new Set(interestTags.map((tag) => tag.toLowerCase()));
    return resolved
      .filter(({ user }) => user?.active)
      .filter(({ user, official }) => {
        if (strategy === 'EVERYONE') return true;
        if (strategy === 'OFFICIALS_ONLY') return user?.role === 'OFFICIAL';
        return (user?.interestTags ?? official?.interestTags ?? []).some((tag) => normalizedTags.has(tag.toLowerCase()));
      })
      .flatMap(({ user }) => (user ? [user.whatsappJid] : []));
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  }
}
