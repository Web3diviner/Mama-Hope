import { AppError, forbidden, notFound } from '../../common/errors.js';
import { makePublicId, newId } from '../../common/ids.js';
import type { JobScheduler, OperationsStore } from '../../domain/ports.js';
import type {
  Announcement,
  CreateAnnouncementInput,
  ScheduledJob,
  UpdateAnnouncementInput,
  User
} from '../../domain/types.js';
import { AuditService } from '../audit/audit.service.js';
import type { TaskActionContext } from '../tasks/task.service.js';

export class AnnouncementService {
  private publicSequence = 0;

  public constructor(
    private readonly store: OperationsStore,
    private readonly scheduler: JobScheduler,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async create(input: CreateAnnouncementInput, context: TaskActionContext): Promise<Announcement> {
    this.requireSuperAdmin(context.actor);
    const group = await this.store.getGroup(input.groupId);
    if (!group?.active) throw new AppError('UNKNOWN_GROUP', 'Choose an active configured group.', 400);
    if (input.publishAt && input.publishAt < this.now()) {
      throw new AppError('INVALID_SCHEDULE', 'Publication time cannot be in the past.', 400);
    }
    if (input.expiresAt && input.publishAt && input.expiresAt <= input.publishAt) {
      throw new AppError('INVALID_SCHEDULE', 'Expiry must be after publication.', 400);
    }
    if (input.mentionStrategy === 'EVERYONE' && group.mentionAllMaxParticipants < 1) {
      throw new AppError('MENTION_NOT_ALLOWED', 'This group does not allow everyone mentions.', 400);
    }
    const now = this.now();
    const announcement: Announcement = {
      id: newId(),
      publicId: this.nextPublicId(now),
      groupId: input.groupId,
      createdBy: context.actor.id,
      sourceMessageId: input.sourceMessageId ?? context.sourceMessageId,
      title: input.title?.trim(),
      category: input.category?.trim(),
      body: input.body.trim(),
      mentionStrategy: input.mentionStrategy ?? 'NONE',
      interestTags: input.interestTags ?? [],
      status: 'SCHEDULED',
      publishAt: input.publishAt ?? now,
      expiresAt: input.expiresAt,
      attachmentIds: input.attachmentIds ?? [],
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    const saved = await this.store.createAnnouncement(announcement);
    if (/opportunit|grant|scholarship|audition|competition|training|internship|funding|webinar/i.test(`${saved.category ?? ''} ${saved.title ?? ''}`)) {
      const applicationUrl = saved.body.match(/https?:\/\/[^\s)]+/i)?.[0];
      await this.store.saveOpportunity({
        id: newId(),
        announcementId: saved.id,
        title: saved.title ?? saved.body.split(/\r?\n/).find(Boolean)?.slice(0, 180) ?? 'Community opportunity',
        category: saved.category ?? 'Opportunity',
        summary: saved.body.slice(0, 4_000),
        applicationUrl,
        deadlineAt: saved.expiresAt,
        active: true,
        createdBy: context.actor.id,
        createdAt: now,
        updatedAt: now
      });
    }
    await this.schedulePublish(saved);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'ANNOUNCEMENT_CREATED',
      entityType: 'ANNOUNCEMENT',
      entityId: saved.id,
      originalInput: context.originalInput,
      executedPayload: { publicId: saved.publicId, mentionStrategy: saved.mentionStrategy },
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async update(
    announcementId: string,
    input: UpdateAnnouncementInput,
    context: TaskActionContext
  ): Promise<Announcement> {
    this.requireSuperAdmin(context.actor);
    const current = await this.store.getAnnouncement(announcementId);
    if (!current) throw notFound('Announcement', announcementId);
    if (['PUBLISHED', 'CANCELLED'].includes(current.status)) {
      throw new AppError('ANNOUNCEMENT_NOT_EDITABLE', 'Published or cancelled announcements cannot be edited.', 409);
    }
    const next: Announcement = {
      ...current,
      title: input.title?.trim() ?? current.title,
      body: input.body?.trim() ?? current.body,
      category: input.category?.trim() ?? current.category,
      mentionStrategy: input.mentionStrategy ?? current.mentionStrategy,
      interestTags: input.interestTags ?? current.interestTags,
      publishAt: input.publishAt ?? current.publishAt,
      expiresAt: input.expiresAt ?? current.expiresAt,
      attachmentIds: input.attachmentIds ?? current.attachmentIds
    };
    if (next.publishAt && next.publishAt < this.now()) {
      throw new AppError('INVALID_SCHEDULE', 'Publication time cannot be in the past.', 400);
    }
    if (next.expiresAt && next.publishAt && next.expiresAt <= next.publishAt) {
      throw new AppError('INVALID_SCHEDULE', 'Expiry must be after publication.', 400);
    }
    const saved = await this.store.saveAnnouncement(next, input.expectedVersion);
    await this.store.cancelJobsForEntity('ANNOUNCEMENT', announcementId);
    await this.schedulePublish(saved);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'ANNOUNCEMENT_UPDATED',
      entityType: 'ANNOUNCEMENT',
      entityId: announcementId,
      originalInput: context.originalInput,
      executedPayload: { version: saved.version },
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async cancel(
    announcementId: string,
    expectedVersion: number,
    reason: string,
    context: TaskActionContext
  ): Promise<Announcement> {
    this.requireSuperAdmin(context.actor);
    const current = await this.store.getAnnouncement(announcementId);
    if (!current) throw notFound('Announcement', announcementId);
    if (current.status === 'PUBLISHED') {
      throw new AppError('ANNOUNCEMENT_ALREADY_PUBLISHED', 'A published announcement cannot be recalled by the bot.', 409);
    }
    const saved = await this.store.saveAnnouncement(
      { ...current, status: 'CANCELLED', failureReason: reason.trim() },
      expectedVersion
    );
    await this.store.cancelJobsForEntity('ANNOUNCEMENT', announcementId);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'ANNOUNCEMENT_CANCELLED',
      entityType: 'ANNOUNCEMENT',
      entityId: announcementId,
      originalInput: context.originalInput,
      executedPayload: { reason: reason.trim() },
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async recordPublishReceipt(announcementId: string, messageId: string, sentAt: Date): Promise<Announcement> {
    const current = await this.store.getAnnouncement(announcementId);
    if (!current) throw notFound('Announcement', announcementId);
    if (current.status === 'CANCELLED' || current.publishedMessageId) return current;
    return this.store.saveAnnouncement(
      { ...current, status: 'PUBLISHED', publishedAt: sentAt, publishedMessageId: messageId },
      current.version
    );
  }

  private requireSuperAdmin(actor: User): void {
    if (actor.role !== 'SUPER_ADMIN' || !actor.active) throw forbidden();
  }

  private nextPublicId(now: Date): string {
    this.publicSequence = (this.publicSequence + 1) % 10_000;
    return makePublicId('ANN', (now.getTime() % 1_000_000) + this.publicSequence, now);
  }

  private async schedulePublish(announcement: Announcement): Promise<void> {
    const now = this.now();
    const runAt = announcement.publishAt && announcement.publishAt > now ? announcement.publishAt : now;
    const job: ScheduledJob = {
      id: newId(),
      jobKey: `announcement:${announcement.id}:v${announcement.version}:TASK_PUBLISH`.replace('TASK_PUBLISH', 'ANNOUNCEMENT_PUBLISH'),
      jobType: 'ANNOUNCEMENT_PUBLISH',
      entityType: 'ANNOUNCEMENT',
      entityId: announcement.id,
      runAt,
      payload: {},
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      createdAt: now,
      updatedAt: now
    };
    const durable = await this.store.createJob(job);
    if (durable.status === 'PENDING') await this.scheduler.schedule(durable);
  }
}
