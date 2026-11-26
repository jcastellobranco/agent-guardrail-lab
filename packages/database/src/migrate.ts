import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { database } from './index.js';
const { db, pool } = database(process.env.DATABASE_URL ?? '');
try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
} finally {
  await pool.end();
}
