---
name: data-pipeline-architect
description: Senior-architect guidance for designing data pipelines and platforms end-to-end. Covers architecture patterns (batch, lambda, kappa, event-driven, medallion, hub-and-spoke, data mesh), NFR intake (SLA, RTO, RPO, freshness, throughput), capacity planning, reliability (backpressure, DLQ, circuit breakers, idempotency), disaster recovery, multi-region, data contracts, build-vs-buy, migration strategies (strangler, dual-write, shadow, expand-contract), observability, FinOps, and reference architectures. Use whenever the user asks to "design a data platform", "architect a pipeline", "scale our data stack", "migrate from X to Y", "pick batch vs streaming", "build a data mesh", defines SLAs/RTOs, or makes design decisions spanning teams or years. Also trigger on "data platform", "reference architecture", "capacity planning", "data contract", "event-driven", "lambda", "kappa", "DR plan", "greenfield data stack", "modernize pipeline". Err toward triggering for any design-level question.
---

# Data Pipeline Architect

A senior-architect playbook. This skill is for *designing* data platforms and pipelines — choosing patterns, setting SLAs, planning capacity, drafting reference architectures, and writing the decisions down so a team can execute for the next 2–3 years.

For day-to-day implementation (writing dbt models, tuning queries, building specific ingestion jobs), use the `data-engineering-expert` skill instead. This skill is about the *shape* of the system; that one is about the *insides*.

## How to use this skill

1. **Start with requirements, not tools.** Before recommending Snowflake vs Databricks vs Postgres, gather the non-functional requirements (section 2). Skipping this is how you end up with a Kafka cluster nobody needs.
2. **Produce an architecture document, not a chat reply.** When the user asks "how should we design X", structure the response as: context → requirements → options considered → chosen architecture (with a diagram) → trade-offs → migration/rollout plan → risks.
3. **Draw diagrams in ASCII or Mermaid.** Every architecture gets a picture. Section 15 has templates.
4. **Pick one path and justify it.** An architect who presents "six options, you choose" is abdicating. Recommend, then list the runner-up and why it lost.
5. **Deep dives** live in references:
   - `references/reference-architectures.md` — concrete diagrams for 8 common scenarios
   - `references/capacity-planning.md` — sizing formulas, queue theory basics, worked examples
   - `references/migration-playbook.md` — strangler, dual-write, shadow, cutover patterns

---

## 1. The architect's job

A data pipeline architect owns:
- **Requirements translation** — business asks → NFRs with numbers.
- **Pattern selection** — which architecture style fits.
- **System boundaries** — what's one service, what's separate, what's a platform.
- **Data contracts** — who owes what to whom, schema + semantic + SLA.
- **Failure design** — how the system degrades, not just how it succeeds.
- **Capacity and cost** — sizing now, headroom for 2 years.
- **Migration paths** — how we get from current-state to target-state without downtime.
- **Decisions written down** — ADRs (Architecture Decision Records), runbooks, diagrams.

Not your job: writing every dbt model, tuning every query, picking every library. Delegate and review.

---

## 2. Requirements intake (NFRs with numbers)

Before drawing a single box, establish these. Refuse to design until you have numbers, not adjectives.

### Volume and velocity
- Current and projected data volume (rows/day, GB/day, TB total).
- Peak-to-average ratio (some sources are 20× higher during events).
- Record size distribution (1 KB vs 1 MB changes the stack).
- Growth rate (doubling every 6 months vs 10%/year is a different problem).

### Latency / freshness SLA
- **End-to-end lag budget**: from source event to consumer queryable. "Fresh by 9am" vs "< 5 min" vs "< 1 sec" are three different architectures.
- **p50 vs p99** — streaming systems have long tails; specify both.

### Availability and durability
- **Uptime SLA** — 99.9% (~9h/year downtime), 99.99% (~52min), 99.999% (~5min). Each extra 9 roughly 10×'s the cost.
- **RPO (Recovery Point Objective)** — how much data can you afford to lose? 0? 1 hour? 1 day?
- **RTO (Recovery Time Objective)** — how long can the system be down? Minutes? Hours?
- **Durability** — S3 is 11 nines; single-node Postgres is not. Match tier to data criticality.

### Consistency
- **Exactly-once vs at-least-once vs at-most-once.** Exactly-once is expensive; most analytics survive at-least-once + idempotent sinks.
- **Ordering guarantees** — per-key? Global? Best-effort?

### Access patterns
- Who queries? Analysts (SQL), apps (low-latency API), data scientists (notebooks), ML (batch inference).
- QPS, query shape, result size.
- Read-heavy vs write-heavy (changes the whole design).

### Regulatory / compliance
- PII handling (UU PDP, GDPR, CCPA).
- Financial (PCI-DSS, SOX, POJK, BI regulations for Indonesian banks).
- Data residency — must data stay in-country? This constrains cloud region choices.
- Audit trail requirements (who did what when).
- Retention requirements — 7 years for financial, 3 years for HR, etc.

### Organizational
- Team size and skills (a 2-person team can't operate Kafka + Flink + Airflow + Spark).
- Operating model — will there be dedicated data engineers, or will app teams own their pipelines?
- Budget envelope.

**Rule of thumb**: if you can't fill in 80% of this table, the design will be wrong. Go back and ask.

---

## 3. Architecture patterns

### Batch ELT
Source → raw landing → warehouse → dbt → marts → BI.

- **Latency**: minutes to hours.
- **Complexity**: low.
- **Cost**: low-moderate.
- **When**: 95% of analytics workloads. BI dashboards, reporting, ML training data.
- **Avoid when**: real-time alerting, fraud, trading, operational use cases.

### Micro-batch
Same as batch but every 1–15 minutes. Often dbt incremental runs, or Snowflake Streams+Tasks, or Dynamic Tables.

- **When**: "near real-time" requirements without true streaming complexity.
- **Caveat**: at 1-min cadence, incremental overhead starts to dominate. Past that, switch to streaming.

### Lambda architecture
Two pipelines in parallel: a **batch layer** (correct, slow) and a **speed layer** (approximate, fast). Serving layer unions both.

- **When**: you need real-time AND high accuracy, and can't get both from one path.
- **Downside**: *two codebases for the same logic*. This is the main critique of Lambda — you end up maintaining everything twice.
- **Modern alternative**: Kappa (below) or "big batch + thin streaming overlay" with pre-merged views.

### Kappa architecture
One streaming pipeline. Historical reprocessing happens by replaying the stream from the log (Kafka retention, Pulsar tiered storage).

- **When**: streaming-native org, event-sourced sources, team can operate Flink/Spark Streaming/Materialize.
- **Downside**: long backfills = long replays. Not ideal if history lives outside the log.

### Event-driven (event sourcing + CQRS)
Producers emit events to a log. Multiple consumers materialize their own read models. Source of truth is the event log.

- **When**: lots of consumers, evolving read requirements, need perfect audit trail. Good fit for banking/fintech — every state change is an event.
- **Downside**: event schema evolution is hard. Requires a schema registry and discipline.

### Medallion (bronze / silver / gold)
- **Bronze**: raw, append-only.
- **Silver**: cleaned, deduped, conformed.
- **Gold**: aggregated, business-facing.

Not really a competing pattern — more a *layering convention* that sits inside any of the above. Use it as your default layering language.

### Hub-and-spoke
Central platform team operates shared ingestion, storage, orchestration. Domain teams build their own marts on top.

- **When**: medium org (20–200 data users), single warehouse, shared infra is cost-efficient.
- **Downside**: central team becomes bottleneck as domains grow.

### Data mesh
Decentralized. Each domain owns its data as a *product* with its own SLA, contract, docs. Central platform team provides self-serve infrastructure but doesn't own domain data.

- **When**: large org (100s of data users, 10+ domains), strong engineering culture, enough domains to justify per-domain ownership.
- **Downside**: expensive; requires mature domains; wrong for small/medium companies. The most misapplied pattern in data.
- **Honest take**: unless you're at a >500-person company with multiple clear product lines, don't do data mesh. Do hub-and-spoke well first.

**Decision heuristic**:
- Small team, single app → batch ELT into a warehouse. dbt. Done.
- Medium org, analytics + light streaming → batch ELT + CDC + micro-batch. Medallion layering.
- Real-time operational use case → streaming (Kafka + Flink or Materialize).
- Very large org, many domains → hub-and-spoke or data mesh.

---

## 4. Capacity planning

Size for 2 years out at 3× today's peak. Not 100× — that's over-engineering. Not 1× — that's a rewrite in 6 months.

Key numbers you need to estimate:

- **Ingestion rate** (events/sec, MB/sec at peak).
- **Storage growth** (GB/month, retained for N years).
- **Query concurrency** (analysts + dashboards + ML).
- **Query scan size** (TB scanned/month, for BigQuery/Snowflake cost).
- **Job runtime budget** (total minutes/day of warehouse compute).

Rules of thumb:
- Kafka partition: ~10 MB/s sustained per partition. Multiply partitions to scale.
- Postgres OLTP: ~10k TPS on a beefy single instance before you need sharding.
- Snowflake XS warehouse: ~8 concurrent queries comfortably. Scale out with multi-cluster.
- BigQuery: serverless, but you pay per byte scanned — design to scan little.
- dbt run time: if it takes > 30 min, you need incremental models.
- Data lake file size: target 128 MB – 1 GB per Parquet file. Too many small files kill query engines.

See `references/capacity-planning.md` for worked examples and queue-theory basics (Little's law, M/M/1 utilization limits).

---

## 5. Reliability patterns

### Idempotency (non-negotiable)
Every pipeline step must be idempotent. Retries are a fact of life. Use natural keys + MERGE, not INSERT-with-dedupe-later.

### Backpressure
When downstream is slow, upstream must slow down, not crash.
- **Kafka consumers**: pull-based, built-in backpressure.
- **HTTP-based ingestion**: use bounded queues + 429 responses.
- **Streaming frameworks (Flink, Spark Streaming)**: built-in watermark-based backpressure.

Never drop data silently. If you must drop, drop to a dead-letter queue with metadata.

### Dead-letter queue (DLQ)
Bad records go to a quarantine location with the error, source offset, and timestamp. Pipeline continues. Alert on DLQ growth rate, not individual failures.

### Circuit breaker
When a dependency is failing, stop calling it for a cooldown period. Prevents cascading failure. Patterns: Hystrix (historical), Resilience4j, or built into service meshes.

### Retry with exponential backoff + jitter
Never retry in a tight loop. `sleep = base * 2^attempt + random_jitter`. Cap at some maximum. Don't retry on 4xx errors (the request is wrong; retrying won't help).

### Bulkheads
Isolate resources so one failure can't drain everything. Example: separate Snowflake warehouses for ETL vs BI vs ad-hoc. An expensive ad-hoc query shouldn't starve the dashboard refresh.

### Timeouts, everywhere
Every network call has a deadline. Default 30s is wrong — set it based on the operation. A 5-min `GET` is almost never correct.

### Graceful degradation
If the real-time layer fails, does the batch layer still serve? If the enrichment API is down, do you buffer, skip, or fail? Answer these at design time.

---

## 6. Scalability design

Scale along four axes — pick the one(s) that match the bottleneck:

1. **Vertical** (bigger machine). Simple. Has a ceiling. Good early on.
2. **Horizontal** (more machines). Stateless work scales trivially; stateful work needs partitioning.
3. **Temporal** (batch bigger intervals; parallelize by time partition). Natural for date-partitioned data.
4. **Functional** (split one pipeline into several with clearer domains). Organizational, not just technical.

**Partitioning**: if you can't partition by a meaningful key (customer_id, region, event_date), you can't scale horizontally. Pick the key early — changing it later is painful.

**Avoid shared state**. Any pipeline step that holds global state (a dedupe cache, a lookup table in memory) becomes the bottleneck. Push state to a DB, cache, or stream store.

**Skew is the silent killer**. 10% of customers = 80% of orders. One partition does all the work. Address with salting, sub-bucketing, or special-casing the hot keys.

---

## 7. Disaster recovery & business continuity

Define at design time — not after the first outage.

| Tier | RPO | RTO | Cost | Typical implementation |
|---|---|---|---|---|
| **Critical (Tier 1)** | < 1 min | < 15 min | High | Multi-region active-active, sync replication |
| **Important (Tier 2)** | < 1 hr | < 4 hr | Moderate | Multi-region active-passive, async replication |
| **Standard (Tier 3)** | < 24 hr | < 24 hr | Low | Daily backup to object storage, restore on demand |
| **Archive (Tier 4)** | N/A | Weeks | Very low | Glacier / cold storage |

Backups are not DR. A backup you've never restored doesn't work. **Test DR at least annually** with a real failover drill. For banking/fintech, quarterly is expected.

**Backup requirements**:
- Backups in a different region (protects against regional outage).
- Backups in a different account (protects against credential compromise).
- Encrypted at rest.
- Immutable / WORM if regulatory (protects against ransomware).
- Retention matches legal requirements.

---

## 8. Data contracts

A data contract is a producer-consumer agreement:
- **Schema** — columns, types, nullability.
- **Semantics** — what does each field mean? Units, enums, conventions.
- **SLA** — freshness, availability, volume tolerance.
- **Ownership** — who fixes breakage; who approves changes.
- **Versioning** — how breaking changes are handled.

Stored in Git, enforced in CI. When a producer tries to merge a breaking change, CI blocks until consumers sign off.

Concretely:
- **Schema**: Avro / Protobuf / JSON Schema registered in a schema registry (Confluent, AWS Glue, Apicurio).
- **Tests**: dbt contracts (`contract: {enforced: true}` on models), or producer-side tests that validate against the contract.
- **Docs**: written in the same repo; generated into a catalog.

Banking/fintech use case: the "customer" table is a contract between the core banking system team and the analytics team. Fields like `account_status`, `balance_currency`, `tax_residency` have precise semantics and change only via PR.

---

## 9. Observability architecture

Five pillars for data pipelines:

1. **Freshness** — is the data current? (max `updated_at` per table vs now).
2. **Volume** — today's row count vs rolling baseline.
3. **Schema** — did columns appear/disappear/change type?
4. **Quality** — do assertions still pass? (not_null, unique, reference integrity).
5. **Lineage** — if upstream X fails, what downstream is affected?

Signals go to:
- **Metrics** (Prometheus/CloudWatch/Datadog) — numerical time series, alert thresholds.
- **Logs** (structured, JSON) — for post-hoc investigation.
- **Traces** (OpenTelemetry) — for distributed pipeline debugging.
- **Catalog** (Atlan, DataHub, OpenLineage, Marquez) — lineage + docs.

Every pipeline must answer:
- **Who owns me?** (team, on-call)
- **What's my SLA?** (freshness, success rate)
- **How do I fail?** (runbook — how to retry, backfill, escalate)
- **Who depends on me?** (downstream consumers)

Design this in from day one. Retrofitting observability onto an existing platform is brutal.

---

## 10. Security architecture (by design)

- **Encryption in transit**: TLS 1.2+ everywhere, including internal service-to-service.
- **Encryption at rest**: KMS-backed, with key rotation. Separate key per tenant if multi-tenant.
- **Authentication**: service-to-service via short-lived tokens (workload identity, SPIFFE, IAM roles), not static credentials.
- **Authorization**: least privilege. Row-level and column-level access in warehouses. No "select *" roles.
- **PII handling**: identify at ingestion, mask/tokenize before silver layer. Define the rules in a data classification policy.
- **Audit trail**: who queried what, who changed what. Required for banking, PCI, HIPAA. Store in an immutable tier, separate account.
- **Secret management**: vault or platform secret store. Never in code, CI logs, Slack, or Jira.
- **Network isolation**: private subnets, VPC endpoints, no public database access.

See the `security-best-practices` skill for app-layer specifics; this skill owns the *architectural* placement of those controls.

---

## 11. FinOps / cost architecture

Data platform costs balloon silently. Design for cost governance from day one.

**Patterns**:
- **Tag everything** — every resource, query, job has an owner + cost center tag.
- **Chargeback / showback** — each team sees (or pays) their share. Behavior changes when bills are visible.
- **Query budgets** — per-user / per-role limits (BigQuery `maximum_bytes_billed`, Snowflake resource monitors).
- **Warehouse isolation** — BI on one, ETL on another, ad-hoc on a third. Scale independently; one team's bad query doesn't tank everyone.
- **Tiered storage** — hot (last 30 days in warehouse), warm (90 days in cheap object storage, queried via external tables), cold (Glacier).
- **Auto-suspend** — dev warehouses suspend after 60s idle.
- **Materialization budget** — every additional materialized table costs storage + refresh compute. Review quarterly.
- **Right-sizing review** — monthly: find over-provisioned resources, drop unused indexes/tables, archive dead datasets.

**Unit economics**: know your $/GB ingested, $/query, $/active user. You cannot optimize what you don't measure.

---

## 12. Build vs buy

For each component (orchestration, CDC, catalog, observability, transformation), ask:

| Question | Weight |
|---|---|
| Is this differentiated to our business? | If no → buy. |
| Do we have operational capacity for this? | If no → managed/buy. |
| How mature is the OSS option? | If immature → buy (or wait). |
| What's the TCO including people? | Include salary, on-call, maintenance. |
| Can we switch later if we're wrong? | Prefer choices with exit paths. |

**Common correct "buy" decisions**: Fivetran/Airbyte for connectors, dbt Cloud or Astronomer for orchestration hosting, managed Kafka (Confluent/MSK), managed warehouse (Snowflake/BigQuery over self-hosted ClickHouse).

**Common correct "build" decisions**: domain-specific data models, custom metrics layer logic, company-specific data products.

**Common wrong "build" decisions**: home-grown orchestrator, custom CDC from scratch, bespoke schema registry. These have swallowed many data teams.

---

## 13. Migration strategies

See `references/migration-playbook.md` for full step-by-step. Summary:

### Strangler fig
Route traffic/data slowly from old to new. Build the new alongside the old; redirect one feature at a time; retire old when traffic is 0.
- **When**: any migration where big-bang is too risky. Most migrations.

### Dual-write
Write to both old and new for a period, compare, switch reads when confident.
- **When**: source-system migrations. Critical path for accuracy.

### Shadow / dark launch
New pipeline runs in parallel, produces outputs nobody consumes. Compare outputs against old. Fix discrepancies. Cut over when matched.
- **When**: re-platforming with confidence needed.

### Big-bang cutover
Stop old, start new. Fast, high-risk.
- **When**: small scope, low criticality, tight deadline.

### Expand-contract (for schema migrations)
Add new columns (expand) → dual-write → switch readers → remove old (contract).
- **When**: non-breaking schema evolution with zero downtime.

**Universal rule**: every migration needs a **rollback plan** tested before cutover. "We'll figure it out if something breaks" is not a plan.

---

## 14. Documentation the architect owns

Writing things down is the architect's job. Minimum artifacts:

1. **Architecture Decision Records (ADRs)** — one per significant decision. Context, options, decision, consequences. Stored in Git alongside code.
2. **Reference architecture diagram** — the canonical picture, updated when things change.
3. **Data flow map** — sources → sinks, with SLAs and owners.
4. **Runbooks** — one per pipeline: how to retry, backfill, escalate, roll back.
5. **Data contracts** — schema + SLA + ownership, in the data catalog.
6. **Capacity plan** — current usage, projections, trigger points for scaling.
7. **DR plan** — tiers, RPO/RTO, tested failover procedure.
8. **Security and compliance map** — where PII lives, what controls apply.

An architecture that exists only in one person's head is not a design. It's a bus factor.

---

## 15. Drawing the architecture

Every design deliverable includes a picture. Use ASCII for portability or Mermaid for collaboration tools that render it.

**Minimum acceptable diagram**:

```
┌─────────────┐    CDC     ┌──────────┐   Landing   ┌────────────┐
│  Postgres   │───────────▶│  Kafka   │────────────▶│  S3 Bronze │
│  (source)   │  Debezium  │          │   Sink      │  (Iceberg) │
└─────────────┘            └──────────┘             └─────┬──────┘
                                                          │
                                                          │ dbt + Spark
                                                          ▼
                               ┌──────────────┐     ┌─────────────┐
                               │  BI tool     │◀────│  Snowflake  │
                               │  (Looker)    │     │  Gold marts │
                               └──────────────┘     └─────────────┘

SLA: end-to-end freshness < 15 min
Owner: data-platform team
PII: masked at Bronze → Silver boundary
```

For complex systems, split into layered views:
- **Context diagram** — this system vs external systems.
- **Container diagram** — major components / services.
- **Component diagram** — inside one container.
- **Data flow diagram** — who produces/consumes what.

See `references/reference-architectures.md` for 8 complete worked examples (small analytics, banking transaction ledger, fintech event-driven, multi-region, streaming-first, lakehouse, real-time fraud, IoT ingestion).

---

## 16. Common architecture failures

| Failure | Root cause | Design fix |
|---|---|---|
| Pipeline can't scale past single machine | State held in memory, no partition key | Pick partition key early; externalize state |
| One bad record crashes the whole run | No DLQ | Build DLQ into every ingestion path |
| Retrying doubles data | Non-idempotent sink | MERGE / upsert on natural key |
| Can't backfill without downtime | No parameterized date range; full-refresh only | Design incremental models with `start_date`/`end_date` |
| Central team is bottleneck | Single-team ownership of all domains | Hub-and-spoke or mesh; domain ownership |
| Costs tripled after launch | No tagging, no budgets | Tags, budgets, warehouse isolation, cost dashboards |
| Can't onboard new sources | Bespoke code for each source | Managed connectors (Fivetran/Airbyte) + standard schema pattern |
| 3am pages with no runbook | No ownership + observability | Every pipeline has an owner, SLA, runbook |
| Producer breaks downstream constantly | No data contract | Git-versioned contracts, CI enforcement |
| DR plan exists on paper but fails | Never tested | Annual/quarterly DR drill |
| Pipeline is a black box to analysts | No lineage / docs | OpenLineage + catalog from day one |
| Streaming pipeline nobody can debug | Built too early, for a batch use case | Start batch, add streaming only where needed |
| Schema drift causes silent data loss | `ignore` or no drift handling | `append_new_columns` + alerts on new/removed fields |

---

## 17. How to respond to an architecture request

Structure every serious design response like this:

1. **Context** (2–3 sentences) — what problem is being solved, for whom.
2. **Requirements** — the NFRs you're designing against, with numbers. Flag any missing ones and ask.
3. **Options considered** — brief; 2–3 alternatives with one-line trade-off each.
4. **Recommended architecture** — the diagram. Components labeled. Data flow arrows. SLA numbers on the page.
5. **Key decisions** — 3–5 ADR-worthy choices and the reasoning.
6. **Trade-offs and risks** — what you're accepting; what can go wrong.
7. **Rollout / migration plan** — phases, rollback point, success criteria.
8. **Open questions** — what's unknown, who owns resolving it.

Resist the urge to jump to section 4. The first three sections are what separates architecture from "here's a diagram I drew."

When the user asks a narrower question ("should we use Kafka or SQS?"), still frame the answer around requirements and trade-offs. Never recommend a tool without tying it back to an NFR.
