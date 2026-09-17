# Phase 1 telemetry persistence

The production Edge receiver keeps its existing request parsing, CORS, Vercel log and response contract. When `TELEMETRY_PERSIST_ENABLED=true`, it also awaits a bounded (2 second) Neon HTTP write. Database failures log a sanitized failure marker and leave the beacon response unchanged. This is fail-open shadow persistence, not a lossless queue: an outage or ambiguous timeout can lose a receipt. No new beacon/session identity is invented.

## Deployment sequence

1. Provision a Neon Postgres database on the approved plan/region. Preview must use a separate database/branch with separate credentials; never seed production with tests.
2. Set `TELEMETRY_MIGRATION_DATABASE_URL` only in a trusted local/CI process and run `npm run telemetry:migrate`. The two additive migrations execute transactionally and can be reapplied. Existing application tables are untouched.
3. Create separate login roles and grant each only its corresponding NOLOGIN group: `merchantpro_telemetry_writer`, `merchantpro_telemetry_reader`, or `merchantpro_telemetry_maintenance`. Do not give these logins owner/admin membership. Use their connection strings for the server-only environment variables below. Check grants with each role before deployment. The migration owner is not a runtime credential.
4. Configure Vercel production `TELEMETRY_DATABASE_URL` (writer), `TELEMETRY_READ_DATABASE_URL` (reader), `TELEMETRY_MAINTENANCE_DATABASE_URL` (maintenance), a randomly generated `CRON_SECRET`, `TELEMETRY_PERSIST_ENABLED=true`, and `TELEMETRY_READ_ENABLED=false`. Never expose them through frontend/public prefixes. Deploy the code. Existing Vercel logging continues.
5. Export a complete, bounded interval of **real production** Vercel logs after deployment. Run `npm run telemetry:verify -- <export.json-or-jsonl> <report.json>` with the read-only connection string. It compares original payload fields and multiplicity, successful marker receipt IDs, timestamps, tenants/types, stored fingerprints and recalculated row fingerprints. It fails on missing rows, write failures, field mismatches, incomplete counts or no attributed traffic. Confirm project/environment/export boundaries separately. No data is inserted by verification.
6. Check tenant-isolated 24h/7d/30d reads with actual rows and run authenticated retention once. Inspect original response status/log continuity. Only after the production comparison passes, set `TELEMETRY_READ_ENABLED=true` and redeploy. Confirm dashboard values against SQL for the same cutoff. Archive the verification result, deployment identifier and observed interval.
7. Stop Phase 1 here. Schema v2 and runtime changes require separate work.

To roll back, turn both flags off and redeploy. Original log ingestion continues; migrations/tables can remain. Do not drop tables during a live rollback. Environment changes require redeployment to affect existing functions.

## Storage and retention

`telemetry_events` contains one server receipt per incoming request, server receive time, nullable exact-host tenant attribution, event type, existing client timestamp/country/cohort, sanitized host/path, vendor states, nullable counters, reported blocking milliseconds, error vendor/presence, validation flags and a verification fingerprint. It excludes IP, URL query/fragment, and free-form error messages. Original logs retain their existing format. `telemetry_collections` records first receipt per tenant, not guaranteed continuity.

Tenant attribution matches registered merchant hostnames exactly; a conflicting optional payload storeId or unknown host remains unattributed and is excluded from tenant reads. The public beacon is not authenticated, so attribution does not prove sender identity. Dashboard authorization still derives the tenant from the existing server-side authenticated session.

Indexes support tenant/time reads, summary aggregation, error/vendor reads and receive-time retention. No partitions/materialized views are introduced. A daily protected Vercel cron deletes records older than 35 days in batches, up to 25,000 per invocation. Partial cleanup returns 503 with `moreMayRemain=true`; invoke again and check cron logs if a backlog appears. Daily scheduling means physical deletion can lag the threshold by up to a day, plus any failures. Dashboard last-seen/vendor reads are independently bounded to 35 days. Monitor Neon storage/compute quotas and retention failures; the free plan is capacity-limited.

## Read semantics and unavailable fields

Queries use server-received UTC half-open windows of 24/168/720 hours. Aggregation covers all matching rows before the recent-record limit of 50. HTTP dashboard responses are private/no-store. Disabled/failed database reads return unavailable values, never memory or fixtures.

| Dashboard item | Phase 1 meaning / missing evidence |
|---|---|
| Store operational status | Unavailable: no runtime heartbeat/status payload. Receipt recency alone does not establish health. |
| Last telemetry | Maximum persisted server receive time within retained 35 days. |
| Unique sessions | Unavailable: missing sessionId and eventId; summary counts are explicitly received reports. |
| Country | Trusted ingestion-edge country, counted over summary reports, with unknown preserved. Payload-reported country is stored separately. |
| Classification | Unavailable: no authoritative classification field/rule version; country/cohort is not promoted to a visitor classification. |
| Vendor states | Actual latest reported summary state plus receive time/freshness and per-period state counts; not delivery success. |
| Errors | Error-beacon count separate from summary-reported error counters; they are never added or deduplicated. Missing counters stay null. Free-form diagnostics remain in existing logs. |
| Recent sessions | Shown as recent telemetry records; no session deduplication or synthetic identifiers. Receipt UUID identifies only a database receipt. |
| longTaskBlockingMs history | Reported numeric values, hourly/daily median and p75 (p75 needs 20 observations), including explicit zero. Measurement validity, support and duration are absent; zero cannot prove a supported successful observation. |
| Control/optimized comparison, runtime version | Unavailable: missing explicit mode/runtimeVersion and valid comparable measurement windows. |
| Business impact | Unavailable: no persisted conversion/revenue attribution model. |

No historical backfill is included. Period completeness remains false because collection start and available rows do not prove uninterrupted delivery. The log verifier cannot independently prove trusted country provenance because the old logger flattens header and payload country into the same property.

## Validation

`npm run check` runs type checks, project tests and build. Persistence tests use a temporary on-disk PostgreSQL-compatible PGlite database to verify migration idempotence, restart durability, period boundaries, tenant isolation, aggregate-versus-recent limits, missing-versus-zero behavior, retention, fail-open handling and original response contracts. Fixtures only enter that temporary test database, never production. A passing local test suite does not substitute for the production comparison in step 5.
