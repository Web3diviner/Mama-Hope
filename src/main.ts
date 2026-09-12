import { createContainer } from './app-container.js';
import { loadConfig } from './config/env.js';
import { runMigrations } from './infrastructure/database/migrate.js';
import { seedDemoData } from './infrastructure/seed/demo-seed.js';
import { buildServer } from './http/server.js';

const config = loadConfig();
if (config.STORE_DRIVER === 'postgres' && config.DATABASE_URL) {
  await runMigrations(config.DATABASE_URL);
}
const container = createContainer(config);

await container.gateway.connect();
if (config.NODE_ENV !== 'production' && config.STORE_DRIVER === 'memory') {
  await seedDemoData(container.store, config);
}
const syncGroupMembership = async (): Promise<void> => {
  await container.inbound.syncConfiguredGroupMembership().catch((error: unknown) => {
    container.logger.warn({ err: error }, 'Unable to synchronize configured WhatsApp group membership');
  });
};
await syncGroupMembership();

const syncExternalIntelligence = async (): Promise<void> => {
  if (container.googleCalendar) {
    const from = new Date();
    const to = new Date(from.getTime() + 90 * 24 * 60 * 60 * 1000);
    await container.googleCalendar.sync(from, to).catch((error: unknown) => {
      container.logger.warn({ err: error }, 'Google Calendar synchronization failed');
    });
  }
  for (const url of (config.OPPORTUNITY_RSS_URLS ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    let sourceName = 'Configured opportunity feed';
    try { sourceName = new URL(url).hostname; } catch { /* validation happens in the fetcher */ }
    await container.rssOpportunities.fetch(url, sourceName).catch((error: unknown) => {
      container.logger.warn({ err: error, sourceName }, 'Opportunity feed synchronization failed');
    });
  }
};

const app = buildServer(container);
await container.scheduler.start?.((jobKey) => container.automation.process(jobKey));
await container.planning.scheduleNext(container.scheduler, config.ORGANIZATION_TIMEZONE);
const automationInterval = setInterval(() => {
  void container.automation.processDue().catch((error: unknown) => {
    container.logger.error({ err: error }, 'Automation tick failed');
  });
}, 1_000);
const intelligenceInterval = setInterval(() => void syncExternalIntelligence(), 6 * 60 * 60 * 1000);
const groupSyncInterval = setInterval(() => void syncGroupMembership(), 15 * 60 * 1000);
const startupGroupSync = setTimeout(() => void syncGroupMembership(), 5_000);
const stop = async (): Promise<void> => {
  clearInterval(automationInterval);
  clearInterval(intelligenceInterval);
  clearInterval(groupSyncInterval);
  clearTimeout(startupGroupSync);
  await app.close();
  await container.gateway.disconnect('shutdown');
  await container.scheduler.close?.();
  if ('close' in container.store && typeof container.store.close === 'function') await container.store.close();
};
process.on('SIGINT', () => void stop().finally(() => process.exit(0)));
process.on('SIGTERM', () => void stop().finally(() => process.exit(0)));

await app.listen({ host: '0.0.0.0', port: config.PORT });
void syncExternalIntelligence();
