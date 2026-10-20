# Scenario review, round 7 (2026-10-19)

4 reviewers covered the 31 scenarios; each finding was checked by an adversarial verifier. 22 confirmed, 5 refuted (Bedrock Guardrails per-call price, log ingestion share, on-prem Loki/WAF flat price, Power BI tie on AWS, Keyspaces node proxy).

## Confirmed

Group A: cost model (engine)
- A1 video-streaming: the 25% non-production share and the staffing x1.25 apply to the own push-CDN edge fleet (about $744k/mo and 5 FTE too high). Fix: evaluate.ts costBreakdown instanceLines and architecture.ts staffEstate skip the cdn edge.
- A2 social-network: the active-active peer region copies per-request lines (API Gateway $760k, SQS $33k) that split between regions. Fix: architecture.ts peer/standby-region sum keeps instance and data-tier lines, not request-billed lines.
- A3 dynamics-crm-to-d365: the AWS/GCP support plan is priced on the whole bill including Microsoft-billed SaaS licenses ($2.4k-3.1k instead of about $100). Fix: evaluate.ts supportPlanPrice on monthly minus license and vendor-billed lines.
- A4 oracle-orders-to-aws: a 12 TB database migrated to managed PostgreSQL is hash-sharded into 5 Aurora Limitless partitions because the 4 TB node figure applies; RDS holds 64 TiB, Aurora 128 TiB. Fix: workload.ts dbNodeStorageGb uses dbMaxNodeStorageGb for database migrations too (and add the dependency in engine/questions.ts).
- A5 agent-support-copilot-aws and rag-assistant-azure: totalStorageGb leaves out corpus vectors (3.7 GB total next to a 30 GB database). Fix: workload.ts totalStorageGb adds corpus vector GB.
- A6 gcp-bigquery-marketing: SQL AI row classification priced at the chat token mix (2,000 in / 300 out) gives $1,750 for 500k rows; about 300 in / 20 out is right. Fix: workload.ts per-row token mix for enrichedRowsMonth (reference values), weighted with chat calls.
- A7 crm-to-ai-insights: 13M 1,024-dim vectors in pgvector on one small $75 node sized only on storage; HNSW needs memory. Fix: price or size db-primary memory on primaryEmbeddingGb with the vector-store rule ($250 per 20 GB in memory), or steer ai.vector_store away from pgvector above a few million vectors.

Group B: request-path pricing (services/edges)
- B1 social-network: API Gateway flat $2.50/M at 304B requests; above 20B the AWS tier is $1.51/M (blend about $1.57). Fix: services.ts tier row above 2e10 requests.
- B2 url-shortener: the API gateway is sized on all requests although 99% are anonymous redirects; only the link-creation API needs keys and quotas. Fix: size the gateway on API traffic (writes / public_api share) or route reads lb -> app.
- B3 chat-app: WAF is billed on WebSocket messages (it inspects only the upgrade), and the ALB with 25M persistent connections ignores connection LCUs (about $48.7k). Fix: WAF on HTTP requests only; ALB connection LCUs when ws-gateway is present (or an NLB).
- B4 iot-telemetry-aws: Kinesis inherits Kafka broker sizing (4 brokers, $400); provisioned Kinesis needs >= 20 shards plus PUT units plus retention (about $1,250). Fix: services.ts Kinesis (and Event Hubs, Pub/Sub) own sizing.
- B5 erp-crm-sync-azure: Logic Apps Standard priced $250 per connected system ($3,000) though one WS1 plan hosts all workflows (about $300-400). Fix: services.ts iPaaS per-provider pricing; AWS AppFlow per flow run; keep GCP per connection.
- B6 web-crawler: Azure sharded PostgreSQL named 'Azure Cosmos DB for PostgreSQL (Citus)', which Microsoft closed to new projects; use 'Azure Database for PostgreSQL elastic clusters (Citus)'.

Group C: missing components and links
- C1 iot-telemetry-aws: 200,000 devices write straight into Kinesis with no device gateway or per-device identity. Fix: device-gateway component for product.type iot (AWS IoT Core, Azure IoT Hub, EMQX/HiveMQ on GCP and on-prem), priced per million messages; edge client -> device-gateway -> stream.
- C2 agents-on-kept-sqlserver: Azure agents query the kept on-prem SQL Server live with no VPN/ExpressRoute drawn. Fix: hybrid-link when profile.keptUncopied, source.location onprem_dc, cloud target; route tool-gateway -> hybrid-link -> legacy-db.
- C3 gcp-bigquery-marketing: source.kinds defaults to an on-prem SQL Server though the description names web, CRM and ad data; free BigQuery DTS reads it over no link. Fix: scenario source.kinds; hybrid-link for a cloud data platform with an on-prem database source; limit the free DTS row to Google/GCS/S3/SaaS sources.
- C4 personal-finance: the bank aggregator for 10M users is priced $0; aggregators bill per connected account (about $0.30). Fix: billed sizing over monthly users with a shortcut comment.

Group D: recommendations and findings
- D1 social-graph: OIDC (Cognito) is recommended at 10M DAU and bills about $90k of a $101k run; SSO has a per-MAU penalty, OIDC none. Fix: OIDC penalty above 1M DAU on clouds that bill per MAU; drop the scenario's raised budget workaround.
- D2 onprem-regulated-ai and rag-assistant-azure: staff-facing AI apps can never get SSO (the rule needs product.type saas or internal; ai_app forces product.type ai). Fix: SSO score for product.type ai when the organisation has a directory (m365, google_workspace, datacenter) and staff-scale users.
- D3 url-shortener: range sharding is recommended for random short-code lookups and then flagged hot by the engine's own finding. Fix: gate range_sharding's storage score on time-ordered data, or score hash_sharding at storage load > 1.
- D4 oracle-orders-to-aws, sqlserver-dw-to-fabric: cutover-window fires on every CDC design with a Minutes window even when reverse CDC rollback is in place (its own remedy). Fix: validations.ts cutover-window not when migration.rollback = reverse_cdc, or align the Minutes window with the CDC drain.
- D5 rag-assistant-azure: the scenario enters 120 GB of documents as 120 GB of parsed text (40M pages, $60k one-off). Fix: scenarios.ts parsed-text size (about 12 GB) with a comment.

## Status

All 22 confirmed findings fixed with pinning tests on 2026-10-19, plus follow-ups: own CDN kept off the cloud support bill (B7), saved unit prices migrated after the offer rename (C5), no migration engineering when agents read a kept system live (D6). 1103 tests, tsc, oxlint, build and 28 UI gate checks pass.
