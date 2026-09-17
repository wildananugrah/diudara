---
name: data-engineering-expert
description: Expert guidance for data pipelines, warehouses, lakes, and lakehouses. Covers data modeling (OLTP vs OLAP, dimensional, SCDs), ingestion (batch, streaming, CDC), transformation (dbt, SQL, Spark), orchestration (Airflow, Dagster, Prefect), storage formats (Parquet, Iceberg, Delta), query performance, data quality and contracts, schema evolution, PII governance, and cost. Use whenever the user mentions ETL, ELT, CDC, pipeline, warehouse, lake, lakehouse, dbt, Airflow, Dagster, Snowflake, BigQuery, Redshift, Databricks, Iceberg, Delta, Kafka, Debezium, medallion, bronze/silver/gold, star schema, SCD, Parquet, partition, clustering, MERGE, upsert, backfill, incremental, data contract, or data quality. Also trigger on "ingest", "load", "move data from X to Y", "my query is slow", "backfill", "reconcile", "deduplicate", or any analytical data flow. Err toward triggering — if work involves moving, shaping, or querying analytical data at any scale, engage.
---

# Data Engineering Expert

A practical playbook for designing, building, and operating data systems. Apply it in the order: model the data → pick the storage → design ingestion → transform → test → orchestrate → observe → optimize.

## How to use this skill

1. **Diagnose before prescribing.** Before recommending a stack, ask (or infer from context): volume, velocity, latency SLA, update frequency, access patterns, team size, budget, existing stack. The "right" answer for 10 GB/day is wrong for 10 TB/hour.
2. **For greenfield design**, walk the user through modeling → storage → ingestion → transformation → orchestration. Pick one concrete stack and justify it — don't present five options with a shrug.
3. **For fixing a broken or slow pipeline**, read the symptoms, jump to the relevant section (ingestion reliability, query performance, schema drift, cost), and give a concrete fix with SQL or code.
4. **Deep dives** live in `references/`:
   - `references/pipeline-patterns.md` — orchestration, idempotency, CDC, backfill, streaming
   - `references/dbt-patterns.md` — models, tests, macros, incremental strategies
   - `references/sql-performance.md` — EXPLAIN, indexes, partitioning, clustering, common anti-patterns
5. **Be opinionated.** "Use dbt + Snowflake + Airflow" beats "consider various options." Default to the industry-standard stack unless there's a reason to deviate.

---

## 1. Diagnostic first questions

Before writing a single line of code, establish:

| Question | Why it matters |
|---|---|
| **Volume today / in 2 years?** | 1 GB vs 1 TB vs 1 PB are different universes. Postgres handles 1 TB fine; 100 TB needs a warehouse. |
| **Latency SLA?** | "Fresh by tomorrow 9am" → batch. "< 1 min" → micro-batch or streaming. "< 1 sec" → real-time with Kafka/Flink. |
| **Who queries it?** | Analysts writing SQL → warehouse. Data scientists doing ML → lakehouse. App reading one row by key → OLTP, not analytics. |
| **Update pattern?** | Append-only, upsert, full-refresh, SCD type 2 — each has a different ingestion pattern. |
| **Source systems?** | Postgres CDC is different from Salesforce API is different from S3 file drops. |
| **Budget and team?** | A 2-person team should not run Airflow + Spark + Kafka + dbt + 5 warehouses. |

If the answers are unclear, ask. "I'll build a pipeline" without these is premature.

---

## 2. Data modeling: OLTP vs OLAP

These are different worlds. Don't mix them.

**OLTP (transactional)** — Postgres, MySQL, etc.
- Normalized (3NF). Minimize redundancy, protect consistency.
- Row-oriented storage, indexed by primary key.
- Point queries: "Get user 42's current balance." Sub-ms.
- Don't run analytics here — a `GROUP BY` over 100M rows will tank your prod DB.

**OLAP (analytical)** — Snowflake, BigQuery, Redshift, Databricks, DuckDB, ClickHouse.
- Denormalized. Wide tables, star schemas. Redundancy is fine; scans are fast.
- Columnar storage, partitioned and clustered.
- Aggregates: "Total revenue by region, month over 5 years." Seconds.
- Don't do single-row lookups here — warehouse queries have high overhead.

**Rule**: if the same table is hit by both an app and a BI tool, you have a problem. Replicate OLTP → OLAP via CDC (Debezium, Fivetran, Airbyte, native CDC) and keep them separate.

### Dimensional modeling (Kimball)

For analytics, the default is **star schema**:
- **Fact tables** — measurements at some grain (one row per order-line, one row per page-view). Mostly numeric, foreign keys to dimensions.
- **Dimension tables** — descriptive entities (customer, product, date, store). Denormalized, wide.

```sql
-- fact
CREATE TABLE fct_orders (
  order_key       BIGINT,         -- surrogate key
  order_date_key  INT,            -- FK to dim_date
  customer_key    BIGINT,         -- FK to dim_customer
  product_key     BIGINT,         -- FK to dim_product
  quantity        INT,
  gross_amount    NUMERIC(12,2),
  tax_amount      NUMERIC(12,2),
  net_amount      NUMERIC(12,2)
);

-- dim
CREATE TABLE dim_customer (
  customer_key    BIGINT,         -- surrogate
  customer_id     VARCHAR,        -- natural / business key
  name            VARCHAR,
  country         VARCHAR,
  segment         VARCHAR,
  valid_from      TIMESTAMP,
  valid_to        TIMESTAMP,
  is_current      BOOLEAN         -- SCD type 2 markers
);
```

### Slowly Changing Dimensions (SCDs)

When a dimension attribute changes (customer moves country), how do you record history?

- **SCD Type 1** — overwrite. Simplest. Loses history. Fine for typo corrections.
- **SCD Type 2** — new row with `valid_from`, `valid_to`, `is_current`. Preserves history. The default for business-meaningful changes.
- **SCD Type 3** — previous value in a column. Rarely used; doesn't scale beyond one prior value.

For most dimensions, use Type 2. dbt snapshots handle this — see `references/dbt-patterns.md`.

### Medallion architecture (Databricks' name for a common pattern)

- **Bronze** — raw, append-only, exact copy of source. No transformations. Your audit trail.
- **Silver** — cleaned, deduplicated, joined, conformed. One row per business entity per event.
- **Gold** — aggregated, business-facing marts. What the BI tool queries.

Rebuild silver+gold from bronze any time — bronze is sacrosanct.

---

## 3. Storage: warehouse vs lake vs lakehouse

| | **Warehouse** | **Lake** | **Lakehouse** |
|---|---|---|---|
| Examples | Snowflake, BigQuery, Redshift | S3 + Glue/Athena, raw Parquet on GCS | Databricks, Iceberg on S3, Delta Lake |
| Storage | Proprietary | Open (Parquet/ORC) | Open (Parquet + Iceberg/Delta) |
| Compute | Bundled | BYO (Spark, Trino, Athena) | Decoupled, multi-engine |
| SQL performance | Excellent | Decent with engines | Excellent (ACID, stats) |
| Schema enforcement | Strong | Weak (schema-on-read) | Strong |
| Cost model | Storage + compute credits | Cheap storage; compute per query | Storage + compute |
| Best for | Analytics, BI, dashboards | ML, unstructured, cheap cold storage | Both |

**Default pick for most teams**: start with a warehouse (Snowflake or BigQuery). Move to lakehouse only when you have ML workloads, multi-TB/day, or multi-engine needs.

**Postgres as a warehouse** works up to ~1 TB and a handful of concurrent analysts. Beyond that you'll fight it — move to Snowflake/BigQuery. For single-machine analytics on files, **DuckDB** is spectacular and often the right answer for under 1 TB.

---

## 4. Ingestion: ETL vs ELT, batch vs streaming

### ELT > ETL for modern stacks

Historically: **E**xtract → **T**ransform in a pipeline → **L**oad cleaned data.
Modern (post-Snowflake/BigQuery): **E**xtract → **L**oad raw → **T**ransform inside the warehouse (dbt).

Why ELT wins:
- Warehouse compute is cheap and parallel.
- Raw data is preserved in bronze — you can always reprocess.
- SQL transformations are easier to maintain than Python/Scala jobs.
- dbt gives you tests, docs, lineage for free.

Use ETL only when: transforms are heavy (ML features, complex parsing) and the target is a lake, not a warehouse.

### Batch vs streaming

- **Batch** — hourly or daily. 95% of analytics needs. Simple, cheap, easy to reason about.
- **Micro-batch** — every few minutes. dbt incremental models triggered frequently, or Snowflake Dynamic Tables.
- **Streaming** — sub-second. Kafka + Flink / ksqlDB / Materialize. Only when a human or machine acts on the data in real-time (fraud detection, trading, alerting).

**Rule**: if "five minutes late" would not cause pain, don't stream. Streaming is 10× the complexity.

### CDC (Change Data Capture)

Replicate Postgres/MySQL into the warehouse continuously:
- **Debezium → Kafka → warehouse** — open-source, powerful, operationally heavy.
- **Fivetran / Airbyte / Estuary** — managed, usage-priced, just works.
- **Native CDC** — AWS DMS, GCP Datastream, Snowflake's native Postgres CDC.

For banking/financial systems where every change matters, prefer log-based CDC (reads WAL) over trigger-based or timestamp-based (lossy, misses deletes).

See `references/pipeline-patterns.md` for full CDC, idempotency, and backfill patterns.

### Ingestion principles (non-negotiable)

1. **Idempotent loads** — running the same load twice must not duplicate data. Use `MERGE`/upsert keyed on a natural or hash key, not `INSERT`.
2. **Watermarks** — track the high-water mark (`updated_at`, LSN, offset) per source. Resume from it. Don't re-scan the world every run.
3. **Late-arriving data** — allow a lookback window (e.g. last 7 days) so corrections propagate.
4. **Dead-letter queues** — bad rows go to a quarantine table with the error; the pipeline doesn't halt.
5. **Schema drift handling** — log unknown columns; don't crash. But alert.
6. **Full-refresh escape hatch** — every incremental pipeline needs a "rebuild from scratch" path.

---

## 5. Transformation: use dbt

For SQL-based transforms in a warehouse, **dbt is the default**. It gives you:
- Dependency graph (models reference each other; dbt orders them).
- Incremental materializations (only process new rows).
- Tests (`unique`, `not_null`, `accepted_values`, custom SQL).
- Docs and lineage auto-generated.
- Version-controlled SQL as code.

```sql
-- models/marts/fct_orders.sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    on_schema_change='append_new_columns'
) }}

SELECT
  o.order_id,
  o.customer_id,
  o.ordered_at,
  SUM(oi.quantity * oi.unit_price) AS gross_amount
FROM {{ ref('stg_orders') }} o
JOIN {{ ref('stg_order_items') }} oi USING (order_id)

{% if is_incremental() %}
  WHERE o.ordered_at >= (SELECT COALESCE(MAX(ordered_at), '1900-01-01') FROM {{ this }})
                   - INTERVAL '3 days'  -- lookback for late arrivals
{% endif %}

GROUP BY 1, 2, 3
```

Standard project layout:
```
models/
  staging/       -- one model per source table, light cleaning, renames
    stg_orders.sql
    stg_orders.yml   -- tests and docs
  intermediate/  -- reusable joins / transformations
    int_order_items_enriched.sql
  marts/
    core/        -- business-grade fact/dim tables
      fct_orders.sql
      dim_customers.sql
    finance/     -- domain-specific marts
```

Full dbt guidance in `references/dbt-patterns.md` (incremental strategies, snapshots for SCD2, macros, exposures, testing pyramid).

### When not dbt

- Python transforms (ML features, complex parsing) → Spark (Databricks), Polars, or PyArrow.
- Streaming transforms → Flink, Spark Structured Streaming, Materialize, RisingWave.

---

## 6. Orchestration: Airflow, Dagster, Prefect

All three run DAGs of tasks on a schedule with retries.

- **Airflow** — most mature, largest ecosystem, most Kubernetes-friendly. Steep learning curve, imperative DAG definition. Default for large enterprises.
- **Dagster** — asset-oriented (you declare *what*, not *how*). Great local dev experience, better typing, better observability. Best modern choice for new projects.
- **Prefect** — Pythonic, easy on-ramp. Good for small-to-medium teams.

For a small team: **Dagster** or managed alternatives (dbt Cloud, Prefect Cloud, Astronomer).
For large / regulated / Kubernetes-native: **Airflow**, ideally managed (MWAA, Cloud Composer, Astronomer).

### Orchestration principles

- **Tasks are idempotent.** A retry must not double-process.
- **Tasks are small.** A 6-hour task that fails at hour 5 is expensive. Split.
- **Data dependencies, not time dependencies.** Don't schedule B at 10am hoping A finished by 9:59am. Make B depend on A completing.
- **Backfills are first-class.** You will need to rerun 90 days of history. Design for it.
- **Retries with backoff.** Network fails; retry 3× with exponential backoff before alerting.
- **Alerts go to the on-call, not a shared inbox.** With context (which table, which date, what error).

---

## 7. Data quality and contracts

Without tests, your warehouse becomes untrusted. Build the testing pyramid:

1. **Source freshness** — "orders hasn't loaded in 6 hours" → page someone.
2. **Schema tests** — `unique`, `not_null`, `relationships`, `accepted_values`. Cheap, catches 80% of bugs.
3. **Volume tests** — row count is within ±20% of trailing 7-day average. Catches silent loss.
4. **Business-logic tests** — `sum(net_amount) = sum(gross) - sum(tax)`. Catches transformation bugs.
5. **Cross-system reconciliation** — daily, source-system total vs warehouse total. Catches ingestion bugs.

Tools: **dbt tests** for 1–4, **Great Expectations** or **Soda** for broader/complex, **Elementary** or **Monte Carlo** for monitoring + anomaly detection.

### Data contracts

Producer-consumer agreement on schema + semantics, enforced in CI. Enables safe evolution.
- Producer declares a schema (YAML, protobuf, Avro).
- Changes to fields in the contract require a PR and consumer sign-off.
- Breaking changes bump a version; old version deprecated on a timeline.

This is what prevents "the engineer renamed `user_id` to `customer_id` and broke 40 dashboards."

---

## 8. Schema evolution and file formats

### Formats

| Format | Use case |
|---|---|
| **Parquet** | Columnar, compressed, splittable. Default for analytics at rest. |
| **ORC** | Similar to Parquet, Hive-native. |
| **Avro** | Row-oriented, schema-embedded. Default for Kafka messages. |
| **JSON** | Human-readable. Fine for APIs and small config, bad for analytics at scale. |
| **CSV** | Avoid in production — no schema, no types, no escaping guarantees. OK as an interchange. |
| **Iceberg / Delta / Hudi** | Table formats on top of Parquet; add ACID, time travel, schema evolution, partition evolution. |

For anything > 1 GB, use **Parquet**. For a lakehouse table, wrap it in **Iceberg** or **Delta**.

### Schema evolution rules

- **Additive changes are safe**: new nullable columns, new enum values (if consumers handle unknown).
- **Breaking changes**: rename, type change, drop column, make nullable → not-null. These require migration.
- **Avro + schema registry** gives you compile-time compatibility checks.
- In SQL warehouses, use dbt `on_schema_change: append_new_columns` for additive evolution, and `--full-refresh` for breaking.

### Partitioning and clustering

- **Partition** by the column most filtered on (usually date). Enables partition pruning — the engine skips files outside the filter.
- **Cluster / sort** within partitions by the next most common filter (user_id, region).
- **Don't over-partition.** One partition per day is fine; one per minute creates metadata chaos.
- In BigQuery: partition by date, cluster up to 4 columns. In Snowflake: clustering keys; let auto-clustering run. In Iceberg: partition spec, hidden partitioning.

See `references/sql-performance.md` for partition-pruning verification and common pitfalls.

---

## 9. Query performance

Query slow? Before buying more compute, check:

1. **`EXPLAIN`** — Is there a full scan? Are partitions pruned? Is the join order sane? Are stats fresh?
2. **Filter push-down** — Does your `WHERE` land on a partition/clustering column? If not, it scans everything.
3. **Joins** — Large-on-large without predicate = cartesian death. Filter first, then join. Use broadcast joins for small dims.
4. **Aggregation cardinality** — `COUNT(DISTINCT ...)` over billions is expensive. Use `APPROX_COUNT_DISTINCT` when approximate is OK.
5. **Materialize intermediate results** — Complex CTEs referenced multiple times are often recomputed. Materialize as a table.
6. **Indexes (OLTP)** — B-tree on equality+range columns, partial indexes for hot subsets, covering indexes for read-heavy.
7. **Stats freshness** — `ANALYZE` in Postgres, auto-stats in warehouses. Stale stats = bad plans.

Full performance deep-dive (EXPLAIN reading, index design, warehouse-specific tuning) in `references/sql-performance.md`.

---

## 10. Cost management

Analytics costs balloon silently. Guard rails:

- **Query budgets / row scanned limits** per user role (BigQuery `maximum_bytes_billed`, Snowflake resource monitors).
- **Separate warehouses per workload** — BI queries on one, ETL on another, ad-hoc on a third. Scale independently.
- **Auto-suspend / auto-resume** — Snowflake warehouses suspend after 60s idle.
- **Materialize frequent aggregations** — a 100 GB scan → 10 MB summary table costs more to build once than to scan 100× daily.
- **Partition and cluster.** Unpartitioned tables = full scans = bills.
- **Tiered storage** — cold data to S3 Glacier or BigQuery long-term storage. 10× cheaper after 90 days.
- **Cost attribution** — tag queries by team/dashboard. Show dashboards' cost to their owners. Nothing kills wasteful queries faster.

---

## 11. Governance, PII, and lineage

For banking/fintech (UU PDP, GDPR, PCI, POJK), these are required, not optional.

- **PII inventory** — know which columns hold personal data. Tag them (`pii=true`) in dbt or a catalog.
- **Masking/tokenization** — hash or tokenize SSNs, card numbers, emails before they land in analytics. Use Snowflake dynamic data masking, BigQuery column-level access, or tokenization at ingest.
- **Access control** — row-level security for multi-tenant, column-level for PII. Default deny.
- **Lineage** — dbt, OpenLineage, Marquez, or commercial catalogs (Atlan, Collibra, Alation). Answer: "if source.users changes, what breaks?"
- **Data retention** — right to erasure means you need to find and delete a user everywhere they appear. Design for it: single customer_id, no copy-pasted tables.
- **Audit trail** — log who queried what and when. Required for PCI/HIPAA/banking.

---

## 12. Observability

Four things must be monitored:

1. **Freshness** — "is the data current?"
2. **Volume** — "did today's load look like yesterday's?"
3. **Schema** — "did columns appear/disappear/change type?"
4. **Quality** — "do row-level tests still pass?"

Tools: **Elementary** (open source on dbt), **Monte Carlo**, **Bigeye**, **Anomalo**, **Soda**. For orchestration: Airflow/Dagster built-in + Grafana + PagerDuty.

Every pipeline needs: an owner, an SLA, a runbook, and alerts wired to a human.

---

## 13. Stack-specific notes

**Postgres** — Fine up to ~1 TB / medium analyst concurrency. Use logical replication for CDC. `pg_partman` for time partitioning. Beyond 1 TB, offload analytics.

**Snowflake** — Default warehouse. Virtual warehouses for compute isolation. Streams + Tasks for in-warehouse micro-batch. Dynamic tables for declarative freshness. Zero-copy clones for dev/test.

**BigQuery** — Default if you're on GCP. Serverless — no cluster to manage. Partition + cluster religiously; `SELECT *` in a query on a TB table costs real money. BI Engine for dashboards.

**Databricks** — Lakehouse. Choose when you have ML + analytics + streaming and want one platform. Use Unity Catalog for governance, Delta Live Tables for declarative pipelines.

**DuckDB** — Single-node analytics. Brilliant for under 1 TB, local dev, embedded in apps. Often the right answer for small/medium data that has been prematurely pushed to a warehouse.

**ClickHouse** — Real-time analytics on huge data. Sub-second over billions of rows. The right answer for product analytics, observability, ad tech.

**pgvector / vector DBs** — For RAG and similarity search, not analytics. Don't force vector workloads into the same Postgres that serves transactions.

---

## 14. Common pitfalls

- **Premature streaming.** Starts with Kafka, never delivers. Start with batch; add streaming only for the parts that truly need it.
- **One giant model.** A single 2000-line dbt model nobody can touch. Break into staging → intermediate → marts.
- **`SELECT *` in production.** Schema changes break downstream. Always enumerate columns.
- **Timezone drift.** Store UTC, convert at the presentation layer. Mixing `TIMESTAMP` and `TIMESTAMPTZ` and local zones is a bug factory.
- **Soft-delete unawareness.** Source says "deleted = true" but warehouse still counts the row. Filter at the staging layer.
- **No backfill plan.** Runs fine day-to-day but can't rebuild last quarter when requested.
- **Tests that never fire.** `not_null` on a column that's already `NOT NULL` in DDL. Write tests that could realistically fail.
- **Dashboards as sources of truth.** Metric defined in 8 dashboards → 8 different numbers. Define once in dbt or a semantic layer (Cube, dbt Semantic Layer, LookML).
- **PII in bronze unmasked.** Analysts now have production PII. Mask or tokenize *at ingestion*.
- **No data contract.** Engineer renames a column in prod Postgres; overnight all dashboards break.

---

## 15. Review checklist before shipping a pipeline

- [ ] Source of truth identified. Why this source? What's the upstream SLA?
- [ ] Schema documented with owner and PII tags.
- [ ] Idempotent load (MERGE / upsert, not INSERT).
- [ ] Watermark persisted; lookback window defined.
- [ ] dbt tests: `unique`, `not_null`, `relationships` on every important model.
- [ ] Volume / freshness alert configured.
- [ ] Backfill command tested end-to-end.
- [ ] Cost ceiling known — expected daily scan/credit burn documented.
- [ ] Lineage visible in catalog / dbt docs.
- [ ] Runbook written: how to retry, how to backfill, who to page.
- [ ] Access controls applied (RBAC, row-level, masking).

---

## When answering a data engineering question

Structure the response like this:

1. **Clarify** (one line) — what is the user actually trying to accomplish?
2. **Recommend** — pick *one* concrete approach. Name the tools.
3. **Show code** — SQL, dbt YAML, or Python that they can paste.
4. **Call out the trap** — what will go wrong in 6 months if they don't think about it (late-arriving data, schema drift, cost).
5. **Offer the next step** — "when you outgrow this, you'll want to move to X."

Don't list 7 options and let the user pick. Be the senior data engineer on the team.
