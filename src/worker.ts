import { createContainer } from './app-container.js';
import { loadConfig } from './config/env.js';
import { runMigrations } from './infrastructure/database/migrate.js';
import { seedDemoData } from './infrastructure/seed/demo-seed.js';

const config = loadConfig();
if (config.STORE_DRIVER === 'postgres' && config.DATABASE_URL) {
  await runMigrations(config.DATABASE_URL);
}
const container = createContainer(config);
await container.gateway.connect();
if (config.NODE_ENV !== 'production' && config.STORE_DRIVER === 'memory') {
  await seedDemoData(container.store, config);
}
await container.scheduler.start?.((jobKey) => container.automation.process(jobKey));
await container.planning.scheduleNext(container.scheduler, config.ORGANIZATION_TIMEZONE);

const interval = setInterval(() => {
  void container.automation.processDue().catch((error: unknown) => {
    container.logger.error({ err: error }, 'Automation tick failed');
  });
}, 1_000);

const stop = async (): Promise<void> => {
  clearInterval(interval);
  await container.gateway.disconnect('worker shutdown');
  await container.scheduler.close?.();
  if ('close' in container.store && typeof container.store.close === 'function') await container.store.close();
};
process.on('SIGINT', () => void stop().finally(() => process.exit(0)));
process.on('SIGTERM', () => void stop().finally(() => process.exit(0)));
