import { AppError } from '../../common/errors.js';
import { newCorrelationId, newId } from '../../common/ids.js';
import { formatDateTime, moveIntoWorkingHours, parseNaturalDate } from '../../common/time.js';
import { inferDeadlineAt, inferPriority, parseTaskRecurrence } from '../../common/recurrence.js';
import type { AIProvider, GroupParticipantEvent, MediaStore, OperationsStore, WhatsAppGateway } from '../../domain/ports.js';
import type { Attachment, GroupMember, InboundMessage, Task, User } from '../../domain/types.js';
import { AuditService } from '../audit/audit.service.js';
import { AnnouncementService } from '../community/announcement.service.js';
import { ConfirmationService } from '../confirmations/confirmation.service.js';
import { ReportService } from '../reports/report.service.js';
import { PlanningService } from '../reports/planning.service.js';
import { TaskService } from '../tasks/task.service.js';
import { EngagementMonitoringService } from '../engagement/engagement-monitoring.service.js';

export interface InboundHandlingResult {
  handled: boolean;
  ignored?: boolean;
  reply?: string;
}

export class InboundRouter {
  private readonly inboundRateWindows = new Map<string, number[]>();
  public constructor(
    private readonly store: OperationsStore,
    private readonly gateway: WhatsAppGateway,
    private readonly mediaStore: MediaStore,
    private readonly ai: AIProvider,
    private readonly tasks: TaskService,
    private readonly announcements: AnnouncementService,
    private readonly confirmations: ConfirmationService,
    private readonly reports: ReportService,
    private readonly planning: PlanningService,
    private readonly audit: AuditService,
    private readonly engagement: EngagementMonitoringService,
    private readonly botJid: string,
    private readonly botName: string,
    private readonly organizationName: string,
    private readonly organizationTimezone: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async handle(message: InboundMessage): Promise<InboundHandlingResult> {
    const accepted = await this.store.markMessageProcessed(message.id);
    if (!accepted) return { handled: false, ignored: true };
    try {
      return await this.handleProcessed(message);
    } catch (error) {
      const correlationId = newCorrelationId();
      const appError = error instanceof AppError ? error : undefined;
      await this.audit.write({
        correlationId,
        sourceMessageId: message.id,
        action: 'INBOUND_MESSAGE_FAILED',
        originalInput: message.text,
        outcome: 'FAILED',
        errorCode: appError?.code ?? 'UNEXPECTED_ERROR',
        errorDetail: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      const reply = appError && appError.statusCode < 500
        ? appError.message
        : 'I ran into a temporary problem while handling that. I have recorded the failure—please try again in a moment.';
      if (this.gateway.isConnected()) {
        await this.gateway.sendText({ chatJid: message.chatJid, text: reply, correlationId }).catch(() => undefined);
      }
      return { handled: true, reply };
    }
  }

  private async handleProcessed(message: InboundMessage): Promise<InboundHandlingResult> {
    const isGroup = message.chatJid.endsWith('@g.us');
    const configuredGroup = isGroup
      ? (await this.store.listGroups()).find((candidate) => candidate.active && candidate.whatsappJid === message.chatJid)
      : undefined;
    let sender = await this.store.findUserByJid(message.senderJid);
    if (!sender && configuredGroup?.type === 'COMMUNITY') {
      sender = await this.registerCommunityMember(message.senderJid, configuredGroup.id);
    }
    if (sender?.active && configuredGroup) {
      await this.engagement.recordMessage(sender.id, configuredGroup.id, Boolean(message.text?.trim()));
    }
    const repliedTask = message.quotedMessageId
      ? await this.store.findTaskByPublishedMessageId(message.quotedMessageId)
      : undefined;
    const invoked = !isGroup || message.mentions.includes(this.botJid) || message.quotedSenderJid === this.botJid || Boolean(repliedTask);
    if (!invoked) {
      if (sender?.active && configuredGroup && message.text?.trim()) {
        await this.rememberGroupMessage(configuredGroup.id, sender, message.text);
      }
      return { handled: false, ignored: true };
    }
    const correlationId = newCorrelationId();

    if (!sender?.active) {
      return this.respond(message, 'I can only help registered members in this group.', correlationId);
    }
    if (this.isRateLimited(sender)) {
      return this.respond(message, 'Give me a short moment, please—I’m receiving several requests at once.', correlationId);
    }
    if (this.looksLikeIntroductionRequest(message.text)) {
      return this.respond(message, this.introductionMessage(), correlationId);
    }
    if (this.looksLikeWelcome(message.text)) {
      return this.respond(message, `Thank you for the warm welcome. I’m happy to be here and ready to help the ${this.organizationName} team.`, correlationId);
    }
    if (sender.role === 'SUPER_ADMIN') {
      return this.handleAdmin(message, sender, correlationId);
    }
    if (repliedTask && sender.role === 'OFFICIAL') {
      return this.handleOfficialTaskReply(message, sender, repliedTask, correlationId);
    }
    if (sender.role === 'OFFICIAL' && /^\s*\d+\s*$/.test(message.text ?? '')) {
      const selected = await this.handleOfficialTaskSelection(message, sender, correlationId);
      if (selected) return selected;
    }
    if (sender.role === 'OFFICIAL' && this.looksLikeSubmission(message.text)) {
      return this.handleOfficialUnthreadedSubmission(message, sender, correlationId);
    }
    if (sender.role === 'OFFICIAL' && /\b(?:blocked|blocker|started|starting|working on it|in progress|acknowledge|got it)\b/i.test(message.text ?? '')) {
      return this.handleOfficialUnthreadedUpdate(message, sender, correlationId);
    }
    if (sender.role === 'OFFICIAL' && /\b(?:my tasks?|tasks? assigned to me|what.*tasks?)\b/i.test(message.text ?? '')) {
      return this.handleOfficialTaskStatus(message, sender, correlationId);
    }
    if (this.looksLikeUnauthorizedCommand(message.text) && !this.looksLikeContentRequest(message.text)) {
      await this.audit.write({
        correlationId,
        actorUserId: sender.id,
        sourceMessageId: message.id,
        action: 'UNAUTHORIZED_OPERATION_ATTEMPT',
        entityType: 'USER',
        entityId: sender.id,
        originalInput: message.text,
        outcome: 'REJECTED',
        errorCode: 'FORBIDDEN'
      });
      return this.respond(message, 'Nice try — you do not have permission to do that.', correlationId);
    }
    if (/\b(?:i am|i'm|interested in|my interests? (?:are|is))\b/i.test(message.text ?? '') && /\b(?:grant|scholarship|audition|competition|event|webinar|training|funding|internship|music)\b/i.test(message.text ?? '')) {
      return this.updateMemberInterests(message, sender, correlationId);
    }
    return this.handleCommunityQuestion(message, sender, correlationId);
  }

  private async updateMemberInterests(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const supported = ['music', 'grants', 'scholarships', 'auditions', 'competitions', 'events', 'webinars', 'training', 'funding', 'internships'];
    const text = (message.text ?? '').toLowerCase();
    const tags = supported.filter((tag) => text.includes(tag) || text.includes(tag.replace(/s$/, '')));
    const saved = await this.store.saveUser({ ...sender, interestTags: [...new Set([...(sender.interestTags ?? []), ...tags])], updatedAt: this.now() });
    return this.respond(message, `Got you. I’ll prioritize ${saved.interestTags?.join(', ')} when relevant updates are shared.`, correlationId);
  }

  private isRateLimited(sender: User): boolean {
    const now = this.now().getTime();
    const threshold = sender.role === 'SUPER_ADMIN' ? 40 : 12;
    const recent = (this.inboundRateWindows.get(sender.id) ?? []).filter((value) => now - value < 60_000);
    recent.push(now);
    this.inboundRateWindows.set(sender.id, recent);
    return recent.length > threshold;
  }

  public async handleGroupParticipants(event: GroupParticipantEvent): Promise<void> {
    const group = (await this.store.listGroups()).find((candidate) =>
      candidate.whatsappJid === event.groupJid && candidate.active && candidate.type === 'COMMUNITY'
    );
    if (!group) return;
    if (['remove', 'leave'].includes(event.action)) {
      const leaving = new Set(event.participants);
      const members = await this.store.listGroupMembers(group.id);
      const updated = await Promise.all(members.map(async (member) => {
        const user = await this.store.getUser(member.userId);
        return leaving.has(user?.whatsappJid ?? '') ? { ...member, active: false, lastSyncedAt: this.now() } : member;
      }));
      await this.store.replaceGroupMembers(group.id, updated);
      return;
    }
    if (!['add', 'invite'].includes(event.action)) return;
    const entrants = await Promise.all(event.participants.map(async (jid) => {
      const user = await this.registerCommunityMember(jid, group.id);
      return { jid, name: user?.displayName ?? 'new member' };
    }));
    const names = entrants.map(({ name }) => name).join(', ');
    const text = entrants.length === 1
      ? `Welcome to the ${this.organizationName} community, ${names}!\n\nYou’re now part of a community of musicians and creatives connecting, growing, sharing opportunities, and creating impact through music.\n\nFeel free to introduce yourself and tell us what you do in music.\n\nWelcome to the family! 💚🎵`
      : `Welcome to the ${this.organizationName} community, ${names}!\n\nYou’re now part of a community of musicians and creatives connecting, growing, sharing opportunities, and creating impact through music.\n\nFeel free to introduce yourselves and tell us what you do in music.\n\nWelcome to the family! 💚🎵`;
    await this.gateway.sendText({
      chatJid: group.whatsappJid,
      text,
      mentions: entrants.map(({ jid }) => jid),
      correlationId: newCorrelationId()
    });
  }

  private async registerCommunityMember(jid: string, groupId: string, updateMembership = true): Promise<User> {
    let user = await this.store.findUserByJid(jid);
    if (!user) {
      const phone = jid.split('@')[0]?.split(':')[0] ?? jid;
      try {
        user = await this.store.createUser({
          id: newId(),
          whatsappJid: jid,
          phoneE164: /^\d+$/.test(phone) ? `+${phone}` : undefined,
          displayName: /^\d+$/.test(phone) ? `+${phone}` : 'Community member',
          role: 'COMMUNITY_MEMBER',
          active: true,
          createdAt: this.now(),
          updatedAt: this.now()
        });
      } catch (error) {
        user = await this.store.findUserByJid(jid);
        if (!user) throw error;
      }
    }
    if (updateMembership) {
      const members = await this.store.listGroupMembers(groupId);
      const existing = members.find((member) => member.userId === user!.id);
      await this.store.replaceGroupMembers(groupId, [
        ...members.filter((member) => member.userId !== user!.id),
        { groupId, userId: user.id, isAdmin: existing?.isAdmin ?? false, active: true, lastSyncedAt: this.now() }
      ]);
    }
    return user;
  }

  private async rememberGroupMessage(groupId: string, sender: User, text: string): Promise<void> {
    const now = this.now();
    const scopeKey = `group:${groupId}`;
    const existing = await this.store.getConversationMemory(scopeKey, now);
    const label = sender.displayName ?? sender.phoneE164 ?? 'Member';
    await this.store.saveConversationMemory({
      id: existing?.id ?? newId(),
      scopeKey,
      groupId,
      turns: [
        ...(existing?.turns ?? []),
        { role: 'user' as const, content: `[${label}] ${text}`, createdAt: now }
      ].slice(-12),
      expiresAt: new Date(now.getTime() + 6 * 60 * 60 * 1000),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  public async syncConfiguredGroupMembership(): Promise<number> {
    if (!this.gateway.listGroupParticipants || !this.gateway.isConnected()) return 0;
    let synced = 0;
    for (const group of (await this.store.listGroups()).filter((candidate) => candidate.active)) {
      const participants = await this.gateway.listGroupParticipants(group.whatsappJid);
      if (!participants.length) continue;
      const members: GroupMember[] = [];
      for (const participant of participants) {
        let user = await this.store.findUserByJid(participant.jid);
        if (!user && group.type === 'COMMUNITY') user = await this.registerCommunityMember(participant.jid, group.id, false);
        if (!user) continue;
        members.push({ groupId: group.id, userId: user.id, isAdmin: participant.isAdmin, active: true, lastSyncedAt: this.now() });
      }
      await this.store.replaceGroupMembers(group.id, members);
      synced += members.length;
    }
    return synced;
  }

  private async handleAdmin(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const confirmationCommand = (message.text ?? '').trim().match(/^(confirm|cancel)\s+(MH-CONF-[A-Z0-9-]+)$/i);
    if (confirmationCommand?.[1] && confirmationCommand[2]) {
      const action = confirmationCommand[1].toLowerCase();
      if (action === 'confirm') {
        const result = await this.confirmations.confirm(confirmationCommand[2], {
          actor: sender,
          correlationId,
          sourceMessageId: message.id,
          originalInput: message.text
        });
        return this.respond(
          message,
          result.taskId
            ? 'Confirmed. I’ve cancelled the task and stopped its remaining reminders.'
            : `Confirmed. I’ve scheduled the everyone-mention announcement as ${result.announcementId}.`,
          correlationId
        );
      }
      await this.confirmations.cancel(confirmationCommand[2], {
        actor: sender,
        correlationId,
        sourceMessageId: message.id,
        originalInput: message.text
      });
      return this.respond(message, 'Cancelled. That announcement will not be published.', correlationId);
    }
    let allGroups = await this.store.listGroups();
    const officialsGroups = allGroups.filter((group) => group.active && group.type === 'OFFICIALS');
    const communityGroups = allGroups.filter((group) => group.active && group.type === 'COMMUNITY');
    const conversationScope = `admin:${sender.id}:${message.chatJid}`;
    if (/^\s*(?:start over|forget (?:this|that) conversation)\s*[.!]?\s*$/i.test(message.text ?? '')) {
      await this.store.deleteConversationMemory(conversationScope);
      return this.respond(message, 'No problem. I’ve cleared our recent conversation context, so we can start fresh.', correlationId);
    }
    const memory = await this.store.getConversationMemory(conversationScope, this.now());
    const finish = async (action: Promise<InboundHandlingResult>): Promise<InboundHandlingResult> => {
      const result = await action;
      if (result.reply) {
        await this.rememberConversation({
          scopeKey: conversationScope,
          userId: sender.id,
          groupId: allGroups.find((group) => group.whatsappJid === message.chatJid)?.id,
          userMessage: message.text ?? '',
          assistantMessage: result.reply
        });
      }
      return result;
    };
    if (/^\s*(?:add|register)\b/i.test(message.text ?? '') && /\+?\d[\d\s-]{8,}/.test(message.text ?? '')) {
      return finish(this.registerOfficialFromMessage(message, sender, correlationId));
    }
    if (/\b(?:how many groups|what groups|which groups)\b.*\b(?:do you have access to|are you in|can you access)\b/i.test(message.text ?? '')) {
      const activeGroups = allGroups.filter((group) => group.active);
      const reply = activeGroups.length
        ? `I currently have access to ${activeGroups.length} active group${activeGroups.length === 1 ? '' : 's'}:\n${activeGroups.map((group) => `• ${group.name} (${group.whatsappJid})`).join('\n')}`
        : 'I currently have access to no active groups.';
      return finish(this.respond(message, reply, correlationId));
    }
    if (/^\s*(?:all(?:\s+of)?\s+the)?\s*(?:groups?|the groups?)\s+(?:you are|you have access to|you are in)\b/i.test(message.text ?? '')) {
      const activeGroups = allGroups.filter((group) => group.active);
      const reply = activeGroups.length
        ? `I currently have access to ${activeGroups.length} active group${activeGroups.length === 1 ? '' : 's'}:\n${activeGroups.map((group) => `• ${group.name} (${group.whatsappJid})`).join('\n')}`
        : 'I currently have access to no active groups.';
      return finish(this.respond(message, reply, correlationId));
    }
    const simpleBroadcastText = (() => {
      const text = (message.text ?? '').trim();
      const explicitDrop = text.match(/^(?:just\s+)?(?:drop|send|post|publish)\s+(?:a\s+)?(?:message|announcement)?\s*(.+)$/i)?.[1]?.trim();
      if (explicitDrop) {
        return explicitDrop
          .replace(/\b(?:in|to)\s+(?:those|all)\s+(?:groups?|the groups?)\b.*$/i, '')
          .replace(/\b(?:now|please)\b/gi, '')
          .trim();
      }
      if (/^greetings?$/i.test(text)) {
        return 'Greetings';
      }
      return undefined;
    })();
    if (simpleBroadcastText !== undefined) {
      const visibleGroups = allGroups.filter((group) => group.active);
      if (!visibleGroups.length) {
        return finish(this.respond(message, 'I currently have no active groups configured to send a message to.', correlationId));
      }
      if (!simpleBroadcastText) {
        return finish(this.respond(message, 'What message would you like me to send to the active groups?', correlationId));
      }
      await Promise.all(visibleGroups.map(async (group) => this.gateway.sendText({
        chatJid: group.whatsappJid,
        text: simpleBroadcastText,
        correlationId
      })));
      return finish(this.respond(
        message,
        `Done — I sent the message to ${visibleGroups.length} active group${visibleGroups.length === 1 ? '' : 's'}: ${visibleGroups.map((group) => group.name).join(', ')}.`,
        correlationId
      ));
    }
    if (/^\s*(?:remember that|save (?:this|that) (?:to|in) (?:the )?(?:knowledge base|organization knowledge)|track this information(?: in your memory)?)\b/i.test(message.text ?? '')) {
      return finish(this.saveKnowledgeFromMessage(message, sender, correlationId, memory));
    }
    if (/\b(?:plan (?:my|the|our) day|today'?s plan|operations brief|brief me)\b/i.test(message.text ?? '')) {
      const snapshot = await this.planning.dailySnapshot();
      return finish(this.respond(message, this.planning.render(snapshot), correlationId));
    }
    if (/\b(?:send|approve)\b.*\bcheck-?ins?\b/i.test(message.text ?? '')) {
      return finish(this.sendApprovedCheckins(message, sender, correlationId));
    }
    if (/\b(?:mark|set)\b.+\b(?:task\s+)?(?:complete|completed)\b|\bcomplete\b.+\btask\b/i.test(message.text ?? '')) {
      return finish(this.completeTaskFromMessage(message, sender, correlationId));
    }
    const draft = await this.ai.extractCommand({
      text: message.text ?? '',
      senderRole: sender.role,
      timezone: this.organizationTimezone,
      now: this.now(),
      defaultOfficialsGroupName: officialsGroups.length === 1 ? officialsGroups[0]!.name : undefined,
      defaultCommunityGroupName: communityGroups.length === 1 ? communityGroups[0]!.name : undefined,
      conversationHistory: memory?.turns.slice(-8).map((turn) => ({ role: turn.role, content: turn.content }))
    });
    const discoveredGroupName = await this.discoverMentionedGroup(message, draft.intent);
    allGroups = await this.store.listGroups();
    if (discoveredGroupName && draft.intent === 'CREATE_TASK' && draft.task && !draft.task.groupName) {
      draft.task.groupName = discoveredGroupName;
    }
    if (
      discoveredGroupName
      && ['CREATE_ANNOUNCEMENT', 'SCHEDULE_ANNOUNCEMENT'].includes(draft.intent)
      && draft.announcement
      && !draft.announcement.groupName
    ) {
      draft.announcement.groupName = discoveredGroupName;
    }
    if (draft.intent === 'CREATE_TASK' && draft.task && !draft.task.groupName && officialsGroups.length === 1) {
      draft.task.groupName = officialsGroups[0]!.name;
    }
    const taskCanBeCompleted = draft.intent === 'CREATE_TASK'
      && Boolean(draft.task?.title)
      && Boolean(draft.task?.assigneeNames.length)
      && Boolean(draft.task?.groupName);
    if (draft.needsClarification && !taskCanBeCompleted) {
      return finish(this.respond(message, draft.clarificationQuestion ?? 'Could you clarify that for me?', correlationId));
    }
    switch (draft.intent) {
      case 'CREATE_TASK':
        return finish(this.createTaskFromDraft(message, sender, draft, correlationId));
      case 'CREATE_ANNOUNCEMENT':
      case 'SCHEDULE_ANNOUNCEMENT':
        return finish(this.createAnnouncementFromDraft(message, sender, draft, correlationId));
      case 'REPORT_REQUEST': {
        const weekly = /\bweek(?:ly)?\b/i.test(message.text ?? '');
        const reply = weekly
          ? this.reports.renderWeekly(await this.reports.weekly())
          : this.reports.renderDaily(await this.reports.daily());
        return finish(this.respond(message, reply, correlationId));
      }
      case 'TASK_STATUS': {
        const tasks = await this.store.listTasks();
        const active = tasks.filter((task) => ['SCHEDULED', 'ACTIVE', 'SUBMITTED', 'OVERDUE'].includes(task.status));
        return finish(this.respond(
          message,
          active.length ? `You have ${active.length} active task(s):\n${active.map((task) => `• ${task.title} — ${task.status}`).join('\n')}` : 'There are no active tasks right now.',
          correlationId
        ));
      }
      case 'UPDATE_TASK':
        return finish(this.updateTaskFromMessage(message, sender, correlationId));
      case 'CANCEL_TASK':
        return finish(this.requestTaskCancellation(message, sender, correlationId));
      case 'GENERATE_CONTENT':
        return finish(this.respond(message, await this.ai.draftReply({
          userMessage: message.text ?? '',
          facts: [
            'The sender is the authenticated Super Admin.',
            'This is a content-generation request only; no task, announcement, or database record has been created.'
          ],
          conversationHistory: memory?.turns.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
          tone: 'WARM',
          mode: 'CREATIVE',
          fallback: 'I couldn’t generate that draft just now. Please try again in a moment.'
        }), correlationId));
      default:
        return finish(this.respond(message, await this.ai.draftReply({
          userMessage: message.text ?? '',
          facts: [
            'The sender is the authenticated Super Admin.',
            `${this.botName} can create tasks, schedule announcements, and produce daily or weekly reports.`,
            `The configured officials group is ${officialsGroups.length === 1 ? officialsGroups[0]!.name : 'not uniquely configured'}.`
          ],
          conversationHistory: memory?.turns.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
          tone: 'WARM',
          fallback: "I’m ready. You can ask me to create a task, schedule an announcement, or give you today's report."
        }), correlationId));
    }
  }

  private async saveKnowledgeFromMessage(
    message: InboundMessage,
    sender: User,
    correlationId: string,
    memory?: { turns?: Array<{ role: 'user' | 'assistant'; content: string }> }
  ): Promise<InboundHandlingResult> {
    const stripped = (message.text ?? '').replace(/^\s*(?:remember that|save (?:this|that) (?:to|in) (?:the )?(?:knowledge base|organization knowledge)|track this information(?: in your memory)?)\s*[:,-]?\s*/i, '').trim();
    const content = stripped || [...(memory?.turns ?? [])].reverse().find((turn) => turn.role === 'assistant')?.content?.trim() || '';
    if (!content) return this.respond(message, 'What information should I add to the organization knowledge base?', correlationId);
    const title = content.split(/[.!?\n]/).find(Boolean)?.trim().slice(0, 120) ?? 'Organization note';
    const now = this.now();
    const item = await this.store.saveOrganizationKnowledge({
      id: newId(), title, content, tags: [], active: true, createdAt: now, updatedAt: now
    });
    await this.audit.write({
      correlationId,
      actorUserId: sender.id,
      sourceMessageId: message.id,
      action: 'ORGANIZATION_KNOWLEDGE_SAVED',
      originalInput: message.text,
      executedPayload: { knowledgeId: item.id, title: item.title },
      outcome: 'SUCCEEDED'
    });
    return this.respond(message, `Saved. I’ll use “${item.title}” when answering relevant organization questions.`, correlationId);
  }

  private async sendApprovedCheckins(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const drafts = (await this.store.listMemberCheckins()).filter((checkin) => checkin.status === 'DRAFT').slice(0, 10);
    let sent = 0;
    for (const draft of drafts) {
      const user = await this.store.getUser(draft.userId);
      if (!user?.active) continue;
      await this.gateway.sendText({ chatJid: user.whatsappJid, text: draft.message, correlationId });
      await this.store.saveMemberCheckin({ ...draft, status: 'SENT', sentAt: this.now() });
      sent += 1;
    }
    await this.audit.write({
      correlationId,
      actorUserId: sender.id,
      sourceMessageId: message.id,
      action: 'COMMUNITY_CHECKINS_SENT',
      originalInput: message.text,
      executedPayload: { count: sent },
      outcome: 'SUCCEEDED'
    });
    return this.respond(message, sent ? `Done — I sent ${sent} approved community check-in${sent === 1 ? '' : 's'}.` : 'There are no draft community check-ins waiting for approval.', correlationId);
  }

  private async registerOfficialFromMessage(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const text = message.text ?? '';
    const phoneMatch = text.match(/\+?\d[\d\s-]{8,}\d/);
    if (!phoneMatch) return this.respond(message, 'Please include the official’s WhatsApp number.', correlationId);
    let digits = phoneMatch[0].replace(/\D/g, '');
    if (digits.startsWith('0')) digits = `234${digits.slice(1)}`;
    const beforePhone = text.slice(0, phoneMatch.index).replace(/^\s*(?:add|register)\s+/i, '').replace(/\b(?:official|team member|member)\b/gi, '').trim().replace(/[,:-]+$/, '').trim();
    const afterPhone = text.slice((phoneMatch.index ?? 0) + phoneMatch[0].length);
    const afterAs = afterPhone.match(/\b(?:as|role\s*[:=-]?)\s+(.+)$/i)?.[1]?.trim();
    const nameAfter = afterPhone.match(/^\s*[-,:]\s*([^,]+?)(?:,|\bas\b|\brole\b|$)/i)?.[1]?.trim();
    const name = beforePhone || nameAfter;
    const role = afterAs ?? afterPhone.replace(/^\s*[-,:]\s*/, '').replace(new RegExp(`^${(nameAfter ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*,?\s*`), '').trim();
    if (!name) return this.respond(message, 'What name should I use for this official?', correlationId);
    if (!role) return this.respond(message, `What role should I record for ${name}?`, correlationId);
    const jid = `${digits}@s.whatsapp.net`;
    const now = this.now();
    const existing = await this.store.findUserByJid(jid);
    const officialUser = await this.store.saveUser({
      id: existing?.id ?? newId(),
      whatsappJid: jid,
      phoneE164: `+${digits}`,
      displayName: name,
      role: 'OFFICIAL',
      active: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    await this.store.saveOfficial({
      userId: officialUser.id,
      fullName: name,
      jobRole: role,
      capabilities: role.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2),
      active: true,
      interestTags: []
    });
    for (const group of (await this.store.listGroups()).filter((candidate) => candidate.active && candidate.type === 'OFFICIALS')) {
      const members = await this.store.listGroupMembers(group.id);
      await this.store.replaceGroupMembers(group.id, [
        ...members.filter((member) => member.userId !== officialUser.id),
        { groupId: group.id, userId: officialUser.id, isAdmin: false, active: true, lastSyncedAt: now }
      ]);
    }
    await this.audit.write({
      correlationId,
      actorUserId: sender.id,
      sourceMessageId: message.id,
      action: 'OFFICIAL_REGISTERED',
      entityType: 'USER',
      entityId: officialUser.id,
      originalInput: message.text,
      executedPayload: { displayName: name, jobRole: role },
      outcome: 'SUCCEEDED'
    });
    return this.respond(message, `Done — ${name} is registered as ${role}. I’ll recognize and tag ${name} using @${digits}.`, correlationId);
  }

  private async requestTaskCancellation(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const task = await this.resolveTaskReference(message.text ?? '');
    if (!task) return this.respond(message, 'Which active task should I cancel? Please use its task ID or enough of its title.', correlationId);
    const confirmation = await this.confirmations.requestTaskCancellation(
      task,
      `Cancelled from WhatsApp instruction: ${message.text ?? ''}`,
      { actor: sender, correlationId, sourceMessageId: message.id, originalInput: message.text }
    );
    return this.respond(
      message,
      `You’re about to cancel *${task.title}*. Reply *Confirm ${confirmation.publicId}* within 15 minutes, or *Cancel ${confirmation.publicId}* to keep it.`,
      correlationId
    );
  }

  private async completeTaskFromMessage(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const task = await this.resolveTaskReference(message.text ?? '');
    if (!task) return this.respond(message, 'Which active task should I mark completed? Please use its task ID or title.', correlationId);
    await this.tasks.complete(task.id, task.version, message.text, {
      actor: sender,
      correlationId,
      sourceMessageId: message.id,
      originalInput: message.text
    });
    return this.respond(message, `Done — *${task.title}* is now completed. Beautiful work, team.`, correlationId);
  }

  private async updateTaskFromMessage(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const text = message.text ?? '';
    const task = await this.resolveTaskReference(text);
    if (!task) return this.respond(message, 'Which active task should I update? Please use its task ID or enough of its title.', correlationId);
    const deadlineText = text.match(/\b(?:deadline|due)(?:\s+(?:is|to|on|by))?\s*[:\-]?\s*(.+)$/i)?.[1]
      ?? text.match(/\bmove\b.+?\bto\b\s+(.+)$/i)?.[1];
    const deadlineAt = deadlineText ? this.parseTaskDeadline(deadlineText, message.timestamp) : undefined;
    const priorityMatch = text.match(/\b(low|normal|high|urgent)(?:\s+priority)?\b/i)?.[1]?.toUpperCase() as Task['priority'] | undefined;
    if (deadlineText && !deadlineAt) {
      return this.respond(message, 'I couldn’t understand the new deadline. Try something like “Friday at 5 PM”.', correlationId);
    }
    if (!deadlineAt && !priorityMatch) {
      return this.respond(message, 'Tell me the new deadline or priority you want for that task.', correlationId);
    }
    const updated = await this.tasks.update(task.id, {
      expectedVersion: task.version,
      deadlineAt,
      priority: priorityMatch
    }, { actor: sender, correlationId, sourceMessageId: message.id, originalInput: message.text });
    return this.respond(
      message,
      `Updated *${updated.title}*.${deadlineAt ? ` New deadline: ${formatDateTime(deadlineAt, this.organizationTimezone)}.` : ''}${priorityMatch ? ` Priority: ${priorityMatch}.` : ''}`,
      correlationId
    );
  }

  private async resolveTaskReference(text: string): Promise<Task | undefined> {
    const active = (await this.store.listTasks()).filter((task) => ['SCHEDULED', 'ACTIVE', 'SUBMITTED', 'OVERDUE'].includes(task.status));
    const publicId = text.match(/\bMH-TASK-\d{8}-\d+\b/i)?.[0];
    if (publicId) return active.find((task) => task.publicId.toLowerCase() === publicId.toLowerCase());
    const normalized = text.toLowerCase();
    const scored = active.map((task) => {
      const tokens = task.title.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
      return { task, score: tokens.filter((token) => normalized.includes(token)).length / Math.max(1, tokens.length) };
    }).filter((item) => item.score >= 0.5).sort((a, b) => b.score - a.score);
    if (scored.length === 1 || (scored[0] && scored[1] && scored[0].score > scored[1].score)) return scored[0]?.task;
    return active.length === 1 ? active[0] : undefined;
  }

  private async discoverMentionedGroup(
    message: InboundMessage,
    intent: Awaited<ReturnType<AIProvider['extractCommand']>>['intent']
  ): Promise<string | undefined> {
    const listGroups = this.gateway.listGroups;
    if (!listGroups || !message.text) return undefined;
    const discovered = await listGroups.call(this.gateway);
    const text = message.text.toLocaleLowerCase();
    const matches = discovered.filter((group) => text.includes(group.name.toLocaleLowerCase()));
    if (matches.length !== 1) return undefined;
    const match = matches[0]!;
    const existing = (await this.store.listGroups()).find((group) => group.whatsappJid === match.whatsappJid);
    const now = this.now();
    await this.store.saveGroup(existing ?? {
      id: newId(),
      whatsappJid: match.whatsappJid,
      name: match.name,
      type: intent === 'CREATE_TASK' ? 'OFFICIALS' : 'COMMUNITY',
      active: true,
      timezone: this.organizationTimezone,
      mentionAllMaxParticipants: Math.max(150, match.participantCount),
      createdAt: now,
      updatedAt: now
    });
    return match.name;
  }

  private async createTaskFromDraft(
    message: InboundMessage,
    sender: User,
    draft: Awaited<ReturnType<AIProvider['extractCommand']>>,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const task = draft.task;
    if (!task?.title || !task.description || !task.groupName || task.assigneeNames.length === 0) {
      return this.respond(message, 'I need enough information to identify the work and at least one registered assignee.', correlationId);
    }
    const groups = await this.store.findGroupsByName(task.groupName);
    if (groups.length !== 1) {
      return this.respond(
        message,
        groups.length ? `I found more than one group matching “${task.groupName}”. Please tell me the exact group name.` : `I could not find a configured group called “${task.groupName}”.`,
        correlationId
      );
    }
    const resolvedUsers: User[] = [];
    for (const name of task.assigneeNames) {
      const matches = await this.store.findOfficialsByName(name);
      if (matches.length !== 1) {
        const names = matches.map((match) => match.profile.fullName).join(', ');
        return this.respond(
          message,
          matches.length ? `I found more than one official matching “${name}”: ${names}. Which one did you mean?` : `I could not find an active official called “${name}”.`,
          correlationId
        );
      }
      resolvedUsers.push(matches[0]!.user);
    }
    const priority = inferPriority(message.text ?? '', task.priority);
    const recurrencePlan = parseTaskRecurrence(message.text ?? '', this.organizationTimezone, message.timestamp);
    const explicitPublishAt = task.publishAtText
      ? parseNaturalDate(task.publishAtText, this.organizationTimezone, message.timestamp)
      : undefined;
    const publishAt = recurrencePlan?.firstRunAt ?? explicitPublishAt;
    const deadlineReference = publishAt ?? message.timestamp;
    const explicitDeadlineAt = task.deadlineAtText
      ? this.parseTaskDeadline(task.deadlineAtText, deadlineReference)
      : undefined;
    const deadlineAt = explicitDeadlineAt
      ?? moveIntoWorkingHours(
        inferDeadlineAt(deadlineReference, priority, recurrencePlan?.recurrence.frequency),
        this.organizationTimezone
      );
    if ((task.deadlineAtText && !explicitDeadlineAt) || (task.publishAtText && !explicitPublishAt && !recurrencePlan)) {
      return this.respond(message, 'Please confirm the schedule in a form such as “tomorrow at 8 AM” or “Friday 5 PM”.', correlationId);
    }
    const recurrence = recurrencePlan ? {
      ...recurrencePlan.recurrence,
      deadlineOffsetMinutes: Math.max(1, Math.round((deadlineAt.getTime() - deadlineReference.getTime()) / 60_000))
    } : undefined;
    const attachmentIds = message.media ? await this.captureInboundMedia(message, sender) : [];
    const created = await this.tasks.create(
      {
        title: task.title,
        description: task.description,
        groupId: groups[0]!.id,
        assigneeIds: resolvedUsers.map((user) => user.id),
        priority,
        publishAt,
        deadlineAt,
        recurrence,
        attachmentIds,
        sourceMessageId: message.id,
        sourceMessageText: message.text
      },
      { actor: sender, correlationId, sourceMessageId: message.id, originalInput: message.text }
    );
    const names = (await Promise.all(resolvedUsers.map((user) => this.store.getOfficial(user.id)))).flatMap((profile) => profile ? [profile.fullName] : []);
    return this.respond(
      message,
      [
        'Got it.',
        `*${created.title}*`,
        `Assigned to ${names.join(', ')}`,
        `Priority: ${priority}`,
        `Deadline: ${formatDateTime(deadlineAt, this.organizationTimezone)}`,
        ...(recurrence ? [`Routine: repeats ${recurrence.frequency.toLowerCase()}`] : []),
        `I’ll post it in ${groups[0]!.name} ${publishAt ? formatDateTime(publishAt, this.organizationTimezone) : 'right away'}.`
      ].join('\n'),
      correlationId
    );
  }

  private async createAnnouncementFromDraft(
    message: InboundMessage,
    sender: User,
    draft: Awaited<ReturnType<AIProvider['extractCommand']>>,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const announcement = draft.announcement;
    const communityGroups = (await this.store.listGroups()).filter((group) => group.active && group.type === 'COMMUNITY');
    if (announcement && !announcement.groupName && communityGroups.length === 1) {
      announcement.groupName = communityGroups[0]!.name;
    }
    if (!announcement?.groupName || !announcement.body) {
      return this.respond(message, 'Please send the announcement text and tell me the configured group to use.', correlationId);
    }
    const groups = await this.store.findGroupsByName(announcement.groupName);
    if (groups.length !== 1) {
      return this.respond(message, 'I need the exact configured destination group before I schedule that announcement.', correlationId);
    }
    const publishAt = announcement.publishAtText
      ? parseNaturalDate(announcement.publishAtText, this.organizationTimezone, message.timestamp)
      : undefined;
    if (announcement.publishAtText && !publishAt) {
      return this.respond(message, 'Please confirm the publication time, for example “tomorrow at 10 AM”.', correlationId);
    }
    const expiresAt = announcement.expiresAtText
      ? parseNaturalDate(announcement.expiresAtText, this.organizationTimezone, message.timestamp)
      : undefined;
    if (announcement.expiresAtText && !expiresAt) {
      return this.respond(message, 'Please confirm the opportunity or announcement deadline, for example “Friday at 5 PM”.', correlationId);
    }
    const attachmentIds = message.media ? await this.captureInboundMedia(message, sender) : [];
    if (announcement.mentionStrategy === 'EVERYONE') {
      const confirmation = await this.confirmations.requestEveryoneAnnouncement(
        {
          groupId: groups[0]!.id,
          body: announcement.body,
          title: announcement.title,
          category: announcement.category,
          mentionStrategy: 'EVERYONE',
          interestTags: announcement.interestTags,
          publishAt,
          expiresAt,
          attachmentIds,
          sourceMessageId: message.id
        },
        { actor: sender, correlationId, sourceMessageId: message.id, originalInput: message.text }
      );
      return this.respond(
        message,
        `That announcement would tag everyone. Reply *Confirm ${confirmation.publicId}* within 15 minutes to schedule it, or *Cancel ${confirmation.publicId}* to discard it.`,
        correlationId
      );
    }
    const created = await this.announcements.create(
      {
        groupId: groups[0]!.id,
        body: announcement.body,
        title: announcement.title,
        category: announcement.category,
        mentionStrategy: announcement.mentionStrategy,
        interestTags: announcement.interestTags,
        publishAt,
        expiresAt,
        attachmentIds,
        sourceMessageId: message.id
      },
      { actor: sender, correlationId, sourceMessageId: message.id, originalInput: message.text }
    );
    return this.respond(
      message,
      `Got you. I’ve scheduled announcement ${created.publicId} for ${publishAt ? formatDateTime(publishAt, this.organizationTimezone) : 'immediate publication'} in ${groups[0]!.name}.`,
      correlationId
    );
  }

  private async handleOfficialTaskReply(
    message: InboundMessage,
    sender: User,
    task: Task,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const text = (message.text ?? '').trim();
    if (/\b(blocked|blocker)\b/i.test(text)) {
      const reason = text.replace(/^.*?\b(?:blocked|blocker)\b\s*[:\-]?\s*/i, '').trim() || 'No reason supplied.';
      await this.tasks.recordBlocked(task.id, sender, reason, message.id, correlationId);
      return this.respond(message, 'Thanks for the update. I’ve recorded the blocker so the team record stays accurate.', correlationId);
    }
    if (/\b(acknowledge|acknowledged|seen|got it)\b/i.test(text)) {
      await this.tasks.acknowledge(task.id, sender, message.id, correlationId);
      return this.respond(message, `Noted — you’re on *${task.title}*.`, correlationId);
    }
    if (/\b(started|starting|working on it|in progress|halfway|progress)\b/i.test(text)) {
      await this.tasks.recordProgress(task.id, sender, text, message.id, correlationId);
      return this.respond(message, `Thanks — I’ve marked your part of *${task.title}* as in progress.`, correlationId);
    }
    if (this.looksLikeSubmission(text) || Boolean(message.media)) {
      const attachmentIds = await this.captureInboundMedia(message, sender);
      await this.tasks.submit({
        taskId: task.id,
        submitter: sender,
        note: text || 'Submission attached.',
        attachmentIds,
        sourceMessageId: message.id,
        correlationId
      });
      return this.respond(
        message,
        attachmentIds.length
          ? `Nice one. I’ve recorded your submission for *${task.title}* and attached the file to the task record.`
          : `Nice one. I’ve recorded your submission for *${task.title}*.` ,
        correlationId
      );
    }
    return this.respond(message, `You are assigned to *${task.title}*. Reply with “done”, “submission attached”, or “blocked + reason”.`, correlationId);
  }

  private async handleOfficialUnthreadedSubmission(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const candidates = (await this.store.listTasks({ assigneeUserId: sender.id })).filter((task) =>
      ['SCHEDULED', 'ACTIVE', 'OVERDUE'].includes(task.status)
    );
    if (candidates.length === 0) {
      return this.respond(message, 'I cannot find an active task assigned to you. Please reply directly to the assignment message.', correlationId);
    }
    if (candidates.length > 1) {
      const reply = `I can see ${candidates.length} active tasks assigned to you. Which one are you submitting?\n${candidates.map((task, index) => `${index + 1}. ${task.title}`).join('\n')}`;
      await this.rememberConversation({
        scopeKey: `official-selection:${sender.id}:${message.chatJid}`,
        userId: sender.id,
        userMessage: message.text ?? '',
        assistantMessage: reply
      });
      return this.respond(
        message,
        reply,
        correlationId
      );
    }
    return this.handleOfficialTaskReply(message, sender, candidates[0]!, correlationId);
  }

  private async handleOfficialUnthreadedUpdate(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const candidates = (await this.store.listTasks({ assigneeUserId: sender.id })).filter((task) =>
      ['SCHEDULED', 'ACTIVE', 'OVERDUE'].includes(task.status)
    );
    if (!candidates.length) return this.respond(message, 'I can’t find an active task assigned to you.', correlationId);
    const text = (message.text ?? '').toLowerCase();
    const matches = candidates.filter((task) => task.title.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3).some((word) => text.includes(word)));
    const task = matches.length === 1 ? matches[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!task) {
      return this.respond(message, `Which task is this update for?\n${candidates.map((item, index) => `${index + 1}. ${item.title}`).join('\n')}`, correlationId);
    }
    return this.handleOfficialTaskReply(message, sender, task, correlationId);
  }

  private async handleOfficialTaskStatus(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const tasks = (await this.store.listTasks({ assigneeUserId: sender.id })).filter((task) =>
      ['SCHEDULED', 'ACTIVE', 'SUBMITTED', 'OVERDUE'].includes(task.status)
    );
    if (!tasks.length) return this.respond(message, 'You don’t have any open tasks right now.', correlationId);
    const lines = await Promise.all(tasks.map(async (task) => {
      const assignment = await this.store.getTaskAssignee(task.id, sender.id);
      return `• *${task.title}* — ${assignment?.status ?? task.status}${task.deadlineAt ? ` — due ${formatDateTime(task.deadlineAt, this.organizationTimezone)}` : ''}`;
    }));
    return this.respond(message, `Here’s your current task list:\n${lines.join('\n')}`, correlationId);
  }

  private async handleOfficialTaskSelection(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult | undefined> {
    const scopeKey = `official-selection:${sender.id}:${message.chatJid}`;
    const memory = await this.store.getConversationMemory(scopeKey, this.now());
    if (!memory?.turns.some((turn) => turn.role === 'assistant' && turn.content.includes('Which one are you submitting?'))) return undefined;
    const candidates = (await this.store.listTasks({ assigneeUserId: sender.id })).filter((task) =>
      ['SCHEDULED', 'ACTIVE', 'OVERDUE'].includes(task.status)
    );
    const index = Number((message.text ?? '').trim()) - 1;
    const task = candidates[index];
    if (!task) return this.respond(message, `Please choose a number between 1 and ${candidates.length}.`, correlationId);
    const attachmentIds = await this.captureInboundMedia(message, sender);
    await this.tasks.submit({
      taskId: task.id,
      submitter: sender,
      note: 'Submitted after task selection.',
      attachmentIds,
      sourceMessageId: message.id,
      correlationId
    });
    await this.store.deleteConversationMemory(scopeKey);
    return this.respond(message, `Nice one. I’ve recorded your submission for *${task.title}*.`, correlationId);
  }

  private async handleCommunityQuestion(
    message: InboundMessage,
    sender: User,
    correlationId: string
  ): Promise<InboundHandlingResult> {
    const group = (await this.store.listGroups()).find((candidate) => candidate.whatsappJid === message.chatJid);
    const personalScope = `member:${sender.id}:${message.chatJid}`;
    const [personalMemory, groupMemory] = await Promise.all([
      this.store.getConversationMemory(personalScope, this.now()),
      group ? this.store.getConversationMemory(`group:${group.id}`, this.now()) : Promise.resolve(undefined)
    ]);
    const conversationHistory = [
      ...(groupMemory?.turns.slice(-6) ?? []),
      ...(personalMemory?.turns.slice(-6) ?? [])
    ].map((turn) => ({ role: turn.role, content: turn.content }));
    const finish = async (reply: string): Promise<InboundHandlingResult> => {
      const result = await this.respond(message, reply, correlationId);
      await this.rememberConversation({
        scopeKey: personalScope,
        userId: sender.id,
        groupId: group?.id,
        userMessage: message.text ?? '',
        assistantMessage: reply
      });
      if (group && message.text?.trim()) await this.rememberGroupMessage(group.id, sender, message.text);
      return result;
    };
    if (this.looksLikeContentRequest(message.text)) {
      return finish(await this.ai.draftReply({
        userMessage: message.text ?? '',
        facts: [
          `The sender is a registered ${sender.role === 'OFFICIAL' ? 'official' : 'community member'}.`,
          'This is a content-generation request only; no organisational record or action has been created.'
        ],
        tone: 'WARM',
        mode: 'CREATIVE',
        conversationHistory,
        fallback: 'I couldn’t generate that draft just now. Please try again in a moment.'
      }));
    }
    const text = (message.text ?? '').toLowerCase();
    if (/\b(?:what is|what's|tell me about)\b.*\b(?:vision|mission)\b|\bvision and mission\b/i.test(message.text ?? '')) {
      return finish(this.visionMissionMessage());
    }
    if (/opportunit|scholarship|grant|audition|competition|webinar/.test(text)) {
      const category = ['scholarship', 'grant', 'audition', 'competition', 'webinar']
        .find((keyword) => text.includes(keyword));
      const opportunities = await this.store.listActiveOpportunities(category);
      if (!opportunities.length) {
        return finish('I do not have an active opportunity matching that right now. I’ll only share opportunities that have been added to the organisation record.');
      }
      const top = opportunities.slice(0, 3);
      return finish(
        `Here are the active opportunities I can confirm:\n${top.map((item) => `• *${item.title}* — ${item.summary}${item.deadlineAt ? ` (deadline: ${formatDateTime(item.deadlineAt, this.organizationTimezone)})` : ''}${item.applicationUrl ? `\n  Apply: ${item.applicationUrl}` : ''}`).join('\n')}`
      );
    }
    const knowledge = await this.store.searchOrganizationKnowledge(message.text ?? '', 3);
    return finish(await this.ai.draftReply({
      userMessage: message.text ?? '',
      facts: [
        `The sender is a registered ${sender.role === 'OFFICIAL' ? 'official' : 'community member'}.`,
        ...(knowledge.length
          ? knowledge.map((item) => `${item.title}: ${item.content}`)
          : ['No matching task, announcement, opportunity, or organisation knowledge record was found for this message.'])
      ],
      tone: 'WARM',
      conversationHistory,
      fallback: `Hi, I’m ${this.botName}, ${this.organizationName}’s AI assistant. Tag me with a question about a task, announcement, or recorded opportunity and I’ll help where I can.`
    }));
  }

  private async captureInboundMedia(message: InboundMessage, sender: User): Promise<string[]> {
    if (!message.media) return [];
    const id = newId();
    const storageKey = message.media.data?.length
      ? await this.mediaStore.put(
        `inbound/${message.timestamp.toISOString().slice(0, 10)}/${id}`,
        message.media.data,
        message.media.mimeType
      )
      : undefined;
    if (!storageKey && !message.media.url) {
      throw new AppError('MEDIA_CAPTURE_FAILED', 'I received the file but could not safely store it. Please resend it once I am back online.', 503);
    }
    const attachment: Attachment = {
      id,
      storageKey,
      kind: message.media.kind,
      sourceUrl: message.media.url,
      mimeType: message.media.mimeType,
      fileName: message.media.fileName,
      sizeBytes: message.media.sizeBytes,
      uploadedBy: sender.id,
      createdAt: this.now()
    };
    await this.store.createAttachment(attachment);
    return [attachment.id];
  }

  private async respond(message: InboundMessage, text: string, correlationId: string): Promise<InboundHandlingResult> {
    if (this.gateway.isConnected()) {
      await this.gateway.sendText({ chatJid: message.chatJid, text, correlationId });
    }
    return { handled: true, reply: text };
  }

  private async rememberConversation(input: {
    scopeKey: string;
    userId: string;
    groupId?: string;
    userMessage: string;
    assistantMessage: string;
  }): Promise<void> {
    const now = this.now();
    const existing = await this.store.getConversationMemory(input.scopeKey, now);
    const turns = [
      ...(existing?.turns ?? []),
      { role: 'user' as const, content: input.userMessage, createdAt: now },
      { role: 'assistant' as const, content: input.assistantMessage, createdAt: now }
    ].slice(-10);
    await this.store.saveConversationMemory({
      id: existing?.id ?? newId(),
      scopeKey: input.scopeKey,
      userId: input.userId,
      groupId: input.groupId,
      turns,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  private parseTaskDeadline(text: string, reference: Date): Date | undefined {
    const direct = parseNaturalDate(text, this.organizationTimezone, reference);
    if (direct && direct > reference) return direct;
    const sameDay = parseNaturalDate(`today at ${text}`, this.organizationTimezone, reference);
    if (sameDay && sameDay > reference) return sameDay;
    return parseNaturalDate(`tomorrow at ${text}`, this.organizationTimezone, reference);
  }

  private looksLikeSubmission(text?: string): boolean {
    return /\b(done|complete(?:d)?|finished|submitted|submission)\b/i.test(text ?? '');
  }

  private looksLikeUnauthorizedCommand(text?: string): boolean {
    return /\b(delete|cancel|assign|schedule|post|publish|change deadline)\b/i.test(text ?? '');
  }

  private looksLikeContentRequest(text?: string): boolean {
    return /\b(?:write|draft|generate|compose|rewrite|create)\b.*\b(?:caption|content|copy|script|post|email|message|article|thread|proposal|bio|description|speech|outline)\b/i.test(text ?? '');
  }

  private looksLikeWelcome(text?: string): boolean {
    return /\b(?:welcome|glad to have you|happy to have you|pleased to have you)\b/i.test(text ?? '')
      && !this.looksLikeIntroductionRequest(text);
  }

  private looksLikeIntroductionRequest(text?: string): boolean {
    return /\b(?:introduce yourself|tell us about yourself|who are you|what can you do|what do you do)\b/i.test(text ?? '');
  }

  private introductionMessage(): string {
    return [
      `Hello everyone. I’m ${this.botName}, ${this.organizationName}’s AI operations assistant on WhatsApp.`,
      '',
      'I help the team coordinate work and share trusted information. I can:',
      '• create and schedule tasks for registered officials;',
      '• post assignments in the configured officials group with real WhatsApp mentions;',
      '• receive acknowledgements, submissions, attachments, blockers, and completion updates;',
      '• send reminders and identify overdue assignments;',
      '• prepare and schedule community announcements and opportunities;',
      '• answer questions using recorded organisational information;',
      '• draft captions, messages, and other creative content;',
      '• provide daily and weekly operations reports; and',
      '• keep an auditable record of sensitive operational actions.',
      '',
      'Please tag me when you need help.'
    ].join('\n');
  }

  private visionMissionMessage(): string {
    return [
      `${this.organizationName} Vision:`,
      'To be a leading African hub where every young person can access music learning and use creativity as a pathway to confidence, education, opportunity, and a better future, regardless of status or background.',
      '',
      'DMO Mission:',
      'To expand access to music education and opportunity for underserved young people through free learning programmes, instrument access, scholarships and grants, performance pathways, and community-based outreach.'
    ].join('\n');
  }
}
