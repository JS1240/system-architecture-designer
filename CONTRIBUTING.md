# Contributing

`main` is protected. Every change goes through a pull request that needs one approving review from the code owner.

## Steps

1. Fork and branch:

   ```bash
   gh repo fork JS1240/system-architecture-designer --clone
   cd system-architecture-designer
   git checkout -b my-change
   cd architect && npm install
   ```

2. Make the change. [AGENTS.md](AGENTS.md) says which file each kind of change goes in and lists the rules: declarative score rules with reasons and sources, list prices with `asOf`, `shortcut:` comments on heuristics, a store migration when an id or offer name changes, and the scenario invariants.
3. Add one focused test that fails without your change.
4. Run the checks in `architect/` until all pass:

   ```bash
   npm run typecheck && npm test && npm run lint && npm run build
   ```

5. If the scenario snapshot moved on purpose, update it with `npx vitest run src/knowledge/catalog.test.ts -u` and name the scenarios that moved in the PR.
6. After a UI change, refresh the README screenshots with the dev server on port 5174: `node scripts/readme-screenshots.mjs`.
7. Push and open the pull request; the template lists what reviewers check.

## Sources and licences

Cite system-design-primer, system-design-101 and system-design-main by repo, path and line range, and write the knowledge in your own words. system-design-101 and system-design-main are CC BY-NC-ND 4.0, so their text stays out of the repository. Contributions are accepted under the [MIT License](LICENSE).

The source-repository citation tests run when the three repositories are checked out next to `architect/`, and skip otherwise.
