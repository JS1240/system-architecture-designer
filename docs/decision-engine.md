# Decision Engine Design

The engine is a pure function: `evaluate(knowledgeBase, answers) -> Evaluation`. A project's own assumptions apply first, as `evaluate(withOverrides(kb, overrides), answers)` (`engine/overrides.ts`), so the signature stays the same. It has no hard-coded decision paths. All branching, recommendations, components, data flows and validations come from declarative data in `architect/src/knowledge/`.

## Pipeline

```
answers
  -> resolve questions (fixed point)      engine/questions.ts
       relevance (askWhen), recommendation (scoring), effective values, facts,
       derived facts (knowledge/derived.ts), migration estimates (engine/migration.ts)
  -> workload estimate                    engine/workload.ts
       QPS, reads/writes, storage, egress, cache memory, connections, DB load
  -> architecture derivation              engine/architecture.ts
       component rules (fixed point over `has`), technology, sizing, edges
  -> availability and cost                engine/availability.ts, evaluate.ts
       run, people, one-time and transition cost, payback
  -> validation                           knowledge/validations.ts
  -> Evaluation (facts, question states, next question, workload, architecture, findings)
```

Every stage is deterministic, so any change to an earlier answer re-evaluates everything downstream.

## Facts and conditions

- A fact is a named value: an answer (`arch.style = "monolith"`), a value an option sets (`traffic.readRatio = 100`), a workload metric (`cap.peakWriteQps`), a sizing result (`size.app.replicas`), or a derived metric (`availability.gap`, `cost.budgetRatio`).
- Conditions are JSON: `{ fact, op, value }` with `eq, ne, gt, gte, lt, lte, in, includes, exists`, combined with `all`, `any`, `not`, plus `{ has: componentId }` in the architecture phase.
- Derived facts (`knowledge/derived.ts`, 21 rules) set profile flags from the task kind, add-ons and origin (`profile.ai`, `profile.migration`, `profile.retire`). Question sets gate on these flags and never name a kind themselves. The first matching rule per fact wins; a fact an answer already set is kept.
- A test checks that every fact a condition references is produced by some question, option, or derived metric.

## Questions

Each question has `askWhen` (relevance), `priority`, `isDecision`, a `default`, and options. Each option has `complexity` (1 = simplest), `pros`, `cons`, `feasibleWhen`, `sets` (extra facts) and `score` rules `{ when, weight, reason }`.

- Relevance: a question is asked only when `askWhen` holds for the current facts. Because relevance depends on facts produced by other answers, resolution iterates to a fixed point (at most 8 passes).
- Order: the next question is the pending relevant one with the lowest category order and priority, among those whose dependencies (the questions that produce the facts its relevance and recommendation read) are already answered. A question also waits for an inactive question that a pending answer could still make relevant (a three-valued check of its `askWhen`), unless only its own answer decides that. Questions that depend on each other fall back to category order and priority. The Context and constraints category (existing platforms, data residency, cloud provider, region, data center sites) follows the product questions, and the provider's scores read only those answers and the existing sources, so it is asked within the first nine questions. The Existing sources and migration category comes next, before traffic, because a measured peak and the migrated data replace derived estimates. Clicking a recommended option pins it, so asking a question before its inputs would keep a stale choice.
- Unknown answers: the recommendation (or default) is used and marked "assumed" in the UI and documents.
- Custom answers: free text plus the option it behaves like. The engine uses the mapped option; documents and components show the text.
- Answers to questions that are no longer relevant are kept but ignored, so switching back restores them.
- Why asked: `explainCondition` turns the `askWhen` leaves that hold into question titles and option labels. The question card shows "Asked because ..." and an inactive question shows "Off because ...".

## Recommendation

For single-choice questions:

```
score(option) = sum(weight of matching score rules) - 0.5 * complexity
```

Infeasible options are excluded. Ties go to the question's default, then to the lower complexity; when a tied option matched a requirement, the reasons name it and the tie-break. With no matching rule, the simplest feasible option wins, which implements "prefer the simplest architecture that satisfies the requirements". Each matched rule with a positive weight contributes a human-readable reason, and each matched rule with a negative weight a trade-off; both appear in the sidebar and in the ADR.

When a later answer changes the recommendation for an earlier decision, that decision is flagged "revisit".

## Dependency tracking

`factProducers` maps each fact to the questions that produce it (directly, through option `sets`, or through the workload model for `cap.*`). A question's dependencies are the producers of every fact in its `askWhen`, `feasibleWhen` and score rules. The sidebar shows them as "Depends on".

## Workload model

From the primer's back-of-the-envelope method:

- average QPS = DAU x requests per user / 86,400; peak = average x peak factor
- writes = QPS / (1 + read ratio); reads = QPS - writes
- storage per year = writes/s x 86,400 x 365 x record size + media uploads x media size; with retrieval on PostgreSQL, each upload adds one 6 KB embedding per chunk to the database
- record lookups = reads x adjacency lists fetched per read (graph traversals; 1 otherwise); cache and database read capacity are sized on lookups
- records larger than 64 KB (pages, documents) are stored as blobs in object storage; the database keeps a 1 KB metadata row
- total storage = per year x retention x replication factor (3); the analytics choice reads the database size (rows and embeddings, one copy) instead
- search index = its documents: database rows by default, one 1 KB metadata document per uploaded title for a media catalog, or the latest version of each crawled page (one week of crawl writes x (row + 10 KB of text)) for a crawler. Every query reads one copy of every shard, so search nodes = shards (index / 4 TB at 70%) x copies (queries / 2,000 per node at 70%, at least two); only caches that store query results (cache-aside, refresh-ahead) reduce search load
- cache working set = 20% of one day of reads
- DB write load = peak writes / (5,000 x store write factor); DB primary load = write load + the cache-miss reads that stay on the primary (strong consistency or no replica tier) / 10,000; DB storage load = records / 4 TB. Primary load and storage load decide the partitioning question and whether scale-up is feasible. With a PostGIS geo index, each location ping overwrites its client's current-position row: it adds write load, but no stored rows or background jobs

## Architecture derivation

- Component rules: `when` conditions over facts and other components. Example: the load balancer appears when the style is not serverless and the compute is not PaaS (the platform routes requests itself), and the availability target is 99.9% or higher, or the app's peak load (requests, location updates and background work done inside requests without a queue) exceeds 700 req/s (where the app needs a second instance), or the style is microservices, or a real-time gateway exists.
- Technology: `techFrom` maps a decision fact to a product name; custom answers override it.
- Sizing: per sizing type (app, model serving on scored reads, service, worker, primary, replica, cache, queue, stream, search, WebSocket, load balancer, a primary with a standby for the payment ledger, and the usage-billed object storage, CDN, functions and LLM completions). Fleets are sized for 70% peak utilization with a minimum of 2 instances when availability is 99.9% or higher; request-path fleets then keep one spare so the survivors carry the peak, and cache, presence and geo shards each get a standby. With synchronous processing (no queue), the application or services also do the background work: each job costs 2 requests (a worker handles 500 jobs/s) and each worker-second of media processing one instance.
- Edges: `from` is a component or `@group`; `to` is a preference list, and the first present target is used. Example: client to `[waf, lb, api-gateway, @service]` connects the client to the WAF when it exists, otherwise the load balancer, and so on. This removes hard-coded paths. Two flows between the same pair of components are drawn as one edge that carries both rates.

## Task kinds and cloud

- `project.kind` picks the kind of task: web or mobile app, B2B SaaS, analytics or data platform, AI-powered app, integration between existing systems, event streaming or IoT. A pending kind counts as a transactional app. `project.addons` adds the question sets of other kinds (analytics, AI, integration, event ingestion) to one project. `project.origin` is the starting point: new build, migrate a database, replace a legacy application, modernize an application, or build on existing data.
- `infra.cloud` is AWS, Azure, Google Cloud or on-premises. Hybrid is on-premises with `data.platform_location` set to cloud analytics fed from on premises; Fabric, Databricks or Snowflake then run in a cloud region behind a gateway over VPN or private link. Residency that requires own hardware makes the clouds infeasible; existing commitments (EDP, MACC, CUDs), Microsoft 365, SQL Server licences and where the source runs raise a provider's score.
- Each component takes the first matching provider offer in `knowledge/services.ts` (720 offers): its product name, unit price, SLA and sizing. Offers with provider `any` (Fabric, Databricks, Snowflake) apply on every cloud.

## Data platforms and table formats

`data.platform` chooses the provider's native warehouse (Redshift Serverless + Athena on AWS, BigQuery on Google Cloud), Microsoft Fabric, Databricks, Snowflake, an open lakehouse (Iceberg + Spark + Trino), a real-time OLAP store (ClickHouse) or PostgreSQL + DuckDB. Billing models differ: RPU-hours, TiB scanned, a Fabric capacity SKU, compute-hours, or nodes. `data.table_format` is Delta Lake, Iceberg, Hudi or platform-managed storage. Any open format adds a table catalog: Unity Catalog on Databricks, OneLake catalog + Purview on Fabric, Snowflake Open Catalog (Polaris), Glue or BigLake metastore on the native platforms, and Polaris, Nessie, Unity Catalog OSS or Hive Metastore elsewhere.

## Existing systems and migration

When the origin is not a new build, `source.kinds` takes the inventory: relational database, mainframe, CRM, legacy application, files, SaaS APIs, data warehouse, event streams. Follow-up questions read the source engine, CRM product, volumes, history to move, location, logic inside the database, data quality, change rate, measured peak and the old system's monthly cost. Migration decisions are the target approach (replatform, rehost, repurchase, refactor, retain), replacement CRM, strategy (big bang, phased waves, strangler fig, parallel run), sync method, rollback path, transfer link and downtime window.

`engine/migration.ts` computes the `mig.*` facts inside question resolution, so options can score on them: the migrated and archived volume after the history policy, bulk-copy hours on each link (VPN, 1 Gbps, 10 Gbps, offline device, same site), loader nodes, cutover hours as a share of the downtime window per link, the months before cutover (two trial migrations, initial load, CDC catch-up) and engineering effort by approach, with mainframe and heavy database code costing more. Transition components (old system, link, migration tooling) are removed at cutover; the 3D view shows the transition or the target design.

## Availability and cost

- Availability: components on the request path multiply (series); replicas combine in parallel; database, cache, presence and geo shards are in series, and a standby makes its shard a parallel pair; the region itself is out 0.01% of the time (the published 99.99% region-level SLA); a warm standby region recovers 90% of a regional outage (the region and its managed services) and a pilot light 50%, backups none, while a failed shard stays with its in-region standby; an active peer region doubles the path in parallel when every region takes writes and otherwise counts as a warm standby. The topology and DR decisions read the gap each option leaves (`availability.singleRegionGap`, `availability.pilotLightGap`, `availability.warmStandbyGap`). For streaming, the CDN stays in series after the regions combine. Managed services use 99.99%, DNS its published 100% SLA, and self-run instances 99.9%.
- Cost: a fleet costs instances x unit price x an instance-class factor (small, medium or large by the load the fleet is sized on, in nodes: under 0.05, under 1, 1 or more; a failover replica takes its primary's class). Managed services without a load of their own take the class of the request rate; third-party services take none. Usage-priced services bill what they serve with no class: object storage per TB-month for one copy, a pull CDN per TB of media served, SQS per million calls, a hosted LLM per 1,000 completions, functions per million requests; an own edge (push CDN) runs cache servers sized on the peak. A component's `pricing` rules change its unit price by decision (PaaS, full tracing, push CDN, SQS). A peer region costs the whole regional stack; a standby costs the data replicated to it plus 50% (warm standby) or 15% (pilot light) of the rest. Budgets up to $50k and under $500 penalize options a cheaper one can replace (active-active when a warm standby also meets the target; the WAF and full tracing). It is a rough planning number, not a quote.
- Cost kinds: every line is run, licence, non-production, transfer, one-time or people. The monthly total is run cost plus a non-production share of the instance lines and the support plan; people and one-time cost are reported apart. Transition cost = one-time + transition months x (monthly + transition lines), where transition months are the pre-cutover months plus coexistence. Payback = transition cost / (old system's monthly cost - new monthly - people), only when the old system is retired.
- Compare: `compareOver` completes the design once per option of the cloud or data platform question and compares the totals; options within 2% of each other are a tie. Cost levers list, for each answered decision, the feasible option with the lowest total and its saving, skipping options that drop a capability the project is for.
- Overrides: a project can replace a unit price (per offer and capacity tier), a reference number (it reaches every price and sizing built from it), pin replica counts, exclude components, add cost lines, and set a negotiated discount that applies to the instance and usage lines of one cloud only.

## Validation

81 rules flag conflicts and risks, for example a single database with a 99.9% target, active-active with strong consistency, microservices for a small team, estimated availability below target, or cost above budget. Severity is error, warning or info, and each rule has a fix and sources. An answer that picks an option the engine marks infeasible also raises an error with the option's own reason, unless an error rule already names that decision.

## Exploration

- What-if: overrides merge on top of the answers without saving; the 3D view and HUD show the preview and a diff, which you can apply or discard.
- Alternatives: for any decision, each option is evaluated with the remaining questions auto-completed, then compared on components, availability, cost and issues.
- Versions: snapshots of answers; any two versions (or the current design) can be compared.
- Undo and redo: each change to answers or overrides is one labelled step in the project store (up to 100 per project); Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z outside text fields.
- Brief and suggestions: the description is matched against option keywords; detected answers show as chips, and Apply sends the ticked ones through the what-if preview. Auto-design accepts the recommendation for every remaining question (`autoComplete`).

## Verification

`npm test` runs 1102 tests in 16 files (the repository citation checks need the three source repositories checked out next to `architect/`; they are skipped otherwise):

- knowledge-base integrity checks: pure JSON, unique ids, known facts and components, valid technology mappings, citations that exist in the repositories, and full section coverage of the source READMEs
- influence checks: for every single-choice question, some option change alters components, technology, sizing, findings, cost, availability or the next questions; every numeric input changes the workload
- 31 scenarios in `knowledge/scenarios.ts`, each of which must produce zero error findings when all recommendations are accepted and reach its stated `expect` options and `expectComponents`: internal admin tool; URL shortener (Bit.ly); social network (Twitter); chat application (WhatsApp); e-commerce store; ride hailing (Uber); video streaming (Netflix); AI assistant SaaS; web crawler and search; personal finance (Mint.com); social graph search; search query cache; sales rank by category (Amazon); B2B SaaS on a Microsoft estate; regulated AI assistant on premises; Power BI reporting on Fabric (Azure); on-prem open lakehouse for telemetry (Iceberg + Trino); commerce recommendations on Databricks (AWS); on-prem ERP with Databricks forecasting (hybrid); RAG knowledge assistant on Azure (Foundry + AI Search); air-gapped document extraction with vLLM on premises; agentic support copilot on Bedrock with ticketing tools; Oracle order database to AWS with CDC; SQL Server reporting database moved into Fabric; home-grown SQL Server CRM rebuilt on Azure; sales insights and an AI assistant on Salesforce and HubSpot data; order agents on a kept SQL Server, read live through tools; home-grown CRM on SQL Server replaced by Dynamics 365; order hub syncing ERP, CRM and partners on Azure; marketing analytics on BigQuery (Google Cloud); IoT telemetry ingestion on AWS
- coherence checks on each of the 31 designs: every component has a data flow, every request-path component is reachable from the clients, every fleet stays within 70% utilization, producers have consumers, and the availability target is met
- migration and override tests: transfer and cutover estimates, transition cost and payback, unit-price, reference and discount overrides
- store tests for versions, what-if commits, JSON export and import, duplicate and delete
