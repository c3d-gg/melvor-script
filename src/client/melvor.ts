import { format } from 'node:util';
import { basename } from 'node:path';
import type {
  ActionInfo,
  ActionResult,
  AreaInfo,
  AttackResult,
  CanDoResult,
  FarmingPlotInfo,
  FightResult,
  HarvestResult,
  PlantResult,
  GameEventMessage,
  GameEventType,
  GameState,
  ItemInfo,
  LogLevel,
  MasteryInfo,
  MasteryPoolState,
  MonsterInfo,
  PlayerState,
  FoodSlotState,
  RuntimeInfo,
  ShopPurchaseInfo,
  SkillState,
  SlayerCategoryInfo,
  SlayerTaskState,
  SpellInfo,
  StateNotification,
  StateSection,
} from '../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import type {
  AltSpellId,
  AttackSpellId,
  AttackStyleId,
  AuroraSpellId,
  CombatAreaId,
  ConstellationId,
  CookingRecipeId,
  CraftingRecipeId,
  CropId,
  CurseSpellId,
  DigSiteId,
  DungeonId,
  EquipmentSlotId,
  FarmingCategoryId,
  FarmingPlotId,
  FishId,
  FletchingRecipeId,
  FoodId,
  HerbloreRecipeId,
  ItemId,
  LogId,
  MonsterId,
  NpcId,
  PotionId,
  PrayerId,
  RockId,
  RunecraftingRecipeId,
  ShopPurchaseId,
  SkillId,
  SlayerCategoryId,
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
    /** The skill's id, e.g. 'melvorD:Woodcutting'. */
    readonly id: SkillId,
  ) {}

  protected get s(): SkillState | undefined {
    return this.m.state.skills[this.id];
  }
  /** Display name. */
  get name(): string {
    return this.s?.name ?? this.id;
  }
  /** Current level. */
  get level(): number {
    return this.s?.level ?? 1;
  }
  /** Total XP. */
  get xp(): number {
    return this.s?.xp ?? 0;
  }
  /** XP still needed for the next level (0 at the level cap). */
  get xpToNext(): number {
    return this.s?.xpToNext ?? 0;
  }
  /** The highest level you can reach right now. */
  get levelCap(): number {
    return this.s?.levelCap ?? 99;
  }
  /** False for a skill you haven't unlocked yet (Adventure mode). */
  get unlocked(): boolean {
    return this.s?.unlocked ?? false;
  }
  /** Into the Abyss: abyssal level (0 if the skill has none). */
  get abyssalLevel(): number {
    return this.s?.abyssalLevel ?? 0;
  }
  /** The mastery pool (normal realm), live. Undefined for skills without mastery. */
  get masteryPool(): MasteryPoolState | undefined {
    return this.s?.masteryPools?.['melvorD:Melvor'];
  }
  /** Into the Abyss: the abyssal realm's mastery pool, live. */
  get abyssalMasteryPool(): MasteryPoolState | undefined {
    return this.s?.masteryPools?.['melvorItA:Abyssal'];
  }

  /** This skill's actions/recipes with level, costs, products and whether they're unlocked. Cached; pass `true` to refresh. */
  actions(refresh = false): Promise<ActionInfo[]> {
    return this.m.data.actions(this.id, refresh);
  }
}

/** A skill with mastery: every skill with actions, plus Farming. `T` is its action id type. */
export class MasterySkill<T extends string = string> extends Skill {
  /** One action's mastery: level (1 to 99), XP, and XP to the next level. */
  async mastery(action: T): Promise<MasteryInfo> {
    const all = await this.m.connection.call('mastery.get', { skill: this.id, actions: [action] });
    return Object.values(all)[0]!;
  }

  /** Mastery of every action in this skill, keyed by action id. */
  masteries(): Promise<Record<T, MasteryInfo>> {
    return this.m.connection.call('mastery.get', { skill: this.id }) as Promise<Record<T, MasteryInfo>>;
  }

  /**
   * Spend mastery pool XP to raise an action's mastery by `levels` (default 1), like the game's
   * "Spend Mastery XP" menu. Free: no cooldown. Refuses if it would drop the pool below a
   * checkpoint (10/25/50/95%) and lose that bonus, unless `allowCheckpointLoss` is set.
   */
  spendMasteryPool(
    action: T,
    levels = 1,
    opts: { allowCheckpointLoss?: boolean } = {},
  ): Promise<MasteryInfo & { spent: number }> {
    return this.m.connection.call('mastery.spendPool', { skill: this.id, action, levels, ...opts });
  }
}

/** A skill whose actions can be scripted (every gathering and artisan skill). */
export class ActionSkill<T extends string = string> extends MasterySkill<T> {
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
  /** Catch a fish. */
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
  /** Burn logs. */
  burn(log: LogId, opts?: ActOptions) {
    return this.act(log, opts);
  }
}
export class Cooking extends ActionSkill<CookingRecipeId> {
  /** Cook a recipe. */
  cook(recipe: CookingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Smithing extends ActionSkill<SmithingRecipeId> {
  /** Smelt a bar or smith an item. */
  smith(recipe: SmithingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Fletching extends ActionSkill<FletchingRecipeId> {
  /** Fletch a recipe. */
  fletch(recipe: FletchingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Crafting extends ActionSkill<CraftingRecipeId> {
  /** Craft a recipe. */
  craft(recipe: CraftingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Runecrafting extends ActionSkill<RunecraftingRecipeId> {
  /** Craft runes, staves or another Runecrafting recipe. */
  craft(recipe: RunecraftingRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Herblore extends ActionSkill<HerbloreRecipeId> {
  /** Brew a potion. */
  brew(recipe: HerbloreRecipeId, opts?: ActOptions) {
    return this.act(recipe, opts);
  }
}
export class Summoning extends ActionSkill<SummoningRecipeId> {
  /** Create summoning tablets. */
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
  /** Study a constellation. */
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
  /** Harvest a vein (Into the Abyss). */
  harvest(vein: VeinId, opts?: ActOptions) {
    return this.act(vein, opts);
  }
}

/**
 * Farming. Crops grow on their own while you do other things, so every call here is free: no
 * cooldown, and it doesn't interrupt the action in progress. In the Scripted gamemode crops grow
 * in their normal time ÷ farming speed (Mod Settings → Melvor Script), and they can still die:
 * compost raises the odds.
 *
 *   await farming.harvestAll();
 *   await farming.plantAll(Crops.Potatoes);
 *   await farming.whenGrown();
 */
/** A farming plot, as `m.skills.farming.plots()` returns it: [`FarmingPlotInfo`](#farmingplotinfo) with typed ids. */
export type FarmingPlot = Omit<FarmingPlotInfo, 'id' | 'category' | 'crop'> & {
  id: FarmingPlotId;
  category: FarmingCategoryId;
  crop: CropId | null;
};

export class Farming extends MasterySkill<CropId> {
  /** Every plot (or one kind, e.g. `FarmingCategories.Herb`): what's in it and when it's ready. */
  plots(category?: FarmingCategoryId): Promise<FarmingPlot[]> {
    return this.m.connection.call('farming.plots', { category }) as Promise<FarmingPlot[]>;
  }

  /** One plot. */
  async plot(plot: FarmingPlotId): Promise<FarmingPlot> {
    const found = (await this.plots()).find((p) => p.id === plot);
    if (!found) throw new MelvorError('NOT_FOUND', `Unknown farming plot '${plot}'`);
    return found;
  }

  /** Plant a crop in an empty plot. Compost goes on first, if you want it (see `compost`). */
  plant(plot: FarmingPlotId, crop: CropId): Promise<PlantResult & { plot: FarmingPlot }> {
    return this.m.connection.call('farming.plant', { plot, crop }) as Promise<PlantResult & { plot: FarmingPlot }>;
  }

  /** Plant a crop in every empty plot of its kind, until the seeds run out. */
  plantAll(crop: CropId): Promise<{ planted: FarmingPlotId[]; seeds: number; xp: Record<string, number> }> {
    return this.m.connection.call('farming.plantAll', { crop }) as Promise<{
      planted: FarmingPlotId[];
      seeds: number;
      xp: Record<string, number>;
    }>;
  }

  /** Harvest a grown plot, or clear a dead one. */
  harvest(plot: FarmingPlotId): Promise<HarvestResult> {
    return this.m.connection.call('farming.harvest', { plot });
  }

  /** Harvest every grown plot and clear every dead one (or only one kind of plot). */
  harvestAll(category?: FarmingCategoryId): Promise<HarvestResult> {
    return this.m.connection.call('farming.harvestAll', { category });
  }

  /**
   * Put compost (`Items.Compost`, `Items.Weird_Gloop`...) on an empty plot, before planting.
   * Without `quantity`, uses as much as fills it to 100%. Each % of compost adds 0.5% to the
   * chance the crop grows; better compost also raises the harvest.
   */
  compost(plot: FarmingPlotId, item: ItemId, quantity?: number): Promise<{ used: number; level: number }> {
    return this.m.connection.call('farming.compost', { plot, item, quantity: quantity ?? null });
  }

  /** Buy a locked plot (see its `level` and `unlockCosts`). */
  unlockPlot(plot: FarmingPlotId): Promise<FarmingPlot> {
    return this.m.connection.call('farming.unlockPlot', { plot }) as Promise<FarmingPlot>;
  }

  /** Dig up a growing crop. Its seeds and compost are lost. */
  destroy(plot: FarmingPlotId): Promise<FarmingPlot> {
    return this.m.connection.call('farming.destroy', { plot }) as Promise<FarmingPlot>;
  }

  /**
   * Wait until at least one plot is grown or dead, and return those plots (at once if some
   * already are). Rejects with NOT_READY when nothing is growing, or TIMEOUT after `timeoutMs`.
   */
  async whenGrown(opts: { timeoutMs?: number } = {}): Promise<FarmingPlot[]> {
    const end = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : Infinity;
    for (;;) {
      // Listen before looking, so a crop finishing in between isn't missed.
      let off = () => {};
      const grown = new Promise<void>((resolve) => (off = this.m.on('cropsGrown', () => resolve())));
      try {
        const plots = await this.plots();
        const done = plots.filter((p) => p.status === 'grown' || p.status === 'dead');
        if (done.length > 0) return done;
        const growing = plots.filter((p) => p.status === 'growing');
        if (growing.length === 0) throw new MelvorError('NOT_READY', 'Nothing is growing: plant something first');
        const left = end - Date.now();
        if (left <= 0) throw new MelvorError('TIMEOUT', `No crop finished within ${opts.timeoutMs}ms`);
        // The event is the signal; the timer is a fallback in case it was missed (a reconnect).
        const soonest = Math.min(...growing.map((p) => p.readyInMs)) + 250;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([grown, new Promise<void>((r) => (timer = setTimeout(r, Math.min(left, soonest))))]);
        clearTimeout(timer);
      } finally {
        off();
      }
    }
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
  /** Plots, planting, harvesting and compost. */
  readonly farming: Farming;
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
    this.farming = new Farming(m, 'melvorD:Farming');
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

  /** How many of an item you have (0 if none). */
  count(item: ItemId): number {
    return this.m.state.bank[item] ?? 0;
  }
  /** True if you have at least `quantity` (default 1). */
  has(item: ItemId, quantity = 1): boolean {
    return this.count(item) >= quantity;
  }
  /** Every item in the bank. */
  items(): { id: ItemId; quantity: number }[] {
    return Object.entries(this.m.state.bank).map(([id, quantity]) => ({ id: id as ItemId, quantity }));
  }
  /** Bank slots in use. */
  get usedSlots(): number {
    return this.m.state.bankSpace.used;
  }
  /** Total bank slots. */
  get maxSlots(): number {
    return this.m.state.bankSpace.max;
  }
  /** Bank slots left. */
  get freeSlots(): number {
    return Math.max(0, this.maxSlots - this.usedSlots);
  }
  /** No free slots: a new kind of item has nowhere to go. */
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
  /** Bury bones for prayer points. */
  bury(item: ItemId, quantity = 1) {
    return this.m.connection.call('bank.bury', { item, quantity });
  }
}

export class Player {
  constructor(private m: Melvor) {}

  private get p() {
    return this.m.state.player;
  }
  /** Current hitpoints. */
  get hp(): number {
    return this.p.hp;
  }
  /** Maximum hitpoints. */
  get maxHp(): number {
    return this.p.maxHp;
  }
  /** Hitpoints as a fraction, 0..1. */
  get hpFraction(): number {
    return this.p.maxHp > 0 ? this.p.hp / this.p.maxHp : 0;
  }
  /** Prayer points. */
  get prayerPoints(): number {
    return this.p.prayerPoints;
  }
  /** Combat level. */
  get combatLevel(): number {
    return this.p.combatLevel;
  }
  /** 'melee', 'ranged' or 'magic'. */
  get attackType(): string {
    return this.p.attackType;
  }
  /** Equipped food: the selected slot, and each slot's item and quantity. */
  get food(): PlayerState['food'] {
    return this.p.food;
  }
  /** The currently selected food slot. */
  get currentFood(): FoodSlotState {
    return this.p.food.slots[this.p.food.selected] ?? { item: null, quantity: 0 };
  }
  /** Equipped items by slot id. Empty slots are left out. */
  get equipment(): PlayerState['equipment'] {
    return this.p.equipment;
  }
  /** Prayers that are on. */
  get activePrayers(): PrayerId[] {
    return this.p.activePrayers as PrayerId[];
  }
  /** The item in a slot, or null. */
  equipped(slot: EquipmentSlotId): ItemId | null {
    return (this.p.equipment[slot]?.item as ItemId) ?? null;
  }
  /** True if the item is equipped in any slot. */
  isEquipped(item: ItemId): boolean {
    return Object.values(this.p.equipment).some((e) => e.item === item);
  }

  /** Eat the selected food `times` times (default 1). */
  eat(times = 1) {
    return this.m.connection.call('player.eat', { quantity: times });
  }
  /** Move food from the bank into a food slot (at most what you have). */
  equipFood(item: FoodId | ItemId, quantity: number) {
    return this.m.connection.call('player.equipFood', { item, quantity });
  }
  /** Choose which food slot to eat from. */
  selectFood(slot: number) {
    return this.m.connection.call('player.selectFood', { slot });
  }
  /** Equip an item from the bank. Defaults: its first valid slot, quantity 1, the current equipment set. */
  equip(item: ItemId, opts: { slot?: EquipmentSlotId; quantity?: number; set?: number } = {}) {
    return this.m.connection.call('player.equip', { item, ...opts });
  }
  /** Empty a slot (in the current equipment set unless `set` is given). */
  unequip(slot: EquipmentSlotId, set?: number) {
    return this.m.connection.call('player.unequip', { slot, set });
  }
  /** Switch equipment set (0-based). */
  setEquipmentSet(set: number) {
    return this.m.connection.call('player.setEquipmentSet', { set });
  }
  /** Turn a prayer on or off. */
  togglePrayer(prayer: PrayerId) {
    return this.m.connection.call('player.togglePrayer', { prayer });
  }
  /** Choose an attack style (see `AttackStyles`). */
  setAttackStyle(style: AttackStyleId) {
    return this.m.connection.call('player.setAttackStyle', { style });
  }

  /** The selected combat spells. The attack spell is what you cast when attacking with magic. */
  get spells(): SpellSelection {
    return (this.p.spells ?? { attack: null, curse: null, aurora: null }) as SpellSelection;
  }
  /**
   * Choose combat spells (see `AttackSpells`, `Curses`, `Auroras`). Leave a key out to keep it;
   * `null` removes the curse or aurora. Curses and auroras need magic attacks, and a spellbook
   * that allows them. Free: no cooldown.
   *
   * There's no separate "cast" in combat: your weapon decides how you attack. With a magic weapon
   * (a staff or wand) equipped, every attack casts your attack spell and uses its runes from the
   * bank. A staff like `Items.Staff_of_Fire` also provides its element's runes.
   *
   *   await m.player.equip(Items.Staff_of_Fire);
   *   await m.player.setSpells({ attack: AttackSpells.FireBolt, curse: Curses.WeakeningI });
   */
  setSpells(spells: { attack?: AttackSpellId; curse?: CurseSpellId | null; aurora?: AuroraSpellId | null }) {
    return this.m.connection.call('player.setSpells', spells) as Promise<SpellSelection>;
  }
}

/** Selected combat spells (null = none). */
export interface SpellSelection {
  attack: AttackSpellId | null;
  curse: CurseSpellId | null;
  aurora: AuroraSpellId | null;
}

/** A slayer task. */
export type SlayerTask = Omit<SlayerTaskState, 'monster' | 'category'> & {
  monster: MonsterId;
  category: SlayerCategoryId;
};

/** What a potion works for: 'melvorD:Combat' or a skill. */
export type PotionAction = 'melvorD:Combat' | SkillId;

/** A potion in use. */
export interface ActivePotion {
  item: PotionId;
  /** Charges left. */
  charges: number;
}

export class Slayer {
  constructor(private m: Melvor) {}

  /** Your slayer task, or null. After a task is done it's null for about a second, while the game picks the next. */
  get task(): SlayerTask | null {
    return this.m.state.combat.slayerTask as SlayerTask | null;
  }

  /** Every task tier: level, costs, completions, and whether you can pick it. */
  categories(): Promise<SlayerCategoryInfo[]> {
    return this.m.connection.call('slayer.categories');
  }

  /**
   * Get a new task in a tier (see `SlayerCategories`), paying its cost (Easy is free).
   * It replaces the task you have. Resolves with the task once the game has picked it (about a second).
   * When a task is done the game picks the next one in the same tier for free; calling this
   * during that second takes that one instead of paying for another.
   */
  newTask(category: SlayerCategoryId): Promise<SlayerTask> {
    return this.m.connection.call('slayer.newTask', { category }) as Promise<SlayerTask>;
  }

  /** Your task if you have one (or the one the game is picking), otherwise a new one in `category`. */
  ensureTask(category: SlayerCategoryId): Promise<SlayerTask> {
    return this.m.connection.call('slayer.newTask', { category, keepCurrent: true }) as Promise<SlayerTask>;
  }

  /** Extend your task for more kills (once per task; costs Slayer Coins). */
  extend(): Promise<SlayerTask> {
    return this.m.connection.call('slayer.extend') as Promise<SlayerTask>;
  }

  /**
   * Fight your task's monster until the task is done. Like `m.combat.fight` with `kills`: in instant
   * mode it attacks for you, and it leaves combat afterwards. Rejects with `FightStoppedError` if
   * the fight ends early (you died or fled, or the task changed), unless `allowStop`.
   *
   *   await m.combat.slayer.ensureTask(SlayerCategories.Easy);
   *   await m.combat.slayer.fight();
   */
  async fight(opts: { allowStop?: boolean } = {}): Promise<FightResult> {
    const result = await this.m._paced(() => this.m.connection.call('slayer.fight'));
    if (result.status !== 'completed' && !opts.allowStop) throw new FightStoppedError(result);
    return result;
  }
}

export class PotionManager {
  constructor(private m: Melvor) {}

  private get s() {
    return this.m.state.potions ?? { active: {}, autoReuse: [] };
  }

  /** Potions in use, keyed by what they work for ('melvorD:Combat' or a skill id). */
  get active(): Partial<Record<PotionAction, ActivePotion>> {
    return this.s.active as Partial<Record<PotionAction, ActivePotion>>;
  }
  /** The potion in use for combat or a skill, or null. */
  activeFor(action: PotionAction): ActivePotion | null {
    return (this.s.active[action] as ActivePotion | undefined) ?? null;
  }
  /** True when that action's potion is refilled from the bank as its charges run out. */
  autoReuse(action: PotionAction): boolean {
    return this.s.autoReuse.includes(action);
  }

  /**
   * Drink a potion from the bank. It works for its action (combat, or one skill) until its charges
   * run out. The same potion again tops its charges back up; another one for the same action
   * replaces it. Free: no cooldown.
   */
  use(potion: PotionId) {
    return this.m.connection.call('potions.use', { item: potion }) as Promise<{
      action: PotionAction;
      item: PotionId;
      charges: number;
    }>;
  }
  /** Stop using the potion for combat or a skill (its charges are lost). */
  remove(action: PotionAction) {
    return this.m.connection.call('potions.remove', { action });
  }
  /** Refill that action's potion from the bank as it runs out (the game's "auto re-use" box). */
  setAutoReuse(action: PotionAction, enabled = true) {
    return this.m.connection.call('potions.setAutoReuse', { action, enabled });
  }
}

export class Combat {
  /** Slayer tasks: get one, extend it, fight it. */
  readonly slayer: Slayer;

  constructor(private m: Melvor) {
    this.slayer = new Slayer(m);
  }

  private get c() {
    return this.m.state.combat;
  }
  /** You're in combat. */
  get active(): boolean {
    return this.c.active;
  }
  /** The combat area you're in. */
  get area(): CombatAreaId | null {
    return this.c.area as CombatAreaId | null;
  }
  /** The monster you're fighting. */
  get monster(): MonsterId | null {
    return this.c.monster as MonsterId | null;
  }
  /** The enemy's hitpoints. */
  get enemyHp(): number {
    return this.c.enemyHp;
  }
  /** The enemy's maximum hitpoints. */
  get enemyMaxHp(): number {
    return this.c.enemyMaxHp;
  }
  /** Your slayer task, or null. Same as `m.combat.slayer.task`. */
  get slayerTask(): SlayerTask | null {
    return this.c.slayerTask as SlayerTask | null;
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
   * Your weapon sets the attack type: with a magic weapon this casts your spell (see `m.player.setSpells`).
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

  /** One item's details. Cached. */
  async item(id: ItemId): Promise<ItemInfo> {
    let info = this.itemCache.get(id);
    if (!info) {
      info = await this.m.connection.call('data.item', { id });
      this.itemCache.set(id, info);
    }
    return info;
  }
  /** Items, optionally filtered by ids, type or category. */
  items(filter: { ids?: ItemId[]; type?: string; category?: string } = {}): Promise<ItemInfo[]> {
    return this.m.connection.call('data.items', filter);
  }
  /** A skill's actions or recipes. Cached; pass `true` to refresh. */
  async actions(skill: SkillId | (string & {}), refresh = false): Promise<ActionInfo[]> {
    let list = refresh ? undefined : this.actionCache.get(skill);
    if (!list) {
      list = await this.m.connection.call('data.actions', { skill });
      this.actionCache.set(skill, list);
    }
    return list;
  }
  /** Every monster. Cached. */
  async monsters(): Promise<MonsterInfo[]> {
    return (this.monsterCache ??= await this.m.connection.call('data.monsters'));
  }
  /** Every combat area, slayer area and dungeon. Cached. */
  async areas(): Promise<AreaInfo[]> {
    return (this.areaCache ??= await this.m.connection.call('data.areas'));
  }
  /** Combat spells (attack spells, curses, auroras), with levels, runes and whether you can use them. */
  spells(): Promise<SpellInfo[]> {
    return this.m.connection.call('data.spells');
  }
}

// ---------------------------------------------------------------------------
// Melvor
// ---------------------------------------------------------------------------

type StateListener = (state: GameState, changed: StateSection[]) => void;

export class Melvor {
  /** Live mirror of the game state. Updated a few times per second and before every call returns. */
  readonly state: GameState;
  /** Every skill: levels, XP, mastery and the action methods. */
  readonly skills: Skills;
  /** Bank contents, selling, opening and burying. */
  readonly bank: Bank;
  /** HP, food, equipment and prayers. */
  readonly player: Player;
  /** Fighting monsters and dungeons, and slayer tasks. */
  readonly combat: Combat;
  /** Potions for combat and skills. */
  readonly potions: PotionManager;
  /** Buying from the shop. */
  readonly shop: Shop;
  /** Game data: items, skill actions, monsters, areas. */
  readonly data: GameData;
  /** This script's name, as shown in the in-game panel. */
  readonly name: string;
  /** This connection's id in the game. */
  readonly clientId: number;
  /** Version of the mod running in the game. */
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
    /** The low-level connection. Most scripts never need it. */
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
    this.potions = new PotionManager(this);
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
  /** Slayer Coins. */
  get slayerCoins(): number {
    return this.state.currencies['melvorD:SlayerCoins'] ?? 0;
  }
  /** Any currency by id, e.g. 'melvorD:GP'. */
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

  /** Instant mode: crops grow in their normal time / farmingSpeed. 1 in real-time mode. */
  get farmingSpeed(): number {
    return this.state.meta.farmingSpeed ?? 1;
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

  /** Wait `ms` milliseconds. */
  sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  // -- logging --------------------------------------------------------------

  /** Print locally and in the in-game script panel. */
  log(...args: unknown[]) {
    this.emitLog('info', args);
  }
  /** Like `log`, as a warning. */
  warn(...args: unknown[]) {
    this.emitLog('warn', args);
  }
  /** Like `log`, as an error. */
  error(...args: unknown[]) {
    this.emitLog('error', args);
  }
  /** Like `log`, in green. */
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
  /** Turn Script Mode on or off (the panel toggle). Always on in the Scripted gamemode. */
  setScriptMode(enabled: boolean) {
    return this.connection.call('runtime.setScriptMode', { enabled });
  }
  /** Mod version, mode, speed and connected scripts. */
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

  /** Disconnect. Scripts started with `run` don't need to. */
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
