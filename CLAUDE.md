# melvor-script

A Melvor Idle mod that makes the game a programming game. The game runs a local WebSocket JSON-RPC server (the mod
runtime, `src/runtime/`); scripts written in TypeScript with Bun are the client (`src/client/`). README.md explains the
design; the docs site (`site/`) is the user-facing manual.

## Commands

```sh
bun run typecheck        # client, tools, examples and the docs site's code samples (site/snippets)
bun test                 # end-to-end tests against a fake game (test/fake-game.ts)
bun fmt                  # formatter (bunfig.toml); CI runs `bun fmt --check`
bun run build            # builds mod/runtime.mjs
bun run docs             # regenerates docs/API.md from the client's doc comments (CI checks it's current)
bun run docs:site        # regenerates the site's reference, id list, changelog page and the mod page roadmap
bun run docs:site --check  # docs coverage, CI runs it (see site/CONTRIBUTING.md)
cd site && bun run dev   # the docs site at http://localhost:4321/melvor-script/
```

## Conventions

- Commit messages follow Conventional Commits; they decide the next version (`feat` minor, `fix` patch). The version
  lives only in package.json. Never bump it by hand: the Release workflow does it.
- Scripts must not be able to act faster than the rules: new action APIs go through the shared cooldown (`_paced` on the
  client). Eating, banking, the shop, equipment and similar are deliberately free.
- New game-side behaviour needs a fake-game test (test/fake-game.ts mirrors the game's code; read the real game source
  before mirroring it).
- Never print or commit the token in `~/.melvor-scripting/config.json`.
- `bun run melvor reload` disconnects every running script in the game: ask before running it.

## Done means documented

A feature isn't finished until the docs are. For every change to the public API (`src/client/`):

1. Doc comments on every new public call, property and class. They become the reference and the VS Code hovers.
2. The guide for that game system shows the new calls, with code in `site/snippets/` (a new guide from
   `site/templates/guide.mdx` for a new system). Run the `/docs` skill to find and draft what's missing.
3. `site/roadmap.json` moves a shipped roadmap item from `next` to `available` (then `bun run docs:site`).
4. `bun run docs`, `bun run docs:site --check`, `bun run typecheck` and a site build all pass.

Where things go and how to write them: `site/CONTRIBUTING.md`.

## Releasing

1. Push to main and wait for CI.
2. `gh workflow run release.yml -f bump=auto`, wait for it, then `git pull --tags` (the release commit is made in CI).
3. Write player-facing patch notes into the GitHub release body (`gh release edit vX.Y.Z --notes-file notes.md`), and a
   plain-text copy for the mod.io changelog.
4. The docs site deploys itself after the Release workflow (`.github/workflows/pages.yml`).
5. The maintainer uploads `melvor-script-vX.Y.Z.zip` to mod.io and re-pastes `modio/description.html` if it changed.
