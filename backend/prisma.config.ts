import { defineConfig } from '@prisma/config';
import 'dotenv/config';

// Prisma CLI (migrate, db push, etc.) needs a direct DB connection — pgbouncer
// transaction-pool URLs (Supabase port 6543) cause prisma migrate to hang. Use
// DIRECT_URL when present, fall back to DATABASE_URL for local dev.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
});