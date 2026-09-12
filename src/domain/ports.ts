import type {
  Announcement,
  Attachment,
  ConversationMemory,
  AuditLog,
  Group,
  GroupMember,
  OfficialProfile,
  OrganizationKnowledge,
  Opportunity,
  ScheduledJob,
  Task,
  TaskAssignee,
  TaskSubmission,
  TaskUpdate,
  User
} from './types.js';

export interface TaskListFilter {
  status?: Task['status'];
  groupId?: string;
  assigneeUserId?: string;
  dueFrom?: Date;
  dueTo?: Date;
}

export interface AnnouncementListFilter {
  status?: Announcement['status'];
  groupId?: string;
}

export interface OperationsStore {
  createUser(user: User): Promise<User>;
  saveUser(user: User): Promise<User>;
  getUser(id: string): Promise<User | undefined>;
  findUserByJid(whatsappJid: string): Promise<User | undefined>;
  listUsers(): Promise<User[]>;

  saveOfficial(profile: OfficialProfile): Promise<OfficialProfile>;
  getOfficial(userId: string): Promise<OfficialProfile | undefined>;
  findOfficialsByName(name: string): Promise<Array<{ user: User; profile: OfficialProfile }>>;
  listOfficials(): Promise<Array<{ user: User; profile: OfficialProfile }>>;

  saveGroup(group: Group): Promise<Group>;
  getGroup(id: string): Promise<Group | undefined>;
  findGroupsByName(name: string): Promise<Group[]>;
  listGroups(): Promise<Group[]>;
  replaceGroupMembers(groupId: string, members: GroupMember[]): Promise<void>;
  listGroupMembers(groupId: string): Promise<GroupMember[]>;

  markMessageProcessed(messageId: string): Promise<boolean>;

  getConversationMemory(scopeKey: string, now: Date): Promise<ConversationMemory | undefined>;
  saveConversationMemory(memory: ConversationMemory): Promise<ConversationMemory>;
  deleteConversationMemory(scopeKey: string): Promise<void>;

  createTask(task: Task, assignees: TaskAssignee[]): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  listTaskAttachmentIds(taskId: string): Promise<string[]>;
  findTaskByPublishedMessageId(messageId: string): Promise<Task | undefined>;
  listTasks(filter?: TaskListFilter): Promise<Task[]>;
  saveTask(task: Task, expectedVersion: number): Promise<Task>;
  listTaskAssignees(taskId: string): Promise<TaskAssignee[]>;
  listTaskAssigneesForTasks(taskIds: string[]): Promise<TaskAssignee[]>;
  getTaskAssignee(taskId: string, userId: string): Promise<TaskAssignee | undefined>;
  saveTaskAssignee(assignee: TaskAssignee): Promise<TaskAssignee>;
  replaceTaskAssignees(taskId: string, assignees: TaskAssignee[]): Promise<void>;
  addTaskUpdate(update: TaskUpdate): Promise<TaskUpdate>;
  listTaskUpdates(taskId: string): Promise<TaskUpdate[]>;
  createSubmission(submission: TaskSubmission): Promise<TaskSubmission>;
  listTaskSubmissions(taskId: string): Promise<TaskSubmission[]>;

  createAttachment(attachment: Attachment): Promise<Attachment>;
  getAttachment(id: string): Promise<Attachment | undefined>;

  createAnnouncement(announcement: Announcement): Promise<Announcement>;
  getAnnouncement(id: string): Promise<Announcement | undefined>;
  listAnnouncements(filter?: AnnouncementListFilter): Promise<Announcement[]>;
  saveAnnouncement(announcement: Announcement, expectedVersion: number): Promise<Announcement>;

  saveOpportunity(opportunity: Opportunity): Promise<Opportunity>;
  listActiveOpportunities(query?: string): Promise<Opportunity[]>;
  saveOrganizationKnowledge(item: OrganizationKnowledge): Promise<OrganizationKnowledge>;
  searchOrganizationKnowledge(query: string, limit?: number): Promise<OrganizationKnowledge[]>;
  saveOpportunityCandidate(candidate: import('./types.js').OpportunityCandidate): Promise<import('./types.js').OpportunityCandidate>;
  listOpportunityCandidates(minScore?: number): Promise<import('./types.js').OpportunityCandidate[]>;

  saveCalendarEvent(event: import('./types.js').CalendarEvent): Promise<import('./types.js').CalendarEvent>;
  getCalendarEvent(id: string): Promise<import('./types.js').CalendarEvent | undefined>;
  listCalendarEvents(from?: Date, to?: Date): Promise<import('./types.js').CalendarEvent[]>;
  recordMemberActivity(activity: import('./types.js').MemberActivity): Promise<import('./types.js').MemberActivity>;
  listMemberActivity(groupId?: string, since?: Date): Promise<import('./types.js').MemberActivity[]>;
  saveMemberCheckin(checkin: import('./types.js').MemberCheckin): Promise<import('./types.js').MemberCheckin>;
  listMemberCheckins(userId?: string, since?: Date): Promise<import('./types.js').MemberCheckin[]>;
  savePlanningRun(run: import('./types.js').PlanningRun): Promise<import('./types.js').PlanningRun>;
  listPlanningRuns(since?: Date): Promise<import('./types.js').PlanningRun[]>;

  createJob(job: ScheduledJob): Promise<ScheduledJob>;
  getJobByKey(jobKey: string): Promise<ScheduledJob | undefined>;
  listJobsForEntity(entityType: ScheduledJob['entityType'], entityId: string): Promise<ScheduledJob[]>;
  claimJob(jobKey: string, now: Date): Promise<ScheduledJob | undefined>;
  listDueJobs(now: Date): Promise<ScheduledJob[]>;
  listFailedJobs(since: Date): Promise<ScheduledJob[]>;
  recoverStaleJobs(staleBefore: Date, now: Date): Promise<number>;
  completeJob(jobKey: string, completedAt: Date): Promise<void>;
  failJob(jobKey: string, error: string, retryAt?: Date): Promise<void>;
  cancelJobsForEntity(
    entityType: ScheduledJob['entityType'],
    entityId: string,
    options?: { preserveTypes?: ScheduledJob['jobType'][] }
  ): Promise<void>;

  addAuditLog(log: AuditLog): Promise<AuditLog>;
  listAuditLogs(entityType?: AuditLog['entityType'], entityId?: string): Promise<AuditLog[]>;

  createActionConfirmation(confirmation: import('./types.js').ActionConfirmation): Promise<import('./types.js').ActionConfirmation>;
  getActionConfirmation(idOrPublicId: string): Promise<import('./types.js').ActionConfirmation | undefined>;
  confirmActionConfirmation(idOrPublicId: string, requestedBy: string, now: Date): Promise<import('./types.js').ActionConfirmation | undefined>;
  cancelActionConfirmation(idOrPublicId: string, requestedBy: string, now: Date): Promise<import('./types.js').ActionConfirmation | undefined>;
}

export interface JobScheduler {
  schedule(job: ScheduledJob): Promise<void>;
  start?(handler: (jobKey: string) => Promise<void>): Promise<void>;
  close?(): Promise<void>;
}

export interface MediaStore {
  put(key: string, data: Uint8Array, contentType?: string): Promise<string>;
  get(key: string): Promise<Uint8Array>;
}

export interface WhatsAppGateway {
  connect(): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  listGroups?(): Promise<Array<{ whatsappJid: string; name: string; participantCount: number }>>;
  listGroupParticipants?(groupJid: string): Promise<Array<{ jid: string; isAdmin: boolean }>>;
  sendText(message: import('./types.js').OutboundMessage): Promise<import('./types.js').SentMessage>;
  isConnected(): boolean;
  setInboundHandler?(handler: (message: import('./types.js').InboundMessage) => Promise<void>): void;
  setGroupParticipantHandler?(handler: (event: GroupParticipantEvent) => Promise<void>): void;
}

export interface GroupParticipantEvent {
  groupJid: string;
  participants: string[];
  action: 'add' | 'invite' | 'promote' | 'demote' | 'remove' | 'leave';
}

export interface AIProvider {
  extractCommand(input: AICommandInput): Promise<AICommandDraft>;
  draftReply(input: AIReplyInput): Promise<string>;
}

export interface AICommandInput {
  text: string;
  senderRole: User['role'];
  timezone: string;
  now: Date;
  defaultOfficialsGroupName?: string;
  defaultCommunityGroupName?: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export type AIIntent =
  | 'CREATE_TASK'
  | 'UPDATE_TASK'
  | 'CANCEL_TASK'
  | 'ACKNOWLEDGE_TASK'
  | 'SUBMIT_TASK'
  | 'TASK_STATUS'
  | 'CREATE_ANNOUNCEMENT'
  | 'SCHEDULE_ANNOUNCEMENT'
  | 'ASK_COMMUNITY_QUESTION'
  | 'ASK_ORGANIZATION_QUESTION'
  | 'GENERATE_CONTENT'
  | 'REPORT_REQUEST'
  | 'GENERAL_CONVERSATION'
  | 'UNKNOWN';

export interface AICommandDraft {
  intent: AIIntent;
  confidence: number;
  needsClarification: boolean;
  clarificationQuestion?: string;
  task?: {
    title?: string;
    description?: string;
    assigneeNames: string[];
    groupName?: string;
    priority?: Task['priority'];
    publishAtText?: string;
    deadlineAtText?: string;
  };
  announcement?: {
    body?: string;
    title?: string;
    groupName?: string;
    category?: string;
    publishAtText?: string;
    expiresAtText?: string;
    mentionStrategy?: Announcement['mentionStrategy'];
    interestTags?: string[];
  };
}

export interface AIReplyInput {
  userMessage: string;
  facts: string[];
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  tone: 'WARM' | 'FIRM' | 'PROFESSIONAL' | 'CONCISE';
  mode?: 'FACTUAL' | 'CREATIVE';
  fallback: string;
}
