import { AppError, forbidden } from '../../common/errors.js';
import { newId } from '../../common/ids.js';
import type { OperationsStore } from '../../domain/ports.js';
import type { ActionConfirmation, CreateAnnouncementInput, Task, User } from '../../domain/types.js';
import { AuditService } from '../audit/audit.service.js';
import { AnnouncementService } from '../community/announcement.service.js';
import type { TaskActionContext } from '../tasks/task.service.js';
import { TaskService } from '../tasks/task.service.js';

interface StoredAnnouncementDraft {
  groupId: string;
  body: string;
  title?: string;
  category?: string;
  mentionStrategy: 'EVERYONE';
  interestTags?: string[];
  publishAt?: string;
  expiresAt?: string;
  attachmentIds?: string[];
  sourceMessageId?: string;
}

export class ConfirmationService {
  public constructor(
    private readonly store: OperationsStore,
    private readonly announcements: AnnouncementService,
    private readonly tasks: TaskService,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async requestEveryoneAnnouncement(
    input: CreateAnnouncementInput,
    context: TaskActionContext
  ): Promise<ActionConfirmation> {
    this.requireSuperAdmin(context.actor);
    if (input.mentionStrategy !== 'EVERYONE') {
      throw new AppError('CONFIRMATION_NOT_REQUIRED', 'Only everyone-mention announcements use this confirmation flow.', 400);
    }
    const now = this.now();
    const id = newId();
    const draft: StoredAnnouncementDraft = {
      groupId: input.groupId,
      body: input.body,
      title: input.title,
      category: input.category,
      mentionStrategy: 'EVERYONE',
      interestTags: input.interestTags,
      publishAt: input.publishAt?.toISOString(),
      expiresAt: input.expiresAt?.toISOString(),
      attachmentIds: input.attachmentIds,
      sourceMessageId: input.sourceMessageId ?? context.sourceMessageId
    };
    const confirmation: ActionConfirmation = {
      id,
      publicId: `MH-CONF-${id.slice(0, 8).toUpperCase()}`,
      requestedBy: context.actor.id,
      actionType: 'CREATE_EVERYONE_ANNOUNCEMENT',
      draft: draft as unknown as Record<string, unknown>,
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + 15 * 60_000),
      createdAt: now
    };
    const saved = await this.store.createActionConfirmation(confirmation);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'EVERYONE_ANNOUNCEMENT_PENDING_CONFIRMATION',
      entityType: 'ANNOUNCEMENT',
      originalInput: context.originalInput,
      executedPayload: { confirmationId: saved.publicId, groupId: input.groupId },
      outcome: 'PENDING_CONFIRMATION'
    });
    return saved;
  }

  public async requestTaskCancellation(
    task: Task,
    reason: string,
    context: TaskActionContext
  ): Promise<ActionConfirmation> {
    this.requireSuperAdmin(context.actor);
    const now = this.now();
    const id = newId();
    const confirmation: ActionConfirmation = {
      id,
      publicId: `MH-CONF-${id.slice(0, 8).toUpperCase()}`,
      requestedBy: context.actor.id,
      actionType: 'CANCEL_TASK',
      draft: { taskId: task.id, expectedVersion: task.version, reason },
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + 15 * 60_000),
      createdAt: now
    };
    const saved = await this.store.createActionConfirmation(confirmation);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'TASK_CANCELLATION_PENDING_CONFIRMATION',
      entityType: 'TASK',
      entityId: task.id,
      originalInput: context.originalInput,
      executedPayload: { confirmationId: saved.publicId, reason },
      outcome: 'PENDING_CONFIRMATION'
    });
    return saved;
  }

  public async confirm(
    idOrPublicId: string,
    context: TaskActionContext
  ): Promise<{ confirmation: ActionConfirmation; announcementId?: string; taskId?: string }> {
    this.requireSuperAdmin(context.actor);
    const confirmation = await this.store.confirmActionConfirmation(idOrPublicId, context.actor.id, this.now());
    if (!confirmation) {
      throw new AppError('CONFIRMATION_INVALID_OR_EXPIRED', 'That confirmation is not pending, belongs to another admin, or has expired.', 409);
    }
    if (confirmation.actionType === 'CANCEL_TASK') {
      const taskId = typeof confirmation.draft.taskId === 'string' ? confirmation.draft.taskId : undefined;
      const expectedVersion = Number(confirmation.draft.expectedVersion);
      const reason = typeof confirmation.draft.reason === 'string' ? confirmation.draft.reason : 'Cancelled by Super Admin.';
      if (!taskId || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw new AppError('INVALID_CONFIRMATION_DRAFT', 'The saved task cancellation is invalid.', 500);
      }
      await this.tasks.cancel(taskId, expectedVersion, reason, context);
      return { confirmation, taskId };
    }
    if (confirmation.actionType !== 'CREATE_EVERYONE_ANNOUNCEMENT') throw new AppError('UNKNOWN_CONFIRMATION_ACTION', 'This confirmation action is not supported.', 400);
    const input = this.toAnnouncementInput(confirmation.draft);
    const announcement = await this.announcements.create(input, context);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'EVERYONE_ANNOUNCEMENT_CONFIRMED',
      entityType: 'ANNOUNCEMENT',
      entityId: announcement.id,
      executedPayload: { confirmationId: confirmation.publicId },
      outcome: 'SUCCEEDED'
    });
    return { confirmation, announcementId: announcement.id };
  }

  public async cancel(idOrPublicId: string, context: TaskActionContext): Promise<ActionConfirmation> {
    this.requireSuperAdmin(context.actor);
    const confirmation = await this.store.cancelActionConfirmation(idOrPublicId, context.actor.id, this.now());
    if (!confirmation) {
      throw new AppError('CONFIRMATION_INVALID_OR_EXPIRED', 'That confirmation is not pending, belongs to another admin, or has expired.', 409);
    }
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'PENDING_ACTION_CANCELLED',
      entityType: confirmation.actionType === 'CANCEL_TASK' ? 'TASK' : 'ANNOUNCEMENT',
      executedPayload: { confirmationId: confirmation.publicId },
      outcome: 'SUCCEEDED'
    });
    return confirmation;
  }

  private toAnnouncementInput(draft: Record<string, unknown>): CreateAnnouncementInput {
    const value = draft as Partial<StoredAnnouncementDraft>;
    if (!value.groupId || !value.body || value.mentionStrategy !== 'EVERYONE') {
      throw new AppError('INVALID_CONFIRMATION_DRAFT', 'The saved announcement draft is invalid.', 500);
    }
    return {
      groupId: value.groupId,
      body: value.body,
      title: value.title,
      category: value.category,
      mentionStrategy: 'EVERYONE',
      interestTags: value.interestTags,
      publishAt: value.publishAt ? new Date(value.publishAt) : undefined,
      expiresAt: value.expiresAt ? new Date(value.expiresAt) : undefined,
      attachmentIds: value.attachmentIds,
      sourceMessageId: value.sourceMessageId
    };
  }

  private requireSuperAdmin(actor: User): void {
    if (actor.role !== 'SUPER_ADMIN' || !actor.active) throw forbidden();
  }
}
