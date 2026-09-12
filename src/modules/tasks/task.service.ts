import { AppError, forbidden, notFound } from '../../common/errors.js';
import { makePublicId, newId } from '../../common/ids.js';
import { nextRecurrenceAt } from '../../common/recurrence.js';
import type { JobScheduler, OperationsStore } from '../../domain/ports.js';
import type {
  CreateTaskInput,
  Group,
  ScheduledJob,
  Task,
  TaskAssignee,
  TaskRecurrence,
  TaskSubmission,
  TaskUpdate,
  UpdateTaskInput,
  User
} from '../../domain/types.js';
import { AuditService } from '../audit/audit.service.js';
import { CapabilityMatcherService } from '../team/capability-matcher.service.js';

export interface TaskActionContext {
  actor: User;
  correlationId: string;
  sourceMessageId?: string;
  originalInput?: string;
}

export interface SubmissionInput {
  taskId: string;
  submitter: User;
  note?: string;
  attachmentIds?: string[];
  sourceMessageId?: string;
  correlationId: string;
}

export class TaskService {
  private publicSequence = 0;

  public constructor(
    private readonly store: OperationsStore,
    private readonly scheduler: JobScheduler,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
    private readonly capabilityMatcher?: CapabilityMatcherService
  ) {}

  public async create(input: CreateTaskInput, context: TaskActionContext): Promise<Task> {
    this.requireSuperAdmin(context.actor);
    const assigneeIds = input.assigneeIds?.length
      ? input.assigneeIds
      : input.requiredCapability && this.capabilityMatcher
        ? (await this.capabilityMatcher.recommend(input.requiredCapability, 1)).map(({ user }) => user.id)
        : [];
    const [group, assignees] = await this.validateTaskReferences(input.groupId, assigneeIds);
    if (group.type !== 'OFFICIALS') {
      throw new AppError('INVALID_TASK_GROUP', 'Official tasks can only be posted to a configured officials group.', 400);
    }
    const now = this.now();
    if (input.publishAt && input.deadlineAt && input.deadlineAt <= input.publishAt) {
      throw new AppError('INVALID_SCHEDULE', 'The deadline must be after the assignment publish time.', 400);
    }
    if (input.deadlineAt && input.deadlineAt <= now) {
      throw new AppError('INVALID_SCHEDULE', 'The deadline must be in the future.', 400);
    }
    const id = newId();
    const task: Task = {
      id,
      publicId: this.nextPublicId('TASK', now),
      title: input.title.trim(),
      description: input.description.trim(),
      groupId: input.groupId,
      createdBy: context.actor.id,
      requiredCapability: input.requiredCapability?.trim(),
      sourceMessageId: input.sourceMessageId ?? context.sourceMessageId,
      sourceMessageText: input.sourceMessageText ?? context.originalInput,
      status: 'SCHEDULED',
      priority: input.priority ?? 'NORMAL',
      completionPolicy: input.completionPolicy ?? 'ALL_ASSIGNEES_SUBMIT',
      publishAt: input.publishAt ?? now,
      deadlineAt: input.deadlineAt,
      reminderOffsetsMinutes: this.normalizeReminderOffsets(input.reminderOffsetsMinutes),
      attachmentIds: input.attachmentIds ?? [],
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    const taskAssignees: TaskAssignee[] = assignees.map((user) => ({
      taskId: id,
      userId: user.id,
      status: 'PENDING'
    }));
    const created = await this.store.createTask(task, taskAssignees);
    await this.addUpdate(created.id, context.actor.id, 'TASK_CREATED', 'Task created and scheduled.', context.sourceMessageId);
    await this.scheduleLifecycle(created, input.recurrence, assignees.map((user) => user.id), group.timezone);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'TASK_CREATED',
      entityType: 'TASK',
      entityId: created.id,
      originalInput: context.originalInput,
      executedPayload: { publicId: created.publicId, publishAt: created.publishAt?.toISOString() },
      outcome: 'SUCCEEDED'
    });
    return created;
  }

  public async update(taskId: string, input: UpdateTaskInput, context: TaskActionContext): Promise<Task> {
    this.requireSuperAdmin(context.actor);
    const current = await this.store.getTask(taskId);
    if (!current) throw notFound('Task', taskId);
    if (current.status === 'CANCELLED' || current.status === 'COMPLETED') {
      throw new AppError('TASK_NOT_EDITABLE', 'Completed or cancelled tasks cannot be edited.', 409);
    }
    if (input.assigneeIds) {
      await this.validateTaskReferences(current.groupId, input.assigneeIds);
    }
    const next: Task = {
      ...current,
      title: input.title?.trim() ?? current.title,
      description: input.description?.trim() ?? current.description,
      priority: input.priority ?? current.priority,
      publishAt: input.publishAt ?? current.publishAt,
      deadlineAt: input.deadlineAt ?? current.deadlineAt,
      reminderOffsetsMinutes: input.reminderOffsetsMinutes
        ? this.normalizeReminderOffsets(input.reminderOffsetsMinutes)
        : current.reminderOffsetsMinutes,
      completionNotes: input.completionNotes ?? current.completionNotes
    };
    if (next.publishAt && next.deadlineAt && next.deadlineAt <= next.publishAt) {
      throw new AppError('INVALID_SCHEDULE', 'The deadline must be after the assignment publish time.', 400);
    }
    if (input.deadlineAt && input.deadlineAt <= this.now()) {
      throw new AppError('INVALID_SCHEDULE', 'The deadline must be in the future.', 400);
    }
    const recurrenceJob = (await this.store.listJobsForEntity('TASK', taskId)).find(
      (job) => job.jobType === 'TASK_RECURRENCE' && ['PENDING', 'PROCESSING'].includes(job.status)
    );
    const saved = await this.store.saveTask(next, input.expectedVersion);
    let currentAssigneeIds = (await this.store.listTaskAssignees(taskId)).map((assignee) => assignee.userId);
    if (input.assigneeIds) {
      const existing = new Map((await this.store.listTaskAssignees(taskId)).map((assignee) => [assignee.userId, assignee]));
      await this.store.replaceTaskAssignees(
        taskId,
        input.assigneeIds.map((userId) => existing.get(userId) ?? { taskId, userId, status: 'PENDING' })
      );
      currentAssigneeIds = [...new Set(input.assigneeIds)];
    }
    await this.store.cancelJobsForEntity('TASK', taskId);
    await this.scheduleLifecycle(saved);
    if (recurrenceJob) {
      const recurrence = recurrenceJob.payload.recurrence as TaskRecurrence | undefined;
      if (recurrence) {
        await this.createAndScheduleJob(saved, 'TASK_RECURRENCE', recurrenceJob.runAt, {
          recurrence,
          template: {
            title: saved.title,
            description: saved.description,
            groupId: saved.groupId,
            assigneeIds: currentAssigneeIds,
            priority: saved.priority,
            completionPolicy: saved.completionPolicy,
            createdBy: saved.createdBy,
            requiredCapability: saved.requiredCapability,
            sourceMessageText: saved.sourceMessageText
          }
        });
      }
    }
    await this.addUpdate(taskId, context.actor.id, 'TASK_UPDATED', 'Task details were updated.', context.sourceMessageId);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'TASK_UPDATED',
      entityType: 'TASK',
      entityId: taskId,
      originalInput: context.originalInput,
      executedPayload: { version: saved.version },
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async cancel(
    taskId: string,
    expectedVersion: number,
    reason: string,
    context: TaskActionContext
  ): Promise<Task> {
    this.requireSuperAdmin(context.actor);
    const current = await this.store.getTask(taskId);
    if (!current) throw notFound('Task', taskId);
    if (current.status === 'CANCELLED') return current;
    const now = this.now();
    const saved = await this.store.saveTask(
      { ...current, status: 'CANCELLED', cancelledAt: now, cancellationReason: reason.trim() },
      expectedVersion
    );
    await this.store.cancelJobsForEntity('TASK', taskId);
    await this.addUpdate(taskId, context.actor.id, 'TASK_CANCELLED', reason.trim(), context.sourceMessageId);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'TASK_CANCELLED',
      entityType: 'TASK',
      entityId: taskId,
      originalInput: context.originalInput,
      executedPayload: { reason: reason.trim() },
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async recordPublishReceipt(taskId: string, messageId: string, sentAt: Date): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw notFound('Task', taskId);
    if (task.status === 'CANCELLED' || task.publishedMessageId) return task;
    const saved = await this.store.saveTask(
      { ...task, status: 'ACTIVE', publishedAt: sentAt, publishedMessageId: messageId },
      task.version
    );
    await this.addUpdate(taskId, undefined, 'TASK_PUBLISHED', 'Assignment sent to officials group.');
    return saved;
  }

  public async acknowledge(taskId: string, actor: User, sourceMessageId: string | undefined, correlationId: string): Promise<TaskAssignee> {
    const assignment = await this.requireAssignee(taskId, actor);
    if (assignment.status === 'SUBMITTED' || assignment.status === 'COMPLETED') return assignment;
    const now = this.now();
    const saved = await this.store.saveTaskAssignee({
      ...assignment,
      status: 'ACKNOWLEDGED',
      acknowledgedAt: now
    });
    await this.addUpdate(taskId, actor.id, 'ASSIGNMENT_ACKNOWLEDGED', undefined, sourceMessageId);
    await this.audit.write({
      correlationId,
      actorUserId: actor.id,
      sourceMessageId,
      action: 'TASK_ACKNOWLEDGED',
      entityType: 'TASK',
      entityId: taskId,
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async recordBlocked(
    taskId: string,
    actor: User,
    reason: string,
    sourceMessageId: string | undefined,
    correlationId: string
  ): Promise<TaskAssignee> {
    const assignment = await this.requireAssignee(taskId, actor);
    const saved = await this.store.saveTaskAssignee({
      ...assignment,
      status: 'BLOCKED',
      blockedReason: reason.trim()
    });
    await this.addUpdate(taskId, actor.id, 'ASSIGNMENT_BLOCKED', reason.trim(), sourceMessageId);
    await this.audit.write({
      correlationId,
      actorUserId: actor.id,
      sourceMessageId,
      action: 'TASK_BLOCKED',
      entityType: 'TASK',
      entityId: taskId,
      executedPayload: { reason: reason.trim() },
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async recordProgress(
    taskId: string,
    actor: User,
    note: string | undefined,
    sourceMessageId: string | undefined,
    correlationId: string
  ): Promise<TaskAssignee> {
    const assignment = await this.requireAssignee(taskId, actor);
    if (['SUBMITTED', 'COMPLETED'].includes(assignment.status)) return assignment;
    const saved = await this.store.saveTaskAssignee({
      ...assignment,
      status: 'IN_PROGRESS',
      acknowledgedAt: assignment.acknowledgedAt ?? this.now(),
      blockedReason: undefined
    });
    await this.addUpdate(taskId, actor.id, 'ASSIGNMENT_PROGRESS', note?.trim(), sourceMessageId);
    await this.audit.write({
      correlationId,
      actorUserId: actor.id,
      sourceMessageId,
      action: 'TASK_PROGRESS_RECORDED',
      entityType: 'TASK',
      entityId: taskId,
      executedPayload: note ? { note: note.trim() } : undefined,
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async submit(input: SubmissionInput): Promise<{ task: Task; submission: TaskSubmission }> {
    const task = await this.store.getTask(input.taskId);
    if (!task) throw notFound('Task', input.taskId);
    if (task.status === 'CANCELLED') {
      throw new AppError('TASK_CANCELLED', 'This task has been cancelled, so I cannot record a submission.', 409);
    }
    const assignment = await this.requireAssignee(task.id, input.submitter);
    const now = this.now();
    const submission: TaskSubmission = {
      id: newId(),
      taskId: task.id,
      submitterUserId: input.submitter.id,
      note: input.note?.trim(),
      sourceMessageId: input.sourceMessageId,
      attachmentIds: input.attachmentIds ?? [],
      submittedAt: now
    };
    const recorded = await this.store.createSubmission(submission);
    await this.store.saveTaskAssignee({
      ...assignment,
      status: 'SUBMITTED',
      submittedAt: now,
      latestSubmissionId: recorded.id
    });
    await this.addUpdate(task.id, input.submitter.id, 'TASK_SUBMITTED', input.note?.trim(), input.sourceMessageId, {
      submissionId: recorded.id,
      attachmentCount: recorded.attachmentIds.length
    });
    const refreshedAssignments = await this.store.listTaskAssignees(task.id);
    const allSubmitted = refreshedAssignments.every((item) => ['SUBMITTED', 'COMPLETED'].includes(item.status));
    const next = allSubmitted && task.status !== 'OVERDUE' ? { ...task, status: 'SUBMITTED' as const } : task;
    const saved = next === task ? task : await this.store.saveTask(next, task.version);
    await this.audit.write({
      correlationId: input.correlationId,
      actorUserId: input.submitter.id,
      sourceMessageId: input.sourceMessageId,
      action: 'TASK_SUBMITTED',
      entityType: 'SUBMISSION',
      entityId: recorded.id,
      executedPayload: { taskId: task.id, attachmentCount: recorded.attachmentIds.length },
      outcome: 'SUCCEEDED'
    });
    return { task: saved, submission: recorded };
  }

  public async complete(
    taskId: string,
    expectedVersion: number,
    notes: string | undefined,
    context: TaskActionContext
  ): Promise<Task> {
    this.requireSuperAdmin(context.actor);
    const task = await this.store.getTask(taskId);
    if (!task) throw notFound('Task', taskId);
    if (task.status === 'CANCELLED') throw new AppError('TASK_CANCELLED', 'Cancelled tasks cannot be completed.', 409);
    const now = this.now();
    const assignments = await this.store.listTaskAssignees(taskId);
    for (const assignment of assignments) {
      if (assignment.status !== 'COMPLETED') {
        await this.store.saveTaskAssignee({ ...assignment, status: 'COMPLETED', completedAt: now });
      }
    }
    const saved = await this.store.saveTask(
      { ...task, status: 'COMPLETED', completedAt: now, completionNotes: notes?.trim() },
      expectedVersion
    );
    // Completing one occurrence must not silently cancel the next occurrence
    // of an established routine.
    await this.store.cancelJobsForEntity('TASK', taskId, { preserveTypes: ['TASK_RECURRENCE'] });
    await this.addUpdate(taskId, context.actor.id, 'TASK_COMPLETED', notes?.trim(), context.sourceMessageId);
    await this.audit.write({
      correlationId: context.correlationId,
      actorUserId: context.actor.id,
      sourceMessageId: context.sourceMessageId,
      action: 'TASK_COMPLETED',
      entityType: 'TASK',
      entityId: taskId,
      outcome: 'SUCCEEDED'
    });
    return saved;
  }

  public async markOverdue(taskId: string): Promise<{ task: Task; overdueAssignees: TaskAssignee[] }> {
    const task = await this.store.getTask(taskId);
    if (!task) throw notFound('Task', taskId);
    if (['CANCELLED', 'COMPLETED', 'SUBMITTED'].includes(task.status)) {
      return { task, overdueAssignees: [] };
    }
    const now = this.now();
    const assignments = await this.store.listTaskAssignees(taskId);
    const overdue = assignments.filter((item) => !['SUBMITTED', 'COMPLETED'].includes(item.status));
    for (const assignment of overdue) {
      await this.store.saveTaskAssignee({ ...assignment, status: 'OVERDUE', overdueAt: assignment.overdueAt ?? now });
    }
    if (overdue.length === 0) return { task, overdueAssignees: [] };
    const saved = await this.store.saveTask({ ...task, status: 'OVERDUE' }, task.version);
    await this.addUpdate(taskId, undefined, 'TASK_OVERDUE', 'Task deadline reached.');
    return { task: saved, overdueAssignees: overdue };
  }

  public async createRecurringInstance(job: ScheduledJob): Promise<Task> {
    const template = job.payload.template as {
      title?: unknown;
      description?: unknown;
      groupId?: unknown;
      assigneeIds?: unknown;
      priority?: unknown;
      completionPolicy?: unknown;
      createdBy?: unknown;
      requiredCapability?: unknown;
      sourceMessageText?: unknown;
    } | undefined;
    const recurrence = job.payload.recurrence as TaskRecurrence | undefined;
    if (!template || !recurrence || typeof template.createdBy !== 'string') {
      throw new AppError('INVALID_RECURRENCE_JOB', 'Recurring task data is incomplete.', 400);
    }
    const actor = await this.store.getUser(template.createdBy);
    if (!actor || actor.role !== 'SUPER_ADMIN' || !actor.active) {
      throw new AppError('INVALID_RECURRENCE_OWNER', 'The recurring task owner is no longer an active Super Admin.', 400);
    }
    if (
      typeof template.title !== 'string'
      || typeof template.description !== 'string'
      || typeof template.groupId !== 'string'
      || !Array.isArray(template.assigneeIds)
      || !template.assigneeIds.every((id) => typeof id === 'string')
    ) {
      throw new AppError('INVALID_RECURRENCE_JOB', 'Recurring task template is invalid.', 400);
    }
    const now = this.now();
    const publishAt = job.runAt > now ? job.runAt : now;
    return this.create({
      title: template.title,
      description: template.description,
      groupId: template.groupId,
      assigneeIds: template.assigneeIds as string[],
      requiredCapability: typeof template.requiredCapability === 'string' ? template.requiredCapability : undefined,
      priority: typeof template.priority === 'string' ? template.priority as Task['priority'] : 'NORMAL',
      completionPolicy: typeof template.completionPolicy === 'string'
        ? template.completionPolicy as Task['completionPolicy']
        : 'ALL_ASSIGNEES_SUBMIT',
      publishAt,
      deadlineAt: new Date(publishAt.getTime() + recurrence.deadlineOffsetMinutes * 60_000),
      recurrence,
      sourceMessageText: typeof template.sourceMessageText === 'string' ? template.sourceMessageText : undefined
    }, {
      actor,
      correlationId: job.id,
      originalInput: 'Automatically generated recurring task instance.'
    });
  }

  private async validateTaskReferences(groupId: string, assigneeIds: string[]): Promise<[Group, User[]]> {
    const group = await this.store.getGroup(groupId);
    if (!group || !group.active) {
      throw new AppError('UNKNOWN_GROUP', 'Choose an active configured group for this task.', 400);
    }
    const uniqueAssigneeIds = [...new Set(assigneeIds)];
    if (uniqueAssigneeIds.length === 0) {
      throw new AppError('TASK_REQUIRES_ASSIGNEE', 'Choose at least one active official.', 400);
    }
    const users = await Promise.all(uniqueAssigneeIds.map((id) => this.store.getUser(id)));
    const resolved: User[] = [];
    for (const user of users) {
      if (!user || !user.active || user.role !== 'OFFICIAL') {
        throw new AppError('INVALID_ASSIGNEE', 'Every assignee must be an active registered official.', 400);
      }
      const profile = await this.store.getOfficial(user.id);
      if (!profile?.active) {
        throw new AppError('INVALID_ASSIGNEE', 'Every assignee must have an active official profile.', 400);
      }
      resolved.push(user);
    }
    return [group, resolved];
  }

  private async requireAssignee(taskId: string, actor: User): Promise<TaskAssignee> {
    if (!actor.active) throw forbidden('Your account is inactive.');
    const assignment = await this.store.getTaskAssignee(taskId, actor.id);
    if (!assignment) throw forbidden('This task is not assigned to you.');
    return assignment;
  }

  private requireSuperAdmin(actor: User): void {
    if (actor.role !== 'SUPER_ADMIN' || !actor.active) {
      throw forbidden();
    }
  }

  private normalizeReminderOffsets(offsets?: number[]): number[] {
    const result = [...new Set(offsets ?? [1440, 360, 60, 0])]
      .filter((offset) => Number.isInteger(offset) && offset >= 0)
      .sort((a, b) => b - a);
    return result.length ? result : [0];
  }

  private nextPublicId(kind: 'TASK', now: Date): string {
    this.publicSequence = (this.publicSequence + 1) % 10_000;
    return makePublicId(kind, (now.getTime() % 1_000_000) + this.publicSequence, now);
  }

  private async scheduleLifecycle(
    task: Task,
    recurrence?: TaskRecurrence,
    assigneeIds: string[] = [],
    timeZone = 'Africa/Lagos'
  ): Promise<void> {
    const now = this.now();
    const publishAt = task.publishAt && task.publishAt > now ? task.publishAt : now;
    await this.createAndScheduleJob(task, 'TASK_PUBLISH', publishAt, {});
    if (!task.deadlineAt) return;
    for (const offset of task.reminderOffsetsMinutes.filter((minutes) => minutes > 0)) {
      const runAt = new Date(task.deadlineAt.getTime() - offset * 60_000);
      if (runAt > now) {
        await this.createAndScheduleJob(task, 'TASK_REMINDER', runAt, { minutesBefore: offset });
      }
    }
    await this.createAndScheduleJob(task, 'TASK_DEADLINE', task.deadlineAt, {});
    if (recurrence) {
      const nextRunAt = nextRecurrenceAt(recurrence, task.publishAt ?? now, timeZone);
      await this.createAndScheduleJob(task, 'TASK_RECURRENCE', nextRunAt, {
        recurrence,
        template: {
          title: task.title,
          description: task.description,
          groupId: task.groupId,
          assigneeIds,
          priority: task.priority,
          completionPolicy: task.completionPolicy,
          createdBy: task.createdBy,
          requiredCapability: task.requiredCapability,
          sourceMessageText: task.sourceMessageText
        }
      });
    }
  }

  private async createAndScheduleJob(
    task: Task,
    jobType: Extract<ScheduledJob['jobType'], 'TASK_PUBLISH' | 'TASK_REMINDER' | 'TASK_DEADLINE' | 'TASK_RECURRENCE'>,
    runAt: Date,
    payload: Record<string, unknown>
  ): Promise<void> {
    const suffix = jobType === 'TASK_REMINDER' ? `:${String(payload.minutesBefore)}` : '';
    const job: ScheduledJob = {
      id: newId(),
      jobKey: `task:${task.id}:v${task.version}:${jobType}${suffix}`,
      jobType,
      entityType: 'TASK',
      entityId: task.id,
      runAt,
      payload,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      createdAt: this.now(),
      updatedAt: this.now()
    };
    const durable = await this.store.createJob(job);
    if (durable.status === 'PENDING') {
      await this.scheduler.schedule(durable);
    }
  }

  private async addUpdate(
    taskId: string,
    actorUserId: string | undefined,
    updateType: string,
    body?: string,
    sourceMessageId?: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const update: TaskUpdate = {
      id: newId(),
      taskId,
      actorUserId,
      updateType,
      body,
      sourceMessageId,
      metadata,
      createdAt: this.now()
    };
    await this.store.addTaskUpdate(update);
  }
}
