---
name: bun-postgres-performance
description: >-
  Diagnose and fix performance problems in projects using Bun + PostgreSQL, and
  apply performance-aware patterns when building new features. Use this skill
  whenever the user mentions slow API responses, high p95/p99 latency, high
  database CPU, N+1 queries, connection pool exhaustion, query timeouts, load
  testing, or generally wants to make a Bun or Postgres application faster —
  even if they don't explicitly say 'performance'. Also trigger on phrases
  like 'my API is slow', 'Postgres is slow', 'queries are taking forever',
  'optimize this endpoint', 'reduce latency', 'EXPLAIN ANALYZE', 'add an
  index', 'connection pooling', 'Bun.serve optimization', 'high memory usage',
  'k6 baseline', or 'scale to more users'. Trigger proactively when the user
  is building a new endpoint or service whose design has performance
  implications (hot read paths, batch inserts, heavy joins, long transactions,
  jobs with BullMQ).
---

# Bun + PostgreSQL Performance

A practical, measurement-first guide for making Bun + Postgres applications fast — whether you're fixing a slow system or building one that scales from day one.

Works across drivers: **Bun.sql**, **postgres.js** (porsager/postgres), **Drizzle**, and **Prisma**. Driver-specific notes are called out inline; the deep dive lives in `references/drivers-and-pooling.md`.

## Core principle: measure → locate → fix → re-measure

Performance is an empirical discipline. Do not guess. Do not blanket-apply tips. Every change goes through this loop:

1. **Measure** the current behavior with numbers (latency p50/p95/p99, QPS, CPU, DB time share)
2. **Locate** the actual bottleneck — it is almost never where you think it is
3. **Fix** the specific bottleneck with a targeted change
4. **Re-measure** to confirm improvement and check for regressions

If the user asks for "general performance improvements" without numbers, the first response is to establish a baseline. See `references/diagnose-workflow.md`.

## Triage tree (when something is slow)

Follow this tree top-down. Stop when you find the cause.

```
Is p95 latency high?
├── Yes → Is DB time >50% of request time?
│   ├── Yes → Run pg_stat_statements. Top queries by total_exec_time win.
│   │         → Go to "Postgres bottlenecks"
│   └── No  → Go to "App-layer bottlenecks"
└── No, but throughput is low → Go to "Throughput bottlenecks"

Postgres bottlenecks (in order of frequency):
  1. Missing / wrong index              → §2 Indexing
  2. N+1 query pattern                  → §3 Query patterns
  3. Sequential scan on large table     → §2 Indexing
  4. Long-running transaction locking   → §7 Transactions
  5. Connection pool exhaustion         → §4 Pooling
  6. Bloated table / stale stats        → references/diagnose-workflow.md

App-layer bottlenecks:
  1. Synchronous / blocking work on the hot path  → §5 Bun runtime
  2. Missing cache for hot reads                  → §6 Caching
  3. Oversized JSON payloads                      → §5 Bun runtime
  4. CPU-bound work in the main thread            → §5 Bun runtime

Throughput bottlenecks:
  1. Pool too small (most common)               → §4 Pooling
  2. Upstream service blocking requests         → §5 Bun runtime
  3. Bun.serve config (no reusePort, etc.)      → §5 Bun runtime
```

## The four things that cause 90% of Bun+Postgres perf problems

If you only remember four things, remember these:

1. **A missing index** on a filtered/joined column (usually `WHERE status = ?` or `JOIN ... ON user_id`)
2. **N+1 queries** — a loop that issues one query per iteration instead of one batch query
3. **Connection pool sized wrong** — too small causes queueing; too large causes Postgres to thrash
4. **No cache for reads hit many times per second with rarely-changing data**

---

## §1 — Baseline measurement

Never optimize without a baseline. Minimum viable baseline:

- **Load test**: p50, p95, p99 latency + requests/sec at target concurrency (use `k6`, `oha`, or `autocannon`)
- **Postgres top queries**: `pg_stat_statements` sorted by `total_exec_time`
- **Request breakdown**: how much of request time is DB vs app vs serialization

Ready-to-run k6 script: `references/scripts/k6-baseline.js`. Diagnostic SQL queries: `references/scripts/pg-diagnostic.sql`. Full workflow: `references/diagnose-workflow.md`.

```bash
# HTTP load test
bun x k6 run references/scripts/k6-baseline.js

# Or simpler, for a quick sanity check:
bun x oha -n 10000 -c 50 http://localhost:3000/api/endpoint
```

Enable `pg_stat_statements` once per database:

```sql
-- In postgresql.conf or via ALTER SYSTEM:
-- shared_preload_libraries = 'pg_stat_statements'
-- Restart Postgres, then:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

---

## §2 — Indexing (the single most common fix)

**Rule of thumb**: every column that appears in `WHERE`, `JOIN ON`, or `ORDER BY` on a table with >10K rows is a candidate for an index.

### Diagnosing

```sql
-- Is a query using an index?
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
-- "Seq Scan" on a big table = bad
-- "Index Scan" / "Index Only Scan" = good
-- "Buffers: shared read=..." = cold cache, numbers will drop on warm run
```

### Choosing the right index

| Situation | Index type |
|---|---|
| Equality or range on single column | B-tree (default) |
| Multi-column filter, leftmost prefix | Composite B-tree |
| `WHERE status = 'active'` on mostly-inactive rows | Partial: `... WHERE status = 'active'` |
| `WHERE lower(email) = ?` | Expression: `ON (lower(email))` |
| Full-text / `ILIKE '%...%'` | GIN + `pg_trgm` |
| JSONB field lookup | GIN on `->` or `jsonb_path_ops` |
| Large append-only table by time | BRIN on `created_at` |

Deep dive with examples: `references/postgres-indexing.md`.

### Gotchas

- A composite index on `(a, b, c)` helps `WHERE a=?`, `WHERE a=? AND b=?`, `WHERE a=? AND b=? AND c=?` — but NOT `WHERE b=?` alone.
- Every index costs write performance. Don't index columns you never query.
- Use `CREATE INDEX CONCURRENTLY` in production — regular `CREATE INDEX` locks writes against the table.

---

## §3 — Query patterns

### Fix N+1 immediately

The single most common app-layer perf bug:

```typescript
// ❌ N+1 — one query per user
const users = await sql`SELECT * FROM users WHERE team_id = ${teamId}`;
for (const u of users) {
  u.posts = await sql`SELECT * FROM posts WHERE user_id = ${u.id}`;
}

// ✅ Two queries total, regardless of user count
const users = await sql`SELECT * FROM users WHERE team_id = ${teamId}`;
const posts = await sql`
  SELECT * FROM posts WHERE user_id = ANY(${users.map(u => u.id)})
`;
const byUser = Map.groupBy(posts, p => p.user_id);
for (const u of users) u.posts = byUser.get(u.id) ?? [];
```

ORM equivalents:
- **Drizzle**: `db.query.users.findMany({ with: { posts: true } })` — reads as one query
- **Prisma**: `include: { posts: true }` — but verify the emitted SQL; it sometimes issues separate batched queries
- **Bun.sql / postgres.js**: use `ANY($1)` + JS grouping, or one query with `json_agg`

### Use `json_agg` for nested reads

For API endpoints returning nested structures, a single query often beats both N+1 and a join (which duplicates parent rows):

```sql
SELECT
  u.*,
  COALESCE(
    (SELECT json_agg(p.* ORDER BY p.created_at DESC)
     FROM posts p WHERE p.user_id = u.id),
    '[]'
  ) AS posts
FROM users u
WHERE u.team_id = $1;
```

### Pagination — keyset beats offset

```sql
-- ❌ Slow for page 500 — Postgres still scans the first 10000 rows
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 10000;

-- ✅ Constant time regardless of page depth
SELECT * FROM posts
WHERE (created_at, id) < ($1, $2)  -- cursor from previous page
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

### Bulk inserts — use driver bulk syntax or COPY

```typescript
// ❌ 1000 round trips
for (const row of rows) {
  await sql`INSERT INTO t (a, b) VALUES (${row.a}, ${row.b})`;
}

// ✅ One round trip (postgres.js / Bun.sql)
await sql`INSERT INTO t ${sql(rows, 'a', 'b')}`;

// ✅ For really big batches (>10K rows), use COPY FROM STDIN
```

More patterns (window functions, CTEs — when to use vs avoid, lateral joins): `references/query-patterns.md`.

---

## §4 — Drivers and connection pooling

Pool sizing is the most commonly misconfigured thing in production systems.

**Sizing rule**: start with `pool_size = (cores × 2) + effective_spindle_count` per app instance, capped by Postgres `max_connections` divided across all instances (with headroom for admin).

Example: Postgres `max_connections = 100`, 4 app instances → each instance caps at ~20, leaving 20 for admin/migrations/replicas.

Driver-specific config syntax (Bun.sql, postgres.js, Drizzle, Prisma), pool defaults, and when to front with pgBouncer: `references/drivers-and-pooling.md`.

### When to use pgBouncer (transaction pooling)

- App runs on serverless / many short-lived processes → **yes**
- App is long-running and you control pool size → usually unnecessary
- Using Prisma on serverless → **yes**, and set `?pgbouncer=true` on the URL
- Need `LISTEN/NOTIFY` or session-scoped state → use session mode or skip pgBouncer

### Prepared statements

- Bun.sql and postgres.js prepare automatically per-connection (big win on repeated queries)
- pgBouncer transaction mode defeats prepared statements → use `prepare: false`, or use session mode

---

## §5 — Bun runtime

- **`Bun.serve` with `reusePort: true`** enables multi-process scaling; run multiple Bun processes on the same port behind a load balancer, or use `--smol` for memory-constrained environments
- **Streaming responses** — return `new Response(stream)` for large payloads; don't buffer into a string
- **`Bun.file()`** is significantly faster than `fs.readFile` for serving static assets
- **CPU-bound work** (image processing, PDF generation, heavy JSON transforms) — move to a `Worker`; never block the event loop
- **JSON serialization** — for very large payloads, stream NDJSON instead of one big `JSON.stringify`
- **Compression** — offload to the edge (Nginx, Cloudflare) where possible; if serving directly, use Hono's `compress()` middleware

Full Bun runtime notes, worker patterns, and Hono middleware ordering: `references/bun-runtime.md`.

---

## §6 — Caching

Cache reads that are hit often and change rarely. Three tiers, cheapest first:

1. **In-process LRU** (~microseconds, per-instance only) — use for config-like data
2. **Redis** (~1ms, shared across instances) — use for session data, rate limit counters, denormalized read models
3. **Postgres materialized views** — refreshed on schedule — use for expensive aggregations

### Cache stampede protection

When a cache entry expires and 100 requests hit simultaneously, all 100 can try to regenerate it. Fix with either:
- A lock key in Redis (`SET key NX EX 10`) so only one request regenerates
- Stale-while-revalidate: serve stale data while one request refreshes in the background (fits well with BullMQ for the refresh job)

Redis clients for Bun, invalidation patterns, BullMQ integration: `references/caching.md`.

---

## §7 — Transactions and locking

- Keep transactions **short**. Never `await` external HTTP calls inside a transaction.
- `SELECT ... FOR UPDATE` holds row locks until commit — release fast.
- Watch `pg_stat_activity` for long-running transactions during load tests.
- For read-heavy workloads, consider read replicas — but understand replication lag before routing user-facing reads there.
- Deadlock troubleshooting query is in `references/scripts/pg-diagnostic.sql`.

---

## §8 — Building with performance in mind (proactive mode)

When building a new feature, run this checklist before shipping:

- [ ] Every `WHERE`/`JOIN`/`ORDER BY` column on tables expected to exceed 10K rows has an index
- [ ] No loops that issue queries — reads are batched with `ANY($1)` or `json_agg`
- [ ] Pagination uses keyset for anything that can grow beyond a few hundred rows
- [ ] Long-running work is offloaded to BullMQ, not done in the request
- [ ] Hot read paths have a caching strategy (even if TTL=0 for now, the abstraction is in place)
- [ ] A k6 script exists for the endpoint at expected concurrency
- [ ] Pool size is explicit in code, not left at the driver default
- [ ] Query logging is enabled in dev (postgres.js `debug`, Bun.sql logger, Prisma `log: ['query']`, Drizzle `logger: true`) so N+1 is visible during development

---

## §9 — What NOT to do

Common anti-patterns — avoid these unless you have data saying otherwise:

- **Don't use `SELECT *`** on tables with large TOAST-ed columns (big text/JSONB) in hot paths — select only the columns you need
- **Don't cache aggressively before measuring** — invalidation bugs cost more developer time than the CPU you save
- **Don't add indexes speculatively** — each one slows writes, consumes storage, and can confuse the planner
- **Don't rewrite SQL to "be more efficient"** without `EXPLAIN ANALYZE` — Postgres's planner is smart and your rewrite might be worse
- **Don't benchmark on localhost with a cold cache** — results are meaningless for production
- **Don't assume Bun's speed covers DB inefficiency** — Bun is fast, but a bad query is still a bad query

---

## Reference files

Read the relevant reference file when the user's situation calls for depth:

- `references/diagnose-workflow.md` — Full measure-locate-fix-remeasure workflow with commands
- `references/postgres-indexing.md` — Index types deep dive, composite design, partial/expression/GIN/BRIN with examples
- `references/query-patterns.md` — N+1 fixes for each driver, json_agg patterns, CTEs, window functions, bulk ops
- `references/drivers-and-pooling.md` — Bun.sql vs postgres.js vs Drizzle vs Prisma; config and pool sizing
- `references/bun-runtime.md` — Bun.serve tuning, workers, streaming, compression, Hono middleware
- `references/caching.md` — Redis clients for Bun, invalidation patterns, stampede protection, BullMQ integration
- `references/scripts/pg-diagnostic.sql` — Ready-to-run diagnostic queries (slow queries, missing indexes, bloat, locks)
- `references/scripts/k6-baseline.js` — Baseline load test template

---

## How to use this skill in practice

When a user reports a performance problem:

1. **Establish what's actually happening** — ask for metrics if they don't provide them, or have them run the diagnostic SQL first
2. **Find the layer** using the triage tree
3. **Apply the targeted fix** from the relevant section
4. **Recommend re-measurement** with the same method used for the baseline

When a user is building something new, use §8 as a checklist and call out performance considerations inline as the code takes shape — but don't lecture. Point out the one or two things that will matter at their actual scale, not every possible optimization.
