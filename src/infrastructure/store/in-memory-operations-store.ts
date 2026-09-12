import { AppError } from '../../common/errors.js';
import type { AnnouncementListFilter, OperationsStore, TaskListFilter } from '../../domain/ports.js';
import type {
  Announcement,
  Attachment,
  ConversationMemory,
  ActionConfirmation,
  CalendarEvent,
  AuditLog,
  Group,
  GroupMember,
  OfficialProfile,
  OrganizationKnowledge,
  Opportunity,
  OpportunityCandidate,
  MemberActivity,
  MemberCheckin,
  PlanningRun,
  ScheduledJob,
  Task,
  TaskAssignee,
  TaskSubmission,
  TaskUpdate,
  User
} from '../../domain/types.js';

const copy = <T>(value: T): T => structuredClone(value);

const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * Development and test store. It intentionally implements the same operations
 * as the PostgreSQL store so services do not depend on a transport/database.
 */
export class InMemoryOperationsStore implements OperationsStore {
  private readonly users = new Map<string, User>();
  private readonly usersByJid = new Map<string, string>();
  private readonly officials = new Map<string, OfficialProfile>();
  private readonly groups = new Map<string, Group>();
  private readonly groupMembers = new Map<string, Map<string, GroupMember>>();
  private readonly processedMessages = new Set<string>();
  private readonly conversationMemory = new Map<string, ConversationMemory>();
  private readonly tasks = new Map<string, Task>();
  private readonly assignees = new Map<string, Map<string, TaskAssignee>>();
  private readonly taskUpdates = new Map<string, TaskUpdate[]>();
  private readonly submissions = new Map<string, TaskSubmission[]>();
  private readonly attachments = new Map<string, Attachment>();
  private readonly announcements = new Map<string, Announcement>();
  private readonly opportunities = new Map<string, Opportunity>();
  private readonly organizationKnowledge = new Map<string, OrganizationKnowledge>();
  private readonly opportunityCandidates = new Map<string, OpportunityCandidate>();
  private readonly memberActivity = new Map<string, MemberActivity>();
  private readonly memberCheckins = new Map<string, MemberCheckin>();
  private readonly planningRuns = new Map<string, PlanningRun>();
  private readonly calendarEvents = new Map<string, CalendarEvent>();
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly audits: AuditLog[] = [];
  private readonly confirmations = new Map<string, ActionConfirmation>();

  public async createUser(user: User): Promise<User> {
    if (this.users.has(user.id) || this.usersByJid.has(user.whatsappJid)) {
      throw new AppError('USER_ALREADY_EXISTS', 'A user with that WhatsApp identity already exists.', 409);
    }
    this.users.set(user.id, copy(user));
    this.usersByJid.set(user.whatsappJid, user.id);
    return copy(user);
  }

  public async saveUser(user: User): Promise<User> {
    const collision = this.usersByJid.get(user.whatsappJid);
    if (collision && collision !== user.id) throw new AppError('USER_ALREADY_EXISTS', 'A user with that WhatsApp identity already exists.', 409);
    const previous = this.users.get(user.id);
    if (previous && previous.whatsappJid !== user.whatsappJid) this.usersByJid.delete(previous.whatsappJid);
    this.users.set(user.id, copy(user));
    this.usersByJid.set(user.whatsappJid, user.id);
    return copy(user);
  }

  public async getUser(id: string): Promise<User | undefined> {
    const user = this.users.get(id);
    return user ? copy(user) : undefined;
  }

  public async findUserByJid(whatsappJid: string): Promise<User | undefined> {
    const id = this.usersByJid.get(whatsappJid);
    return id ? this.getUser(id) : undefined;
  }

  public async listUsers(): Promise<User[]> {
    return [...this.users.values()].map(copy);
  }

  public async saveOfficial(profile: OfficialProfile): Promise<OfficialProfile> {
    if (!this.users.has(profile.userId)) {
      throw new AppError('USER_NOT_FOUND', 'An official must reference an existing user.', 400);
    }
    this.officials.set(profile.userId, copy(profile));
    return copy(profile);
  }

  public async getOfficial(userId: string): Promise<OfficialProfile | undefined> {
    const profile = this.officials.get(userId);
    return profile ? copy(profile) : undefined;
  }

  public async findOfficialsByName(name: string): Promise<Array<{ user: User; profile: OfficialProfile }>> {
    const target = normalize(name);
    return [...this.officials.values()]
      .filter((profile) => normalize(profile.fullName) === target || normalize(profile.fullName).includes(target))
      .flatMap((profile) => {
        const user = this.users.get(profile.userId);
        return user ? [{ user: copy(user), profile: copy(profile) }] : [];
      });
  }

  public async listOfficials(): Promise<Array<{ user: User; profile: OfficialProfile }>> {
    return [...this.officials.values()].flatMap((profile) => {
      const user = this.users.get(profile.userId);
      return user ? [{ user: copy(user), profile: copy(profile) }] : [];
    });
  }

  public async saveGroup(group: Group): Promise<Group> {
    const jidCollision = [...this.groups.values()].some(
      (existing) => existing.whatsappJid === group.whatsappJid && existing.id !== group.id
    );
    if (jidCollision) {
      throw new AppError('GROUP_ALREADY_EXISTS', 'A group with that WhatsApp identity already exists.', 409);
    }
    this.groups.set(group.id, copy(group));
    return copy(group);
  }

  public async getGroup(id: string): Promise<Group | undefined> {
    const group = this.groups.get(id);
    return group ? copy(group) : undefined;
  }

  public async findGroupsByName(name: string): Promise<Group[]> {
    const target = normalize(name);
    return [...this.groups.values()]
      .filter((group) => normalize(group.name) === target || normalize(group.name).includes(target))
      .map(copy);
  }

  public async listGroups(): Promise<Group[]> {
    return [...this.groups.values()].map(copy);
  }

  public async replaceGroupMembers(groupId: string, members: GroupMember[]): Promise<void> {
    if (!this.groups.has(groupId)) {
      throw new AppError('GROUP_NOT_FOUND', 'The group does not exist.', 404);
    }
    const byUser = new Map<string, GroupMember>();
    for (const member of members) {
      if (member.groupId !== groupId || !this.users.has(member.userId)) {
        throw new AppError('INVALID_GROUP_MEMBER', 'Group members must refer to an existing user and group.', 400);
      }
      byUser.set(member.userId, copy(member));
    }
    this.groupMembers.set(groupId, byUser);
  }

  public async listGroupMembers(groupId: string): Promise<GroupMember[]> {
    return [...(this.groupMembers.get(groupId)?.values() ?? [])].map(copy);
  }

  public async markMessageProcessed(messageId: string): Promise<boolean> {
    if (this.processedMessages.has(messageId)) {
      return false;
    }
    this.processedMessages.add(messageId);
    return true;
  }

  public async getConversationMemory(scopeKey: string, now: Date): Promise<ConversationMemory | undefined> {
    const memory = this.conversationMemory.get(scopeKey);
    if (!memory) return undefined;
    if (memory.expiresAt <= now) {
      this.conversationMemory.delete(scopeKey);
      return undefined;
    }
    return copy(memory);
  }

  public async saveConversationMemory(memory: ConversationMemory): Promise<ConversationMemory> {
    this.conversationMemory.set(memory.scopeKey, copy(memory));
    return copy(memory);
  }

  public async deleteConversationMemory(scopeKey: string): Promise<void> {
    this.conversationMemory.delete(scopeKey);
  }

  public async createTask(task: Task, assignees: TaskAssignee[]): Promise<Task> {
    if (this.tasks.has(task.id) || [...this.tasks.values()].some((item) => item.publicId === task.publicId)) {
      throw new AppError('TASK_ALREADY_EXISTS', 'A task with that identifier already exists.', 409);
    }
    if (!this.groups.has(task.groupId) || !this.users.has(task.createdBy)) {
      throw new AppError('INVALID_TASK_REFERENCE', 'Task group or creator does not exist.', 400);
    }
    const members = new Map<string, TaskAssignee>();
    for (const assignee of assignees) {
      if (assignee.taskId !== task.id || !this.users.has(assignee.userId)) {
        throw new AppError('INVALID_ASSIGNEE', 'Task assignees must reference existing users.', 400);
      }
      members.set(assignee.userId, copy(assignee));
    }
    if (members.size === 0) {
      throw new AppError('TASK_REQUIRES_ASSIGNEE', 'A task needs at least one assignee.', 400);
    }
    this.tasks.set(task.id, copy({ ...task, attachmentIds: [...(task.attachmentIds ?? [])] }));
    this.assignees.set(task.id, members);
    this.taskUpdates.set(task.id, []);
    this.submissions.set(task.id, []);
    return copy(task);
  }

  public async getTask(id: string): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return copy({ ...task, attachmentIds: [...task.attachmentIds] });
  }

  public async listTaskAttachmentIds(taskId: string): Promise<string[]> {
    return [...(this.tasks.get(taskId)?.attachmentIds ?? [])];
  }

  public async findTaskByPublishedMessageId(messageId: string): Promise<Task | undefined> {
    const task = [...this.tasks.values()].find((item) => item.publishedMessageId === messageId);
    return task ? copy(task) : undefined;
  }

  public async listTasks(filter?: TaskListFilter): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((task) => {
        if (filter?.status && task.status !== filter.status) return false;
        if (filter?.groupId && task.groupId !== filter.groupId) return false;
        if (filter?.assigneeUserId && !this.assignees.get(task.id)?.has(filter.assigneeUserId)) return false;
        if (filter?.dueFrom && (!task.deadlineAt || task.deadlineAt < filter.dueFrom)) return false;
        if (filter?.dueTo && (!task.deadlineAt || task.deadlineAt > filter.dueTo)) return false;
        return true;
      })
      .sort((a, b) => (a.deadlineAt?.getTime() ?? Infinity) - (b.deadlineAt?.getTime() ?? Infinity))
      .map(copy);
  }

  public async saveTask(task: Task, expectedVersion: number): Promise<Task> {
    const current = this.tasks.get(task.id);
    if (!current) {
      throw new AppError('TASK_NOT_FOUND', 'The task does not exist.', 404);
    }
    if (current.version !== expectedVersion) {
      throw new AppError('TASK_VERSION_CONFLICT', 'This task changed before your update could be saved.', 409, {
        expectedVersion,
        currentVersion: current.version
      });
    }
    const saved: Task = { ...copy(task), version: expectedVersion + 1, updatedAt: new Date() };
    this.tasks.set(task.id, saved);
    return copy(saved);
  }

  public async listTaskAssignees(taskId: string): Promise<TaskAssignee[]> {
    return [...(this.assignees.get(taskId)?.values() ?? [])].map(copy);
  }

  public async listTaskAssigneesForTasks(taskIds: string[]): Promise<TaskAssignee[]> {
    return taskIds.flatMap((taskId) => [...(this.assignees.get(taskId)?.values() ?? [])].map(copy));
  }

  public async getTaskAssignee(taskId: string, userId: string): Promise<TaskAssignee | undefined> {
    const assignee = this.assignees.get(taskId)?.get(userId);
    return assignee ? copy(assignee) : undefined;
  }

  public async saveTaskAssignee(assignee: TaskAssignee): Promise<TaskAssignee> {
    const existing = this.assignees.get(assignee.taskId);
    if (!existing?.has(assignee.userId)) {
      throw new AppError('ASSIGNMENT_NOT_FOUND', 'The task assignment does not exist.', 404);
    }
    existing.set(assignee.userId, copy(assignee));
    return copy(assignee);
  }

  public async replaceTaskAssignees(taskId: string, assignees: TaskAssignee[]): Promise<void> {
    if (!this.tasks.has(taskId)) {
      throw new AppError('TASK_NOT_FOUND', 'The task does not exist.', 404);
    }
    if (assignees.length === 0) {
      throw new AppError('TASK_REQUIRES_ASSIGNEE', 'A task needs at least one assignee.', 400);
    }
    const target = new Map<string, TaskAssignee>();
    for (const assignee of assignees) {
      if (assignee.taskId !== taskId || !this.users.has(assignee.userId)) {
        throw new AppError('INVALID_ASSIGNEE', 'Task assignees must reference existing users.', 400);
      }
      target.set(assignee.userId, copy(assignee));
    }
    this.assignees.set(taskId, target);
  }

  public async addTaskUpdate(update: TaskUpdate): Promise<TaskUpdate> {
    if (!this.tasks.has(update.taskId)) {
      throw new AppError('TASK_NOT_FOUND', 'The task does not exist.', 404);
    }
    const updates = this.taskUpdates.get(update.taskId) ?? [];
    updates.push(copy(update));
    this.taskUpdates.set(update.taskId, updates);
    return copy(update);
  }

  public async listTaskUpdates(taskId: string): Promise<TaskUpdate[]> {
    return (this.taskUpdates.get(taskId) ?? []).map(copy);
  }

  public async createSubmission(submission: TaskSubmission): Promise<TaskSubmission> {
    const existing = this.submissions.get(submission.taskId);
    if (!existing) {
      throw new AppError('TASK_NOT_FOUND', 'The task does not exist.', 404);
    }
    if (submission.sourceMessageId && existing.some((item) => item.sourceMessageId === submission.sourceMessageId)) {
      throw new AppError('SUBMISSION_ALREADY_RECORDED', 'That message was already recorded as a submission.', 409);
    }
    existing.push(copy(submission));
    return copy(submission);
  }

  public async listTaskSubmissions(taskId: string): Promise<TaskSubmission[]> {
    return (this.submissions.get(taskId) ?? []).map(copy);
  }

  public async createAttachment(attachment: Attachment): Promise<Attachment> {
    if (this.attachments.has(attachment.id)) {
      throw new AppError('ATTACHMENT_ALREADY_EXISTS', 'Attachment already exists.', 409);
    }
    this.attachments.set(attachment.id, copy(attachment));
    return copy(attachment);
  }

  public async getAttachment(id: string): Promise<Attachment | undefined> {
    const attachment = this.attachments.get(id);
    return attachment ? copy(attachment) : undefined;
  }

  public async createAnnouncement(announcement: Announcement): Promise<Announcement> {
    if (this.announcements.has(announcement.id) || [...this.announcements.values()].some((item) => item.publicId === announcement.publicId)) {
      throw new AppError('ANNOUNCEMENT_ALREADY_EXISTS', 'An announcement with that identifier already exists.', 409);
    }
    if (!this.groups.has(announcement.groupId) || !this.users.has(announcement.createdBy)) {
      throw new AppError('INVALID_ANNOUNCEMENT_REFERENCE', 'Announcement group or creator does not exist.', 400);
    }
    this.announcements.set(announcement.id, copy(announcement));
    return copy(announcement);
  }

  public async getAnnouncement(id: string): Promise<Announcement | undefined> {
    const announcement = this.announcements.get(id);
    return announcement ? copy(announcement) : undefined;
  }

  public async listAnnouncements(filter?: AnnouncementListFilter): Promise<Announcement[]> {
    return [...this.announcements.values()]
      .filter((announcement) => {
        if (filter?.status && announcement.status !== filter.status) return false;
        if (filter?.groupId && announcement.groupId !== filter.groupId) return false;
        return true;
      })
      .sort((a, b) => (a.publishAt?.getTime() ?? Infinity) - (b.publishAt?.getTime() ?? Infinity))
      .map(copy);
  }

  public async saveAnnouncement(announcement: Announcement, expectedVersion: number): Promise<Announcement> {
    const current = this.announcements.get(announcement.id);
    if (!current) {
      throw new AppError('ANNOUNCEMENT_NOT_FOUND', 'The announcement does not exist.', 404);
    }
    if (current.version !== expectedVersion) {
      throw new AppError('ANNOUNCEMENT_VERSION_CONFLICT', 'This announcement changed before your update could be saved.', 409, {
        expectedVersion,
        currentVersion: current.version
      });
    }
    const saved: Announcement = { ...copy(announcement), version: expectedVersion + 1, updatedAt: new Date() };
    this.announcements.set(announcement.id, saved);
    return copy(saved);
  }

  public async saveOpportunity(opportunity: Opportunity): Promise<Opportunity> {
    this.opportunities.set(opportunity.id, copy(opportunity));
    return copy(opportunity);
  }

  public async saveOrganizationKnowledge(item: OrganizationKnowledge): Promise<OrganizationKnowledge> {
    this.organizationKnowledge.set(item.id, copy(item));
    return copy(item);
  }

  public async searchOrganizationKnowledge(query: string, limit = 5): Promise<OrganizationKnowledge[]> {
    const words = normalize(query).split(/[^a-z0-9]+/).filter((word) => word.length > 2);
    return [...this.organizationKnowledge.values()]
      .filter((item) => item.active)
      .map((item) => ({ item, score: words.filter((word) => normalize(`${item.title} ${item.content} ${item.tags.join(' ')}`).includes(word)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt.getTime() - a.item.updatedAt.getTime())
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map(({ item }) => copy(item));
  }

  public async listActiveOpportunities(query?: string): Promise<Opportunity[]> {
    const normalizedQuery = query ? normalize(query) : undefined;
    return [...this.opportunities.values()]
      .filter((opportunity) => {
        if (!opportunity.active || (opportunity.deadlineAt && opportunity.deadlineAt < new Date())) return false;
        if (!normalizedQuery) return true;
        return normalize(`${opportunity.title} ${opportunity.category} ${opportunity.summary}`).includes(normalizedQuery);
      })
      .map(copy);
  }

  public async saveOpportunityCandidate(candidate: OpportunityCandidate): Promise<OpportunityCandidate> {
    this.opportunityCandidates.set(candidate.sourceUrl, copy(candidate));
    return copy(candidate);
  }

  public async listOpportunityCandidates(minScore = 0): Promise<OpportunityCandidate[]> {
    return [...this.opportunityCandidates.values()]
      .filter((candidate) => candidate.totalScore >= minScore && candidate.status !== 'IGNORED')
      .sort((left, right) => right.totalScore - left.totalScore)
      .map(copy);
  }

  public async recordMemberActivity(activity: MemberActivity): Promise<MemberActivity> {
    const key = `${activity.userId}:${activity.groupId}:${activity.periodStart.toISOString()}`;
    this.memberActivity.set(key, copy(activity));
    return copy(activity);
  }

  public async listMemberActivity(groupId?: string, since?: Date): Promise<MemberActivity[]> {
    return [...this.memberActivity.values()]
      .filter((activity) => (!groupId || activity.groupId === groupId) && (!since || activity.periodEnd >= since))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .map(copy);
  }

  public async saveMemberCheckin(checkin: MemberCheckin): Promise<MemberCheckin> {
    this.memberCheckins.set(checkin.id, copy(checkin));
    return copy(checkin);
  }

  public async listMemberCheckins(userId?: string, since?: Date): Promise<MemberCheckin[]> {
    return [...this.memberCheckins.values()]
      .filter((checkin) => (!userId || checkin.userId === userId) && (!since || checkin.createdAt >= since))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(copy);
  }

  public async savePlanningRun(run: PlanningRun): Promise<PlanningRun> {
    this.planningRuns.set(run.id, copy(run));
    return copy(run);
  }

  public async listPlanningRuns(since?: Date): Promise<PlanningRun[]> {
    return [...this.planningRuns.values()]
      .filter((run) => !since || run.runAt >= since)
      .sort((left, right) => right.runAt.getTime() - left.runAt.getTime())
      .map(copy);
  }

  public async saveCalendarEvent(event: CalendarEvent): Promise<CalendarEvent> {
    this.calendarEvents.set(event.id, copy(event));
    return copy(event);
  }

  public async getCalendarEvent(id: string): Promise<CalendarEvent | undefined> {
    const event = this.calendarEvents.get(id);
    return event ? copy(event) : undefined;
  }

  public async listCalendarEvents(from?: Date, to?: Date): Promise<CalendarEvent[]> {
    return [...this.calendarEvents.values()]
      .filter((event) => (!from || event.startsAt >= from) && (!to || event.startsAt <= to))
      .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())
      .map(copy);
  }

  public async createJob(job: ScheduledJob): Promise<ScheduledJob> {
    const existing = this.jobs.get(job.jobKey);
    if (existing) {
      return copy(existing);
    }
    this.jobs.set(job.jobKey, copy(job));
    return copy(job);
  }

  public async getJobByKey(jobKey: string): Promise<ScheduledJob | undefined> {
    const job = this.jobs.get(jobKey);
    return job ? copy(job) : undefined;
  }

  public async listJobsForEntity(entityType: ScheduledJob['entityType'], entityId: string): Promise<ScheduledJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.entityType === entityType && job.entityId === entityId)
      .sort((left, right) => left.runAt.getTime() - right.runAt.getTime())
      .map(copy);
  }

  public async claimJob(jobKey: string, now: Date): Promise<ScheduledJob | undefined> {
    const current = this.jobs.get(jobKey);
    if (!current || current.status !== 'PENDING' || current.runAt > now) {
      return undefined;
    }
    const claimed: ScheduledJob = {
      ...current,
      status: 'PROCESSING',
      attempts: current.attempts + 1,
      updatedAt: now
    };
    this.jobs.set(jobKey, claimed);
    return copy(claimed);
  }

  public async listDueJobs(now: Date): Promise<ScheduledJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === 'PENDING' && job.runAt <= now)
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .map(copy);
  }

  public async listFailedJobs(since: Date): Promise<ScheduledJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === 'FAILED' && job.updatedAt >= since)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(copy);
  }

  public async recoverStaleJobs(staleBefore: Date, now: Date): Promise<number> {
    let recovered = 0;
    for (const [key, job] of this.jobs) {
      if (job.status !== 'PROCESSING' || job.updatedAt > staleBefore) continue;
      const canRetry = job.attempts < job.maxAttempts;
      this.jobs.set(key, {
        ...job,
        status: canRetry ? 'PENDING' : 'FAILED',
        runAt: canRetry ? now : job.runAt,
        lastError: 'Recovered after an interrupted worker process.',
        updatedAt: now
      });
      recovered += 1;
    }
    return recovered;
  }

  public async completeJob(jobKey: string, completedAt: Date): Promise<void> {
    const current = this.jobs.get(jobKey);
    if (!current) return;
    this.jobs.set(jobKey, { ...current, status: 'SUCCEEDED', completedAt, updatedAt: completedAt });
  }

  public async failJob(jobKey: string, error: string, retryAt?: Date): Promise<void> {
    const current = this.jobs.get(jobKey);
    if (!current) return;
    const willRetry = current.attempts < current.maxAttempts && retryAt;
    this.jobs.set(jobKey, {
      ...current,
      status: willRetry ? 'PENDING' : 'FAILED',
      runAt: willRetry ? retryAt : current.runAt,
      lastError: error,
      updatedAt: new Date()
    });
  }

  public async cancelJobsForEntity(
    entityType: ScheduledJob['entityType'],
    entityId: string,
    options: { preserveTypes?: ScheduledJob['jobType'][] } = {}
  ): Promise<void> {
    const preserve = new Set(options.preserveTypes ?? []);
    for (const [key, job] of this.jobs) {
      if (job.entityType === entityType && job.entityId === entityId && !preserve.has(job.jobType) && ['PENDING', 'PROCESSING'].includes(job.status)) {
        this.jobs.set(key, { ...job, status: 'CANCELLED', updatedAt: new Date() });
      }
    }
  }

  public async addAuditLog(log: AuditLog): Promise<AuditLog> {
    this.audits.push(copy(log));
    return copy(log);
  }

  public async listAuditLogs(entityType?: AuditLog['entityType'], entityId?: string): Promise<AuditLog[]> {
    return this.audits
      .filter((log) => (!entityType || log.entityType === entityType) && (!entityId || log.entityId === entityId))
      .map(copy);
  }

  public async createActionConfirmation(confirmation: ActionConfirmation): Promise<ActionConfirmation> {
    if (this.confirmations.has(confirmation.id) || [...this.confirmations.values()].some((item) => item.publicId === confirmation.publicId)) {
      throw new AppError('CONFIRMATION_ALREADY_EXISTS', 'A confirmation with that identifier already exists.', 409);
    }
    this.confirmations.set(confirmation.id, copy(confirmation));
    return copy(confirmation);
  }

  public async getActionConfirmation(idOrPublicId: string): Promise<ActionConfirmation | undefined> {
    const direct = this.confirmations.get(idOrPublicId);
    if (direct) return copy(direct);
    const found = [...this.confirmations.values()].find((item) => item.publicId === idOrPublicId);
    return found ? copy(found) : undefined;
  }

  public async confirmActionConfirmation(idOrPublicId: string, requestedBy: string, now: Date): Promise<ActionConfirmation | undefined> {
    const found = await this.getActionConfirmation(idOrPublicId);
    if (!found) return undefined;
    if (found.status === 'PENDING' && found.expiresAt <= now) {
      this.confirmations.set(found.id, { ...found, status: 'EXPIRED' });
      return undefined;
    }
    if (found.requestedBy !== requestedBy || found.status !== 'PENDING') return undefined;
    const saved: ActionConfirmation = { ...found, status: 'CONFIRMED', confirmedAt: now };
    this.confirmations.set(saved.id, saved);
    return copy(saved);
  }

  public async cancelActionConfirmation(idOrPublicId: string, requestedBy: string, now: Date): Promise<ActionConfirmation | undefined> {
    const found = await this.getActionConfirmation(idOrPublicId);
    if (!found) return undefined;
    if (found.status === 'PENDING' && found.expiresAt <= now) {
      this.confirmations.set(found.id, { ...found, status: 'EXPIRED' });
      return undefined;
    }
    if (found.requestedBy !== requestedBy || found.status !== 'PENDING') return undefined;
    const saved: ActionConfirmation = { ...found, status: 'CANCELLED', cancelledAt: now };
    this.confirmations.set(saved.id, saved);
    return copy(saved);
  }

}
