import { loadConfig } from '../../config/env.js';
import { runMigrations } from './migrate.js';
import { PostgresOperationsStore } from '../store/postgres-operations-store.js';
import { seedDemoData } from '../seed/demo-seed.js';

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to seed PostgreSQL.');
await runMigrations(config.DATABASE_URL);
const store = new PostgresOperationsStore(config.DATABASE_URL);
try {
  await seedDemoData(store, config);
} finally {
  await store.close();
}
