# System Architecture Designer

Answer a few questions, get a priced architecture you can walk around in 3D.

![Video streaming design in 3D](docs/images/architecture-3d.png)

```mermaid
flowchart LR
  A[Answers] --> B[Recommendations]
  B --> C[Components + data flows]
  C --> D[Sizing + availability]
  D --> E[Cost per provider]
  E --> F[3D view + generated docs]
```

| Start from a scenario or a brief | Migrate into a data platform |
|---|---|
| ![Welcome screen](docs/images/welcome.png) | ![SQL Server to Fabric migration](docs/images/data-platform-migration.png) |
| **Monthly cost, people and one-off** | **Compare AWS, Azure, Google Cloud and on-prem** |
| ![Cost breakdown](docs/images/cost.png) | ![Provider comparison](docs/images/compare-providers.png) |

## Run

```bash
cd architect
npm install
npm run dev
```

Open http://localhost:5173.

## Add to the repo

`main` is protected: every change goes through a pull request that needs one approving review.

```bash
gh repo fork JS1240/system-architecture-designer --clone
cd system-architecture-designer
git checkout -b my-change
cd architect
npm install
npm run typecheck && npm test && npm run lint && npm run build
git push -u origin my-change
gh pr create --repo JS1240/system-architecture-designer
```

- Questions, components, prices and rules live in `architect/src/knowledge/`; scenarios in `scenarios.ts`.
- After a UI change, refresh the screenshots with the dev server on port 5174: `node scripts/readme-screenshots.mjs`.
- Engine details: [docs/decision-engine.md](docs/decision-engine.md).

## Attribution

The decision engine is built on what these repositories teach; each knowledge-base entry cites its source file and lines.

| Source | Author | Licence | In this repo |
|---|---|---|---|
| [system-design-primer](https://github.com/donnemartin/system-design-primer) | Donne Martin | CC BY 4.0 | Cited; [docs/knowledge/system-design-primer.md](docs/knowledge/system-design-primer.md) is an adapted extract |
| [system-design-101](https://github.com/ByteByteGoHq/system-design-101) | ByteByteGo | CC BY-NC-ND 4.0 | Cited by guide title and path only; no guide text |
| [system-design](https://github.com/karanpratapsingh/system-design) | Karan Pratap Singh | CC BY-NC-ND 4.0 | Cited by section and line range only; no course text |

Code is [MIT](LICENSE).
