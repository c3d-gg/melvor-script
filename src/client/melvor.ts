import { format } from 'node:util';
import { basename } from 'node:path';
import type {
  ActionInfo,
  ActionResult,
  AreaInfo,
  AttackResult,
  CanDoResult,
  FightResult,
  GameEventMessage,
  GameEventType,
  GameState,
  ItemInfo,
  LogLevel,
  MonsterInfo,
  RuntimeInfo,
  ShopPurchaseInfo,
  SkillState,
  StateNotification,
  StateSection,
} from '../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import type {
  AltSpellId,
  AttackStyleId,
  CombatAreaId,
  ConstellationId,
  CookingRecipeId,
  CraftingRecipeId,
  DigSiteId,
  DungeonId,
  EquipmentSlotId,
  FishId,
  FletchingRecipeId,
  FoodId,
  HerbloreRecipeId,
  ItemId,
  LogId,
  MonsterId,
  NpcId,
  PrayerId,
  RockId,
  RunecraftingRecipeId,
  ShopPurchaseId,
  SkillId,
  SmithingRecipeId,
  SummoningRecipeId,
  TreeId,
  VeinId,
} from '../shared/ids.generated.ts';
import { Connection, type ConnectOptions } from './connection.ts';
import { ActionStoppedError, FightStoppedError, MelvorError } from './errors.ts';

export interface ActOptions {
  /**
   * How many actions to perform (default 1). `Infinity` keeps going until it's stopped or cancelled.
   * In instant mode each one is a click, spaced by the cooldown, all inside the game.
   */
  count?: number;
  /** Abort to cancel the job early (the promise then rejects, or resolves if `allowStop`). */
  signal?: AbortSignal;
  /** Resolve with the result instead of throwing ActionStoppedError when the job ends early. */
  allowStop?: boolean;
}

export type GameEvent<T extends GameEventType = GameEventType> = Extract<GameEventMessage, { type: T }>;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export class Skill {
  constructor(
    protected readonly m: Melvor,
    readonly id: SkillId,
  ) {}

  protected get s(): SkillState | undefined {
    return this.m.state.skills[this.id];
  }
  get name(): string {
    return this.s?.name ?? this.id;
  }
  get level(): number {
    return this.s?.level ?? 1;
  }
  get xp(): number {
    return this.s?.xp ?? 0;
  }
  /** XP still needed for the next level (0 at the level cap). */
  get xpToNext(): number {
    return this.s?.xpToNext ?? 0;
  }
  get levelCap(): number {
    return this.s?.levelCap ?? 99;
  }
  get unlocked(): boolean {
    return this.s?.unlocked ?? false;
  }
  get abyssalLevel(): number {
    return this.s?.abyssalLevel ?? 0;
  }

  /** This skill's actions/recipes with level, costs, products and whether they're unlocked. Cached; pass `true` to refresh. */
  actions(refresh = false): Promise<ActionInfo[]> {
    return this.m.data.actions(this.id, refresh);
  }
}

/** A skill whose actions can be scripted (every gathering and artisan skill). */
export class ActionSkill<T extends string = string> extends Skill {
  /**
   * Perform `count` actions on a target (default 1).
   *
   * Instant mode (Scripted gamemode): each action happens the moment it's issued, then the
   * cooldown starts. Real-time mode: each action takes the skill's normal interval.
   * Either way the promise resolves when the next action may start (`m.ready`), so a plain
   * `while (...) await cut(tree)` paces itself. Calling while `!m.ready` rejects at once
   * with COOLDOWN / BUSY (nothing is sent to the game).
   *
   * Throws ActionStoppedError if a multi-action job ends early (bank full, out of materials,
   * cancelled...) unless `allowStop` is set.
   */
  act(
    target: T | readonly T[] | null,
    opts: ActOptions & { options?: Record<string, unknown> } = {},
  ): Promise<ActionResult> {
    const targets = target === null ? [] : Array.isArray(target) ? [...target] : [target as T];
    return this.m._act(this.id, targets, opts);
  }

  /** Check whether an action could start right now (level, requirements, materials). */
  canDo(target: T | readonly T[] | null, options?: Record<string, unknown>): Promise<CanDoResult> {
    const targets = target === null ? [] : Array.isArray(target) ? [...target] : [target as T];
    return this.m.connection.call('action.canDo', { skill: this.id, targets, options });
  }

  /** True while a script job for this skill is running. */
  get busy(): boolean {
    return this.m.state.action.jobs.some((j) => j.skill === this.id);
  }
}

export class Woodcutting extends ActionSkill<TreeId> {
  /** Cut one tree, or several at once once you unlock multi-tree cutting. */
  cut(trees: TreeId | readonly TreeId[], opts?: ActOptions) {
    return this.act(trees, opts);
  }
}
export class Fishing extends ActionSkill<FishId> {
  fish(fish: FishId, opts?: ActOptions) {
    return this.act(fish, opts);
  }
}
export class Mining extends ActionSkill<RockId> {
  /** Mine a rock. If it's depleted, the action waits for it to respawn. */
  mine(rock: RockId, opts?: ActOptions) {
    return this.act(rock, opts);
  }
}
export class Thieving extends ActionSkill<NpcId> {
  /** Each action is one pickpocket attempt; a failed attempt's stun is part of its time. */
  pickpocket(npc: NpcId, opts?: ActOptions) {
    return this.act(npc, opts);
  }
}
export class Firemaking extends ActionSkill<LogId> {
  burn(log: LogId, opts?: ActOptions) {
    return this.act(log, opts);
  }
}
export class Cooking extends ActionSkill<CookingRecipeId> {
  cook(recipe: CookingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Smithing extends ActionSkill<SmithingRecipeId> {
  smith(recipe: SmithingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Fletching extends ActionSkill<FletchingRecipeId> {
  fletch(recipe: FletchingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Crafting extends ActionSkill<CraftingRecipeId> {
  craft(recipe: CraftingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Runecrafting extends ActionSkill<RunecraftingRecipeId> {
  craft(recipe: RunecraftingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Herblore extends ActionSkill<HerbloreRecipeId> {
  brew(recipe: HerbloreRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Summoning extends ActionSkill<SummoningRecipeId> {
  create(recipe: SummoningRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Agility extends ActionSkill<never> {
  /** Run your built course; `count` is the number of obstacles. */
  run(opts?: ActOptions) {
    return this.act(null, opts);
  }
}
export class Astrology extends ActionSkill<ConstellationId> {
  study(constellation: ConstellationId, opts?: ActOptions) {
    return this.act(constellation, opts);
  }
}
export class AltMagic extends ActionSkill<AltSpellId> {
  /** Cast an Alt. Magic spell. Spells that convert an item take `item`; Superheat takes `bar`. */
  cast(spell: AltSpellId, opts: ActOptions & { item?: ItemId; bar?: SmithingRecipeId } = {}) {
    const { item, bar, ...rest } = opts;
    const options: Record<string, unknown> = {};
    if (item !== undefined) options.item = item;
    if (bar !== undefined) options.bar = bar;
    return this.act(spell, { ...rest, options });
  }
}
export class Archaeology extends ActionSkill<DigSiteId> {
  /** Excavate a dig site. Pick its map and tools in the game UI first. */
  excavate(digSite: DigSiteId, opts?: ActOptions) {
    return this.act(digSite, opts);
  }
}
export class Harvesting extends ActionSkill<VeinId> {
  harvest(vein: VeinId, opts?: ActOptions) {
    return this.act(vein, opts);
  }
}

export class Skills {
  readonly woodcutting: Woodcutting;
  readonly fishing: Fishing;
  readonly mining: Mining;
  readonly thieving: Thieving;
  readonly firemaking: Firemaking;
  readonly cooking: Cooking;
  readonly smithing: Smithing;
  readonly fletching: Fletching;
  readonly crafting: Crafting;
  readonly runecrafting: Runecrafting;
  readonly herblore: Herblore;
  readonly summoning: Summoning;
  readonly agility: Agility;
  readonly astrology: Astrology;
  /** Alt. Magic (shares its level with combat Magic). */
  readonly magic: AltMagic;
  readonly archaeology: Archaeology;
  readonly harvesting: Harvesting;
  readonly attack: Skill;
  readonly strength: Skill;
  readonly defence: Skill;
  readonly hitpoints: Skill;
  readonly ranged: Skill;
  readonly prayer: Skill;
  readonly slayer: Skill;
  readonly farming: Skill;
  readonly township: Skill;
  readonly cartography: Skill;
  readonly corruption: Skill;

  constructor(private m: Melvor) {
    this.woodcutting = new Woodcutting(m, 'melvorD:Woodcutting');
    this.fishing = new Fishing(m, 'melvorD:Fishing');
    this.mining = new Mining(m, 'melvorD:Mining');
    this.thieving = new Thieving(m, 'melvorD:Thieving');
    this.firemaking = new Firemaking(m, 'melvorD:Firemaking');
    this.cooking = new Cooking(m, 'melvorD:Cooking');
    this.smithing = new Smithing(m, 'melvorD:Smithing');
    this.fletching = new Fletching(m, 'melvorD:Fletching');
    this.crafting = new Crafting(m, 'melvorD:Crafting');
    this.runecrafting = new Runecrafting(m, 'melvorD:Runecrafting');
    this.herblore = new Herblore(m, 'melvorD:Herblore');
    this.summoning = new Summoning(m, 'melvorD:Summoning');
    this.agility = new Agility(m, 'melvorD:Agility');
    this.astrology = new Astrology(m, 'melvorD:Astrology');
    this.magic = new AltMagic(m, 'melvorD:Magic');
    this.archaeology = new Archaeology(m, 'melvorAoD:Archaeology' as SkillId);
    this.harvesting = new Harvesting(m, 'melvorItA:Harvesting' as SkillId);
    this.attack = new Skill(m, 'melvorD:Attack');
    this.strength = new Skill(m, 'melvorD:Strength');
    this.defence = new Skill(m, 'melvorD:Defence');
    this.hitpoints = new Skill(m, 'melvorD:Hitpoints');
    this.ranged = new Skill(m, 'melvorD:Ranged');
    this.prayer = new Skill(m, 'melvorD:Prayer');
    this.slayer = new Skill(m, 'melvorD:Slayer');
    this.farming = new Skill(m, 'melvorD:Farming');
    this.township = new Skill(m, 'melvorD:Township');
    this.cartography = new Skill(m, 'melvorAoD:Cartography' as SkillId);
    this.corruption = new Skill(m, 'melvorItA:Corruption' as SkillId);
  }

  /** Any skill by id, including modded ones. */
  get(id: SkillId | (string & {})): ActionSkill {
    return new ActionSkill(this.m, id as SkillId);
  }

  /** Every skill's live state, keyed by id. */
  all(): Record<string, SkillState> {
    return this.m.state.skills;
  }
}

// ---------------------------------------------------------------------------
// Bank, player, combat, shop, data
// ---------------------------------------------------------------------------

export class Bank {
  constructor(private m: Melvor) {}

  count(item: ItemId): number {
    return this.m.state.bank[item] ?? 0;
  }
  has(item: ItemId, quantity = 1): boolean {
    return this.count(item) >= quantity;
  }
  /** Every item in the bank. */
  items(): { id: ItemId; quantity: number }[] {
    return Object.entries(this.m.state.bank).map(([id, quantity]) => ({ id: id as ItemId, quantity }));
  }
  get usedSlots(): number {
    return this.m.state.bankSpace.used;
  }
  get maxSlots(): number {
    return this.m.state.bankSpace.max;
  }
  get freeSlots(): number {
    return Math.max(0, this.maxSlots - this.usedSlots);
  }
  get full(): boolean {
    return this.freeSlots === 0;
  }

  /** Sell items. Defaults to all of them (counted in the game, so it's never stale). */
  sell(item: ItemId, quantity: number | 'all' = 'all') {
    return this.m.connection.call('bank.sell', { item, quantity: quantity === 'all' ? null : quantity });
  }
  /** Open chests/bags (no modal, no delay). */
  open(item: ItemId, quantity = 1) {
    return this.m.connection.call('bank.open', { item, quantity });
  }
  bury(item: ItemId, quantity = 1) {
    return this.m.connection.call('bank.bury', { item, quantity });
  }
}

export class Player {
  constructor(private m: Melvor) {}

  private get p() {
    return this.m.state.player;
  }
  get hp(): number {
    return this.p.hp;
  }
  get maxHp(): number {
    return this.p.maxHp;
  }
  /** Hitpoints as a fraction, 0..1. */
  get hpFraction(): number {
    return this.p.maxHp > 0 ? this.p.hp / this.p.maxHp : 0;
  }
  get prayerPoints(): number {
    return this.p.prayerPoints;
  }
  get combatLevel(): number {
    return this.p.combatLevel;
  }
  get attackType(): string {
    return this.p.attackType;
  }
  get food() {
    return this.p.food;
  }
  /** The currently selected food slot. */
  get currentFood() {
    return this.p.food.slots[this.p.food.selected] ?? { item: null, quantity: 0 };
  }
  get equipment() {
    return this.p.equipment;
  }
  get activePrayers(): PrayerId[] {
    return this.p.activePrayers as PrayerId[];
  }
  equipped(slot: EquipmentSlotId): ItemId | null {
    return (this.p.equipment[slot]?.item as ItemId) ?? null;
  }
  isEquipped(item: ItemId): boolean {
    return Object.values(this.p.equipment).some((e) => e.item === item);
  }

  eat(times = 1) {
    return this.m.connection.call('player.eat', { quantity: times });
  }
  equipFood(item: FoodId | ItemId, quantity: number) {
    return this.m.connection.call('player.equipFood', { item, quantity });
  }
  selectFood(slot: number) {
    return this.m.connection.call('player.selectFood', { slot });
  }
  equip(item: ItemId, opts: { slot?: EquipmentSlotId; quantity?: number; set?: number } = {}) {
    return this.m.connection.call('player.equip', { item, ...opts });
  }
  unequip(slot: EquipmentSlotId, set?: number) {
    return this.m.connection.call('player.unequip', { slot, set });
  }
  setEquipmentSet(set: number) {
    return this.m.connection.call('player.setEquipmentSet', { set });
  }
  togglePrayer(prayer: PrayerId) {
    return this.m.connection.call('player.togglePrayer', { prayer });
  }
  setAttackStyle(style: AttackStyleId) {
    return this.m.connection.call('player.setAttackStyle', { style });
  }
}

export class Combat {
  constructor(private m: Melvor) {}

  private get c() {
    return this.m.state.combat;
  }
  get active(): boolean {
    return this.c.active;
  }
  get area(): CombatAreaId | null {
    return this.c.area as CombatAreaId | null;
  }
  get monster(): MonsterId | null {
    return this.c.monster as MonsterId | null;
  }
  get enemyHp(): number {
    return this.c.enemyHp;
  }
  get enemyMaxHp(): number {
    return this.c.enemyMaxHp;
  }
  get slayerTask() {
    return this.c.slayerTask as { monster: MonsterId; killsLeft: number } | null;
  }
  /** An enemy is alive and can be attacked. */
  get fighting(): boolean {
    return this.c.fighting;
  }
  /** Waiting for the next enemy to spawn. */
  get spawning(): boolean {
    return this.c.spawning;
  }
  /** Items waiting in the loot container. Collect them with `collectLoot()`. */
  get loot(): Record<ItemId, number> {
    return this.c.loot as Record<ItemId, number>;
  }

  /**
   * Start fighting a monster (it spawns after the usual delay) and return right away.
   * In instant mode, follow up with `attack()`. In real-time mode combat then runs on its own.
   */
  start(monster: MonsterId, opts: { area?: CombatAreaId } = {}): Promise<FightResult> {
    return this.m.connection.call('combat.fight', { monster, area: opts.area, kills: null });
  }

  /**
   * Instant mode: one combat click. You attack (more than once with "actions per click"
   * bonuses), then the enemy acts. If the next enemy is still spawning, waits for it.
   * Resolves when the cooldown (your attack interval / speed) is over.
   */
  attack(): Promise<AttackResult> {
    return this.m._paced(() => this.m.connection.call('combat.attack'));
  }

  /**
   * Fight a monster. With `kills`, resolves after that many kills (in instant mode it keeps
   * attacking for you; in real-time mode combat stops afterwards). Without `kills`, the same as `start()`.
   */
  async fight(
    monster: MonsterId,
    opts: { area?: CombatAreaId; kills?: number; allowStop?: boolean } = {},
  ): Promise<FightResult> {
    if (opts.kills === undefined) return this.start(monster, opts);
    const result = await this.m._paced(() =>
      this.m.connection.call('combat.fight', { monster, area: opts.area, kills: opts.kills ?? null }),
    );
    if (result.status !== 'completed' && !opts.allowStop) throw new FightStoppedError(result);
    return result;
  }

  /** Run a dungeon. With `runs`, resolves after that many full clears. */
  async dungeon(dungeon: DungeonId, opts: { runs?: number; allowStop?: boolean } = {}): Promise<FightResult> {
    if (opts.runs === undefined) return this.m.connection.call('combat.dungeon', { dungeon, runs: null });
    const result = await this.m._paced(() =>
      this.m.connection.call('combat.dungeon', { dungeon, runs: opts.runs ?? null }),
    );
    if (result.status !== 'completed' && !opts.allowStop) throw new FightStoppedError(result);
    return result;
  }

  /** Move everything in the loot container to the bank. */
  collectLoot(): Promise<{ items: Record<string, number> }> {
    return this.m.connection.call('combat.loot');
  }

  /** Leave combat. */
  stop() {
    return this.m.connection.call('combat.stop');
  }
}

export class Shop {
  constructor(private m: Melvor) {}
  buy(purchase: ShopPurchaseId, quantity = 1) {
    return this.m.connection.call('shop.buy', { purchase, quantity });
  }
  list(): Promise<ShopPurchaseInfo[]> {
    return this.m.connection.call('shop.list');
  }
}

export class GameData {
  private itemCache = new Map<string, ItemInfo>();
  private actionCache = new Map<string, ActionInfo[]>();
  private monsterCache: MonsterInfo[] | null = null;
  private areaCache: AreaInfo[] | null = null;

  constructor(private m: Melvor) {}

  async item(id: ItemId): Promise<ItemInfo> {
    let info = this.itemCache.get(id);
    if (!info) {
      info = await this.m.connection.call('data.item', { id });
      this.itemCache.set(id, info);
    }
    return info;
  }
  items(filter: { ids?: ItemId[]; type?: string; category?: string } = {}): Promise<ItemInfo[]> {
    return this.m.connection.call('data.items', filter);
  }
  async actions(skill: SkillId | (string & {}), refresh = false): Promise<ActionInfo[]> {
    let list = refresh ? undefined : this.actionCache.get(skill);
    if (!list) {
      list = await this.m.connection.call('data.actions', { skill });
      this.actionCache.set(skill, list);
    }
    return list;
  }
  async monsters(): Promise<MonsterInfo[]> {
    return (this.monsterCache ??= await this.m.connection.call('data.monsters'));
  }
  async areas(): Promise<AreaInfo[]> {
    return (this.areaCache ??= await this.m.connection.call('data.areas'));
  }
}

// ---------------------------------------------------------------------------
// Melvor
// ---------------------------------------------------------------------------

type StateListener = (state: GameState, changed: StateSection[]) => void;

export class Melvor {
  /** Live mirror of the game state. Updated a few times per second and before every call returns. */
  readonly state: GameState;
  readonly skills: Skills;
  readonly bank: Bank;
  readonly player: Player;
  readonly combat: Combat;
  readonly shop: Shop;
  readonly data: GameData;
  readonly name: string;
  readonly clientId: number;
  readonly runtimeVersion: string;

  private stateVersion: number;
  private stateListeners = new Set<StateListener>();
  private eventListeners = new Map<string, Set<(e: GameEventMessage) => void>>();
  /** Action calls sent and not yet resolved. */
  private inFlight = 0;
  /** Cooldown end learned from replies (the pushed state may lag a little). */
  private localReadyAt = 0;
  /** Listeners the script registered: they keep the process alive after main() returns. */
  private holds = 0;

  /** @internal use connect() */
  constructor(
    readonly connection: Connection,
    hello: { state: GameState; stateVersion: number; clientId: number; runtimeVersion: string },
    name: string,
    buffered: StateNotification[],
  ) {
    this.state = hello.state;
    this.stateVersion = hello.stateVersion;
    this.clientId = hello.clientId;
    this.runtimeVersion = hello.runtimeVersion;
    this.name = name;
    this.skills = new Skills(this);
    this.bank = new Bank(this);
    this.player = new Player(this);
    this.combat = new Combat(this);
    this.shop = new Shop(this);
    this.data = new GameData(this);
    connection.onNotification((n) => {
      if (n.method === 'state') this.applyState(n.params as StateNotification);
      else if (n.method === 'event') this.dispatch(n.params as GameEventMessage);
    });
    for (const n of buffered) this.applyState(n);
  }

  /** GP in the bank. */
  get gp(): number {
    return this.state.currencies['melvorD:GP'] ?? 0;
  }
  get slayerCoins(): number {
    return this.state.currencies['melvorD:SlayerCoins'] ?? 0;
  }
  currency(id: string): number {
    return this.state.currencies[id] ?? 0;
  }
  /** True when Script Mode is on (nothing repeats unless a script asks). Always on in instant mode. */
  get scriptMode(): boolean {
    return this.state.meta.scriptMode;
  }

  // -- pacing ---------------------------------------------------------------

  /**
   * Instant mode (the Scripted gamemode): actions happen the moment they're issued, followed by
   * a cooldown of (their normal time / `speed`). False in real-time mode.
   */
  get instant(): boolean {
    return this.state.meta.instant;
  }

  /** Instant mode: cooldown = normal action time / speed. 1 in real-time mode. */
  get speed(): number {
    return this.state.meta.speed;
  }

  /**
   * True when you can act right now: no action running and no cooldown left.
   * The Adventure Land-style check for a `setInterval` loop:
   *
   *   setInterval(() => {
   *     if (!m.ready) return;
   *     m.skills.woodcutting.cut(Trees.Normal);
   *   }, 100);
   */
  get ready(): boolean {
    return this.inFlight === 0 && this.state.action.jobs.length === 0 && Date.now() >= this.readyAt();
  }

  /** ms of cooldown left (0 when there is none). An action in progress isn't counted: see `ready`. */
  get cooldown(): number {
    return Math.max(0, Math.ceil(this.readyAt() - Date.now()));
  }

  /** Resolve once `ready` is true. */
  async whenReady(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const end = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : Infinity;
    while (!this.ready) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
      if (this.connection.closed) throw new MelvorError('DISCONNECTED', 'connection closed');
      if (Date.now() > end) throw new MelvorError('TIMEOUT', `not ready within ${opts.timeoutMs}ms`);
      const busy = this.inFlight > 0 || this.state.action.jobs.length > 0;
      await sleep(busy ? 20 : Math.max(1, this.cooldown));
    }
  }

  private readyAt(): number {
    return Math.max(this.localReadyAt, this.state.action.readyAt ?? 0);
  }

  private noteCooldown(readyInMs: unknown) {
    if (typeof readyInMs === 'number' && readyInMs > 0)
      this.localReadyAt = Math.max(this.localReadyAt, Date.now() + readyInMs);
  }

  /**
   * @internal One action at a time: refuse while not ready, then (after the call) wait out the
   * cooldown so awaiting the call is all the pacing a loop needs.
   */
  async _paced<T extends { readyInMs?: number }>(send: () => Promise<T>): Promise<T> {
    if (!this.ready) throw this.notReadyError();
    this.inFlight++;
    try {
      let result: T;
      try {
        result = await send();
      } catch (e) {
        if (e instanceof MelvorError && e.code === 'COOLDOWN')
          this.noteCooldown((e.data as { readyInMs?: number } | undefined)?.readyInMs);
        throw e;
      }
      this.noteCooldown(result.readyInMs);
      const wait = this.readyAt() - Date.now();
      if (wait > 0) await sleep(wait);
      return result;
    } finally {
      this.inFlight--;
    }
  }

  private notReadyError(): MelvorError {
    const busy = this.inFlight > 0 || this.state.action.jobs.length > 0;
    if (!busy) {
      const left = this.cooldown;
      return new MelvorError(
        'COOLDOWN',
        `On cooldown for another ${left}ms. Check m.ready (or await the previous action) before acting.`,
        { readyInMs: left },
      );
    }
    const job = this.state.action.jobs[0];
    const what = job
      ? `${this.state.skills[job.skill]?.name ?? job.skill} ${job.completed}/${job.requested ?? '∞'}`
      : 'a previous call';
    return new MelvorError(
      'BUSY',
      `Another action is still running (${what}). Check m.ready, await it, or cancel it with m.cancelJobs().`,
    );
  }

  // -- events ---------------------------------------------------------------

  /** Subscribe to a game event. Returns an unsubscribe function. While subscribed, the script keeps running. */
  on<T extends GameEventType>(type: T, handler: (e: GameEvent<T>) => void): () => void {
    const off = this._listen(type, handler as (e: GameEventMessage) => void);
    this.hold(1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      this.hold(-1);
    };
  }

  /** @internal Subscribe without keeping the process alive (used by run()). */
  _listen(type: GameEventType, handler: (e: GameEventMessage) => void): () => void {
    let set = this.eventListeners.get(type);
    if (!set) this.eventListeners.set(type, (set = new Set()));
    set.add(handler);
    return () => void set.delete(handler);
  }

  private hold(delta: number) {
    this.holds += delta;
    this.connection.updateRef();
  }

  /** @internal */
  get _holds(): number {
    return this.holds;
  }

  /** Wait for the next event of a type (optionally matching a filter). */
  once<T extends GameEventType>(
    type: T,
    filter?: (e: GameEvent<T>) => boolean,
    timeoutMs?: number,
  ): Promise<GameEvent<T>> {
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs !== undefined
          ? setTimeout(
              () => (off(), reject(new MelvorError('TIMEOUT', `no '${type}' event within ${timeoutMs}ms`))),
              timeoutMs,
            )
          : null;
      const off = this.on(type, (e) => {
        if (filter && !filter(e)) return;
        off();
        if (timer) clearTimeout(timer);
        resolve(e);
      });
    });
  }

  /** Called whenever state sections change. Returns an unsubscribe function. While subscribed, the script keeps running. */
  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    this.hold(1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.stateListeners.delete(fn);
      this.hold(-1);
    };
  }

  /** Resolve once `predicate(state)` is true (checked now and on every state update). */
  waitFor(
    predicate: (state: GameState) => boolean,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (predicate(this.state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        off();
        offClose();
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => (cleanup(), reject(opts.signal?.reason ?? new Error('aborted')));
      const off = this.onState((s) => {
        let ok = false;
        try {
          ok = predicate(s);
        } catch (e) {
          cleanup();
          reject(e);
          return;
        }
        if (ok) {
          cleanup();
          resolve();
        }
      });
      const offClose = this.connection.onClose(
        (reason) => (cleanup(), reject(new MelvorError('DISCONNECTED', reason))),
      );
      const timer =
        opts.timeoutMs !== undefined
          ? setTimeout(
              () => (cleanup(), reject(new MelvorError('TIMEOUT', `waitFor timed out after ${opts.timeoutMs}ms`))),
              opts.timeoutMs,
            )
          : null;
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  // -- logging --------------------------------------------------------------

  /** Print locally and in the in-game script panel. */
  log(...args: unknown[]) {
    this.emitLog('info', args);
  }
  warn(...args: unknown[]) {
    this.emitLog('warn', args);
  }
  error(...args: unknown[]) {
    this.emitLog('error', args);
  }
  success(...args: unknown[]) {
    this.emitLog('success', args);
  }

  private emitLog(level: LogLevel, args: unknown[]) {
    const message = format(...args);
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    out(message);
    if (!this.connection.closed) this.connection.cast('ui.log', { level, message });
  }

  // -- control --------------------------------------------------------------

  /** Cancel every job and stop the current action (same as the in-game Stop button). */
  stopAll(reason?: string) {
    return this.connection.call('runtime.stopAll', { reason });
  }
  /** Cancel this script's running jobs. */
  cancelJobs() {
    return this.connection.call('action.cancel', {});
  }
  setScriptMode(enabled: boolean) {
    return this.connection.call('runtime.setScriptMode', { enabled });
  }
  info(): Promise<RuntimeInfo> {
    return this.connection.call('runtime.info');
  }
  /** Ask the game to reload the scripting runtime (picks up a rebuilt runtime.mjs). */
  reloadRuntime() {
    return this.connection.call('runtime.reload');
  }

  /**
   * Evaluate JavaScript inside the game (escape hatch for anything the API doesn't cover).
   * `code` can be an expression or a function body; `game` is in scope. Returns JSON-safe data.
   * Off by default: rejects with FORBIDDEN unless "Allow eval" is on in Mod Settings → Melvor Script.
   */
  eval<T = unknown>(code: string, depth = 2): Promise<T> {
    return this.connection.call('debug.eval', { code, depth }) as Promise<T>;
  }

  close(): Promise<void> {
    return this.connection.close();
  }

  // -- internals ------------------------------------------------------------

  /** @internal */
  async _act(
    skill: SkillId,
    targets: string[],
    opts: ActOptions & { options?: Record<string, unknown> },
  ): Promise<ActionResult> {
    const count = opts.count === undefined ? 1 : opts.count === Infinity ? null : opts.count;
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    let onAbort: (() => void) | undefined;
    const result = await this._paced(() => {
      const pending = this.connection.call('action.act', { skill, targets, count, options: opts.options });
      if (opts.signal) {
        // Cancel this skill's job when aborted; the pending call then resolves as 'cancelled'.
        onAbort = () => {
          const job = this.state.action.jobs.find((j) => j.skill === skill);
          this.connection.cast('action.cancel', job ? { jobId: job.jobId } : {});
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      return pending;
    }).finally(() => {
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    });
    if (result.status !== 'completed' && !opts.allowStop)
      throw new ActionStoppedError(result, this.state.skills[skill]?.name);
    return result;
  }

  private applyState(n: StateNotification) {
    if (!n || n.version <= this.stateVersion) return;
    this.stateVersion = n.version;
    Object.assign(this.state, n.sections);
    const changed = Object.keys(n.sections) as StateSection[];
    for (const fn of this.stateListeners) {
      try {
        fn(this.state, changed);
      } catch (e) {
        console.error('state listener threw', e);
      }
    }
  }

  private dispatch(e: GameEventMessage) {
    const set = this.eventListeners.get(e.type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(e);
      } catch (err) {
        console.error(`'${e.type}' listener threw`, err);
      }
    }
  }
}

/** Connect to the running game. */
export async function connect(opts: ConnectOptions = {}): Promise<Melvor> {
  const name = opts.name ?? defaultName();
  const connection = await Connection.open(opts);
  // State pushes can arrive before the hello reply; keep them and replay the newer ones.
  const buffered: StateNotification[] = [];
  const stopBuffering = connection.onNotification((n) => {
    if (n.method === 'state') buffered.push(n.params as StateNotification);
  });
  try {
    const hello = await connection.call('hello', { client: name, protocol: PROTOCOL_VERSION });
    stopBuffering();
    return new Melvor(connection, hello, name, buffered);
  } catch (e) {
    stopBuffering();
    await connection.close();
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultName(): string {
  const script = process.argv[1];
  return script ? basename(script).replace(/\.[cm]?[jt]s$/, '') : 'script';
}
