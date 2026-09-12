import { Pool, type PoolClient } from 'pg';
import { AppError } from '../../common/errors.js';
import type { AnnouncementListFilter, OperationsStore, TaskListFilter } from '../../domain/ports.js';
import type {
  Announcement,
  AnnouncementStatus,
  ActionConfirmation,
  CalendarEvent,
  AssignmentStatus,
  Attachment,
  AuditLog,
  ConversationMemory,
  Group,
  GroupMember,
  GroupType,
  JobStatus,
  JobType,
  MentionStrategy,
  OfficialProfile,
  OrganizationKnowledge,
  Opportunity,
  OpportunityCandidate,
  MemberActivity,
  MemberCheckin,
  PlanningRun,
  PriorityLevel,
  ScheduledJob,
  Task,
  TaskAssignee,
  TaskStatus,
  TaskSubmission,
  TaskUpdate,
  User,
  UserRole
} from '../../domain/types.js';

type Row = Record<string, unknown>;

const asDate = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));
const optionalDate = (value: unknown): Date | undefined => value === null || value === undefined ? undefined : asDate(value);
const asTextArray = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const asNumberArray = (value: unknown): number[] => Array.isArray(value) ? value.map(Number) : [];
const asRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
};
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (token) => `\\${token}`);

const mapUser = (row: Row): User => ({
  id: String(row.id),
  whatsappJid: String(row.whatsapp_jid),
  phoneE164: row.phone_e164 ? String(row.phone_e164) : undefined,
  displayName: row.display_name ? String(row.display_name) : undefined,
  interestTags: asTextArray(row.interest_tags),
  role: String(row.role) as UserRole,
  active: Boolean(row.active),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapOfficial = (row: Row): OfficialProfile => ({
  userId: String(row.user_id),
  fullName: String(row.full_name),
  jobRole: row.job_role ? String(row.job_role) : undefined,
  department: row.department ? String(row.department) : undefined,
  capabilities: asTextArray(row.capabilities),
  active: Boolean(row.active),
  interestTags: asTextArray(row.interest_tags)
});

const mapGroup = (row: Row): Group => ({
  id: String(row.id),
  whatsappJid: String(row.whatsapp_jid),
  name: String(row.name),
  type: String(row.type) as GroupType,
  active: Boolean(row.active),
  timezone: String(row.timezone),
  mentionAllMaxParticipants: Number(row.mention_all_max_participants),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapMember = (row: Row): GroupMember => ({
  groupId: String(row.group_id),
  userId: String(row.user_id),
  isAdmin: Boolean(row.is_admin),
  active: Boolean(row.active),
  lastSyncedAt: asDate(row.last_synced_at)
});

const mapConversationMemory = (row: Row): ConversationMemory => {
  let rawTurns: unknown = row.turns;
  if (typeof rawTurns === 'string') {
    try { rawTurns = JSON.parse(rawTurns); } catch { rawTurns = []; }
  }
  const turns = Array.isArray(rawTurns)
    ? rawTurns.flatMap((turn) => {
      if (!turn || typeof turn !== 'object') return [];
      const value = turn as Record<string, unknown>;
      if (!['user', 'assistant'].includes(String(value.role)) || typeof value.content !== 'string') return [];
      return [{
        role: String(value.role) as 'user' | 'assistant',
        content: value.content,
        createdAt: asDate(value.createdAt ?? value.created_at)
      }];
    })
    : [];
  return {
    id: String(row.id),
    scopeKey: String(row.scope_key),
    userId: row.user_id ? String(row.user_id) : undefined,
    groupId: row.group_id ? String(row.group_id) : undefined,
    turns,
    expiresAt: asDate(row.expires_at),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at)
  };
};

const mapTask = (row: Row): Task => ({
  id: String(row.id),
  publicId: String(row.public_id),
  title: String(row.title),
  description: String(row.description),
  groupId: String(row.group_id),
  createdBy: String(row.created_by),
  requiredCapability: row.required_capability ? String(row.required_capability) : undefined,
  sourceMessageId: row.source_message_id ? String(row.source_message_id) : undefined,
  sourceMessageText: row.source_message_text ? String(row.source_message_text) : undefined,
  status: String(row.status) as TaskStatus,
  priority: String(row.priority) as PriorityLevel,
  completionPolicy: String(row.completion_policy) as Task['completionPolicy'],
  publishAt: optionalDate(row.publish_at),
  publishedAt: optionalDate(row.published_at),
  publishedMessageId: row.published_message_id ? String(row.published_message_id) : undefined,
  deadlineAt: optionalDate(row.deadline_at),
  reminderOffsetsMinutes: asNumberArray(row.reminder_offsets_minutes),
  attachmentIds: asTextArray(row.attachment_ids),
  completionNotes: row.completion_notes ? String(row.completion_notes) : undefined,
  completedAt: optionalDate(row.completed_at),
  cancelledAt: optionalDate(row.cancelled_at),
  cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : undefined,
  version: Number(row.version),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapAssignee = (row: Row): TaskAssignee => ({
  taskId: String(row.task_id),
  userId: String(row.user_id),
  status: String(row.status) as AssignmentStatus,
  acknowledgedAt: optionalDate(row.acknowledged_at),
  submittedAt: optionalDate(row.submitted_at),
  completedAt: optionalDate(row.completed_at),
  overdueAt: optionalDate(row.overdue_at),
  blockedReason: row.blocked_reason ? String(row.blocked_reason) : undefined,
  latestSubmissionId: row.latest_submission_id ? String(row.latest_submission_id) : undefined
});

const mapTaskUpdate = (row: Row): TaskUpdate => ({
  id: String(row.id),
  taskId: String(row.task_id),
  actorUserId: row.actor_user_id ? String(row.actor_user_id) : undefined,
  updateType: String(row.update_type),
  body: row.body ? String(row.body) : undefined,
  sourceMessageId: row.source_message_id ? String(row.source_message_id) : undefined,
  metadata: asRecord(row.metadata),
  createdAt: asDate(row.created_at)
});

const mapAttachment = (row: Row): Attachment => ({
  id: String(row.id),
  storageKey: row.storage_key ? String(row.storage_key) : undefined,
  sourceUrl: row.source_url ? String(row.source_url) : undefined,
  kind: String(row.kind) as Attachment['kind'],
  mimeType: row.mime_type ? String(row.mime_type) : undefined,
  fileName: row.file_name ? String(row.file_name) : undefined,
  sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? undefined : Number(row.size_bytes),
  sha256: row.sha256 ? String(row.sha256) : undefined,
  uploadedBy: row.uploaded_by ? String(row.uploaded_by) : undefined,
  createdAt: asDate(row.created_at)
});

const mapSubmission = (row: Row, attachmentIds: string[] = []): TaskSubmission => ({
  id: String(row.id),
  taskId: String(row.task_id),
  submitterUserId: String(row.submitter_user_id),
  note: row.note ? String(row.note) : undefined,
  sourceMessageId: row.source_message_id ? String(row.source_message_id) : undefined,
  attachmentIds,
  submittedAt: asDate(row.submitted_at)
});

const mapAnnouncement = (row: Row, attachmentIds: string[] = []): Announcement => ({
  id: String(row.id),
  publicId: String(row.public_id),
  groupId: String(row.group_id),
  createdBy: String(row.created_by),
  sourceMessageId: row.source_message_id ? String(row.source_message_id) : undefined,
  category: row.category ? String(row.category) : undefined,
  title: row.title ? String(row.title) : undefined,
  body: String(row.body),
  mentionStrategy: String(row.mention_strategy) as MentionStrategy,
  interestTags: asTextArray(row.interest_tags),
  status: String(row.status) as AnnouncementStatus,
  publishAt: optionalDate(row.publish_at),
  publishedAt: optionalDate(row.published_at),
  publishedMessageId: row.published_message_id ? String(row.published_message_id) : undefined,
  expiresAt: optionalDate(row.expires_at),
  attachmentIds,
  failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
  version: Number(row.version),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapOpportunity = (row: Row): Opportunity => ({
  id: String(row.id),
  announcementId: row.announcement_id ? String(row.announcement_id) : undefined,
  title: String(row.title),
  category: String(row.category),
  summary: String(row.summary),
  eligibility: row.eligibility ? String(row.eligibility) : undefined,
  applicationUrl: row.application_url ? String(row.application_url) : undefined,
  deadlineAt: optionalDate(row.deadline_at),
  sourceName: row.source_name ? String(row.source_name) : undefined,
  sourceUrl: row.source_url ? String(row.source_url) : undefined,
  active: Boolean(row.active),
  createdBy: String(row.created_by),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapOpportunityCandidate = (row: Row): OpportunityCandidate => ({
  id: String(row.id),
  sourceName: String(row.source_name),
  sourceUrl: String(row.source_url),
  title: String(row.title),
  summary: String(row.summary),
  category: String(row.category),
  eligibility: row.eligibility ? String(row.eligibility) : undefined,
  deadlineAt: optionalDate(row.deadline_at),
  musicRelevance: Number(row.music_relevance),
  regionalRelevance: Number(row.regional_relevance),
  youthRelevance: Number(row.youth_relevance),
  supportValue: Number(row.support_value),
  sourceCredibility: Number(row.source_credibility),
  deadlineViability: Number(row.deadline_viability),
  totalScore: Number(row.total_score),
  status: String(row.status) as OpportunityCandidate['status'],
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapMemberActivity = (row: Row): MemberActivity => ({
  id: String(row.id),
  userId: String(row.user_id),
  groupId: String(row.group_id),
  messageCount: Number(row.message_count),
  lastMessageAt: optionalDate(row.last_message_at),
  lastMeaningfulAt: optionalDate(row.last_meaningful_at),
  periodStart: asDate(row.period_start),
  periodEnd: asDate(row.period_end),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapMemberCheckin = (row: Row): MemberCheckin => ({
  id: String(row.id),
  userId: String(row.user_id),
  groupId: String(row.group_id),
  message: String(row.message),
  status: String(row.status) as MemberCheckin['status'],
  createdAt: asDate(row.created_at),
  sentAt: optionalDate(row.sent_at)
});

const mapPlanningRun = (row: Row): PlanningRun => ({
  id: String(row.id),
  runAt: asDate(row.run_at),
  status: String(row.status) as PlanningRun['status'],
  summary: String(row.summary),
  createdAt: asDate(row.created_at)
});

const mapCalendarEvent = (row: Row): CalendarEvent => ({
  id: String(row.id),
  externalId: row.external_id ? String(row.external_id) : undefined,
  title: String(row.title),
  description: row.description ? String(row.description) : undefined,
  startsAt: asDate(row.starts_at),
  endsAt: optionalDate(row.ends_at),
  timezone: String(row.timezone),
  source: String(row.source) as CalendarEvent['source'],
  relevanceScore: Number(row.relevance_score),
  preparationStage: String(row.preparation_stage) as CalendarEvent['preparationStage'],
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapJob = (row: Row): ScheduledJob => ({
  id: String(row.id),
  jobKey: String(row.job_key),
  jobType: String(row.job_type) as JobType,
  entityType: String(row.entity_type) as ScheduledJob['entityType'],
  entityId: String(row.entity_id),
  runAt: asDate(row.run_at),
  payload: asRecord(row.payload),
  status: String(row.status) as JobStatus,
  attempts: Number(row.attempts),
  maxAttempts: Number(row.max_attempts),
  completedAt: optionalDate(row.completed_at),
  lastError: row.last_error ? String(row.last_error) : undefined,
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at)
});

const mapAudit = (row: Row): AuditLog => ({
  id: String(row.id),
  correlationId: String(row.correlation_id),
  actorUserId: row.actor_user_id ? String(row.actor_user_id) : undefined,
  sourceMessageId: row.source_message_id ? String(row.source_message_id) : undefined,
  action: String(row.action),
  entityType: row.entity_type ? String(row.entity_type) as AuditLog['entityType'] : undefined,
  entityId: row.entity_id ? String(row.entity_id) : undefined,
  originalInput: row.original_input ? String(row.original_input) : undefined,
  interpretedPayload: asRecord(row.interpreted_payload),
  executedPayload: asRecord(row.executed_payload),
  outcome: String(row.outcome) as AuditLog['outcome'],
  errorCode: row.error_code ? String(row.error_code) : undefined,
  errorDetail: row.error_detail ? String(row.error_detail) : undefined,
  createdAt: asDate(row.created_at)
});

const mapConfirmation = (row: Row): ActionConfirmation => ({
  id: String(row.id),
  publicId: String(row.public_id),
  requestedBy: String(row.requested_by),
  actionType: String(row.action_type) as ActionConfirmation['actionType'],
  draft: asRecord(row.draft),
  status: String(row.status) as ActionConfirmation['status'],
  expiresAt: asDate(row.expires_at),
  confirmedAt: optionalDate(row.confirmed_at),
  cancelledAt: optionalDate(row.cancelled_at),
  createdAt: asDate(row.created_at)
});

export class PostgresOperationsStore implements OperationsStore {
  private readonly pool: Pool;

  public constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 12 });
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async createUser(user: User): Promise<User> {
    try {
      const result = await this.pool.query<Row>(
        `INSERT INTO users (id, whatsapp_jid, phone_e164, display_name, interest_tags, role, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [user.id, user.whatsappJid, user.phoneE164 ?? null, user.displayName ?? null, user.interestTags ?? [], user.role, user.active, user.createdAt, user.updatedAt]
      );
      return mapUser(result.rows[0]!);
    } catch (error) {
      this.throwConflict(error, 'USER_ALREADY_EXISTS', 'A user with that WhatsApp identity already exists.');
    }
  }

  public async saveUser(user: User): Promise<User> {
    try {
      const result = await this.pool.query<Row>(
        `INSERT INTO users (id, whatsapp_jid, phone_e164, display_name, interest_tags, role, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET whatsapp_jid=EXCLUDED.whatsapp_jid, phone_e164=EXCLUDED.phone_e164,
         display_name=EXCLUDED.display_name, interest_tags=EXCLUDED.interest_tags, role=EXCLUDED.role, active=EXCLUDED.active, updated_at=EXCLUDED.updated_at
         RETURNING *`,
        [user.id, user.whatsappJid, user.phoneE164 ?? null, user.displayName ?? null, user.interestTags ?? [], user.role, user.active, user.createdAt, user.updatedAt]
      );
      return mapUser(result.rows[0]!);
    } catch (error) {
      this.throwConflict(error, 'USER_ALREADY_EXISTS', 'A user with that WhatsApp identity already exists.');
    }
  }

  public async getUser(id: string): Promise<User | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  public async findUserByJid(whatsappJid: string): Promise<User | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM users WHERE whatsapp_jid = $1', [whatsappJid]);
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  public async listUsers(): Promise<User[]> {
    const result = await this.pool.query<Row>('SELECT * FROM users ORDER BY created_at');
    return result.rows.map(mapUser);
  }

  public async saveOfficial(profile: OfficialProfile): Promise<OfficialProfile> {
    const result = await this.pool.query<Row>(
      `INSERT INTO officials (user_id, full_name, job_role, department, capabilities, active, interest_tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET full_name=EXCLUDED.full_name, job_role=EXCLUDED.job_role,
       department=EXCLUDED.department, capabilities=EXCLUDED.capabilities, active=EXCLUDED.active, interest_tags=EXCLUDED.interest_tags
       RETURNING *`,
      [profile.userId, profile.fullName, profile.jobRole ?? null, profile.department ?? null, profile.capabilities, profile.active, profile.interestTags]
    );
    return mapOfficial(result.rows[0]!);
  }

  public async getOfficial(userId: string): Promise<OfficialProfile | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM officials WHERE user_id = $1', [userId]);
    return result.rows[0] ? mapOfficial(result.rows[0]) : undefined;
  }

  public async findOfficialsByName(name: string): Promise<Array<{ user: User; profile: OfficialProfile }>> {
    const like = `%${escapeLike(name)}%`;
    const result = await this.pool.query<Row>(
      `SELECT u.*, o.user_id AS official_user_id, o.full_name, o.job_role, o.department, o.capabilities,
        o.active AS official_active, o.interest_tags
       FROM officials o JOIN users u ON u.id = o.user_id
       WHERE lower(o.full_name) = lower($1) OR o.full_name ILIKE $2 ESCAPE '\\'
       ORDER BY CASE WHEN lower(o.full_name) = lower($1) THEN 0 ELSE 1 END, o.full_name`,
      [name.trim(), like]
    );
    return result.rows.map((row) => ({
      user: mapUser(row),
      profile: mapOfficial({
        user_id: row.official_user_id,
        full_name: row.full_name,
        job_role: row.job_role,
        department: row.department,
        capabilities: row.capabilities,
        active: row.official_active,
        interest_tags: row.interest_tags
      })
    }));
  }

  public async listOfficials(): Promise<Array<{ user: User; profile: OfficialProfile }>> {
    const result = await this.pool.query<Row>(
      `SELECT u.*, o.user_id AS official_user_id, o.full_name, o.job_role, o.department, o.capabilities,
        o.active AS official_active, o.interest_tags
       FROM officials o JOIN users u ON u.id = o.user_id ORDER BY o.full_name`
    );
    return result.rows.map((row) => ({
      user: mapUser(row),
      profile: mapOfficial({
        user_id: row.official_user_id,
        full_name: row.full_name,
        job_role: row.job_role,
        department: row.department,
        capabilities: row.capabilities,
        active: row.official_active,
        interest_tags: row.interest_tags
      })
    }));
  }

  public async saveGroup(group: Group): Promise<Group> {
    const result = await this.pool.query<Row>(
      `INSERT INTO groups (id, whatsapp_jid, name, type, active, timezone, mention_all_max_participants, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET whatsapp_jid=EXCLUDED.whatsapp_jid, name=EXCLUDED.name,
       type=EXCLUDED.type, active=EXCLUDED.active, timezone=EXCLUDED.timezone,
       mention_all_max_participants=EXCLUDED.mention_all_max_participants, updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [group.id, group.whatsappJid, group.name, group.type, group.active, group.timezone, group.mentionAllMaxParticipants, group.createdAt, group.updatedAt]
    );
    return mapGroup(result.rows[0]!);
  }

  public async getGroup(id: string): Promise<Group | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM groups WHERE id = $1', [id]);
    return result.rows[0] ? mapGroup(result.rows[0]) : undefined;
  }

  public async findGroupsByName(name: string): Promise<Group[]> {
    const like = `%${escapeLike(name)}%`;
    const result = await this.pool.query<Row>(
      `SELECT * FROM groups WHERE lower(name) = lower($1) OR name ILIKE $2 ESCAPE '\\'
       ORDER BY CASE WHEN lower(name) = lower($1) THEN 0 ELSE 1 END, name`,
      [name.trim(), like]
    );
    return result.rows.map(mapGroup);
  }

  public async listGroups(): Promise<Group[]> {
    const result = await this.pool.query<Row>('SELECT * FROM groups ORDER BY name');
    return result.rows.map(mapGroup);
  }

  public async replaceGroupMembers(groupId: string, members: GroupMember[]): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query('DELETE FROM group_members WHERE group_id = $1', [groupId]);
      for (const member of members) {
        await client.query(
          `INSERT INTO group_members (group_id, user_id, is_admin, active, last_synced_at) VALUES ($1,$2,$3,$4,$5)`,
          [groupId, member.userId, member.isAdmin, member.active, member.lastSyncedAt]
        );
      }
    });
  }

  public async listGroupMembers(groupId: string): Promise<GroupMember[]> {
    const result = await this.pool.query<Row>('SELECT * FROM group_members WHERE group_id = $1 ORDER BY user_id', [groupId]);
    return result.rows.map(mapMember);
  }

  public async markMessageProcessed(messageId: string): Promise<boolean> {
    const result = await this.pool.query(
      'INSERT INTO processed_messages (whatsapp_message_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [messageId]
    );
    return result.rowCount === 1;
  }

  public async getConversationMemory(scopeKey: string, now: Date): Promise<ConversationMemory | undefined> {
    await this.pool.query('DELETE FROM conversation_memory WHERE scope_key=$1 AND expires_at <= $2', [scopeKey, now]);
    const result = await this.pool.query<Row>(
      'SELECT * FROM conversation_memory WHERE scope_key=$1 AND expires_at > $2',
      [scopeKey, now]
    );
    return result.rows[0] ? mapConversationMemory(result.rows[0]) : undefined;
  }

  public async saveConversationMemory(memory: ConversationMemory): Promise<ConversationMemory> {
    const result = await this.pool.query<Row>(
      `INSERT INTO conversation_memory (id, scope_key, group_id, user_id, turns, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (scope_key) DO UPDATE SET
         group_id=EXCLUDED.group_id, user_id=EXCLUDED.user_id, turns=EXCLUDED.turns,
         expires_at=EXCLUDED.expires_at, updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        memory.id, memory.scopeKey, memory.groupId ?? null, memory.userId ?? null,
        JSON.stringify(memory.turns), memory.expiresAt, memory.createdAt, memory.updatedAt
      ]
    );
    return mapConversationMemory(result.rows[0]!);
  }

  public async deleteConversationMemory(scopeKey: string): Promise<void> {
    await this.pool.query('DELETE FROM conversation_memory WHERE scope_key=$1', [scopeKey]);
  }

  public async createTask(task: Task, assignees: TaskAssignee[]): Promise<Task> {
    return this.withTransaction(async (client) => {
      const result = await client.query<Row>(
        `INSERT INTO tasks (id, public_id, title, description, group_id, created_by, required_capability, source_message_id, source_message_text,
         status, priority, completion_policy, publish_at, published_at, published_message_id, deadline_at,
         reminder_offsets_minutes, completion_notes, completed_at, cancelled_at, cancellation_reason, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
        [
          task.id, task.publicId, task.title, task.description, task.groupId, task.createdBy, task.requiredCapability ?? null,
          task.sourceMessageId ?? null, task.sourceMessageText ?? null, task.status, task.priority, task.completionPolicy, task.publishAt ?? null,
          task.publishedAt ?? null, task.publishedMessageId ?? null, task.deadlineAt ?? null, task.reminderOffsetsMinutes,
          task.completionNotes ?? null, task.completedAt ?? null, task.cancelledAt ?? null, task.cancellationReason ?? null,
          task.version, task.createdAt, task.updatedAt
        ]
      );
      for (const assignee of assignees) await this.insertAssignee(client, assignee);
        for (const attachmentId of task.attachmentIds) {
          await client.query('INSERT INTO task_attachments (task_id, attachment_id) VALUES ($1,$2)', [task.id, attachmentId]);
        }
        return mapTask({ ...result.rows[0], attachment_ids: task.attachmentIds });
    });
  }

  public async getTask(id: string): Promise<Task | undefined> {
    const result = await this.pool.query<Row>(
      `SELECT t.*, COALESCE(array_agg(ta.attachment_id) FILTER (WHERE ta.attachment_id IS NOT NULL), '{}') AS attachment_ids
       FROM tasks t LEFT JOIN task_attachments ta ON ta.task_id=t.id WHERE t.id=$1 GROUP BY t.id`,
      [id]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : undefined;
  }

  public async listTaskAttachmentIds(taskId: string): Promise<string[]> {
    const result = await this.pool.query<Row>('SELECT attachment_id FROM task_attachments WHERE task_id=$1 ORDER BY attachment_id', [taskId]);
    return result.rows.map((row) => String(row.attachment_id));
  }

  public async findTaskByPublishedMessageId(messageId: string): Promise<Task | undefined> {
    const result = await this.pool.query<Row>(
      `SELECT t.*, COALESCE(array_agg(ta.attachment_id) FILTER (WHERE ta.attachment_id IS NOT NULL), '{}') AS attachment_ids
       FROM tasks t LEFT JOIN task_attachments ta ON ta.task_id=t.id WHERE t.published_message_id=$1 GROUP BY t.id`,
      [messageId]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : undefined;
  }

  public async listTasks(filter?: TaskListFilter): Promise<Task[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    const add = (sql: string, value: unknown): void => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (filter?.status) add('t.status = ?', filter.status);
    if (filter?.groupId) add('t.group_id = ?', filter.groupId);
    if (filter?.dueFrom) add('t.deadline_at >= ?', filter.dueFrom);
    if (filter?.dueTo) add('t.deadline_at <= ?', filter.dueTo);
    if (filter?.assigneeUserId) {
      values.push(filter.assigneeUserId);
      conditions.push(`EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<Row>(
      `SELECT t.*, COALESCE(array_agg(ta.attachment_id) FILTER (WHERE ta.attachment_id IS NOT NULL), '{}') AS attachment_ids
       FROM tasks t LEFT JOIN task_attachments ta ON ta.task_id=t.id ${where} GROUP BY t.id ORDER BY t.deadline_at NULLS LAST, t.created_at DESC`,
      values
    );
    return result.rows.map(mapTask);
  }

  public async saveTask(task: Task, expectedVersion: number): Promise<Task> {
    return this.withTransaction(async (client) => {
      const result = await client.query<Row>(
        `UPDATE tasks SET title=$1, description=$2, group_id=$3, required_capability=$4, source_message_id=$5, source_message_text=$6,
         status=$7, priority=$8, completion_policy=$9, publish_at=$10, published_at=$11, published_message_id=$12,
         deadline_at=$13, reminder_offsets_minutes=$14, completion_notes=$15, completed_at=$16, cancelled_at=$17,
         cancellation_reason=$18, version=version+1, updated_at=now()
         WHERE id=$19 AND version=$20 RETURNING *`,
        [
          task.title, task.description, task.groupId, task.requiredCapability ?? null, task.sourceMessageId ?? null, task.sourceMessageText ?? null,
          task.status, task.priority, task.completionPolicy, task.publishAt ?? null, task.publishedAt ?? null,
          task.publishedMessageId ?? null, task.deadlineAt ?? null, task.reminderOffsetsMinutes, task.completionNotes ?? null,
          task.completedAt ?? null, task.cancelledAt ?? null, task.cancellationReason ?? null, task.id, expectedVersion
        ]
      );
      if (!result.rows[0]) {
        const existing = await client.query<{ version: number }>('SELECT version FROM tasks WHERE id=$1', [task.id]);
        if (!existing.rows[0]) throw new AppError('TASK_NOT_FOUND', 'The task does not exist.', 404);
        throw new AppError('TASK_VERSION_CONFLICT', 'This task changed before your update could be saved.', 409, {
          expectedVersion,
          currentVersion: existing.rows[0].version
        });
      }
      await client.query('DELETE FROM task_attachments WHERE task_id=$1', [task.id]);
      for (const attachmentId of task.attachmentIds) {
        await client.query('INSERT INTO task_attachments (task_id, attachment_id) VALUES ($1,$2)', [task.id, attachmentId]);
      }
      return mapTask({ ...result.rows[0], attachment_ids: task.attachmentIds });
    });
  }

  public async listTaskAssignees(taskId: string): Promise<TaskAssignee[]> {
    const result = await this.pool.query<Row>('SELECT * FROM task_assignees WHERE task_id = $1 ORDER BY user_id', [taskId]);
    return result.rows.map(mapAssignee);
  }

  public async listTaskAssigneesForTasks(taskIds: string[]): Promise<TaskAssignee[]> {
    if (!taskIds.length) return [];
    const result = await this.pool.query<Row>(
      'SELECT * FROM task_assignees WHERE task_id = ANY($1::uuid[]) ORDER BY task_id, user_id',
      [taskIds]
    );
    return result.rows.map(mapAssignee);
  }

  public async getTaskAssignee(taskId: string, userId: string): Promise<TaskAssignee | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2', [taskId, userId]);
    return result.rows[0] ? mapAssignee(result.rows[0]) : undefined;
  }

  public async saveTaskAssignee(assignee: TaskAssignee): Promise<TaskAssignee> {
    const result = await this.pool.query<Row>(
      `UPDATE task_assignees SET status=$1, acknowledged_at=$2, submitted_at=$3, completed_at=$4, overdue_at=$5,
       blocked_reason=$6, latest_submission_id=$7 WHERE task_id=$8 AND user_id=$9 RETURNING *`,
      [
        assignee.status, assignee.acknowledgedAt ?? null, assignee.submittedAt ?? null, assignee.completedAt ?? null,
        assignee.overdueAt ?? null, assignee.blockedReason ?? null, assignee.latestSubmissionId ?? null,
        assignee.taskId, assignee.userId
      ]
    );
    if (!result.rows[0]) throw new AppError('ASSIGNMENT_NOT_FOUND', 'The task assignment does not exist.', 404);
    return mapAssignee(result.rows[0]);
  }

  public async replaceTaskAssignees(taskId: string, assignees: TaskAssignee[]): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query('DELETE FROM task_assignees WHERE task_id = $1', [taskId]);
      for (const assignee of assignees) await this.insertAssignee(client, assignee);
    });
  }

  public async addTaskUpdate(update: TaskUpdate): Promise<TaskUpdate> {
    const result = await this.pool.query<Row>(
      `INSERT INTO task_updates (id, task_id, actor_user_id, update_type, body, source_message_id, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [update.id, update.taskId, update.actorUserId ?? null, update.updateType, update.body ?? null, update.sourceMessageId ?? null, update.metadata, update.createdAt]
    );
    return mapTaskUpdate(result.rows[0]!);
  }

  public async listTaskUpdates(taskId: string): Promise<TaskUpdate[]> {
    const result = await this.pool.query<Row>('SELECT * FROM task_updates WHERE task_id=$1 ORDER BY created_at', [taskId]);
    return result.rows.map(mapTaskUpdate);
  }

  public async createSubmission(submission: TaskSubmission): Promise<TaskSubmission> {
    return this.withTransaction(async (client) => {
      try {
        const result = await client.query<Row>(
          `INSERT INTO task_submissions (id, task_id, submitter_user_id, note, source_message_id, submitted_at)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [submission.id, submission.taskId, submission.submitterUserId, submission.note ?? null, submission.sourceMessageId ?? null, submission.submittedAt]
        );
        for (const attachmentId of submission.attachmentIds) {
          await client.query('INSERT INTO task_submission_attachments (submission_id, attachment_id) VALUES ($1,$2)', [submission.id, attachmentId]);
        }
        return mapSubmission(result.rows[0]!, submission.attachmentIds);
      } catch (error) {
        this.throwConflict(error, 'SUBMISSION_ALREADY_RECORDED', 'That message was already recorded as a submission.');
      }
    });
  }

  public async listTaskSubmissions(taskId: string): Promise<TaskSubmission[]> {
    const result = await this.pool.query<Row>(
      `SELECT s.*, COALESCE(array_agg(a.attachment_id) FILTER (WHERE a.attachment_id IS NOT NULL), '{}') AS attachment_ids
       FROM task_submissions s LEFT JOIN task_submission_attachments a ON a.submission_id=s.id
       WHERE s.task_id=$1 GROUP BY s.id ORDER BY s.submitted_at`,
      [taskId]
    );
    return result.rows.map((row) => mapSubmission(row, asTextArray(row.attachment_ids)));
  }

  public async createAttachment(attachment: Attachment): Promise<Attachment> {
    const result = await this.pool.query<Row>(
      `INSERT INTO attachments (id, storage_key, source_url, kind, mime_type, file_name, size_bytes, sha256, uploaded_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        attachment.id, attachment.storageKey ?? null, attachment.sourceUrl ?? null, attachment.kind,
        attachment.mimeType ?? null, attachment.fileName ?? null, attachment.sizeBytes ?? null, attachment.sha256 ?? null,
        attachment.uploadedBy ?? null, attachment.createdAt
      ]
    );
    return mapAttachment(result.rows[0]!);
  }

  public async getAttachment(id: string): Promise<Attachment | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM attachments WHERE id=$1', [id]);
    return result.rows[0] ? mapAttachment(result.rows[0]) : undefined;
  }

  public async createAnnouncement(announcement: Announcement): Promise<Announcement> {
    return this.withTransaction(async (client) => {
      const result = await client.query<Row>(
        `INSERT INTO announcements (id, public_id, group_id, created_by, source_message_id, category, title, body,
         mention_strategy, interest_tags, status, publish_at, published_at, published_message_id, expires_at,
         failure_reason, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [
          announcement.id, announcement.publicId, announcement.groupId, announcement.createdBy,
          announcement.sourceMessageId ?? null, announcement.category ?? null, announcement.title ?? null, announcement.body,
          announcement.mentionStrategy, announcement.interestTags, announcement.status, announcement.publishAt ?? null,
          announcement.publishedAt ?? null, announcement.publishedMessageId ?? null, announcement.expiresAt ?? null,
          announcement.failureReason ?? null, announcement.version, announcement.createdAt, announcement.updatedAt
        ]
      );
      for (const attachmentId of announcement.attachmentIds) {
        await client.query('INSERT INTO announcement_attachments (announcement_id, attachment_id) VALUES ($1,$2)', [announcement.id, attachmentId]);
      }
      return mapAnnouncement(result.rows[0]!, announcement.attachmentIds);
    });
  }

  public async getAnnouncement(id: string): Promise<Announcement | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM announcements WHERE id=$1', [id]);
    if (!result.rows[0]) return undefined;
    return mapAnnouncement(result.rows[0], await this.listAnnouncementAttachmentIds(id));
  }

  public async listAnnouncements(filter?: AnnouncementListFilter): Promise<Announcement[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    const add = (sql: string, value: unknown): void => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (filter?.status) add('status = ?', filter.status);
    if (filter?.groupId) add('group_id = ?', filter.groupId);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<Row>(`SELECT * FROM announcements ${where} ORDER BY publish_at NULLS LAST, created_at DESC`, values);
    return Promise.all(result.rows.map(async (row) => mapAnnouncement(row, await this.listAnnouncementAttachmentIds(String(row.id)))));
  }

  public async saveAnnouncement(announcement: Announcement, expectedVersion: number): Promise<Announcement> {
    return this.withTransaction(async (client) => {
      const result = await client.query<Row>(
        `UPDATE announcements SET category=$1, title=$2, body=$3, mention_strategy=$4, interest_tags=$5, status=$6,
         publish_at=$7, published_at=$8, published_message_id=$9, expires_at=$10, failure_reason=$11,
         version=version+1, updated_at=now() WHERE id=$12 AND version=$13 RETURNING *`,
        [
          announcement.category ?? null, announcement.title ?? null, announcement.body, announcement.mentionStrategy,
          announcement.interestTags, announcement.status, announcement.publishAt ?? null, announcement.publishedAt ?? null,
          announcement.publishedMessageId ?? null, announcement.expiresAt ?? null, announcement.failureReason ?? null,
          announcement.id, expectedVersion
        ]
      );
      if (!result.rows[0]) {
        const exists = await client.query('SELECT version FROM announcements WHERE id=$1', [announcement.id]);
        if (!exists.rows[0]) throw new AppError('ANNOUNCEMENT_NOT_FOUND', 'The announcement does not exist.', 404);
        throw new AppError('ANNOUNCEMENT_VERSION_CONFLICT', 'This announcement changed before your update could be saved.', 409);
      }
      await client.query('DELETE FROM announcement_attachments WHERE announcement_id=$1', [announcement.id]);
      for (const attachmentId of announcement.attachmentIds) {
        await client.query('INSERT INTO announcement_attachments (announcement_id, attachment_id) VALUES ($1,$2)', [announcement.id, attachmentId]);
      }
      return mapAnnouncement(result.rows[0]!, announcement.attachmentIds);
    });
  }

  public async saveOpportunity(opportunity: Opportunity): Promise<Opportunity> {
    const result = await this.pool.query<Row>(
      `INSERT INTO opportunities (id, announcement_id, title, category, summary, eligibility, application_url, deadline_at,
       source_name, source_url, active, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET announcement_id=EXCLUDED.announcement_id, title=EXCLUDED.title,
       category=EXCLUDED.category, summary=EXCLUDED.summary, eligibility=EXCLUDED.eligibility,
       application_url=EXCLUDED.application_url, deadline_at=EXCLUDED.deadline_at, source_name=EXCLUDED.source_name,
       source_url=EXCLUDED.source_url, active=EXCLUDED.active, updated_at=EXCLUDED.updated_at RETURNING *`,
      [
        opportunity.id, opportunity.announcementId ?? null, opportunity.title, opportunity.category, opportunity.summary,
        opportunity.eligibility ?? null, opportunity.applicationUrl ?? null, opportunity.deadlineAt ?? null,
        opportunity.sourceName ?? null, opportunity.sourceUrl ?? null, opportunity.active, opportunity.createdBy,
        opportunity.createdAt, opportunity.updatedAt
      ]
    );
    return mapOpportunity(result.rows[0]!);
  }

  public async saveOrganizationKnowledge(item: OrganizationKnowledge): Promise<OrganizationKnowledge> {
    const result = await this.pool.query<Row>(
      `INSERT INTO organization_knowledge (id, title, content, tags, active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, content=EXCLUDED.content,
       tags=EXCLUDED.tags, active=EXCLUDED.active, updated_at=EXCLUDED.updated_at RETURNING *`,
      [item.id, item.title, item.content, item.tags, item.active, item.createdAt, item.updatedAt]
    );
    return this.mapKnowledge(result.rows[0]!);
  }

  public async searchOrganizationKnowledge(query: string, limit = 5): Promise<OrganizationKnowledge[]> {
    const result = await this.pool.query<Row>(
      `SELECT *, ts_rank(search_document, websearch_to_tsquery('english', $1)) AS rank
       FROM organization_knowledge
       WHERE active=TRUE AND (
         search_document @@ websearch_to_tsquery('english', $1)
         OR EXISTS (SELECT 1 FROM unnest(tags) AS item(tag) WHERE item.tag ILIKE '%' || $1 || '%')
       )
       ORDER BY rank DESC, updated_at DESC LIMIT $2`,
      [query, Math.max(1, Math.min(limit, 20))]
    );
    return result.rows.map((row) => this.mapKnowledge(row));
  }

  public async listActiveOpportunities(query?: string): Promise<Opportunity[]> {
    const values: unknown[] = [];
    let condition = 'active = TRUE AND (deadline_at IS NULL OR deadline_at >= now())';
    if (query) {
      values.push(`%${escapeLike(query)}%`);
      condition += ` AND (title ILIKE $1 ESCAPE '\\' OR category ILIKE $1 ESCAPE '\\' OR summary ILIKE $1 ESCAPE '\\')`;
    }
    const result = await this.pool.query<Row>(`SELECT * FROM opportunities WHERE ${condition} ORDER BY deadline_at NULLS LAST, created_at DESC`, values);
    return result.rows.map(mapOpportunity);
  }

  public async saveOpportunityCandidate(candidate: OpportunityCandidate): Promise<OpportunityCandidate> {
    const result = await this.pool.query<Row>(
      `INSERT INTO opportunity_candidates (id, source_name, source_url, title, summary, category, eligibility, deadline_at,
       music_relevance, regional_relevance, youth_relevance, support_value, source_credibility, deadline_viability,
       total_score, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (source_url) DO UPDATE SET source_name=EXCLUDED.source_name, title=EXCLUDED.title,
       summary=EXCLUDED.summary, category=EXCLUDED.category, eligibility=EXCLUDED.eligibility,
       deadline_at=EXCLUDED.deadline_at, music_relevance=EXCLUDED.music_relevance,
       regional_relevance=EXCLUDED.regional_relevance, youth_relevance=EXCLUDED.youth_relevance,
       support_value=EXCLUDED.support_value, source_credibility=EXCLUDED.source_credibility,
       deadline_viability=EXCLUDED.deadline_viability, total_score=EXCLUDED.total_score,
       status=EXCLUDED.status, updated_at=EXCLUDED.updated_at RETURNING *`,
      [candidate.id, candidate.sourceName, candidate.sourceUrl, candidate.title, candidate.summary, candidate.category,
        candidate.eligibility ?? null, candidate.deadlineAt ?? null, candidate.musicRelevance, candidate.regionalRelevance,
        candidate.youthRelevance, candidate.supportValue, candidate.sourceCredibility, candidate.deadlineViability,
        candidate.totalScore, candidate.status, candidate.createdAt, candidate.updatedAt]
    );
    return mapOpportunityCandidate(result.rows[0]!);
  }

  public async listOpportunityCandidates(minScore = 0): Promise<OpportunityCandidate[]> {
    const result = await this.pool.query<Row>(
      'SELECT * FROM opportunity_candidates WHERE total_score >= $1 AND status <> $2 ORDER BY total_score DESC, created_at DESC',
      [minScore, 'IGNORED']
    );
    return result.rows.map(mapOpportunityCandidate);
  }

  public async recordMemberActivity(activity: MemberActivity): Promise<MemberActivity> {
    const result = await this.pool.query<Row>(
      `INSERT INTO member_activity (id, user_id, group_id, message_count, last_message_at, last_meaningful_at,
       period_start, period_end, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, group_id, period_start, period_end) DO UPDATE SET message_count=member_activity.message_count + 1,
       last_message_at=GREATEST(member_activity.last_message_at, EXCLUDED.last_message_at),
       last_meaningful_at=CASE WHEN EXCLUDED.last_meaningful_at IS NULL THEN member_activity.last_meaningful_at
         ELSE GREATEST(member_activity.last_meaningful_at, EXCLUDED.last_meaningful_at) END,
       updated_at=EXCLUDED.updated_at RETURNING *`,
      [activity.id, activity.userId, activity.groupId, activity.messageCount, activity.lastMessageAt ?? null,
        activity.lastMeaningfulAt ?? null, activity.periodStart, activity.periodEnd, activity.createdAt, activity.updatedAt]
    );
    return mapMemberActivity(result.rows[0]!);
  }

  public async listMemberActivity(groupId?: string, since?: Date): Promise<MemberActivity[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (groupId) { values.push(groupId); conditions.push(`group_id=$${values.length}`); }
    if (since) { values.push(since); conditions.push(`period_end >= $${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<Row>(`SELECT * FROM member_activity ${where} ORDER BY updated_at DESC`, values);
    return result.rows.map(mapMemberActivity);
  }

  public async saveMemberCheckin(checkin: MemberCheckin): Promise<MemberCheckin> {
    const result = await this.pool.query<Row>(
      `INSERT INTO member_checkins (id, user_id, group_id, message, status, created_at, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET message=EXCLUDED.message, status=EXCLUDED.status, sent_at=EXCLUDED.sent_at
       RETURNING *`,
      [checkin.id, checkin.userId, checkin.groupId, checkin.message, checkin.status, checkin.createdAt, checkin.sentAt ?? null]
    );
    return mapMemberCheckin(result.rows[0]!);
  }

  public async listMemberCheckins(userId?: string, since?: Date): Promise<MemberCheckin[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (userId) { values.push(userId); conditions.push(`user_id=$${values.length}`); }
    if (since) { values.push(since); conditions.push(`created_at >= $${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<Row>(`SELECT * FROM member_checkins ${where} ORDER BY created_at DESC`, values);
    return result.rows.map(mapMemberCheckin);
  }

  public async savePlanningRun(run: PlanningRun): Promise<PlanningRun> {
    const result = await this.pool.query<Row>(
      `INSERT INTO planning_runs (id, run_at, status, summary, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [run.id, run.runAt, run.status, run.summary, run.createdAt]
    );
    return mapPlanningRun(result.rows[0]!);
  }

  public async listPlanningRuns(since?: Date): Promise<PlanningRun[]> {
    const values = since ? [since] : [];
    const where = since ? 'WHERE run_at >= $1' : '';
    const result = await this.pool.query<Row>(`SELECT * FROM planning_runs ${where} ORDER BY run_at DESC`, values);
    return result.rows.map(mapPlanningRun);
  }

  public async saveCalendarEvent(event: CalendarEvent): Promise<CalendarEvent> {
    const result = await this.pool.query<Row>(
      `INSERT INTO calendar_events (id, external_id, title, description, starts_at, ends_at, timezone, source,
       relevance_score, preparation_stage, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (source, external_id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
       starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, timezone=EXCLUDED.timezone,
       relevance_score=EXCLUDED.relevance_score, preparation_stage=EXCLUDED.preparation_stage,
       updated_at=EXCLUDED.updated_at RETURNING *`,
      [event.id, event.externalId ?? null, event.title, event.description ?? null, event.startsAt, event.endsAt ?? null,
        event.timezone, event.source, event.relevanceScore, event.preparationStage, event.createdAt, event.updatedAt]
    );
    return mapCalendarEvent(result.rows[0]!);
  }

  public async getCalendarEvent(id: string): Promise<CalendarEvent | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM calendar_events WHERE id=$1', [id]);
    return result.rows[0] ? mapCalendarEvent(result.rows[0]) : undefined;
  }

  public async listCalendarEvents(from?: Date, to?: Date): Promise<CalendarEvent[]> {
    const values: Date[] = [];
    const conditions: string[] = [];
    if (from) { values.push(from); conditions.push(`starts_at >= $${values.length}`); }
    if (to) { values.push(to); conditions.push(`starts_at <= $${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<Row>(`SELECT * FROM calendar_events ${where} ORDER BY starts_at`, values);
    return result.rows.map(mapCalendarEvent);
  }

  public async createJob(job: ScheduledJob): Promise<ScheduledJob> {
    const result = await this.pool.query<Row>(
      `INSERT INTO scheduled_jobs (id, job_key, job_type, entity_type, entity_id, run_at, payload, status, attempts,
       max_attempts, completed_at, last_error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (job_key) DO NOTHING RETURNING *`,
      [
        job.id, job.jobKey, job.jobType, job.entityType, job.entityId, job.runAt, job.payload, job.status,
        job.attempts, job.maxAttempts, job.completedAt ?? null, job.lastError ?? null, job.createdAt, job.updatedAt
      ]
    );
    if (result.rows[0]) return mapJob(result.rows[0]);
    const existing = await this.getJobByKey(job.jobKey);
    if (!existing) throw new AppError('JOB_CREATE_FAILED', 'Unable to create scheduled job.', 500);
    return existing;
  }

  public async getJobByKey(jobKey: string): Promise<ScheduledJob | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM scheduled_jobs WHERE job_key=$1', [jobKey]);
    return result.rows[0] ? mapJob(result.rows[0]) : undefined;
  }

  public async listJobsForEntity(entityType: ScheduledJob['entityType'], entityId: string): Promise<ScheduledJob[]> {
    const result = await this.pool.query<Row>(
      'SELECT * FROM scheduled_jobs WHERE entity_type=$1 AND entity_id=$2 ORDER BY run_at',
      [entityType, entityId]
    );
    return result.rows.map(mapJob);
  }

  public async claimJob(jobKey: string, now: Date): Promise<ScheduledJob | undefined> {
    const result = await this.pool.query<Row>(
      `UPDATE scheduled_jobs SET status='PROCESSING', attempts=attempts+1, updated_at=$2
       WHERE job_key=$1 AND status='PENDING' AND run_at <= $2 RETURNING *`,
      [jobKey, now]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : undefined;
  }

  public async listDueJobs(now: Date): Promise<ScheduledJob[]> {
    const result = await this.pool.query<Row>(
      `SELECT * FROM scheduled_jobs WHERE status='PENDING' AND run_at <= $1 ORDER BY run_at ASC LIMIT 500`,
      [now]
    );
    return result.rows.map(mapJob);
  }

  public async listFailedJobs(since: Date): Promise<ScheduledJob[]> {
    const result = await this.pool.query<Row>(
      `SELECT * FROM scheduled_jobs WHERE status='FAILED' AND updated_at >= $1 ORDER BY updated_at DESC LIMIT 100`,
      [since]
    );
    return result.rows.map(mapJob);
  }

  public async recoverStaleJobs(staleBefore: Date, now: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE scheduled_jobs
       SET status = CASE WHEN attempts < max_attempts THEN 'PENDING' ELSE 'FAILED' END,
           run_at = CASE WHEN attempts < max_attempts THEN $2 ELSE run_at END,
           last_error = 'Recovered after an interrupted worker process.',
           updated_at = $2
       WHERE status='PROCESSING' AND updated_at <= $1`,
      [staleBefore, now]
    );
    return result.rowCount ?? 0;
  }

  public async completeJob(jobKey: string, completedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_jobs SET status='SUCCEEDED', completed_at=$2, updated_at=$2 WHERE job_key=$1 AND status='PROCESSING'`,
      [jobKey, completedAt]
    );
  }

  public async failJob(jobKey: string, error: string, retryAt?: Date): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_jobs
       SET status = CASE WHEN attempts < max_attempts AND $3::timestamptz IS NOT NULL THEN 'PENDING' ELSE 'FAILED' END,
       run_at = CASE WHEN attempts < max_attempts AND $3::timestamptz IS NOT NULL THEN $3 ELSE run_at END,
       last_error=$2, updated_at=now() WHERE job_key=$1`,
      [jobKey, error, retryAt ?? null]
    );
  }

  public async cancelJobsForEntity(
    entityType: ScheduledJob['entityType'],
    entityId: string,
    options: { preserveTypes?: ScheduledJob['jobType'][] } = {}
  ): Promise<void> {
    const preserveTypes = options.preserveTypes ?? [];
    await this.pool.query(
      `UPDATE scheduled_jobs SET status='CANCELLED', updated_at=now()
       WHERE entity_type=$1 AND entity_id=$2 AND status IN ('PENDING','PROCESSING')
         AND NOT (job_type = ANY($3::text[]))`,
      [entityType, entityId, preserveTypes]
    );
  }

  public async addAuditLog(log: AuditLog): Promise<AuditLog> {
    const result = await this.pool.query<Row>(
      `INSERT INTO audit_logs (id, correlation_id, actor_user_id, source_message_id, action, entity_type, entity_id,
       original_input, interpreted_payload, executed_payload, outcome, error_code, error_detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        log.id, log.correlationId, log.actorUserId ?? null, log.sourceMessageId ?? null, log.action,
        log.entityType ?? null, log.entityId ?? null, log.originalInput ?? null, log.interpretedPayload ?? null,
        log.executedPayload ?? null, log.outcome, log.errorCode ?? null, log.errorDetail ?? null, log.createdAt
      ]
    );
    return mapAudit(result.rows[0]!);
  }

  public async listAuditLogs(entityType?: AuditLog['entityType'], entityId?: string): Promise<AuditLog[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (entityType) { values.push(entityType); conditions.push(`entity_type=$${values.length}`); }
    if (entityId) { values.push(entityId); conditions.push(`entity_id=$${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<Row>(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC`, values);
    return result.rows.map(mapAudit);
  }

  public async createActionConfirmation(confirmation: ActionConfirmation): Promise<ActionConfirmation> {
    const result = await this.pool.query<Row>(
      `INSERT INTO action_confirmations (id, public_id, requested_by, action_type, draft, status, expires_at, confirmed_at, cancelled_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        confirmation.id, confirmation.publicId, confirmation.requestedBy, confirmation.actionType,
        confirmation.draft, confirmation.status, confirmation.expiresAt, confirmation.confirmedAt ?? null,
        confirmation.cancelledAt ?? null, confirmation.createdAt
      ]
    );
    return mapConfirmation(result.rows[0]!);
  }

  public async getActionConfirmation(idOrPublicId: string): Promise<ActionConfirmation | undefined> {
    await this.pool.query(
      `UPDATE action_confirmations SET status='EXPIRED'
       WHERE (id::text=$1 OR public_id=$1) AND status='PENDING' AND expires_at <= now()`,
      [idOrPublicId]
    );
    const result = await this.pool.query<Row>(
      'SELECT * FROM action_confirmations WHERE id::text=$1 OR public_id=$1',
      [idOrPublicId]
    );
    return result.rows[0] ? mapConfirmation(result.rows[0]) : undefined;
  }

  public async confirmActionConfirmation(idOrPublicId: string, requestedBy: string, now: Date): Promise<ActionConfirmation | undefined> {
    await this.pool.query(
      `UPDATE action_confirmations SET status='EXPIRED'
       WHERE (id::text=$1 OR public_id=$1) AND status='PENDING' AND expires_at <= $2`,
      [idOrPublicId, now]
    );
    const result = await this.pool.query<Row>(
      `UPDATE action_confirmations SET status='CONFIRMED', confirmed_at=$3
       WHERE (id::text=$1 OR public_id=$1) AND requested_by=$2 AND status='PENDING' AND expires_at > $3 RETURNING *`,
      [idOrPublicId, requestedBy, now]
    );
    return result.rows[0] ? mapConfirmation(result.rows[0]) : undefined;
  }

  public async cancelActionConfirmation(idOrPublicId: string, requestedBy: string, now: Date): Promise<ActionConfirmation | undefined> {
    await this.pool.query(
      `UPDATE action_confirmations SET status='EXPIRED'
       WHERE (id::text=$1 OR public_id=$1) AND status='PENDING' AND expires_at <= $2`,
      [idOrPublicId, now]
    );
    const result = await this.pool.query<Row>(
      `UPDATE action_confirmations SET status='CANCELLED', cancelled_at=$3
       WHERE (id::text=$1 OR public_id=$1) AND requested_by=$2 AND status='PENDING' AND expires_at > $3 RETURNING *`,
      [idOrPublicId, requestedBy, now]
    );
    return result.rows[0] ? mapConfirmation(result.rows[0]) : undefined;
  }

  private async insertAssignee(client: PoolClient, assignee: TaskAssignee): Promise<void> {
    await client.query(
      `INSERT INTO task_assignees (task_id, user_id, status, acknowledged_at, submitted_at, completed_at, overdue_at,
       blocked_reason, latest_submission_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        assignee.taskId, assignee.userId, assignee.status, assignee.acknowledgedAt ?? null,
        assignee.submittedAt ?? null, assignee.completedAt ?? null, assignee.overdueAt ?? null,
        assignee.blockedReason ?? null, assignee.latestSubmissionId ?? null
      ]
    );
  }

  private async listAnnouncementAttachmentIds(announcementId: string): Promise<string[]> {
    const result = await this.pool.query<{ attachment_id: string }>(
      'SELECT attachment_id FROM announcement_attachments WHERE announcement_id=$1 ORDER BY attachment_id',
      [announcementId]
    );
    return result.rows.map((row) => row.attachment_id);
  }

  private mapKnowledge(row: Row): OrganizationKnowledge {
    return {
      id: String(row.id),
      title: String(row.title),
      content: String(row.content),
      tags: asTextArray(row.tags),
      active: Boolean(row.active),
      createdAt: asDate(row.created_at),
      updatedAt: asDate(row.updated_at)
    };
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private throwConflict(error: unknown, code: string, message: string): never {
    if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new AppError(code, message, 409);
    }
    throw error;
  }
}
