# System Architecture Designer

An interactive tool that designs software architectures through an adaptive question flow and shows the result as a live 3D system. The decision engine is driven by a knowledge base extracted from three system-design repositories (see [../docs/README.md](../docs/README.md)).

Describe the application, answer the questions in the sidebar, and the 3D view adds, removes, resizes and reconnects components after every answer.

## Run

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. Other scripts:

| Script | Purpose |
|---|---|
| `npm test` | 1102 tests in 16 files (Vitest): engine, influence, coherence, migration, overrides, knowledge-base integrity and coverage, documentation, store, import and UI helper tests |
| `npm run build` | Type-check and production build |
| `npm run typecheck` | Type-check only (`tsc -b`) |
| `npm run preview` | Serve the production build |
| `npm run kb:guides` | Rebuild the index of all 400 system-design-101 guides |
| `npm run kb:export` | Write the knowledge base to `../docs/knowledge/kb.json` |
| `npm run lint` | oxlint |
| `npm run e2e:mobile` | Runs the main flow in WebKit with the iPhone 13 profile and reports errors, WebGL, overflow and frame rate |

## Features

- Adaptive questions: 121 questions across product, context and constraints, existing sources and migration, traffic, data, AI, performance, architecture, security, reliability, infrastructure and operations. Each one is asked only when earlier answers make it relevant, and its card says why ("Asked because ..."); a question that drops out shows "Off because ..." in the sidebar.
- Task kinds: the welcome page starts with the kind of work (web or mobile app, B2B SaaS, analytics or data platform, AI-powered app, integration between existing systems, event streaming, IoT) and the starting point (new build, migrate a database, replace a legacy application, modernize an application, build on existing data). Each kind card lists the questions it brings and two example scenarios. Add-ons (analytics, AI, integration, event ingestion) combine kinds in one project.
- Brief and suggestions: the description is scanned for answers (kind, cloud, capabilities, compliance and more). Detected answers appear as chips you can untick; the Brief button in the workspace reopens the description and applies new detections as a what-if preview. "Auto-design the rest" accepts the recommendation for every remaining question.
- Recommendations: every option has trade-offs, a complexity score and an explanation. The engine prefers the simplest feasible option. You can answer "not sure" (uses the recommendation as an assumption) or give a custom answer mapped to the closest option.
- Live 3D architecture: tiers laid out like city districts, buildings shaped by role, replica counts, utilization rings, and animated data flows whose density follows requests per second. Orbit, pan, zoom, hover to trace connections, click to inspect.
- Cloud and data platform: AWS, Azure, Google Cloud or on-premises, plus hybrid (on-premises systems feeding Fabric, Databricks or Snowflake in a cloud region). 720 provider service offers name and price each component per provider. Analytics platforms: the provider's native warehouse, Microsoft Fabric, Databricks, Snowflake, an open lakehouse (Iceberg + Spark + Trino), a real-time OLAP store, or PostgreSQL + DuckDB. Delta Lake, Iceberg and Hudi tables add a table catalog (Unity Catalog, OneLake catalog + Purview, Polaris, Glue, Nessie or Hive Metastore, depending on platform and provider).
- Existing systems and migration: a source inventory (databases, mainframe, CRM, legacy application, files, SaaS APIs, warehouse, event streams) with engine, volume, history, location and data quality; CRM products and replacements; target approach, strategy, sync method, rollback, transfer link and downtime window. The engine estimates transfer and cutover hours per link, migration effort, the months both systems run, and payback against the old system's cost. The 3D view switches between the transition and the target design.
- Cost: monthly run cost by tier and by kind (run, licence, non-production, transfer, support), people cost, one-time cost, transition cost and payback. Compare providers or data platforms side by side, see cost levers (the cheaper option for each decision), and override unit prices, reference numbers, replica counts and excluded components, add your own lines, and apply a negotiated discount to one cloud.
- Reasoning: capacity estimates, fleet sizing at 70% target utilization, request-path availability, 81 validation rules, dependency tracking, and "revisit" flags when a later answer changes an earlier recommendation.
- Exploration: hover an option to preview its effect, run what-if scenarios (traffic x10, four nines, global users), compare all alternatives of a decision, save versions and compare any two. Undo and redo (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, and the HUD's Undo button) cover answers and cost overrides, up to 100 steps per project.
- Documentation: specification, capacity estimates, component justification, ADRs with alternatives, implementation order, Mermaid diagram, 3D snapshot, project JSON.
- Projects: create, open, rename, duplicate, delete, import and export. Projects persist in the browser's local storage.

## Structure

```
src/
  domain/types.ts      Knowledge base, project and evaluation types
  knowledge/           Declarative knowledge base: questions, components, edges, validations, derived facts, provider services, reference numbers, catalog, scenarios
  engine/              Pure decision engine: conditions, questions, workload, migration, architecture, availability, evaluate, explore, overrides
  docs/                Markdown, ADR and Mermaid generation; safe Markdown rendering
  store/               Zustand project store with persistence and import validation
  scene/               React Three Fiber scene: layout, buildings, flows, camera
  ui/                  Welcome (task kinds), sidebar, question card, suggestions, HUD, inspector, cost, explore and docs panels
```

The engine has no React or browser dependencies. Design notes: [../docs/decision-engine.md](../docs/decision-engine.md).

## Extending the knowledge base

Add a question, option score rule, component, edge, validation, derived fact or provider offer in `src/knowledge/`, then run `npm test`. The integrity tests reject unknown facts, unknown components, bad technology mappings and citations to files or lines that do not exist.

## Limits

- Throughput, availability and cost figures are planning heuristics. Load-test before you commit to a size.
- Projects are stored in this browser only. Export JSON to move or back them up.
