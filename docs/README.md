# System Design Knowledge Base

Consolidated system-design knowledge from three local repositories, organized for engineers and for the decision engine in [`architect/`](../architect).

| Repository | Content | Extract |
|---|---|---|
| `system-design-primer-master` | Building blocks, latency numbers, 8 worked solutions, the AWS scaling progression | [knowledge/system-design-primer.md](knowledge/system-design-primer.md) |
| `system-design-main` | About 50 building blocks with trade-offs, 5 case studies with estimation math | Local only (CC BY-NC-ND 4.0, not redistributed) |
| `system-design-101-main` | 400 short guides: technologies, patterns, real-world architectures | Local only (CC BY-NC-ND 4.0, not redistributed) |
| Machine-readable | 121 questions, 99 components, 231 data flows, 81 validation rules, 21 derived facts, 720 provider service offers, technologies, patterns, reference numbers, 31 scenarios, index of all 400 guides | `knowledge/kb.json`, generated locally |

`kb.json` is generated from `architect/src/knowledge/*.ts` with `npm run kb:export`. Every entry carries `sources` (repository, file, line range). With the three source repositories checked out next to `architect/`, tests fail if a cited file or line range does not exist, or if any architecture section of the system-design-main README (50 of 50), any primer section (all from Performance vs scalability through the appendix), or any of the 8 primer solutions is not cited; without them those checks are skipped. `kb.json` also contains `guides`: an index of all 400 system-design-101 guides (title, category, tags, relevance, and the knowledge-base entries that cite it), built by `npm run kb:guides`. The knowledge base cites 72 guides directly.

## 1. Method

All three repositories teach the same loop:

1. Clarify use cases, users, and constraints (who, how many, read:write ratio, latency, availability).
2. Estimate: requests/s, storage, bandwidth, cache memory (primer `scaling_aws:49-61`, main `3516-3600`).
3. Draw the simplest high-level design that meets the numbers.
4. Benchmark, find the bottleneck, add the component that removes it, repeat (primer `scaling_aws:15`).

The decision engine encodes step 1 as questions, step 2 as the workload model, step 3 as component rules with a simplicity bias, and step 4 as sizing, utilization and validation.

## 2. Reference numbers

| Rule | Value | Source |
|---|---|---|
| Seconds per month | about 2.5 million | primer scaling_aws |
| 1 req/s | 2.5 M req/month; 400 req/s = 1 B/month | primer scaling_aws |
| Main memory reference | 100 ns | primer README 1600-1647 |
| SSD random 4 KB read | 150 us | primer README 1600-1647 |
| Round trip in one data center | 0.5 ms | primer README 1600-1647 |
| Round trip CA to Netherlands | 150 ms | primer README 1600-1647 |
| 99.9% availability | 8.77 h/year, 43.8 min/month | main README 787-846 |
| 99.99% availability | 52.6 min/year, 4.38 min/month | primer README 535-580 |
| Components in series | A = A1 x A2 | main README 813-835 |
| Components in parallel | A = 1 - (1 - A1)(1 - A2) | main README 813-835 |
| Read:write ratio of content systems | 100:1 to 1000:1 | primer README 929 |
| Cache working set | 20% of daily reads (80/20 rule) | main case studies |

Per-node throughput figures in `architect/src/knowledge/reference.ts` (1,000 req/s per app instance, 5,000 writes/s per relational primary, 64 GB per cache node, 50,000 connections per WebSocket node) are planning heuristics, not benchmarks. Fleets are sized for 70% peak utilization. A project can override any numeric reference value in the cost panel; the override reaches every price and sizing built from it.

Provider names and prices in `architect/src/knowledge/services.ts` (AWS, Azure, Google Cloud, on-premises; list prices as of 2025-07) cover what the three repositories do not: the 101 cheat sheets where they name a service, general knowledge for the rest. Entries citing general knowledge are marked as such in their `sources`.

## 3. Scaling progression

From primer `scaling_aws`, confirmed by the case studies in the other two repositories:

| Stage | Bottleneck that triggers it | Component added |
|---|---|---|
| 0 | None | One server, one database, DNS |
| 1 | Database competes with app for CPU and disk | Separate managed database, object storage for files |
| 2 | One web server saturates; downtime at peak | Load balancer, several stateless app servers, master-slave failover, CDN |
| 3 | Database slow under 100:1 reads | Cache (cache-aside), read replicas |
| 4 | Diurnal spikes, cost, toil | Autoscaling, monitoring, configuration automation |
| 5 | Writes and data size exceed one primary | Warehouse for history, federation or sharding, NoSQL for suitable data, queues and workers |

The engine adds each component only when a requirement or measured load calls for it.

## 4. Building blocks and when to use them

| Block | Use when | Avoid when | Main trade-off |
|---|---|---|---|
| CDN (pull) | Media or static content; users far from origin | Content is personalized per request | Edge latency vs invalidation and per-GB cost |
| CDN (push) | Large predictable catalogs (video) | Content changes often | No cold misses vs storage and upload pipeline |
| L7 load balancer | More than one instance or 99.9%+ target | Single instance tools | Redundancy vs one more hop |
| API gateway / BFF | Many services, public API, many client types | One monolith behind a load balancer | Central policy vs extra hop and logic creep |
| Cache-aside | Read-heavy data tolerating brief staleness | Data that must never be stale | Fewer DB reads vs invalidation bugs, stampedes |
| Write-through | Fresh reads after writes | Write-heavy data rarely read | Fresh cache vs slower writes |
| Write-behind | Write-heavy counters, batching | Strong consistency | Fast writes vs data loss on cache failure |
| Read replicas | Read-heavy relational data; failover | Write-bound workloads | Read scale vs replication lag |
| Federation | Clear domain boundaries | Heavy cross-domain joins | Smaller databases vs joins in the app |
| Sharding | Writes or size exceed one node | Before tuning and vertical scaling | Linear scale vs cross-shard queries, resharding |
| Message queue + workers | Media, notifications, jobs, fan-out | Work the user waits for | Spike absorption vs at-least-once delivery |
| Event stream (Kafka) | Very high event volume, replay, many consumers | Simple job queues | Throughput and replay vs operations weight |
| WebSocket | Two-way low-latency messaging | One-way updates (use SSE) | Low overhead vs stateful connections |
| Search cluster | Search load or relevance beyond the DB | Small catalogs | Relevance and scale vs index lag, another cluster |
| Microservices | Many teams needing independent deploys | Small teams | Team autonomy vs distributed-system cost |
| Multi-region active-active | Global users, 99.999% targets | Strong global consistency | Local latency vs conflict resolution |

## 5. Consistency and availability

- CAP: during a partition, choose consistency (CP) or availability (AP). PACELC adds that without partitions you still trade latency for consistency.
- Payments, inventory and balances need ACID transactions and idempotency keys. Feeds, counters and analytics tolerate eventual consistency.
- Strong consistency rules out active-active writes across regions, multi-primary replication without coordination, and write-behind caching. The engine marks those options infeasible and the validator reports them as errors if chosen.

## 6. Lessons from real systems

- Stack Overflow serves very high traffic from a monolith on a few servers: start simple (101 guide `how-will-you-design-the-stack-overflow-website`).
- Amazon Prime Video moved a monitoring service from serverless microservices back to a monolith and cut cost by about 90% (101 guide `amazon-prime-video-monitoring-service`).
- Discord moved trillions of messages from Cassandra to ScyllaDB, a Cassandra-compatible store with 15 ms p99 reads versus 40-125 ms (101 guide `how-discord-stores-trillions-of-messages`).
- Figma scaled PostgreSQL 100x in steps: vertical scaling and replication, then vertical partitioning, then horizontal partitioning (101 guide `100x-postgres-scaling-at-figma`).
- Netflix stores and serves video through its own CDN, Open Connect, and relies on several caching layers (101 guides `netflixs-overall-architecture`, `4-ways-netflix-uses-caching-to-hold-user-attention`).

## 7. Known source issues

The extracts flag errors found in the sources:

- primer solutions say disk is "80x" slower than memory; the primer's own latency table gives 120x.
- system-design-main KGS section says 300 GB; its own math gives 390 GB. Its Twitter summary says 100M DAU; the traffic text says 200M.
- system-design-101 `oauth-20-flows` describes client credentials as a single-page-app flow; it is a machine-to-machine flow. `how-to-store-passwords-in-the-database` suggests a plain salted hash; use a slow KDF (Argon2id, bcrypt, scrypt).

## 8. Decision engine

See [decision-engine.md](decision-engine.md). Beyond the repositories' greenfield method, the engine covers task kinds (app, SaaS, data platform, AI app, integration, event streaming, IoT), the cloud choice including hybrid, data platforms and table formats, migration from existing systems, and a cost model with transition cost and payback. Each scenario's design is compared with its source case study in [scenario-review.md](scenario-review.md).
