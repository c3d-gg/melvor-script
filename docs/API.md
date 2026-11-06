# API reference

Everything a script can do. `m` is the object your `run` callback gets (or that `await connect()` returns).

- **Reads are synchronous.** `m.state` mirrors the game: it's pushed several times a second and refreshed before every call returns. `m.bank.count(...)`, `m.skills.woodcutting.level` and friends read from it.
- **Actions are async and paced.** Skill actions and combat (`attack`, `fight`, `dungeon`) resolve when you may act again. Calling one while `!m.ready` rejects at once with `COOLDOWN` or `BUSY`. Everything else (bank, shop, eating, potions, equipment, spells, slayer tasks, farming, mastery spending, data lookups) is free.
- **Ids are typed.** `Items.Oak_Logs`, `Trees.Oak`, `Monsters.Chicken` ... a typo fails at compile time. See [Ids](#ids).

This page is generated from the source by `bun run docs`. The descriptions are the doc comments VS Code shows on hover.

**Contents:** [Starting a script](#starting-a-script) · [m](#m) · [m.skills](#mskills) · [m.bank](#mbank) · [m.player](#mplayer) · [m.combat](#mcombat) · [m.combat.slayer](#mcombatslayer) · [m.potions](#mpotions) · [m.shop](#mshop) · [m.data](#mdata) · [Options and results](#options-and-results) · [m.state](#mstate) · [Events](#events) · [Errors](#errors) · [Ids](#ids)

## Starting a script

- **`run(main: (m: Melvor) => unknown | Promise<unknown>, opts: ConnectOptions = {}): void`**
  Connect, run `main`, and handle the plumbing a script needs: readable errors, Ctrl+C,
  and the in-game Stop button (which ends the script).

  The script ends when `main` has returned and nothing is left scheduled: no timers or
  intervals, no pending calls, no `m.on` / `m.onState` listeners. So a `setInterval` loop
  runs until you stop it, and a plain `async` script exits when it's done.

  An action you fire without awaiting that fails doesn't kill the loop: it prints a
  warning (repeats are summarised). Errors thrown by your own code still stop the script.

- **`connect(opts: ConnectOptions = {}): Promise<Melvor>`**
  Connect to the running game. Use it for one-off tools; `run` is what scripts usually want.

`ConnectOptions`: `name` (shown in the in-game panel), `timeoutMs`, and `host` / `port` / `token` (default: `~/.melvor-scripting/config.json`).

## m

Sub-APIs: [`m.skills`](#mskills), [`m.bank`](#mbank), [`m.player`](#mplayer), [`m.combat`](#mcombat), [`m.potions`](#mpotions), [`m.shop`](#mshop), [`m.data`](#mdata).

**Properties** (synchronous, from the live state)

- **`state: GameState`**
  Live mirror of the game state. Updated a few times per second and before every call returns.
- **`name: string`**
  This script's name, as shown in the in-game panel.
- **`clientId: number`**
  This connection's id in the game.
- **`runtimeVersion: string`**
  Version of the mod running in the game.
- **`connection: Connection`**
  The low-level connection. Most scripts never need it.
- **`gp: number`**
  GP in the bank.
- **`slayerCoins: number`**
  Slayer Coins.
- **`scriptMode: boolean`**
  True when Script Mode is on (nothing repeats unless a script asks). Always on in instant mode.
- **`instant: boolean`**
  Instant mode (the Scripted gamemode): actions happen the moment they're issued, followed by
  a cooldown of (their normal time / `speed`). False in real-time mode.
- **`speed: number`**
  Instant mode: cooldown = normal action time / speed. 1 in real-time mode.
- **`farmingSpeed: number`**
  Instant mode: crops grow in their normal time / farmingSpeed. 1 in real-time mode.
- **`ready: boolean`**
  True when you can act right now: no action running and no cooldown left.
  The Adventure Land-style check for a `setInterval` loop:

  ```ts
  setInterval(() => {
    if (!m.ready) return;
    m.skills.woodcutting.cut(Trees.Normal);
  }, 100);
  ```

- **`cooldown: number`**
  ms of cooldown left (0 when there is none). An action in progress isn't counted: see `ready`.

**Methods**

- **`currency(id: string): number`**
  Any currency by id, e.g. 'melvorD:GP'.
- **`whenReady(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void>`**
  Resolve once `ready` is true.
- **`on<T extends GameEventType>(type: T, handler: (e: GameEvent<T>) => void): () => void`**
  Subscribe to a game event. Returns an unsubscribe function. While subscribed, the script keeps running.
- **`once<T extends GameEventType>(type: T, filter?: (e: GameEvent<T>) => boolean, timeoutMs?: number): Promise<GameEvent<T>>`**
  Wait for the next event of a type (optionally matching a filter).
- **`onState(fn: StateListener): () => void`**
  Called whenever state sections change. Returns an unsubscribe function. While subscribed, the script keeps running.
- **`waitFor(predicate: (state: GameState) => boolean, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void>`**
  Resolve once `predicate(state)` is true (checked now and on every state update).
- **`sleep(ms: number): Promise<void>`**
  Wait `ms` milliseconds.
- **`log(...args: unknown[]): void`**
  Print locally and in the in-game script panel.
- **`warn(...args: unknown[]): void`**
  Like `log`, as a warning.
- **`error(...args: unknown[]): void`**
  Like `log`, as an error.
- **`success(...args: unknown[]): void`**
  Like `log`, in green.
- **`stopAll(reason?: string): Promise<{ cancelledJobs: number; }>`**
  Cancel every job and stop the current action (same as the in-game Stop button).
- **`cancelJobs(): Promise<{ cancelled: number; }>`**
  Cancel this script's running jobs.
- **`setScriptMode(enabled: boolean): Promise<{ enabled: boolean; }>`**
  Turn Script Mode on or off (the panel toggle). Always on in the Scripted gamemode.
- **`info(): Promise<RuntimeInfo>`**
  Mod version, mode, speed and connected scripts.
- **`reloadRuntime(): Promise<{ reloading: true; }>`**
  Ask the game to reload the scripting runtime (picks up a rebuilt runtime.mjs).
- **`eval<T = unknown>(code: string, depth = 2): Promise<T>`**
  Evaluate JavaScript inside the game (escape hatch for anything the API doesn't cover).
  `code` can be an expression or a function body; `game` is in scope. Returns JSON-safe data.
  Off by default: rejects with FORBIDDEN unless "Allow eval" is on in Mod Settings → Melvor Script.
- **`close(): Promise<void>`**
  Disconnect. Scripts started with `run` don't need to.

## m.skills

- **`get(id: SkillId | (string & {})): ActionSkill`**
  Any skill by id, including modded ones.
- **`all(): Record<string, SkillState>`**
  Every skill's live state, keyed by id.

### Skill actions

Each returns a [`Promise<ActionResult>`](#actionresult) that resolves when you may act again. `opts` is [`ActOptions`](#actoptions).

| Skill                   | Action                                                                                                              |                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `m.skills.woodcutting`  | `cut(trees: TreeId \| readonly TreeId[], opts?: ActOptions): Promise<ActionResult>`                                 | Cut one tree, or several at once once you unlock multi-tree cutting.                      |
| `m.skills.fishing`      | `fish(fish: FishId, opts?: ActOptions): Promise<ActionResult>`                                                      | Catch a fish.                                                                             |
| `m.skills.mining`       | `mine(rock: RockId, opts?: ActOptions): Promise<ActionResult>`                                                      | Mine a rock. If it's depleted, the action waits for it to respawn.                        |
| `m.skills.thieving`     | `pickpocket(npc: NpcId, opts?: ActOptions): Promise<ActionResult>`                                                  | Each action is one pickpocket attempt; a failed attempt's stun is part of its time.       |
| `m.skills.firemaking`   | `burn(log: LogId, opts?: ActOptions): Promise<ActionResult>`                                                        | Burn logs.                                                                                |
| `m.skills.cooking`      | `cook(recipe: CookingRecipeId, opts?: ActOptions): Promise<ActionResult>`                                           | Cook a recipe.                                                                            |
| `m.skills.smithing`     | `smith(recipe: SmithingRecipeId, opts?: ActOptions): Promise<ActionResult>`                                         | Smelt a bar or smith an item.                                                             |
| `m.skills.fletching`    | `fletch(recipe: FletchingRecipeId, opts?: ActOptions): Promise<ActionResult>`                                       | Fletch a recipe.                                                                          |
| `m.skills.crafting`     | `craft(recipe: CraftingRecipeId, opts?: ActOptions): Promise<ActionResult>`                                         | Craft a recipe.                                                                           |
| `m.skills.runecrafting` | `craft(recipe: RunecraftingRecipeId, opts?: ActOptions): Promise<ActionResult>`                                     | Craft runes, staves or another Runecrafting recipe.                                       |
| `m.skills.herblore`     | `brew(recipe: HerbloreRecipeId, opts?: ActOptions): Promise<ActionResult>`                                          | Brew a potion.                                                                            |
| `m.skills.summoning`    | `create(recipe: SummoningRecipeId, opts?: ActOptions): Promise<ActionResult>`                                       | Create summoning tablets.                                                                 |
| `m.skills.agility`      | `run(opts?: ActOptions): Promise<ActionResult>`                                                                     | Run your built course; `count` is the number of obstacles.                                |
| `m.skills.astrology`    | `study(constellation: ConstellationId, opts?: ActOptions): Promise<ActionResult>`                                   | Study a constellation.                                                                    |
| `m.skills.magic`        | `cast(spell: AltSpellId, opts: ActOptions & { item?: ItemId; bar?: SmithingRecipeId } = {}): Promise<ActionResult>` | Cast an Alt. Magic spell. Spells that convert an item take `item`; Superheat takes `bar`. |
| `m.skills.archaeology`  | `excavate(digSite: DigSiteId, opts?: ActOptions): Promise<ActionResult>`                                            | Excavate a dig site. Pick its map and tools in the game UI first.                         |
| `m.skills.harvesting`   | `harvest(vein: VeinId, opts?: ActOptions): Promise<ActionResult>`                                                   | Harvest a vein (Into the Abyss).                                                          |

Level and XP only (no scripted actions yet): `attack`, `strength`, `defence`, `hitpoints`, `ranged`, `prayer`, `slayer`, `township`, `cartography`, `corruption`.

### m.skills.farming

- **`plots(category?: FarmingCategoryId): Promise<FarmingPlot[]>`**
  Every plot (or one kind, e.g. `FarmingCategories.Herb`): what's in it and when it's ready.
- **`plot(plot: FarmingPlotId): Promise<FarmingPlot>`**
  One plot.
- **`plant(plot: FarmingPlotId, crop: CropId): Promise<PlantResult & { plot: FarmingPlot }>`**
  Plant a crop in an empty plot. Compost goes on first, if you want it (see `compost`).
- **`plantAll(crop: CropId): Promise<{ planted: FarmingPlotId[]; seeds: number; xp: Record<string, number> }>`**
  Plant a crop in every empty plot of its kind, until the seeds run out.
- **`harvest(plot: FarmingPlotId): Promise<HarvestResult>`**
  Harvest a grown plot, or clear a dead one.
- **`harvestAll(category?: FarmingCategoryId): Promise<HarvestResult>`**
  Harvest every grown plot and clear every dead one (or only one kind of plot).
- **`compost(plot: FarmingPlotId, item: ItemId, quantity?: number): Promise<{ used: number; level: number }>`**
  Put compost (`Items.Compost`, `Items.Weird_Gloop`...) on an empty plot, before planting.
  Without `quantity`, uses as much as fills it to 100%. Each % of compost adds 0.5% to the
  chance the crop grows; better compost also raises the harvest.
- **`unlockPlot(plot: FarmingPlotId): Promise<FarmingPlot>`**
  Buy a locked plot (see its `level` and `unlockCosts`).
- **`destroy(plot: FarmingPlotId): Promise<FarmingPlot>`**
  Dig up a growing crop. Its seeds and compost are lost.
- **`whenGrown(opts: { timeoutMs?: number } = {}): Promise<FarmingPlot[]>`**
  Wait until at least one plot is grown or dead, and return those plots (at once if some
  already are). Rejects with NOT_READY when nothing is growing, or TIMEOUT after `timeoutMs`.

### Every skill

On all of the above, e.g. `m.skills.mining.level`.

- **`id: SkillId`**
  The skill's id, e.g. 'melvorD:Woodcutting'.
- **`name: string`**
  Display name.
- **`level: number`**
  Current level.
- **`xp: number`**
  Total XP.
- **`xpToNext: number`**
  XP still needed for the next level (0 at the level cap).
- **`levelCap: number`**
  The highest level you can reach right now.
- **`unlocked: boolean`**
  False for a skill you haven't unlocked yet (Adventure mode).
- **`abyssalLevel: number`**
  Into the Abyss: abyssal level (0 if the skill has none).
- **`masteryPool: MasteryPoolState | undefined`**
  The mastery pool (normal realm), live. Undefined for skills without mastery.
- **`abyssalMasteryPool: MasteryPoolState | undefined`**
  Into the Abyss: the abyssal realm's mastery pool, live.
- **`actions(refresh = false): Promise<ActionInfo[]>`**
  This skill's actions/recipes with level, costs, products and whether they're unlocked. Cached; pass `true` to refresh.

### Every skill with actions

On every skill in the actions table, plus `m.skills.get(id)`. `T` is that skill's id type (`TreeId` for woodcutting).

- **`act(target: T | readonly T[] | null, opts: ActOptions & { options?: Record<string, unknown> } = {}): Promise<ActionResult>`**
  Perform `count` actions on a target (default 1).

  Instant mode (Scripted gamemode): each action happens the moment it's issued, then the
  cooldown starts. Real-time mode: each action takes the skill's normal interval.
  Either way the promise resolves when the next action may start (`m.ready`), so a plain
  `while (...) await cut(tree)` paces itself. Calling while `!m.ready` rejects at once
  with COOLDOWN / BUSY (nothing is sent to the game).

  Throws ActionStoppedError if a multi-action job ends early (bank full, out of materials,
  cancelled...) unless `allowStop` is set.

- **`canDo(target: T | readonly T[] | null, options?: Record<string, unknown>): Promise<CanDoResult>`**
  Check whether an action could start right now (level, requirements, materials).
- **`busy: boolean`**
  True while a script job for this skill is running.

### Mastery

On every skill with actions, and on `m.skills.farming` (`T` is `CropId` there).

- **`mastery(action: T): Promise<MasteryInfo>`**
  One action's mastery: level (1 to 99), XP, and XP to the next level.
- **`masteries(): Promise<Record<T, MasteryInfo>>`**
  Mastery of every action in this skill, keyed by action id.
- **`spendMasteryPool(action: T, levels = 1, opts: { allowCheckpointLoss?: boolean } = {}): Promise<MasteryInfo & { spent: number }>`**
  Spend mastery pool XP to raise an action's mastery by `levels` (default 1), like the game's
  "Spend Mastery XP" menu. Free: no cooldown. Refuses if it would drop the pool below a
  checkpoint (10/25/50/95%) and lose that bonus, unless `allowCheckpointLoss` is set.

## m.bank

**Properties** (synchronous, from the live state)

- **`usedSlots: number`**
  Bank slots in use.
- **`maxSlots: number`**
  Total bank slots.
- **`freeSlots: number`**
  Bank slots left.
- **`full: boolean`**
  No free slots: a new kind of item has nowhere to go.

**Methods**

- **`count(item: ItemId): number`**
  How many of an item you have (0 if none).
- **`has(item: ItemId, quantity = 1): boolean`**
  True if you have at least `quantity` (default 1).
- **`items(): { id: ItemId; quantity: number }[]`**
  Every item in the bank.
- **`sell(item: ItemId, quantity: number | 'all' = 'all'): Promise<{ sold: number; currency: string; gained: number; }>`**
  Sell items. Defaults to all of them (counted in the game, so it's never stale).
- **`open(item: ItemId, quantity = 1): Promise<{ opened: number; items: Record<string, number>; }>`**
  Open chests/bags (no modal, no delay).
- **`bury(item: ItemId, quantity = 1): Promise<{ buried: number; }>`**
  Bury bones for prayer points.

## m.player

**Properties** (synchronous, from the live state)

- **`hp: number`**
  Current hitpoints.
- **`maxHp: number`**
  Maximum hitpoints.
- **`hpFraction: number`**
  Hitpoints as a fraction, 0..1.
- **`prayerPoints: number`**
  Prayer points.
- **`combatLevel: number`**
  Combat level.
- **`attackType: string`**
  'melee', 'ranged' or 'magic'.
- **`food: PlayerState['food']`**
  Equipped food: the selected slot, and each slot's item and quantity.
- **`currentFood: FoodSlotState`**
  The currently selected food slot.
- **`equipment: PlayerState['equipment']`**
  Equipped items by slot id. Empty slots are left out.
- **`activePrayers: PrayerId[]`**
  Prayers that are on.
- **`spells: SpellSelection`**
  The selected combat spells. The attack spell is what you cast when attacking with magic.

**Methods**

- **`equipped(slot: EquipmentSlotId): ItemId | null`**
  The item in a slot, or null.
- **`isEquipped(item: ItemId): boolean`**
  True if the item is equipped in any slot.
- **`eat(times = 1): Promise<{ hp: number; }>`**
  Eat the selected food `times` times (default 1).
- **`equipFood(item: FoodId | ItemId, quantity: number): Promise<{ equipped: boolean; }>`**
  Move food from the bank into a food slot (at most what you have).
- **`selectFood(slot: number): Promise<{ selected: number; }>`**
  Choose which food slot to eat from.
- **`equip(item: ItemId, opts: { slot?: EquipmentSlotId; quantity?: number; set?: number } = {}): Promise<{ equipped: boolean; }>`**
  Equip an item from the bank. Defaults: its first valid slot, quantity 1, the current equipment set.
- **`unequip(slot: EquipmentSlotId, set?: number): Promise<{ unequipped: boolean; }>`**
  Empty a slot (in the current equipment set unless `set` is given).
- **`setEquipmentSet(set: number): Promise<{ set: number; }>`**
  Switch equipment set (0-based).
- **`togglePrayer(prayer: PrayerId): Promise<{ active: boolean; }>`**
  Turn a prayer on or off.
- **`setAttackStyle(style: AttackStyleId): Promise<{ style: string; }>`**
  Choose an attack style (see `AttackStyles`).
- **`setSpells(spells: { attack?: AttackSpellId; curse?: CurseSpellId | null; aurora?: AuroraSpellId | null }): Promise<SpellSelection>`**
  Choose combat spells (see `AttackSpells`, `Curses`, `Auroras`). Leave a key out to keep it;
  `null` removes the curse or aurora. Curses and auroras need magic attacks, and a spellbook
  that allows them. Free: no cooldown.

  There's no separate "cast" in combat: your weapon decides how you attack. With a magic weapon
  (a staff or wand) equipped, every attack casts your attack spell and uses its runes from the
  bank. A staff like `Items.Staff_of_Fire` also provides its element's runes.

  ```ts
  await m.player.equip(Items.Staff_of_Fire);
  await m.player.setSpells({ attack: AttackSpells.FireBolt, curse: Curses.WeakeningI });
  ```

## m.combat

**Properties** (synchronous, from the live state)

- **`slayer: Slayer`**
  Slayer tasks: get one, extend it, fight it.
- **`active: boolean`**
  You're in combat.
- **`area: CombatAreaId | null`**
  The combat area you're in.
- **`monster: MonsterId | null`**
  The monster you're fighting.
- **`enemyHp: number`**
  The enemy's hitpoints.
- **`enemyMaxHp: number`**
  The enemy's maximum hitpoints.
- **`slayerTask: SlayerTask | null`**
  Your slayer task, or null. Same as `m.combat.slayer.task`.
- **`fighting: boolean`**
  An enemy is alive and can be attacked.
- **`spawning: boolean`**
  Waiting for the next enemy to spawn.
- **`loot: Record<ItemId, number>`**
  Items waiting in the loot container. Collect them with `collectLoot()`.

**Methods**

- **`start(monster: MonsterId, opts: { area?: CombatAreaId } = {}): Promise<FightResult>`**
  Start fighting a monster (it spawns after the usual delay) and return right away.
  In instant mode, follow up with `attack()`. In real-time mode combat then runs on its own.
- **`attack(): Promise<AttackResult>`**
  Instant mode: one combat click. You attack (more than once with "actions per click"
  bonuses), then the enemy acts. If the next enemy is still spawning, waits for it.
  Resolves when the cooldown (your attack interval / speed) is over.
  Your weapon sets the attack type: with a magic weapon this casts your spell (see `m.player.setSpells`).
- **`fight(monster: MonsterId, opts: { area?: CombatAreaId; kills?: number; allowStop?: boolean } = {}): Promise<FightResult>`**
  Fight a monster. With `kills`, resolves after that many kills (in instant mode it keeps
  attacking for you; in real-time mode combat stops afterwards). Without `kills`, the same as `start()`.
- **`dungeon(dungeon: DungeonId, opts: { runs?: number; allowStop?: boolean } = {}): Promise<FightResult>`**
  Run a dungeon. With `runs`, resolves after that many full clears.
- **`collectLoot(): Promise<{ items: Record<string, number> }>`**
  Move everything in the loot container to the bank.
- **`stop(): Promise<{ stopped: boolean; }>`**
  Leave combat.

## m.combat.slayer

**Properties** (synchronous, from the live state)

- **`task: SlayerTask | null`**
  Your slayer task, or null. After a task is done it's null for about a second, while the game picks the next.

**Methods**

- **`categories(): Promise<SlayerCategoryInfo[]>`**
  Every task tier: level, costs, completions, and whether you can pick it.
- **`newTask(category: SlayerCategoryId): Promise<SlayerTask>`**
  Get a new task in a tier (see `SlayerCategories`), paying its cost (Easy is free).
  It replaces the task you have. Resolves with the task once the game has picked it (about a second).
  When a task is done the game picks the next one in the same tier for free; calling this
  during that second takes that one instead of paying for another.
- **`ensureTask(category: SlayerCategoryId): Promise<SlayerTask>`**
  Your task if you have one (or the one the game is picking), otherwise a new one in `category`.
- **`extend(): Promise<SlayerTask>`**
  Extend your task for more kills (once per task; costs Slayer Coins).
- **`fight(opts: { allowStop?: boolean } = {}): Promise<FightResult>`**
  Fight your task's monster until the task is done. Like `m.combat.fight` with `kills`: in instant
  mode it attacks for you, and it leaves combat afterwards. Rejects with `FightStoppedError` if
  the fight ends early (you died or fled, or the task changed), unless `allowStop`.

  ```ts
  await m.combat.slayer.ensureTask(SlayerCategories.Easy);
  await m.combat.slayer.fight();
  ```

## m.potions

**Properties** (synchronous, from the live state)

- **`active: Partial<Record<PotionAction, ActivePotion>>`**
  Potions in use, keyed by what they work for ('melvorD:Combat' or a skill id).

**Methods**

- **`activeFor(action: PotionAction): ActivePotion | null`**
  The potion in use for combat or a skill, or null.
- **`autoReuse(action: PotionAction): boolean`**
  True when that action's potion is refilled from the bank as its charges run out.
- **`use(potion: PotionId): Promise<{ action: PotionAction; item: PotionId; charges: number; }>`**
  Drink a potion from the bank. It works for its action (combat, or one skill) until its charges
  run out. The same potion again tops its charges back up; another one for the same action
  replaces it. Free: no cooldown.
- **`remove(action: PotionAction): Promise<{ removed: boolean; }>`**
  Stop using the potion for combat or a skill (its charges are lost).
- **`setAutoReuse(action: PotionAction, enabled = true): Promise<{ enabled: boolean; }>`**
  Refill that action's potion from the bank as it runs out (the game's "auto re-use" box).

## m.shop

**Methods**

- **`buy(purchase: ShopPurchaseId, quantity = 1): Promise<{ bought: number; items: Record<string, number>; }>`**
- **`list(): Promise<ShopPurchaseInfo[]>`**

## m.data

**Methods**

- **`item(id: ItemId): Promise<ItemInfo>`**
  One item's details. Cached.
- **`items(filter: { ids?: ItemId[]; type?: string; category?: string } = {}): Promise<ItemInfo[]>`**
  Items, optionally filtered by ids, type or category.
- **`actions(skill: SkillId | (string & {}), refresh = false): Promise<ActionInfo[]>`**
  A skill's actions or recipes. Cached; pass `true` to refresh.
- **`monsters(): Promise<MonsterInfo[]>`**
  Every monster. Cached.
- **`areas(): Promise<AreaInfo[]>`**
  Every combat area, slayer area and dungeon. Cached.
- **`spells(): Promise<SpellInfo[]>`**
  Combat spells (attack spells, curses, auroras), with levels, runes and whether you can use them.

## Options and results

### `ActOptions`

The last argument of every skill action.

| Field        | Type          |                                                                                                                                                                                    |
| ------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `count?`     | `number`      | How many actions to perform (default 1). `Infinity` keeps going until it's stopped or cancelled. In instant mode each one is a click, spaced by the cooldown, all inside the game. |
| `signal?`    | `AbortSignal` | Abort to cancel the job early (the promise then rejects, or resolves if `allowStop`).                                                                                              |
| `allowStop?` | `boolean`     | Resolve with the result instead of throwing ActionStoppedError when the job ends early.                                                                                            |

### `ActionResult`

| Field        | Type                     |                                                                                                     |
| ------------ | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `jobId`      | `number`                 | The job's id (as in the jobStarted / jobFinished events).                                           |
| `skill`      | `string`                 | Skill id.                                                                                           |
| `requested`  | `number \| null`         | Actions asked for (null = until stopped).                                                           |
| `completed`  | `number`                 | Actions done (instant mode: clicks).                                                                |
| `actions?`   | `number`                 | Instant mode: actions the clicks performed. More than `completed` with "actions per click" bonuses. |
| `status`     | `JobStatus`              | 'completed', or 'stopped' / 'cancelled' if it ended early.                                          |
| `reason?`    | `string`                 | Why the job ended early (status !== 'completed').                                                   |
| `durationMs` | `number`                 | How long the job took.                                                                              |
| `xp`         | `Record<string, number>` | skillId -> xp gained during the job.                                                                |
| `items`      | `Record<string, number>` | itemId -> net bank change during the job (negative = consumed).                                     |
| `currencies` | `Record<string, number>` | currencyId -> net change.                                                                           |
| `readyInMs?` | `number`                 | Instant mode: ms until the cooldown ends, measured when the reply was sent.                         |

### `AttackResult`

One combat click (instant mode): you act, then the enemy acts.

| Field       | Type                     |                                                                  |
| ----------- | ------------------------ | ---------------------------------------------------------------- |
| `actions`   | `number`                 | Attacks you made (more than 1 with "actions per click" bonuses). |
| `kills`     | `number`                 | Enemies that died from this click.                               |
| `enemyHp`   | `number`                 | The enemy's hitpoints after the click.                           |
| `hp`        | `number`                 | Your hitpoints after the click.                                  |
| `xp`        | `Record<string, number>` | skillId -> xp gained.                                            |
| `items`     | `Record<string, number>` | itemId -> items gained.                                          |
| `readyInMs` | `number`                 | ms until you can act again.                                      |

### `FightResult`

| Field        | Type                                      |                                                                             |
| ------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| `kills`      | `number`                                  |                                                                             |
| `status`     | `'completed' \| 'stopped' \| 'cancelled'` |                                                                             |
| `reason?`    | `string`                                  |                                                                             |
| `durationMs` | `number`                                  |                                                                             |
| `items`      | `Record<string, number>`                  |                                                                             |
| `xp`         | `Record<string, number>`                  |                                                                             |
| `attacks?`   | `number`                                  | Instant mode: attack clicks made.                                           |
| `readyInMs?` | `number`                                  | Instant mode: ms until the cooldown ends, measured when the reply was sent. |

### `CanDoResult`

| Field      | Type                     |     |
| ---------- | ------------------------ | --- |
| `ok`       | `boolean`                |     |
| `reason?`  | `string`                 |     |
| `missing?` | `Record<string, number>` |     |

### `MasteryInfo`

| Field      | Type     |                                                       |
| ---------- | -------- | ----------------------------------------------------- |
| `level`    | `number` | Mastery level, 1 to 99.                               |
| `xp`       | `number` |                                                       |
| `xpToNext` | `number` | Mastery XP still needed for the next level (0 at 99). |

### `MasteryPoolState`

| Field     | Type     |                                                                                            |
| --------- | -------- | ------------------------------------------------------------------------------------------ |
| `xp`      | `number` | XP in the pool.                                                                            |
| `cap`     | `number` | The most it can hold (with your pool-cap bonuses).                                         |
| `percent` | `number` | Progress as the game shows it (0-100). Pool checkpoints give bonuses at 10, 25, 50 and 95. |

### `ItemInfo`

| Field         | Type                                                |                                                                                                    |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`          | `string`                                            |                                                                                                    |
| `name`        | `string`                                            |                                                                                                    |
| `type`        | `string`                                            |                                                                                                    |
| `category`    | `string`                                            |                                                                                                    |
| `sellsFor`    | `{ currency: string; quantity: number }`            |                                                                                                    |
| `healsFor?`   | `number`                                            |                                                                                                    |
| `validSlots?` | `string[]`                                          |                                                                                                    |
| `potion?`     | `{ action: string; charges: number; tier: number }` | Potions: the action it works for ('melvorD:Combat' or a skill), charges per potion and tier (0-3). |

### `ActionInfo`

| Field            | Type             |                                                              |
| ---------------- | ---------------- | ------------------------------------------------------------ |
| `id`             | `string`         |                                                              |
| `name`           | `string`         |                                                              |
| `level`          | `number`         |                                                              |
| `abyssalLevel`   | `number`         |                                                              |
| `unlocked`       | `boolean`        |                                                              |
| `baseExperience` | `number \| null` |                                                              |
| `baseIntervalMs` | `number \| null` |                                                              |
| `category`       | `string \| null` |                                                              |
| `realm`          | `string \| null` |                                                              |
| `costs`          | `QuantityInfo[]` |                                                              |
| `products`       | `QuantityInfo[]` |                                                              |
| `group`          | `string \| null` | Extra skill-specific grouping (fishing area, thieving area). |

### `MonsterInfo`

| Field         | Type       |     |
| ------------- | ---------- | --- |
| `id`          | `string`   |     |
| `name`        | `string`   |     |
| `combatLevel` | `number`   |     |
| `hitpoints`   | `number`   |     |
| `areas`       | `string[]` |     |

### `AreaInfo`

| Field      | Type                                                                      |     |
| ---------- | ------------------------------------------------------------------------- | --- |
| `id`       | `string`                                                                  |     |
| `name`     | `string`                                                                  |     |
| `kind`     | `'combat' \| 'slayer' \| 'dungeon' \| 'stronghold' \| 'depth' \| 'other'` |     |
| `monsters` | `string[]`                                                                |     |
| `unlocked` | `boolean`                                                                 |     |

### `ShopPurchaseInfo`

| Field      | Type                                                    |     |
| ---------- | ------------------------------------------------------- | --- |
| `id`       | `string`                                                |     |
| `name`     | `string`                                                |     |
| `category` | `string`                                                |     |
| `costs`    | `{ currencies: QuantityInfo[]; items: QuantityInfo[] }` |     |
| `owned`    | `number`                                                |     |
| `buyLimit` | `number`                                                |     |
| `unlocked` | `boolean`                                               |     |

### `SlayerCategoryInfo`

| Field            | Type                                           |                                                                                       |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `id`             | `string`                                       | e.g. 'melvorF:Easy'.                                                                  |
| `name`           | `string`                                       |                                                                                       |
| `level`          | `number`                                       | Slayer level needed.                                                                  |
| `abyssalLevel`   | `number`                                       |                                                                                       |
| `unlocked`       | `boolean`                                      | You have the level for it.                                                            |
| `rollCost`       | `QuantityInfo[]`                               | What a new task costs (empty when free), with your cost bonuses.                      |
| `extensionCost`  | `QuantityInfo[]`                               | What extending a task costs.                                                          |
| `tasksCompleted` | `number`                                       | Tasks of this tier completed.                                                         |
| `combatLevels`   | `{ min: number; max: number \| null } \| null` | Monster combat levels it picks from (null for Abyss tiers, which pick from one area). |

### `SpellInfo`

| Field          | Type                              |                                                                          |
| -------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `id`           | `string`                          |                                                                          |
| `name`         | `string`                          |                                                                          |
| `kind`         | `'attack' \| 'curse' \| 'aurora'` | 'attack' spells hit; a 'curse' weakens the enemy; an 'aurora' buffs you. |
| `spellbook`    | `string \| null`                  | Attack spells: the spellbook ('melvorD:Standard', 'melvorF:Ancient'...). |
| `level`        | `number`                          | Magic level needed.                                                      |
| `abyssalLevel` | `number`                          |                                                                          |
| `maxHit?`      | `number`                          | Attack spells: base max hit.                                             |
| `runes`        | `QuantityInfo[]`                  | Runes used per cast.                                                     |
| `requiredItem` | `string \| null`                  | An item that must be equipped to use it, or null.                        |
| `unlocked`     | `boolean`                         | You can select it now (level, requirements and required item).           |

### `FarmingPlotInfo`

| Field          | Type                                                    |                                                                                                            |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`           | `string`                                                | The plot's id, e.g. 'melvorD:AllotmentPlot1'.                                                              |
| `category`     | `string`                                                | Which crops it takes: 'melvorD:Allotment', 'melvorD:Herb', 'melvorD:Tree' or 'melvorItA:Special'.          |
| `status`       | `FarmingPlotStatus`                                     | 'locked' until you buy it, 'empty', 'growing', then 'grown' or 'dead'.                                     |
| `crop`         | `string \| null`                                        | The crop planted in it, or null.                                                                           |
| `readyInMs`    | `number`                                                | While growing: ms until it's done. 0 otherwise.                                                            |
| `growthChance` | `number`                                                | % chance the crop grows instead of dying: 50 + half the compost level, 100 with "crops can't die" bonuses. |
| `compost`      | `{ item: string; level: number } \| null`               | The compost on it and its level (0-100), or null. Compost goes on an empty plot, before planting.          |
| `level`        | `number`                                                | Farming level needed to unlock it.                                                                         |
| `abyssalLevel` | `number`                                                | Into the Abyss: abyssal level needed to unlock it (0 if none).                                             |
| `unlockCosts`  | `{ currencies: QuantityInfo[]; items: QuantityInfo[] }` | What unlocking it costs (empty once it's unlocked).                                                        |

### `PlantResult`

| Field   | Type                     |                                                                   |
| ------- | ------------------------ | ----------------------------------------------------------------- |
| `plot`  | `FarmingPlotInfo`        | The plot after planting.                                          |
| `seeds` | `number`                 | Seeds used.                                                       |
| `xp`    | `Record<string, number>` | skillId -> XP gained (allotments and herbs give XP when planted). |

### `HarvestResult`

| Field       | Type                     |                                                            |
| ----------- | ------------------------ | ---------------------------------------------------------- |
| `harvested` | `string[]`               | Plots harvested.                                           |
| `died`      | `string[]`               | Dead crops cleared away (no reward).                       |
| `items`     | `Record<string, number>` | itemId -> items gained.                                    |
| `xp`        | `Record<string, number>` | skillId -> XP gained.                                      |
| `bankFull`  | `string[]`               | Plots that couldn't be harvested because the bank is full. |

### `RuntimeInfo`

| Field            | Type                             |                                                                                    |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `protocol`       | `number`                         |                                                                                    |
| `runtimeVersion` | `string`                         |                                                                                    |
| `runtimeSource`  | `string`                         |                                                                                    |
| `scriptMode`     | `boolean`                        |                                                                                    |
| `instant`        | `boolean`                        |                                                                                    |
| `speed`          | `number`                         |                                                                                    |
| `farmingSpeed?`  | `number`                         | Instant mode: crops grow in their normal time / farmingSpeed. 1 in real-time mode. |
| `clients`        | `{ id: number; name: string }[]` |                                                                                    |

## m.state

The live mirror behind every synchronous read. Most scripts use the getters above instead; `m.onState(fn)` and `m.waitFor(predicate)` watch it.

### `GameState`

| Field        | Type                            |                                                        |
| ------------ | ------------------------------- | ------------------------------------------------------ |
| `meta`       | `MetaState`                     |                                                        |
| `skills`     | `Record<string, SkillState>`    |                                                        |
| `bank`       | `Record<string, number>`        | itemId -> quantity. Items not in the bank are omitted. |
| `bankSpace`  | `{ used: number; max: number }` |                                                        |
| `currencies` | `Record<string, number>`        | currencyId -> amount (e.g. 'melvorD:GP').              |
| `player`     | `PlayerState`                   |                                                        |
| `action`     | `ActionState`                   |                                                        |
| `combat`     | `CombatState`                   |                                                        |
| `potions?`   | `PotionsState`                  | Potions in use. Missing with a mod older than 0.7.0.   |

### `MetaState`

| Field            | Type      |                                                                                                                                                               |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `characterName`  | `string`  |                                                                                                                                                               |
| `gamemode`       | `string`  |                                                                                                                                                               |
| `scriptMode`     | `boolean` |                                                                                                                                                               |
| `instant`        | `boolean` | Instant actions (the Scripted gamemode): every action happens the moment it's issued, then a cooldown of (its normal time / `speed`) applies to the next one. |
| `speed`          | `number`  | Instant mode: how many times faster than idle. Cooldown = normal interval / speed.                                                                            |
| `farmingSpeed?`  | `number`  | Instant mode: crops grow in their normal time / farmingSpeed. 1 in real-time mode.                                                                            |
| `gameVersion`    | `string`  |                                                                                                                                                               |
| `runtimeVersion` | `string`  |                                                                                                                                                               |

### `SkillState`

| Field           | Type                               |                                                                                                 |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `name`          | `string`                           |                                                                                                 |
| `level`         | `number`                           |                                                                                                 |
| `xp`            | `number`                           |                                                                                                 |
| `xpToNext`      | `number`                           | XP needed to reach the next level (0 at cap).                                                   |
| `levelCap`      | `number`                           |                                                                                                 |
| `unlocked`      | `boolean`                          |                                                                                                 |
| `abyssalLevel?` | `number`                           |                                                                                                 |
| `abyssalXP?`    | `number`                           |                                                                                                 |
| `masteryPools?` | `Record<string, MasteryPoolState>` | Mastery pool per realm id ('melvorD:Melvor', 'melvorItA:Abyssal'). Only on skills with mastery. |

### `PlayerState`

| Field              | Type                                           |                                                                                                                |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `hp`               | `number`                                       |                                                                                                                |
| `maxHp`            | `number`                                       |                                                                                                                |
| `prayerPoints`     | `number`                                       |                                                                                                                |
| `combatLevel`      | `number`                                       |                                                                                                                |
| `attackType`       | `string`                                       |                                                                                                                |
| `autoEatThreshold` | `number`                                       |                                                                                                                |
| `food`             | `{ selected: number; slots: FoodSlotState[] }` |                                                                                                                |
| `equipmentSet`     | `number`                                       |                                                                                                                |
| `equipment`        | `Record<string, EquippedState>`                | slot id -> equipped item. Empty slots are omitted.                                                             |
| `activePrayers`    | `string[]`                                     |                                                                                                                |
| `spells?`          | `SpellSelectionState`                          | The selected combat spells (of the current equipment set). The attack spell is used when attacking with magic. |

### `SpellSelectionState`

| Field    | Type             |     |
| -------- | ---------------- | --- |
| `attack` | `string \| null` |     |
| `curse`  | `string \| null` |     |
| `aurora` | `string \| null` |     |

### `ActionState`

| Field        | Type                                     |                                                                                                  |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `type`       | `'skill' \| 'combat' \| 'other' \| null` | 'skill' when a skill is running, 'combat' when fighting, null when idle.                         |
| `id`         | `string \| null`                         | Id of the active skill (e.g. 'melvorD:Woodcutting') or action.                                   |
| `intervalMs` | `number \| null`                         | Interval of the current action in ms, if a skill is running.                                     |
| `jobs`       | `JobInfo[]`                              |                                                                                                  |
| `readyAt`    | `number`                                 | Instant mode: when the shared cooldown ends (epoch ms, `Date.now()` clock). 0 = no cooldown yet. |
| `cooldownMs` | `number`                                 | Instant mode: length of the last cooldown in ms.                                                 |

### `JobInfo`

| Field       | Type             |     |
| ----------- | ---------------- | --- |
| `jobId`     | `number`         |     |
| `skill`     | `string`         |     |
| `targets`   | `string[]`       |     |
| `requested` | `number \| null` |     |
| `completed` | `number`         |     |
| `startedAt` | `number`         |     |
| `owner`     | `string`         |     |

### `CombatState`

| Field        | Type                      |                                                                                        |
| ------------ | ------------------------- | -------------------------------------------------------------------------------------- |
| `active`     | `boolean`                 |                                                                                        |
| `area`       | `string \| null`          |                                                                                        |
| `monster`    | `string \| null`          |                                                                                        |
| `enemyHp`    | `number`                  |                                                                                        |
| `enemyMaxHp` | `number`                  |                                                                                        |
| `fighting`   | `boolean`                 | An enemy is alive and can be attacked.                                                 |
| `spawning`   | `boolean`                 | Waiting for the next enemy to spawn.                                                   |
| `loot`       | `Record<string, number>`  | Items waiting in the loot container (collect with `combat.loot`).                      |
| `slayerTask` | `SlayerTaskState \| null` | Your slayer task, or null (also null for the second the game takes to pick a new one). |

### `SlayerTaskState`

| Field       | Type      |                                        |
| ----------- | --------- | -------------------------------------- |
| `monster`   | `string`  | The monster to kill.                   |
| `killsLeft` | `number`  | Kills still needed.                    |
| `category`  | `string`  | The task's tier, e.g. 'melvorF:Easy'.  |
| `extended`  | `boolean` | The task was extended (once per task). |

### `PotionsState`

| Field       | Type                                |                                                                                      |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `active`    | `Record<string, ActivePotionState>` | action id ('melvorD:Combat', 'melvorD:Woodcutting'...) -> the potion working for it. |
| `autoReuse` | `string[]`                          | Actions whose potion is replaced from the bank when its charges run out.             |

## Events

Subscribe with `m.on(type, handler)` (returns an unsubscribe function) or wait for one with `await m.once(type)`.

| Type                  | Fields                                                                  |
| --------------------- | ----------------------------------------------------------------------- |
| `levelUp`             | `{ skill: string; oldLevel: number; newLevel: number }`                 |
| `masteryLevelUp`      | `{ skill: string; action: string; oldLevel: number; newLevel: number }` |
| `monsterKilled`       | `{ monster: string }`                                                   |
| `dungeonCompleted`    | `{ dungeon: string }`                                                   |
| `slayerTaskCompleted` | `{ category: string; monster: string }`                                 |
| `cropsGrown`          | `{ grown: string[]; died: string[] }`                                   |
| `jobStarted`          | `{ job: JobInfo }`                                                      |
| `jobFinished`         | `{ result: ActionResult }`                                              |
| `scriptMode`          | `{ enabled: boolean }`                                                  |
| `stopAll`             | `{ reason: string }`                                                    |
| `log`                 | `{ level: LogLevel; message: string; source: string }`                  |

## Errors

Failed calls reject with a `MelvorError`. Its `code` says why:

| Code             |                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `BAD_REQUEST`    | A bad parameter (wrong type, ambiguous id, negative count...).                                    |
| `UNKNOWN_METHOD` | The mod doesn't know this call: the client is newer than the mod.                                 |
| `NOT_FOUND`      | No item, action, monster... with that id.                                                         |
| `LOCKED`         | Not unlocked yet: level, requirements, realm, or a buy limit.                                     |
| `MISSING_ITEMS`  | Not enough materials. `error.missing` lists what's short.                                         |
| `BUSY`           | Another action is still running.                                                                  |
| `UNSUPPORTED`    | Can't be done here (a skill without mastery, a mode that doesn't allow it...).                    |
| `FAILED`         | The game refused, or a job ended early (`ActionStoppedError` / `FightStoppedError`).              |
| `NOT_READY`      | The game isn't in the right state yet, e.g. `attack()` with no fight going.                       |
| `COOLDOWN`       | Instant mode: the shared action cooldown hasn't finished. `data.readyInMs` says how long is left. |
| `RATE_LIMITED`   | Too many calls per second (a loop with no pacing).                                                |
| `FORBIDDEN`      | Turned off by the player's settings (e.g. eval without "Allow eval").                             |
| `INTERNAL`       | Something threw unexpectedly inside the game or the mod. The message says what.                   |
| `DISCONNECTED`   | The connection to the game closed.                                                                |
| `TIMEOUT`        | `whenReady` / `waitFor` didn't finish in time.                                                    |

- **`MelvorError`**: An error reported by the game (or the connection to it). Has `code: ErrorCode | 'DISCONNECTED' | 'TIMEOUT'`, `data: unknown`, `missing: Record<string, number> | undefined`.

- **`ActionStoppedError`**: Thrown by skill actions that ended before completing (bank full, out of materials, cancelled...). Has `result: ActionResult`.

- **`FightStoppedError`**: Thrown by combat calls that ended before reaching the kill target. Has `result: FightResult`.

## Ids

Const maps of every id in the game, from `import { Items, Trees, ... } from 'melvor-script'`. Each has a matching type (`ItemId`, `TreeId`, ...). They're generated from the game data; `bunx melvor gen-types` regenerates them from your running game, modded content included.

| Map                   | Ids  | Example                                 |                                                                 |
| --------------------- | ---- | --------------------------------------- | --------------------------------------------------------------- |
| `Items`               | 3748 | `Items.Normal_Logs`                     | Every item in the game.                                         |
| `Foods`               | 208  | `Foods.Shrimp`                          | Items that heal when eaten.                                     |
| `SkillIds`            | 28   | `SkillIds.Woodcutting`                  | Skills.                                                         |
| `Monsters`            | 377  | `Monsters.BlackKnight`                  | Monsters.                                                       |
| `CombatAreas`         | 118  | `CombatAreas.Farmlands`                 | Combat areas, slayer areas, dungeons, strongholds and depths.   |
| `Dungeons`            | 40   | `Dungeons.Chicken_Coop`                 | Dungeons (including Abyss depths).                              |
| `ShopPurchases`       | 434  | `ShopPurchases.Extra_Bank_Slot`         | Shop purchases.                                                 |
| `Prayers`             | 87   | `Prayers.Thick_Skin`                    | Prayers.                                                        |
| `AttackStyles`        | 8    | `AttackStyles.Stab`                     | Attack styles.                                                  |
| `EquipmentSlots`      | 19   | `EquipmentSlots.Helmet`                 | Equipment slots.                                                |
| `AttackSpells`        | 69   | `AttackSpells.WindStrike`               | Combat attack spells.                                           |
| `Curses`              | 19   | `Curses.BlindingI`                      | Curses (combat spells).                                         |
| `Auroras`             | 18   | `Auroras.SurgeI`                        | Auroras (combat spells).                                        |
| `Potions`             | 290  | `Potions.Melee_Accuracy_Potion_I`       | Potions: each works for one action.                             |
| `SlayerCategories`    | 14   | `SlayerCategories.Easy`                 | Slayer task tiers (Easy, Normal, Hard...).                      |
| `Trees`               | 34   | `Trees.Normal`                          | Woodcutting trees.                                              |
| `Fish`                | 59   | `Fish.Raw_Shrimp`                       | Fishing: fish.                                                  |
| `Rocks`               | 40   | `Rocks.Rune_Essence`                    | Mining rocks.                                                   |
| `ThievingNpcs`        | 50   | `ThievingNpcs.MAN`                      | Thieving NPCs.                                                  |
| `FiremakingLogs`      | 33   | `FiremakingLogs.Normal_Logs`            | Firemaking: logs you can burn.                                  |
| `CookingRecipes`      | 86   | `CookingRecipes.Shrimp`                 | Cooking recipes.                                                |
| `SmithingRecipes`     | 279  | `SmithingRecipes.Bronze_Bar`            | Smithing recipes.                                               |
| `FletchingRecipes`    | 132  | `FletchingRecipes.Arrow_Shafts`         | Fletching recipes.                                              |
| `CraftingRecipes`     | 187  | `CraftingRecipes.Leather_Gloves`        | Crafting recipes.                                               |
| `RunecraftingRecipes` | 229  | `RunecraftingRecipes.Air_Rune`          | Runecrafting recipes.                                           |
| `HerbloreRecipes`     | 72   | `HerbloreRecipes.Melee_Accuracy_Potion` | Herblore recipes.                                               |
| `SummoningRecipes`    | 53   | `SummoningRecipes.GolbinThief`          | Summoning recipes.                                              |
| `Obstacles`           | 115  | `Obstacles.CargoNet`                    | Agility obstacles.                                              |
| `Constellations`      | 29   | `Constellations.Deedree`                | Astrology constellations.                                       |
| `AltSpells`           | 26   | `AltSpells.JustLearning`                | Alt. Magic spells.                                              |
| `DigSites`            | 18   | `DigSites.OldVillage`                   | Archaeology dig sites (Atlas of Discovery).                     |
| `Veins`               | 7    | `Veins.Abyssal_Vein`                    | Harvesting veins (Into the Abyss).                              |
| `Crops`               | 71   | `Crops.Potatoes`                        | Farming crops: what you plant.                                  |
| `FarmingPlots`        | 47   | `FarmingPlots.AllotmentPlot1`           | Farming plots.                                                  |
| `FarmingCategories`   | 4    | `FarmingCategories.Allotment`           | Kinds of farming plot: allotments, herbs, trees, special plots. |
