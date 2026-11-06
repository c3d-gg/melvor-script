# Writing the docs

The docs site (https://c3d-gg.github.io/melvor-script/) is for two kinds of reader: people who already write
TypeScript and want answers fast, and people learning to code through this mod. Every page is written for one of them,
and links to the other where it helps.

```sh
cd site && bun install     # once
bun run dev                # http://localhost:4321/melvor-script/, reloads as you edit
bun run build              # what CI and the Pages deploy run
bun run docs:site --check  # (from the repo root) the coverage check CI runs
```

## How the site is organised

| Section    | Folder                        | Reader      | Job                                                         |
| ---------- | ----------------------------- | ----------- | ----------------------------------------------------------- |
| Start here | `src/content/docs/start/`     | experienced | Install and the rules that matter, fast                     |
| Learn      | `src/content/docs/learn/`     | new to code | A course: one programming idea per lesson, through the game |
| Guides     | `src/content/docs/guides/`    | everyone    | One page per game system: how to do things, with code       |
| Concepts   | `src/content/docs/concepts/`  | everyone    | How it works: state, the cooldown, errors                   |
| Reference  | `src/content/docs/reference/` | experienced | **Generated.** Every call, from the doc comments            |
| Project    | `roadmap.mdx`, `changelog.md` | everyone    | Roadmap (from `roadmap.json`), changelog (generated)        |

Generated, never edit by hand (they're gitignored): `src/content/docs/reference/`, `src/content/docs/changelog.md`,
`public/ids.json`. `tools/docs-site.ts` writes them from the client source, `CHANGELOG.md` and the id maps, and also
rewrites the roadmap section of `modio/description.html` from `roadmap.json`.

## Where does a change go?

| You added…                                    | Do this                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A call or property                            | A doc comment in `src/client/` (the reference and VS Code hovers use it), and a mention in its system's guide |
| A whole game system (e.g. Astrology upgrades) | A new guide page from `templates/guide.mdx`, and a `roadmap.json` move from `next` to `available`             |
| Something every script must understand        | A section on the concepts page (or a new concept page)                                                        |
| A programming idea beginners need for it      | A lesson from `templates/lesson.mdx`, in course order (see `learn/index.mdx`)                                 |
| A complete, runnable script                   | `examples/`, and pull it into the guide with `<Snippet file="examples/....ts" />`                             |

CI enforces the first row: `bun run docs:site --check` fails when a public call or property has no doc comment, or no
guide or lesson shows it. If something only belongs in the reference (a debugging tool, say), list it under
`referenceOnly` in `coverage.json` with the reason. The `todo` list there holds what predates the site; it may only
shrink, and `bun run docs:site --todo` rewrites it after you cover something.

## Code samples

**Every code sample is a real file that CI type-checks**, so the docs can't fall out of date without CI failing.

- Put samples in `snippets/<section>/<page>.ts`. They import `melvor-script` like a real script (the root `tsconfig.json`
  maps it to the source), and are type-checked by `bun run typecheck`. They never run.
- Show a whole file: `<Snippet file="site/snippets/learn/first-script.ts" title="scripts/first.ts" />`. Paths are from the
  repo root.
- Show part of one: wrap it in `// #region name` … `// #endregion`, then `<Snippet file="..." region="name" />`. The
  markers never show, and the code is dedented. One file per page with a region per sample works well
  (`snippets/guides/combat.ts`).
- `mark={[3, 5]}`, `ins`, `del` and other [Expressive Code](https://expressive-code.com) props pass through.
- A one-line fragment inside prose (`` `m.player.hpFraction` ``) is fine inline. Anything a reader might copy and run
  belongs in a snippet.

## Components

From Starlight (`import { … } from '@astrojs/starlight/components'`):

- `<Tabs syncKey="…">` / `<TabItem label="…">`. Use the shared sync keys so a reader's choice follows them around the
  site: `combat-style` (Melee / Ranged / Magic), `mode` (Scripted Mode / Normal character), `os` (Windows / macOS /
  Linux), `style-of-script` (Await style / Loop style).
- `<Steps>` around a numbered list, for instructions done in order.
- `<Aside type="tip|caution|danger" title="…">`. In lessons, a box titled "New idea: …" introduces a term.
- `<Card>`, `<CardGrid>`, `<LinkCard>`, `<Badge>`.

Ours (`src/components/`):

- `<Snippet>`: code from a real file (above).
- `<Goals build={[…]} learn={[…]} time="20 minutes" />`: the top of a lesson.
- `<Challenge title="…">task<Snippet slot="solution" … /></Challenge>`: a task with a hidden solution.
- `<Install />`: the install commands, pinned to the current version from `package.json`.
- `<IdSearch />`, `<Roadmap />`: the id search and the roadmap.

Link between pages with plain absolute paths (`/guides/combat/`); a remark plugin adds the `/melvor-script` prefix.
Inside our own components, use `import.meta.env.BASE_URL`.

## Voice

Both readers:

- Plain words, short sentences. Say what a thing does before how it works.
- Concrete over abstract: a real item, monster or number, not "some value".
- Every code sample runs as shown (with the right levels and items).
- Name the cost: say when something uses the cooldown and when it's free.

Lessons (new to code):

- Open with what they'll make, in game terms. Teach only what that needs.
- Introduce each new word once, in bold, with a plain definition, then use it consistently.
- Walk through new code line by line. Show the common mistake and what the error looks like.
- End with two or three challenges that each change one thing, with a solution in a snippet.

Guides and the reference (experienced, in a hurry):

- Lead with the code. Keep prose to what the code doesn't say.
- Put the caveats where people will hit them (`fight()` doesn't eat for you).
- Link to the reference for the full signature rather than repeating it.

## After a feature, the checklist

1. Doc comments on every new public call and property in `src/client/` (VS Code shows them too).
2. The guide for that system shows the new calls, with samples in `snippets/` (or a new guide from the template).
3. `roadmap.json` updated if a roadmap item shipped.
4. `bun run docs:site --check` and `bun run typecheck` pass; `bun run build` in `site/` builds.
5. Look at it: `bun run dev` in `site/`.

The site deploys when a release is published (the Pages workflow), so it always matches the version people install.
