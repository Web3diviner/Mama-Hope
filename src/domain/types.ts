export const userRoles = [
  'SUPER_ADMIN',
  'OFFICIAL',
  'COMMUNITY_MEMBER',
  'SYSTEM'
] as const;
export type UserRole = (typeof userRoles)[number];

export const groupTypes = ['OFFICIALS', 'COMMUNITY', 'OTHER'] as const;
export type GroupType = (typeof groupTypes)[number];

export const taskStatuses = [
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'SUBMITTED',
  'COMPLETED',
  'OVERDUE',
  'CANCELLED'
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const assignmentStatuses = [
  'PENDING',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'BLOCKED',
  'SUBMITTED',
  'COMPLETED',
  'OVERDUE'
] as const;
export type AssignmentStatus = (typeof assignmentStatuses)[number];

export const priorityLevels = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type PriorityLevel = (typeof priorityLevels)[number];

export const completionPolicies = [
  'ALL_ASSIGNEES_SUBMIT',
  'ADMIN_CONFIRMATION'
] as const;
export type CompletionPolicy = (typeof completionPolicies)[number];

export const announcementStatuses = [
  'DRAFT',
  'SCHEDULED',
  'PUBLISHED',
  'FAILED',
  'CANCELLED'
] as const;
export type AnnouncementStatus = (typeof announcementStatuses)[number];

export const mentionStrategies = [
  'NONE',
  'RELEVANT_MEMBERS',
  'OFFICIALS_ONLY',
  'EVERYONE'
] as const;
export type MentionStrategy = (typeof mentionStrategies)[number];

export const jobStatuses = [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const confirmationStatuses = ['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'] as const;
export type ConfirmationStatus = (typeof confirmationStatuses)[number];

export const jobTypes = [
  'TASK_PUBLISH',
  'TASK_REMINDER',
  'TASK_DEADLINE',
  'TASK_RECURRENCE',
  'ANNOUNCEMENT_PUBLISH',
  'DAILY_PLANNING'
] as const;
export type JobType = (typeof jobTypes)[number];

export interface User {
  id: string;
  whatsappJid: string;
  phoneE164?: string;
  displayName?: string;
  interestTags?: string[];
  role: UserRole;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OfficialProfile {
  userId: string;
  fullName: string;
  jobRole?: string;
  department?: string;
  capabilities: string[];
  active: boolean;
  interestTags: string[];
}

export interface Group {
  id: string;
  whatsappJid: string;
  name: string;
  type: GroupType;
  active: boolean;
  timezone: string;
  mentionAllMaxParticipants: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupMember {
  groupId: string;
  userId: string;
  isAdmin: boolean;
  active: boolean;
  lastSyncedAt: Date;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

export interface ConversationMemory {
  id: string;
  scopeKey: string;
  userId?: string;
  groupId?: string;
  turns: ConversationTurn[];
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskAssignee {
  taskId: string;
  userId: string;
  status: AssignmentStatus;
  acknowledgedAt?: Date;
  submittedAt?: Date;
  completedAt?: Date;
  overdueAt?: Date;
  blockedReason?: string;
  latestSubmissionId?: string;
}

export interface Task {
  id: string;
  publicId: string;
  title: string;
  description: string;
  groupId: string;
  createdBy: string;
  requiredCapability?: string;
  sourceMessageId?: string;
  sourceMessageText?: string;
  status: TaskStatus;
  priority: PriorityLevel;
  completionPolicy: CompletionPolicy;
  publishAt?: Date;
  publishedAt?: Date;
  publishedMessageId?: string;
  deadlineAt?: Date;
  reminderOffsetsMinutes: number[];
  attachmentIds: string[];
  completionNotes?: string;
  completedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRecurrence {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  weekdays: number[];
  dayOfMonth?: number;
  localHour: number;
  localMinute: number;
  deadlineOffsetMinutes: number;
}

export interface TaskWithDetails extends Task {
  assignees: TaskAssignee[];
  updates: TaskUpdate[];
  submissions: TaskSubmission[];
}

export interface TaskUpdate {
  id: string;
  taskId: string;
  actorUserId?: string;
  updateType: string;
  body?: string;
  sourceMessageId?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface Attachment {
  id: string;
  storageKey?: string;
  sourceUrl?: string;
  kind: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'LINK';
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  sha256?: string;
  uploadedBy?: string;
  createdAt: Date;
}

export interface TaskSubmission {
  id: string;
  taskId: string;
  submitterUserId: string;
  note?: string;
  sourceMessageId?: string;
  attachmentIds: string[];
  submittedAt: Date;
}

export interface Announcement {
  id: string;
  publicId: string;
  groupId: string;
  createdBy: string;
  sourceMessageId?: string;
  category?: string;
  title?: string;
  body: string;
  mentionStrategy: MentionStrategy;
  interestTags: string[];
  status: AnnouncementStatus;
  publishAt?: Date;
  publishedAt?: Date;
  publishedMessageId?: string;
  expiresAt?: Date;
  attachmentIds: string[];
  failureReason?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Opportunity {
  id: string;
  announcementId?: string;
  title: string;
  category: string;
  summary: string;
  eligibility?: string;
  applicationUrl?: string;
  deadlineAt?: Date;
  sourceName?: string;
  sourceUrl?: string;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationKnowledge {
  id: string;
  title: string;
  content: string;
  tags: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpportunityCandidate {
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
  deadlineViability: number;
  totalScore: number;
  status: 'NEW' | 'REVIEW' | 'SAVED' | 'IGNORED';
  createdAt: Date;
  updatedAt: Date;
}

export interface CalendarEvent {
  id: string;
  externalId?: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt?: Date;
  timezone: string;
  source: 'INTERNAL' | 'GOOGLE_CALENDAR' | 'OBSERVANCE' | 'MANUAL';
  relevanceScore: number;
  preparationStage: 'AWARENESS' | 'EVALUATION' | 'PLANNING' | 'EXECUTION' | 'REVIEW' | 'PUBLISH' | 'EVENT_DAY';
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberActivity {
  id: string;
  userId: string;
  groupId: string;
  messageCount: number;
  lastMessageAt?: Date;
  lastMeaningfulAt?: Date;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberCheckin {
  id: string;
  userId: string;
  groupId: string;
  message: string;
  status: 'DRAFT' | 'SENT' | 'SKIPPED';
  createdAt: Date;
  sentAt?: Date;
}

export interface DailyOperationsSnapshot {
  date: string;
  upcomingEvents: CalendarEvent[];
  activeTasks: Task[];
  scheduledAnnouncements: Announcement[];
  opportunityCandidates: OpportunityCandidate[];
  activeMemberCount: number;
  activityRecords: MemberActivity[];
  draftCheckins: MemberCheckin[];
}

export interface PlanningRun {
  id: string;
  runAt: Date;
  status: 'SUCCEEDED' | 'FAILED';
  summary: string;
  createdAt: Date;
}

export interface ScheduledJob {
  id: string;
  jobKey: string;
  jobType: JobType;
  entityType: 'TASK' | 'ANNOUNCEMENT' | 'SYSTEM';
  entityId: string;
  runAt: Date;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  completedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  correlationId: string;
  actorUserId?: string;
  sourceMessageId?: string;
  action: string;
  entityType?: 'TASK' | 'ANNOUNCEMENT' | 'SUBMISSION' | 'USER' | 'GROUP';
  entityId?: string;
  originalInput?: string;
  interpretedPayload?: Record<string, unknown>;
  executedPayload?: Record<string, unknown>;
  outcome: 'SUCCEEDED' | 'REJECTED' | 'FAILED' | 'PENDING_CONFIRMATION';
  errorCode?: string;
  errorDetail?: string;
  createdAt: Date;
}

export interface ActionConfirmation {
  id: string;
  publicId: string;
  requestedBy: string;
  actionType: 'CREATE_EVERYONE_ANNOUNCEMENT' | 'CANCEL_TASK';
  draft: Record<string, unknown>;
  status: ConfirmationStatus;
  expiresAt: Date;
  confirmedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
}

export interface InboundMessage {
  id: string;
  chatJid: string;
  senderJid: string;
  text?: string;
  timestamp: Date;
  quotedMessageId?: string;
  quotedSenderJid?: string;
  mentions: string[];
  media?: InboundMedia;
}

export interface InboundMedia {
  kind: Attachment['kind'];
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  url?: string;
  data?: Uint8Array;
}

export interface OutboundMedia {
  kind: Attachment['kind'];
  data: Uint8Array;
  mimeType?: string;
  fileName?: string;
}

export interface OutboundMessage {
  chatJid: string;
  text: string;
  mentions?: string[];
  attachmentIds?: string[];
  media?: OutboundMedia[];
  correlationId: string;
}

export interface SentMessage {
  id: string;
  chatJid: string;
  sentAt: Date;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  groupId: string;
  assigneeIds?: string[];
  requiredCapability?: string;
  priority?: PriorityLevel;
  completionPolicy?: CompletionPolicy;
  publishAt?: Date;
  deadlineAt?: Date;
  recurrence?: TaskRecurrence;
  reminderOffsetsMinutes?: number[];
  attachmentIds?: string[];
  sourceMessageId?: string;
  sourceMessageText?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: PriorityLevel;
  publishAt?: Date;
  deadlineAt?: Date;
  reminderOffsetsMinutes?: number[];
  assigneeIds?: string[];
  completionNotes?: string;
  expectedVersion: number;
}

export interface CreateAnnouncementInput {
  groupId: string;
  body: string;
  title?: string;
  category?: string;
  mentionStrategy?: MentionStrategy;
  interestTags?: string[];
  publishAt?: Date;
  expiresAt?: Date;
  attachmentIds?: string[];
  sourceMessageId?: string;
}

export interface UpdateAnnouncementInput {
  title?: string;
  body?: string;
  category?: string;
  mentionStrategy?: MentionStrategy;
  interestTags?: string[];
  publishAt?: Date;
  expiresAt?: Date;
  attachmentIds?: string[];
  expectedVersion: number;
}
