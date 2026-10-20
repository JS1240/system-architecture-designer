# AGENTS.md

System Architecture Designer: answers go through a declarative knowledge base and an engine that recommends, derives, sizes and prices a design per provider; a React Three Fiber UI renders it. All code lives in `architect/`; run every command from there.

## Where a change goes

| Change | File |
|---|---|
| A question, its options and their score rules | `src/knowledge/questions.ts` |
| A component, when it appears, its sizing | `src/knowledge/components.ts` |
| A provider product name and list price | `src/knowledge/services.ts` |
| A data flow between components | `src/knowledge/edges.ts` |
| A finding (warning, error, info) | `src/knowledge/validations.ts` |
| A reference number (capacity, rate, price constant) | `src/knowledge/reference.ts` |
| A fact computed from other facts | `src/knowledge/derived.ts` |
| A worked example design | `src/knowledge/scenarios.ts` |
| Workload, sizing, availability, cost maths | `src/engine/` |
| Saved projects, undo, migrations of saved data | `src/store/projectStore.ts` |

Engine internals and the cost model: [docs/decision-engine.md](docs/decision-engine.md).

## Rules

- Keep the knowledge base declarative: a decision is a score rule with a `reason` and `sources`; the engine reads data and stays free of per-id branches.
- Prices are list prices on an offer with `asOf` and a source. A heuristic carries a `shortcut: <the limit>, <when to upgrade>` comment.
- Renaming a question id, option id or offer name changes saved projects: bump `STORE_VERSION` in `src/store/projectStore.ts` and migrate the old key there (see `RENAMED_OFFERS`).
- Every scenario, walked by accepting each recommendation, ends with no answer diverging from its recommendation and no error finding (`src/engine/engine.test.ts`). A brief that overrides the engine is pinned with a comment, as `sqlserver-dw-to-fabric` is.
- Cite the three source repositories by repo, path and line range, and write the knowledge in your own words. system-design-101 and system-design-main are CC BY-NC-ND 4.0, so their text stays out of this repository; the repos and their extracts are git-ignored.
- ASCII in code and docs.

## Done

A change is done when all of these pass in `architect/`:

```bash
npm run typecheck && npm test && npm run lint && npm run build
```

- Each fix has one focused test that fails without it.
- `src/knowledge/__snapshots__/` holds every scenario design on every provider. When a change moves it on purpose, run `npx vitest run src/knowledge/catalog.test.ts -u` and name the scenarios that moved in the PR.
- After a UI change, refresh the README screenshots with the dev server on port 5174: `node scripts/readme-screenshots.mjs`.
- `main` is protected: open a pull request.

## Past reviews

Before reporting a design problem, check [docs/review-round7-findings.md](docs/review-round7-findings.md) (including its refuted list) and [docs/scenario-review.md](docs/scenario-review.md).
