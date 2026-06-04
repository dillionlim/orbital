import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Schema enforces 1:1 (ApiKey.userId is @unique), so duplicates are impossible
  // at the DB layer. This script is kept as a no-op for any pre-migration cleanup
  // need; if the schema ever flips back to 1:N, restore the dedup loop below.
  console.log('clean-api-keys: schema is 1:1; nothing to clean.');
  const count = await prisma.user.count();
  console.log(`(checked ${count} users)`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => await prisma.$disconnect());