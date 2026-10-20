## What and why

<!-- The problem, the change, and the scenario or question it affects. -->

## Checks

- [ ] `npm run typecheck && npm test && npm run lint && npm run build` pass in `architect/`
- [ ] One focused test pins the change and fails without it
- [ ] Knowledge-base changes are declarative: score rules carry a `reason` and `sources`
- [ ] New or changed prices are list prices with `asOf` and a source; heuristics carry a `shortcut:` comment
- [ ] Renamed question ids, option ids or offer names have a store migration (`STORE_VERSION` in `src/store/projectStore.ts`)
- [ ] Sources are cited by repo, path and lines; no text from the CC BY-NC-ND sources

## Snapshot and screenshots

<!-- If src/knowledge/__snapshots__ changed: the scenarios that moved and why. If the UI changed: screenshots refreshed with scripts/readme-screenshots.mjs. Otherwise: "No change". -->
