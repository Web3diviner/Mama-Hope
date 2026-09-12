import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import { newCorrelationId, newId } from '../common/ids.js';
import type { AppContainer } from '../app-container.js';
import { announcementStatuses, mentionStrategies, priorityLevels, taskStatuses } from '../domain/types.js';

const isoDate = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const optionalIsoDate = isoDate.optional();
const uuid = z.string().uuid();

const createTaskSchema = z.object({
  title: z.string().min(1).max(140),
  description: z.string().min(1).max(4_000),
  groupId: uuid,
  assigneeIds: z.array(uuid).min(1).max(30).optional(),
  requiredCapability: z.string().min(1).max(120).optional(),
  priority: z.enum(priorityLevels).optional(),
  completionPolicy: z.enum(['ALL_ASSIGNEES_SUBMIT', 'ADMIN_CONFIRMATION']).optional(),
  publishAt: optionalIsoDate,
  deadlineAt: optionalIsoDate,
  reminderOffsetsMinutes: z.array(z.number().int().min(0).max(43_200)).max(12).optional(),
  attachmentIds: z.array(uuid).max(10).optional()
}).strict();

const updateTaskSchema = createTaskSchema.partial().extend({
  expectedVersion: z.number().int().positive()
}).strict();

const createAnnouncementSchema = z.object({
  groupId: uuid,
  body: z.string().min(1).max(6_000),
  title: z.string().min(1).max(180).optional(),
  category: z.string().min(1).max(80).optional(),
  mentionStrategy: z.enum(mentionStrategies).optional(),
  interestTags: z.array(z.string().min(1).max(60)).max(20).optional(),
  publishAt: optionalIsoDate,
  expiresAt: optionalIsoDate,
  attachmentIds: z.array(uuid).max(10).optional()
}).strict();

const updateAnnouncementSchema = createAnnouncementSchema.partial().extend({
  expectedVersion: z.number().int().positive()
}).strict();

const expectedVersionSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const cancellationSchema = expectedVersionSchema.extend({ reason: z.string().min(1).max(1_000) }).strict();
const completionSchema = expectedVersionSchema.extend({ notes: z.string().max(2_000).optional() }).strict();

const inboundSchema = z.object({
  id: z.string().min(1).max(200),
  chatJid: z.string().min(5).max(200),
  senderJid: z.string().min(5).max(200),
  text: z.string().max(6_000).optional(),
  timestamp: optionalIsoDate,
  quotedMessageId: z.string().max(200).optional(),
  quotedSenderJid: z.string().max(200).optional(),
  mentions: z.array(z.string().max(200)).max(300).default([]),
  media: z.object({
    kind: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'LINK']),
    mimeType: z.string().max(150).optional(),
    fileName: z.string().max(255).optional(),
    sizeBytes: z.number().int().nonnegative().max(50 * 1024 * 1024).optional(),
    url: z.string().url().optional()
  }).optional()
}).strict();

const opportunitySchema = z.object({
  title: z.string().min(1).max(180),
  category: z.string().min(1).max(100),
  summary: z.string().min(1).max(4_000),
  eligibility: z.string().max(2_000).optional(),
  applicationUrl: z.string().url().optional(),
  deadlineAt: optionalIsoDate,
  sourceName: z.string().max(200).optional(),
  sourceUrl: z.string().url().optional(),
  announcementId: uuid.optional()
}).strict();

const paramId = z.object({ taskId: uuid });
const announcementParam = z.object({ announcementId: uuid });
const confirmationParam = z.object({ confirmationId: z.string().min(1).max(100) });

const matchToken = (provided: string | undefined, expected: string): boolean => {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const requireInternal = (container: AppContainer, request: FastifyRequest): void => {
  const header = request.headers['x-internal-api-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (!matchToken(token, container.config.INTERNAL_API_TOKEN)) {
    throw new AppError('UNAUTHORIZED', 'A valid internal API token is required.', 401);
  }
};

const currentAdmin = async (container: AppContainer) => {
  const admin = await container.store.findUserByJid(container.config.SUPER_ADMIN_WHATSAPP_JID);
  if (!admin || admin.role !== 'SUPER_ADMIN' || !admin.active) {
    throw new AppError('SUPER_ADMIN_NOT_CONFIGURED', 'The configured Super Admin account is not registered.', 503);
  }
  return admin;
};

export const buildServer = (container: AppContainer) => {
  const app = Fastify({ loggerInstance: container.logger, requestIdHeader: 'x-request-id' });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.id;
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload.', details: error.flatten(), correlationId }
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, correlationId }
      });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', correlationId }
    });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const ready = container.gateway.isConnected();
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      whatsappConnected: ready,
      storageDriver: container.config.STORE_DRIVER,
      durableStorage: container.config.STORE_DRIVER === 'postgres',
      scheduler: container.config.REDIS_URL ? 'redis' : 'memory',
      aiProvider: container.config.AI_PROVIDER,
      outboundEnabled: container.config.WHATSAPP_SEND_ENABLED
    });
  });

  app.get('/v1/whatsapp/status', async (request) => {
    requireInternal(container, request);
    return { connected: container.gateway.isConnected(), gateway: container.config.WHATSAPP_GATEWAY };
  });

  app.post('/v1/internal/whatsapp/inbound', async (request) => {
    requireInternal(container, request);
    const body = inboundSchema.parse(request.body);
    return container.inbound.handle({ ...body, timestamp: body.timestamp ?? new Date() });
  });

  app.get('/v1/admin/groups', async (request) => {
    requireInternal(container, request);
    return { data: await container.store.listGroups() };
  });

  app.get('/v1/admin/team/recommendations', async (request) => {
    requireInternal(container, request);
    const query = z.object({
      requirement: z.string().min(1).max(300),
      limit: z.coerce.number().int().positive().max(50).optional()
    }).parse(request.query);
    const recommendations = await container.capabilityMatcher.recommend(query.requirement, query.limit);
    return {
      data: recommendations.map((recommendation) => ({
        user: recommendation.user,
        profile: recommendation.profile,
        activeTaskCount: recommendation.activeTaskCount,
        capabilityScore: recommendation.capabilityScore
      }))
    };
  });

  app.post('/v1/admin/events', async (request, reply) => {
    requireInternal(container, request);
    const body = z.object({
      title: z.string().min(1).max(240),
      description: z.string().max(4_000).optional(),
      startsAt: isoDate,
      endsAt: optionalIsoDate,
      timezone: z.string().min(1).default(container.config.ORGANIZATION_TIMEZONE),
      source: z.enum(['INTERNAL', 'GOOGLE_CALENDAR', 'OBSERVANCE', 'MANUAL']).default('MANUAL'),
      relevanceScore: z.number().int().min(0).max(100).optional(),
      externalId: z.string().max(500).optional()
    }).strict().parse(request.body);
    const event = await container.events.create({ id: newId(), ...body });
    return reply.status(201).send(event);
  });

  app.get('/v1/admin/events', async (request) => {
    requireInternal(container, request);
    const query = z.object({ from: optionalIsoDate, to: optionalIsoDate }).parse(request.query);
    return { data: await container.events.list(query.from, query.to) };
  });

  app.post('/v1/admin/opportunity-candidates', async (request, reply) => {
    requireInternal(container, request);
    const body = z.object({
      sourceName: z.string().min(1).max(200),
      sourceUrl: z.string().url(),
      title: z.string().min(1).max(240),
      summary: z.string().min(1).max(4_000),
      category: z.string().min(1).max(100),
      eligibility: z.string().max(2_000).optional(),
      deadlineAt: optionalIsoDate,
      musicRelevance: z.number().int().min(0).max(100),
      regionalRelevance: z.number().int().min(0).max(100),
      youthRelevance: z.number().int().min(0).max(100),
      supportValue: z.number().int().min(0).max(100),
      sourceCredibility: z.number().int().min(0).max(100)
    }).strict().parse(request.body);
    const candidate = await container.opportunities.ingest({ id: newId(), ...body });
    return reply.status(201).send(candidate);
  });

  app.get('/v1/admin/opportunity-candidates', async (request) => {
    requireInternal(container, request);
    const query = z.object({ minScore: z.coerce.number().int().min(0).max(100).optional() }).parse(request.query);
    return { data: await container.opportunities.list(query.minScore) };
  });

  app.get('/v1/admin/engagement/activity', async (request) => {
    requireInternal(container, request);
    const query = z.object({ groupId: uuid.optional(), since: optionalIsoDate }).parse(request.query);
    return { data: await container.store.listMemberActivity(query.groupId, query.since) };
  });

  app.get('/v1/admin/engagement/checkins', async (request) => {
    requireInternal(container, request);
    const query = z.object({ userId: uuid.optional(), since: optionalIsoDate }).parse(request.query);
    return { data: await container.store.listMemberCheckins(query.userId, query.since) };
  });

  app.get('/v1/admin/planning/daily', async (request) => {
    requireInternal(container, request);
    const snapshot = await container.planning.dailySnapshot();
    return { data: snapshot, summary: container.planning.render(snapshot) };
  });

  app.get('/v1/admin/planning/runs', async (request) => {
    requireInternal(container, request);
    const query = z.object({ since: optionalIsoDate }).parse(request.query);
    return { data: await container.store.listPlanningRuns(query.since) };
  });

  app.post('/v1/admin/integrations/google-calendar/sync', async (request) => {
    requireInternal(container, request);
    if (!container.googleCalendar) throw new AppError('GOOGLE_CALENDAR_NOT_CONFIGURED', 'Google Calendar integration is not configured.', 503);
    const query = z.object({ from: isoDate, to: isoDate }).parse(request.query);
    return { synced: await container.googleCalendar.sync(query.from, query.to) };
  });

  app.post('/v1/admin/integrations/opportunities/rss/sync', async (request) => {
    requireInternal(container, request);
    const body = z.object({ url: z.string().url(), sourceName: z.string().min(1).max(200) }).strict().parse(request.body);
    return { ingested: await container.rssOpportunities.fetch(body.url, body.sourceName) };
  });

  app.post('/v1/admin/tasks', async (request, reply) => {
    requireInternal(container, request);
    const body = createTaskSchema.parse(request.body);
    const admin = await currentAdmin(container);
    const task = await container.tasks.create(body, { actor: admin, correlationId: newCorrelationId() });
    return reply.status(201).send(task);
  });

  app.get('/v1/admin/tasks', async (request) => {
    requireInternal(container, request);
    const query = z.object({
      status: z.enum(taskStatuses).optional(),
      groupId: uuid.optional(),
      assigneeUserId: uuid.optional()
    }).parse(request.query);
    return { data: await container.store.listTasks(query) };
  });

  app.get('/v1/admin/tasks/:taskId', async (request) => {
    requireInternal(container, request);
    const { taskId } = paramId.parse(request.params);
    const task = await container.store.getTask(taskId);
    if (!task) throw notFound('Task', taskId);
    const [assignees, updates, submissions] = await Promise.all([
      container.store.listTaskAssignees(taskId),
      container.store.listTaskUpdates(taskId),
      container.store.listTaskSubmissions(taskId)
    ]);
    return { ...task, assignees, updates, submissions };
  });

  app.patch('/v1/admin/tasks/:taskId', async (request) => {
    requireInternal(container, request);
    const { taskId } = paramId.parse(request.params);
    const body = updateTaskSchema.parse(request.body);
    const admin = await currentAdmin(container);
    return container.tasks.update(taskId, body, { actor: admin, correlationId: newCorrelationId() });
  });

  app.post('/v1/admin/tasks/:taskId/cancel', async (request) => {
    requireInternal(container, request);
    const { taskId } = paramId.parse(request.params);
    const body = cancellationSchema.parse(request.body);
    const admin = await currentAdmin(container);
    return container.tasks.cancel(taskId, body.expectedVersion, body.reason, { actor: admin, correlationId: newCorrelationId() });
  });

  app.post('/v1/admin/tasks/:taskId/complete', async (request) => {
    requireInternal(container, request);
    const { taskId } = paramId.parse(request.params);
    const body = completionSchema.parse(request.body);
    const admin = await currentAdmin(container);
    return container.tasks.complete(taskId, body.expectedVersion, body.notes, { actor: admin, correlationId: newCorrelationId() });
  });

  app.post('/v1/admin/tasks/:taskId/publish', async (request) => {
    requireInternal(container, request);
    const { taskId } = paramId.parse(request.params);
    const body = expectedVersionSchema.parse(request.body);
    const admin = await currentAdmin(container);
    await container.tasks.update(taskId, { expectedVersion: body.expectedVersion, publishAt: new Date() }, { actor: admin, correlationId: newCorrelationId() });
    await container.automation.processDue();
    return container.store.getTask(taskId);
  });

  app.post('/v1/admin/announcements', async (request, reply) => {
    requireInternal(container, request);
    const body = createAnnouncementSchema.parse(request.body);
    const admin = await currentAdmin(container);
    if (body.mentionStrategy === 'EVERYONE') {
      const confirmation = await container.confirmations.requestEveryoneAnnouncement(body, {
        actor: admin,
        correlationId: newCorrelationId()
      });
      return reply.status(202).send({
        requiresConfirmation: true,
        confirmationId: confirmation.publicId,
        expiresAt: confirmation.expiresAt,
        message: `Confirm ${confirmation.publicId} before it expires to schedule this everyone-mention announcement.`
      });
    }
    const announcement = await container.announcements.create(body, { actor: admin, correlationId: newCorrelationId() });
    return reply.status(201).send(announcement);
  });

  app.get('/v1/admin/announcements', async (request) => {
    requireInternal(container, request);
    const query = z.object({ status: z.enum(announcementStatuses).optional(), groupId: uuid.optional() }).parse(request.query);
    return { data: await container.store.listAnnouncements(query) };
  });

  app.patch('/v1/admin/announcements/:announcementId', async (request) => {
    requireInternal(container, request);
    const { announcementId } = announcementParam.parse(request.params);
    const body = updateAnnouncementSchema.parse(request.body);
    const admin = await currentAdmin(container);
    return container.announcements.update(announcementId, body, { actor: admin, correlationId: newCorrelationId() });
  });

  app.post('/v1/admin/announcements/:announcementId/cancel', async (request) => {
    requireInternal(container, request);
    const { announcementId } = announcementParam.parse(request.params);
    const body = cancellationSchema.parse(request.body);
    const admin = await currentAdmin(container);
    return container.announcements.cancel(announcementId, body.expectedVersion, body.reason, { actor: admin, correlationId: newCorrelationId() });
  });

  app.post('/v1/admin/announcements/:announcementId/publish', async (request) => {
    requireInternal(container, request);
    const { announcementId } = announcementParam.parse(request.params);
    const body = expectedVersionSchema.parse(request.body);
    const current = await container.store.getAnnouncement(announcementId);
    if (!current) throw notFound('Announcement', announcementId);
    const admin = await currentAdmin(container);
    await container.announcements.update(
      announcementId,
      { expectedVersion: body.expectedVersion, publishAt: new Date() },
      { actor: admin, correlationId: newCorrelationId() }
    );
    await container.automation.processDue();
    return container.store.getAnnouncement(announcementId);
  });

  app.post('/v1/admin/confirmations/:confirmationId/confirm', async (request) => {
    requireInternal(container, request);
    const { confirmationId } = confirmationParam.parse(request.params);
    const admin = await currentAdmin(container);
    return container.confirmations.confirm(confirmationId, { actor: admin, correlationId: newCorrelationId() });
  });

  app.post('/v1/admin/confirmations/:confirmationId/cancel', async (request) => {
    requireInternal(container, request);
    const { confirmationId } = confirmationParam.parse(request.params);
    const admin = await currentAdmin(container);
    return container.confirmations.cancel(confirmationId, { actor: admin, correlationId: newCorrelationId() });
  });

  app.post('/v1/admin/opportunities', async (request, reply) => {
    requireInternal(container, request);
    const body = opportunitySchema.parse(request.body);
    const admin = await currentAdmin(container);
    const now = new Date();
    const opportunity = await container.store.saveOpportunity({
      id: newId(),
      ...body,
      active: true,
      createdBy: admin.id,
      createdAt: now,
      updatedAt: now
    });
    return reply.status(201).send(opportunity);
  });

  app.post('/v1/admin/knowledge', async (request, reply) => {
    requireInternal(container, request);
    const body = z.object({
      title: z.string().min(1).max(240),
      content: z.string().min(1).max(20_000),
      tags: z.array(z.string().min(1).max(80)).max(30).default([]),
      active: z.boolean().default(true)
    }).strict().parse(request.body);
    const now = new Date();
    const item = await container.store.saveOrganizationKnowledge({ id: newId(), ...body, createdAt: now, updatedAt: now });
    return reply.status(201).send(item);
  });

  app.get('/v1/admin/knowledge/search', async (request) => {
    requireInternal(container, request);
    const query = z.object({ q: z.string().min(1).max(500), limit: z.coerce.number().int().min(1).max(20).optional() }).parse(request.query);
    return { data: await container.store.searchOrganizationKnowledge(query.q, query.limit) };
  });

  app.get('/v1/admin/reports/daily', async (request) => {
    requireInternal(container, request);
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timezone: z.string().min(1).optional() }).parse(request.query);
    return container.reports.daily(query.date, query.timezone);
  });

  app.get('/v1/admin/reports/weekly', async (request) => {
    requireInternal(container, request);
    const query = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timezone: z.string().min(1).optional() }).parse(request.query);
    return container.reports.weekly(query.startDate, query.timezone);
  });

  return app;
};
