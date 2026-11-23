import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

// Paths below are resolved relative to this file. Prisma CLI commands run from the workspace root.
// Load the local .env for development; real environments inject variables directly.
const dotEnvPath = join(process.cwd(), '.env');
if (existsSync(dotEnvPath)) {
  process.loadEnvFile(dotEnvPath);
}

export default defineConfig({
  schema: join('prisma', 'schema.prisma'),
  migrations: {
    path: join('prisma', 'migrations'),
  },
  datasource: {
    // `prisma generate` does not need a database; migrate/studio do and will fail clearly if unset.
    url: process.env['DATABASE_URL'] ?? '',
  },
});
