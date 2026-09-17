import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

if (!process.env.TELEMETRY_MIGRATION_DATABASE_URL) {
  console.error('Set TELEMETRY_MIGRATION_DATABASE_URL in the process environment. No migration was run.');
  process.exitCode = 1;
} else {
  try {
    const sql = neon(process.env.TELEMETRY_MIGRATION_DATABASE_URL);
    // HTTP extended-query protocol accepts one statement per query. Dollar-quoted
    // DO blocks are kept intact; ordinary statements split on terminator lines.
    const files = ['001_telemetry.sql', '002_telemetry_roles.sql'];
    const statements = [];
    for (const file of files) {
      const content = await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8');
      statements.push(...content.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(s => s && !s.split('\n').every(line => !line.trim() || line.trim().startsWith('--'))));
    }
    await sql.transaction(statements.map(statement => sql.query(statement)), { fetchOptions: { signal: AbortSignal.timeout(30000) } });
    console.log('Telemetry schema and group roles applied transactionally. No telemetry was seeded.');
  } catch {
    console.error('Telemetry migration failed; transaction rolled back. Inspect the database using the migration role. No secrets were printed.');
    process.exitCode = 1;
  }
}
