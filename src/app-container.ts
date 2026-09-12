import type { Logger } from 'pino';
import { createLogger } from './common/logger.js';
import type { AppConfig } from './config/env.js';
import type { AIProvider, JobScheduler, MediaStore, OperationsStore, WhatsAppGateway } from './domain/ports.js';
import type { InboundMessage } from './domain/types.js';
import { RuleBasedAIProvider } from './infrastructure/ai/rule-based-ai-provider.js';
import { GroqAIProvider } from './infrastructure/ai/groq-ai-provider.js';
import { LedgerScheduler } from './infrastructure/scheduler/ledger-scheduler.js';
import { InMemoryOperationsStore } from './infrastructure/store/in-memory-operations-store.js';
import { PostgresOperationsStore } from './infrastructure/store/postgres-operations-store.js';
import { LocalMediaStore } from './infrastructure/media/local-media-store.js';
import { S3MediaStore } from './infrastructure/media/s3-media-store.js';
import { MemoryWhatsAppGateway } from './infrastructure/whatsapp/memory-whatsapp-gateway.js';
import { BaileysWhatsAppGateway } from './infrastructure/whatsapp/baileys-whatsapp-gateway.js';
import { ControlledWhatsAppGateway } from './infrastructure/whatsapp/controlled-whatsapp-gateway.js';
import { AuditService } from './modules/audit/audit.service.js';
import { AutomationService } from './modules/automation/automation.service.js';
import { AnnouncementService } from './modules/community/announcement.service.js';
import { ConfirmationService } from './modules/confirmations/confirmation.service.js';
import { MessageRenderer } from './modules/messaging/message-renderer.js';
import { ReportService } from './modules/reports/report.service.js';
import { TaskService } from './modules/tasks/task.service.js';
import { InboundRouter } from './modules/whatsapp/inbound-router.js';
import { CapabilityMatcherService } from './modules/team/capability-matcher.service.js';
import { EventIntelligenceService } from './modules/events/event-intelligence.service.js';
import { OpportunityIntelligenceService } from './modules/opportunities/opportunity-intelligence.service.js';
import { EngagementMonitoringService } from './modules/engagement/engagement-monitoring.service.js';
import { PlanningService } from './modules/reports/planning.service.js';
import { GoogleCalendarAdapter } from './infrastructure/calendar/google-calendar-adapter.js';
import { RssOpportunityFetcher } from './infrastructure/opportunities/rss-opportunity-fetcher.js';

export interface AppContainer {
  config: AppConfig;
  store: OperationsStore;
  scheduler: JobScheduler;
  mediaStore: MediaStore;
  gateway: WhatsAppGateway;
  ai: AIProvider;
  logger: Logger;
  audit: AuditService;
  tasks: TaskService;
  announcements: AnnouncementService;
  confirmations: ConfirmationService;
  reports: ReportService;
  automation: AutomationService;
  inbound: InboundRouter;
  capabilityMatcher: CapabilityMatcherService;
  events: EventIntelligenceService;
  opportunities: OpportunityIntelligenceService;
  engagement: EngagementMonitoringService;
  planning: PlanningService;
  googleCalendar?: GoogleCalendarAdapter;
  rssOpportunities: RssOpportunityFetcher;
}

export interface ContainerOverrides {
  store?: OperationsStore;
  scheduler?: JobScheduler;
  mediaStore?: MediaStore;
  gateway?: WhatsAppGateway;
  ai?: AIProvider;
  logger?: Logger;
  now?: () => Date;
}

const bootstrapOfficialJids = (value?: string): string[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const jid = (item as { whatsappJid?: unknown }).whatsappJid;
      return typeof jid === 'string' && /^\d+@s\.whatsapp\.net$/.test(jid) ? [jid] : [];
    });
  } catch {
    return [];
  }
};

export const createContainer = (config: AppConfig, overrides: ContainerOverrides = {}): AppContainer => {
  const now = overrides.now ?? (() => new Date());
  const store = overrides.store ?? (config.STORE_DRIVER === 'postgres'
    ? new PostgresOperationsStore(config.DATABASE_URL!)
    : new InMemoryOperationsStore());
  // Scheduled jobs are persisted in OperationsStore. The process polls and
  // atomically claims due ledger rows, avoiding a separate queue dependency.
  const scheduler = overrides.scheduler ?? new LedgerScheduler();
  const mediaStore = overrides.mediaStore ?? (config.MEDIA_DRIVER === 's3'
    ? new S3MediaStore({
      endpoint: config.S3_ENDPOINT!,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET!,
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!
    })
    : new LocalMediaStore(config.MEDIA_LOCAL_DIR));
  const logger = overrides.logger ?? createLogger(config);
  const transport: WhatsAppGateway = overrides.gateway ?? (config.WHATSAPP_GATEWAY === 'baileys'
    ? new BaileysWhatsAppGateway({
      sessionDirectory: config.WHATSAPP_SESSION_DIR,
      pairingPhone: config.WHATSAPP_PAIRING_PHONE,
      hostIp: config.WHATSAPP_HOST_IP,
      knownPhoneJids: [
        config.SUPER_ADMIN_WHATSAPP_JID,
        config.BOT_WHATSAPP_JID,
        ...bootstrapOfficialJids(config.BOOTSTRAP_OFFICIALS_JSON)
      ],
      connectTimeoutMs: config.WHATSAPP_CONNECT_TIMEOUT_MS,
      logger
    })
    : new MemoryWhatsAppGateway());
  // Real WhatsApp traffic is deliberately paced. Injected gateways are test or
  // embedding adapters and should not make deterministic workflows wait.
  const gateway: WhatsAppGateway = new ControlledWhatsAppGateway(
    transport,
    config.WHATSAPP_SEND_ENABLED,
    overrides.gateway ? 0 : 750
  );
  const ai = overrides.ai ?? (config.AI_PROVIDER === 'groq'
    ? new GroqAIProvider({
      apiKey: config.AI_API_KEY!,
      botName: config.BOT_NAME,
      organizationName: config.ORGANIZATION_NAME,
      models: config.AI_MODEL
        ? [config.AI_MODEL]
        : config.AI_MODELS?.split(',').map((model) => model.trim()).filter(Boolean),
      timeoutMs: config.AI_REQUEST_TIMEOUT_MS,
      logger
    })
    : new RuleBasedAIProvider());
  const audit = new AuditService(store);
  const capabilityMatcher = new CapabilityMatcherService(store);
  const events = new EventIntelligenceService(store, now);
  const opportunities = new OpportunityIntelligenceService(store, now);
  const engagement = new EngagementMonitoringService(store, now);
  const planning = new PlanningService(store, config.ORGANIZATION_TIMEZONE, config.ORGANIZATION_NAME, now);
  const googleCalendar = config.GOOGLE_CALENDAR_ID && config.GOOGLE_CALENDAR_ACCESS_TOKEN
    ? new GoogleCalendarAdapter(config.GOOGLE_CALENDAR_ID, config.GOOGLE_CALENDAR_ACCESS_TOKEN, events)
    : undefined;
  const rssOpportunities = new RssOpportunityFetcher(opportunities);
  const tasks = new TaskService(store, scheduler, audit, now, capabilityMatcher);
  const announcements = new AnnouncementService(store, scheduler, audit, now);
  const confirmations = new ConfirmationService(store, announcements, tasks, audit, now);
  const reports = new ReportService(store, config.ORGANIZATION_TIMEZONE, now);
  const renderer = new MessageRenderer(store, config.ORGANIZATION_TIMEZONE, now);
  const automation = new AutomationService(
    store,
    scheduler,
    gateway,
    mediaStore,
    renderer,
    tasks,
    announcements,
    planning,
    config.SUPER_ADMIN_WHATSAPP_JID,
    config.BOT_WHATSAPP_JID,
    config.ORGANIZATION_TIMEZONE,
    config.AUTO_SEND_DAILY_SUMMARY,
    logger,
    now
  );
  const inbound = new InboundRouter(
    store,
    gateway,
    mediaStore,
    ai,
    tasks,
    announcements,
    confirmations,
    reports,
    planning,
    audit,
    engagement,
    config.BOT_WHATSAPP_JID,
    config.BOT_NAME,
    config.ORGANIZATION_NAME,
    config.ORGANIZATION_TIMEZONE,
    now
  );
  gateway.setInboundHandler?.(async (message: InboundMessage) => { await inbound.handle(message); });
  gateway.setGroupParticipantHandler?.(async (event) => { await inbound.handleGroupParticipants(event); });
  return { config, store, scheduler, mediaStore, gateway, ai, logger, audit, tasks, announcements, confirmations, reports, automation, inbound, capabilityMatcher, events, opportunities, engagement, planning, googleCalendar, rssOpportunities };
};
