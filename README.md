# melvor-script

Turn Melvor Idle into a programming game. Nothing repeats on its own: every action comes from TypeScript you write in VS Code. The game runs a local server; your scripts are the client.

```ts
import { run, Trees, Items, FiremakingLogs } from 'melvor-script';

// Loop style (like Adventure Land): look at the game every tick, act when ready.
run((m) => {
  setInterval(() => {
    if (!m.ready) return; // still cooling down
    if (m.bank.count(Items.Normal_Logs) >= 20) m.skills.firemaking.burn(FiremakingLogs.Normal_Logs);
    else m.skills.woodcutting.cut(Trees.Normal); // logs arrive instantly
  }, 100);
});
```

```ts
// Await style: every action call resolves when you may act again.
run(async (m) => {
  while (m.bank.count(Items.Oak_Logs) < 200) await m.skills.woodcutting.cut(Trees.Oak);
});
```

## How it works

```
 VS Code ─ scripts/*.ts ─▶ melvor-script client ──WebSocket──▶ Melvor Idle (Steam/NW.js)
   F5 = run + debug        typed API, live state     127.0.0.1    mod "Melvor Script"
                                                     token auth     ├─ runtime: RPC server, click / job engine
                                                                    └─ in-game panel: status, jobs, log, STOP
```

### Scripted Mode (the gamemode): click speed with a cooldown

Create a character in **Scripted Mode**. It uses Melvor's built-in _instant actions_ rules, plus a cooldown:

- **Every action is a click that happens at once.** Cutting a tree gives you the logs the moment you ask.
- **Then a cooldown:** the next action can't start until _that action's normal time ÷ speed_ has passed. At the default speed of 10, a 3s tree means a 0.3s cooldown. Speed bonuses still count: a better axe means a shorter cooldown.
- **Nothing idles.** No offline progress for skills. Your own mouse clicks work too, and share the same cooldown.
- **Combat is turn-based.** Each `attack()` is one round: you swing, then the monster swings. Nothing happens between rounds, so you can eat exactly when you need to. Monsters respawn `speed`× faster too. `fight(monster, { kills })` attacks until that many have died, then leaves combat; for an endless fight use `start()` + `attack()` (see `examples/fight-loop.ts`).
- "Actions per click" bonuses give extra actions for the same cooldown.

Set the speed in the game: sidebar **Mod Settings → Melvor Script → Speed** (1 to 1000). It takes effect right away. The cooldown never goes below 50 ms.

### Any other character: real time

On a normal character, each scripted action takes the skill's normal interval. A _job_ (`cut(tree, { count: 10 })`) runs exactly that many actions and stops. **Script Mode** (the panel toggle) makes the UI one-click-one-action and turns idling off. With it off, the game idles normally and scripts still work.

### Pacing rules (both modes)

- **One action at a time.** `m.ready` is true when nothing is running and no cooldown is left (`m.cooldown` = ms left, `await m.whenReady()` to wait).
- **Calling an action while not ready fails at once** with `COOLDOWN` (or `BUSY` if one is still running). The client knows the cooldown, so the call never reaches the game. A `setInterval(..., 1)` loop can't spam it.
- **Awaiting an action resolves when you're ready again**, so `while (...) await cut(tree)` paces itself.
- `count: n` does n actions in one request (spaced by the cooldown, inside the game).
- The game also refuses more than 60 calls/s per script (`RATE_LIMITED`), like Adventure Land's call limit.

### Live state and typed ids

- `m.state` mirrors the game: bank, skills, HP, equipment, combat, loot, jobs, cooldown. It's pushed several times a second and refreshed before every call returns, so reads are synchronous.
- Every item, tree, fish, rock, recipe, monster, area and shop purchase has a string-literal type and a const map (`Items.Oak_Logs`, `Trees.Oak`, `SmithingRecipes.Bronze_Bar`). Typos fail at compile time.

## Requirements

- **The desktop game (Steam).** The mod runs a server through the Node APIs that only the desktop build exposes. On the browser and mobile versions it loads but shows "Node APIs unavailable". Tested on Steam, game v1.3.1.
- **Scripted Mode characters need this mod.** The gamemode comes from it, and the game refuses to load a save whose gamemode isn't registered. Other characters load fine without it.
- The runtime works with the game's internals, so a big game update can break it until the mod is updated.

## Setup (once)

1. Install [Bun](https://bun.com), then `git clone https://github.com/c3d-gg/melvor-script && cd melvor-script && bun install && bun run build` → builds `mod/runtime.mjs`. Scripts, the CLI, the build and the tests all run on Bun, so scripts can use Bun APIs (`Bun.file`, `Bun.$`, `bun:sqlite`, ...). The runtime inside the game does not: it runs in the game's own NW.js.
2. **Get Creator Toolkit** (the official mod for loading local mods). In Melvor, open the **Mod Manager** (button on the character-select screen, or sidebar _Modding → Mod Manager_) → **Browse** → search `Creator Toolkit` → **Subscribe**, then restart the game.
3. **Add this mod.** Open Creator Toolkit (sidebar _Modding → Creator Toolkit_, or the orange ✱ button next to the Mod Manager button) → **Local Mods** → **Add Mod**:
   - Name: `Melvor Script`
   - Choose **Directory Link** and pick this repo's `mod` folder (e.g. `C:\Users\you\Documents\dev\melvor-script\mod`)
   - **Save**, then restart the game (or press **Reload** in the toolkit header).

   Creator Toolkit re-packs a linked folder every time the game starts, so after `bun run build` you just restart. (Or pick **Modfile** with `dist/melvor-script.zip` from `bun run pack`, but then you have to re-upload it after every change.)

4. Load a character, or create one in **Scripted Mode**. A **Melvor Script** panel appears (bottom right; the _Modding → Melvor Script_ sidebar entry toggles it). On first load the game writes `~/.melvor-scripting/config.json` with a random token. The client reads it from there.
5. `bun examples/hello.ts`, or open the file in VS Code and press **F5** (uses the Bun VS Code extension, `oven.bun-vscode`).

## Settings

In the game: sidebar **Mod Settings → Melvor Script**. The values are kept in `~/.melvor-scripting/config.json` and shared by all your characters. (Melvor saves mod settings per character, and only for mods installed from mod.io, so the file is the real store.)

| Setting    | Default |                                                                                                                          |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Speed      | 10      | Scripted Mode cooldown = normal action time ÷ speed                                                                      |
| Allow eval | off     | Lets connected clients run any JavaScript in the game (`m.eval`, `bun run melvor eval`, the REPL). Scripts don't need it |

## Writing scripts

Put your files in `scripts/`. It's gitignored, so `git pull` never touches them. The demos live in `examples/`. Each script calls `run((m) => { ... })`, which connects and reports errors at your script's line.

- **The script ends when `main` has returned and nothing is left scheduled** (no intervals or timers, no pending calls, no `m.on` / `m.onState` listeners). A `setInterval` loop runs until you stop it; an `async` script exits when it's done.
- **Ctrl+C** or the in-game **stop** button ends it and cancels its actions.
- **A fire-and-forget action that fails prints a warning instead of killing the loop.** Repeats are summarised, and calls made while not ready are ignored silently after the first notice. Errors thrown by your own code still stop the script.

Examples (in `examples/`): `hello.ts` (read state) · `loop.ts` (setInterval woodcut/burn) · `fight-loop.ts` (turn-based combat loop) · `woodcut-and-burn.ts` · `best-tree.ts` · `mine-and-smith.ts` · `food-and-fight.ts`.

|                    |                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pacing             | `m.ready` · `m.cooldown` · `await m.whenReady()` · `m.instant` · `m.speed`                                                                                                                           |
| `m.skills.<skill>` | `.level .xp .xpToNext`, `.actions()` (recipes with level/costs/unlocked), `.canDo(id)`                                                                                                               |
| Gathering          | `woodcutting.cut(trees)` · `fishing.fish` · `mining.mine` · `thieving.pickpocket` · `astrology.study` · `archaeology.excavate` · `harvesting.harvest` · `agility.run()`                              |
| Artisan            | `firemaking.burn` · `cooking.cook` · `smithing.smith` · `fletching.fletch` · `crafting.craft` · `runecrafting.craft` · `herblore.brew` · `summoning.create` · `magic.cast(spell, { item })`          |
| Options            | `{ count: n \| Infinity, signal: AbortSignal, allowStop: true }`                                                                                                                                     |
| `m.combat`         | `active fighting spawning monster area enemyHp loot slayerTask` · `start(monster)` · `attack()` (Scripted Mode) · `fight(monster, { kills })` · `dungeon(id, { runs })` · `collectLoot()` · `stop()` |
| `m.player`         | `hp maxHp hpFraction food currentFood equipment` · `eat equipFood selectFood equip unequip togglePrayer setAttackStyle setEquipmentSet`                                                              |
| `m.bank`           | `count has items() usedSlots maxSlots full` · `sell(id, n?)` `open` `bury`                                                                                                                           |
| `m.shop`           | `buy(id, qty)` · `list()`                                                                                                                                                                            |
| `m.data`           | `item(id) items() actions(skill) monsters() areas()` (cached)                                                                                                                                        |
| Events             | `m.on('levelUp' \| 'monsterKilled' \| 'jobFinished' \| ..., fn)` · `m.once(...)` · `m.onState(fn)` · `m.waitFor(state => ...)`                                                                       |
| Misc               | `m.gp` · `m.log/warn/success/error` (also shown in the game) · `m.stopAll()` · `m.cancelJobs()` · `m.setScriptMode(on)` · `m.eval('game.woodcutting.level')` (needs Allow eval)                      |

Eating, looting, banking, the shop and equipment changes are not actions: they have no cooldown.

Actions return an `ActionResult` (`completed`, `actions`, `xp`, `items` deltas, `durationMs`). If a multi-action job ends early (bank full, out of materials, cancelled) it throws `ActionStoppedError` with the reason, unless you pass `allowStop: true`. The game refuses actions it can't start up front, with `LOCKED` or `MISSING_ITEMS` (`e.missing` lists what you lack).

## CLI

`bun run melvor <cmd>`: `status` · `eval "<js>"` · `repl` (`m` is the API; `.game <js>` evaluates in the game) · `watch` (live events) · `stop` · `script-mode on|off` · `gen-types` · `reload` · `use-bundled`.

The Steam build ships with devtools disabled, so `eval` and `repl` are your console into the game. Both need **Allow eval** turned on (see [Settings](#settings)).

## Working on the mod itself

- `bun run dev` points the game at `mod/runtime.mjs` on disk and rebuilds on change. Each rebuild hot-reloads the runtime inside the running game. `bun run melvor use-bundled` undoes this.
- `bun test` runs the end-to-end tests: the real server, RPC, click and job engines and client, against a fake game that mirrors Melvor's skill, combat and timer code (real-time and instant).
- `bun run melvor gen-types` regenerates `src/shared/ids.generated.ts` from the running game (includes modded content). `bun run gen:ids` does the same offline from the public game data.

```
mod/            installed mod: manifest, bootstrap (setup.mjs), Scripted gamemode, built runtime.mjs
src/runtime/    in-game server: ws-server, rpc, clicks.ts (instant + cooldown), actions.ts (real-time jobs),
                skills.ts (per-skill adapters), api/*, hud
src/client/     the SDK your scripts import
src/shared/     protocol types + generated ids
examples/       demo scripts
scripts/        your own scripts (gitignored)
test/           end-to-end tests against a fake game
tools/          build, id generation, release
```

### Versioning and releases

The version lives in one place, `package.json`; the runtime reads it from there. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):

| Commit                                                             | Release                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `feat: …`                                                          | minor (0.3.0 → 0.4.0)                                       |
| `fix: …`, `perf: …`, or a message without a type                   | patch (0.3.0 → 0.3.1)                                       |
| `feat!: …` or a `BREAKING CHANGE:` line                            | major; a minor bump while the version is 0.x                |
| `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `build:`, `style:` | no release on their own (refactors still show in the notes) |

`bun run release --dry-run` previews the next version and its notes. `bun run release` then writes `package.json` and [CHANGELOG.md](CHANGELOG.md), runs typecheck, tests and the format check, packs the mod, commits `chore(release): vX.Y.Z`, tags and pushes it, and publishes a GitHub release with `melvor-script-vX.Y.Z.zip` attached. Pass `major`, `minor`, `patch` or an exact version to override the bump.

## Security

The server binds to `127.0.0.1` only. It needs the token from `~/.melvor-scripting/config.json` and rejects any request carrying an `Origin` header, so web pages in your browser can't reach it. Treat the token like a password. `eval` runs code in the game with Node access, so it's off until you turn on **Allow eval**.

## License

[MIT](LICENSE)
