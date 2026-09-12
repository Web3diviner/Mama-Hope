import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { loadConfig } from '../../config/env.js';

export const runMigrations = async (databaseUrl: string, migrationsPath?: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl });
  const defaultPath = join(process.cwd(), 'db', 'migrations');
  const directory = migrationsPath ?? defaultPath;
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const appliedRows = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map((row) => row.id));
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(directory, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to run migrations.');
  await runMigrations(config.DATABASE_URL);
}
