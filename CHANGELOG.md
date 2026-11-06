# Changelog

All notable changes, newest first. Versions follow [Semantic Versioning](https://semver.org) (while 0.x, a minor
bump may change behaviour). Entries are written by `bun run release` from
[Conventional Commit](https://www.conventionalcommits.org) messages.

## [0.7.0](https://github.com/c3d-gg/melvor-script/releases/tag/v0.7.0) - 2026-11-06

### Features

- **combat:** slayer tasks, potions and combat spell selection ([5af2e67](https://github.com/c3d-gg/melvor-script/commit/5af2e67209a2e4d619d52193133232e21e3371e5))

### Fixes

- **magic:** Alt Magic spells no longer report locked at any level ([83c9882](https://github.com/c3d-gg/melvor-script/commit/83c9882dd853369a3682e8b2ed7b3176925a5af9))

## [0.6.0](https://github.com/c3d-gg/melvor-script/releases/tag/v0.6.0) - 2026-11-05

### Features

- **farming:** Farming API and a Farming speed setting for Scripted Mode ([f86cc00](https://github.com/c3d-gg/melvor-script/commit/f86cc00140dd98eaa68f8edbbe5d0dcf80ea62c0))

## [0.5.0](https://github.com/c3d-gg/melvor-script/releases/tag/v0.5.0) - 2026-11-05

### Features

- mastery API and a generated API reference ([3378fd3](https://github.com/c3d-gg/melvor-script/commit/3378fd3c2168011c64fff1dadb4971b70f3f199e))

### Fixes

- **runtime:** stop Scripted Mode from saving the game after every action ([e6a1d2e](https://github.com/c3d-gg/melvor-script/commit/e6a1d2e777d3518b809b0fc3e2ec54be0b76b0ef))
- **client:** say plainly when the game closes mid-script ([4ae73b2](https://github.com/c3d-gg/melvor-script/commit/4ae73b24ae47b5f28b79b3490e3f4a2a2a31c878))

## [0.4.0](https://github.com/c3d-gg/melvor-script/releases/tag/v0.4.0) - 2026-11-04

### Features

- install with bun add github:c3d-gg/melvor-script; melvor init sets up a scripts folder ([ac43e51](https://github.com/c3d-gg/melvor-script/commit/ac43e51d1eb555ce91d400cc7d7cb3def0bc6587))

### Fixes

- ship @types/ws so projects that install melvor-script type-check ([3782621](https://github.com/c3d-gg/melvor-script/commit/3782621dfeb75757f13f883b22f50a79248def67))
- typecheck cleanly under bun init's strict TypeScript settings ([4ac87bc](https://github.com/c3d-gg/melvor-script/commit/4ac87bc80e6bfe931c30e2e5abaae943e5c78dce))

## [0.3.0](https://github.com/c3d-gg/melvor-script/releases/tag/v0.3.0) - 2026-11-03

### Other changes

- read the runtime version from package.json ([a6923f2](https://github.com/c3d-gg/melvor-script/commit/a6923f2f0fd9bfd20683e39a421d7259cf762b4c))
- Scripted clicks skip the April Fools "Out of Actions!" popup ([2b9f788](https://github.com/c3d-gg/melvor-script/commit/2b9f7881eb140cbeaa2370bc47b49f4a941e0b11))
- Scripted Mode fights leave combat when done; actions in locked realms count as locked ([2ecfaa5](https://github.com/c3d-gg/melvor-script/commit/2ecfaa5edc73aada0f3dabe4eacab940b96231c3))
- Report actions locked by more than level (e.g. Cartography discoveries) as locked; demo fixes ([9a65b65](https://github.com/c3d-gg/melvor-script/commit/9a65b651bd27ba3629b321e3ae3a1960d1228715))
- food-and-fight: cook only the food it needs, not every raw shrimp in the bank ([b4b63bb](https://github.com/c3d-gg/melvor-script/commit/b4b63bbc4379a517dbab47f7e68eef5c2caae79e))
