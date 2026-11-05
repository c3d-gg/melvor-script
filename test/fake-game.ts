/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A tiny stand-in for Melvor's `game`, faithful to the parts the runtime touches.
 * GatheringSkill / CraftingSkill / Thieving mirror the real (v1.3.x, build 12097)
 * start/stop/action/startActionTimer logic, so the ActionController is exercised
 * against the same control flow it will see in the game.
 */
const TICK = 50;

type Handler = (e: any) => void;
class Emitter {
  private h = new Map<string, Set<Handler>>();
  on = (ev: string, fn: Handler) => {
    if (!this.h.has(ev)) this.h.set(ev, new Set());
    this.h.get(ev)!.add(fn);
  };
  off = (ev: string, fn: Handler) => {
    this.h.get(ev)?.delete(fn);
  };
  emit(ev: string, e: any) {
    for (const fn of this.h.get(ev) ?? []) fn(e);
  }
}

export class Registry<T extends { id: string; localID: string }> {
  private m = new Map<string, T>();
  register(o: T) {
    this.m.set(o.id, o);
    return o;
  }
  getObjectByID(id: string) {
    return this.m.get(id);
  }
  get allObjects() {
    return [...this.m.values()];
  }
  forEach(fn: (o: T) => void) {
    this.m.forEach(fn);
  }
}

class Obj {
  constructor(
    public id: string,
    public name: string,
  ) {}
  get localID() {
    return this.id.split(':')[1];
  }
}

export class Item extends Obj {
  sellsFor: any;
  constructor(
    id: string,
    name: string,
    public healsFor?: number,
  ) {
    super(id, name);
  }
}

class Timer {
  active = false;
  ticksLeft = 0;
  maxTicks = 0;
  constructor(private cb: () => void) {}
  start(ms: number) {
    this.maxTicks = this.ticksLeft = Math.max(1, Math.floor(ms / TICK));
    this.active = true;
  }
  stop() {
    this.active = false;
  }
  tick() {
    if (!this.active) return;
    if (--this.ticksLeft <= 0) {
      this.active = false;
      this.cb();
    }
  }
}

class Currency extends Obj {
  amount = 0;
  canAfford(q: number) {
    return this.amount >= q;
  }
  add(q: number) {
    this.amount += q;
  }
  remove(q: number) {
    this.amount -= q;
  }
}

class Bank extends Emitter {
  items = new Map<Item, { quantity: number; locked: boolean }>();
  maximumSlots = 20;
  constructor(private game: FakeGame) {
    super();
  }
  get occupiedSlots() {
    return this.items.size;
  }
  getQty(item: Item) {
    return this.items.get(item)?.quantity ?? 0;
  }
  addItem(item: Item, quantity: number) {
    const existing = this.items.get(item);
    if (!existing && this.occupiedSlots >= this.maximumSlots) return false;
    const old = existing?.quantity ?? 0;
    if (existing) existing.quantity += quantity;
    else this.items.set(item, { quantity, locked: false });
    this.emit('itemChanged', { item, oldQuantity: old, newQuantity: old + quantity });
    return true;
  }
  removeItemQuantity(item: Item, quantity: number) {
    const existing = this.items.get(item);
    if (!existing) throw new Error('not owned');
    const old = existing.quantity;
    existing.quantity -= quantity;
    if (existing.quantity <= 0) this.items.delete(item);
    this.emit('itemChanged', { item, oldQuantity: old, newQuantity: Math.max(0, old - quantity) });
  }
  processItemSale(item: Item, quantity: number) {
    this.game.gp.add(item.sellsFor.quantity * quantity);
    this.removeItemQuantity(item, quantity);
  }
}

/** The normal realm (Into the Abyss adds Abyssal and Eternal). */
export const MELVOR_REALM = { id: 'melvorD:Melvor', name: 'Melvor Realm', isUnlocked: true };

export class Action extends Obj {
  realm: { id: string; name: string; isUnlocked: boolean } = MELVOR_REALM;
  constructor(
    id: string,
    name: string,
    public level: number,
    public baseExperience: number,
    public product: Item,
    public itemCosts: { item: Item; quantity: number }[] = [],
  ) {
    super(id, name);
  }
  abyssalLevel = 0;
  /** Unlock requirements besides level (real ones: CartographyPOIDiscovery, ShopPurchase, ...). */
  requirements: { type: string; met?: boolean }[] = [];
}

/** Mirrors GatheringSkill in skill.js */
export class GatheringSkill extends Emitter {
  isActive = false;
  _xp = 0;
  _level = 1;
  actions = new Registry<Action>();
  actionTimer = new Timer(() => this.action());
  renderQueue: any = {};
  currentLevelCap = 99;
  isUnlocked = true;
  interval = 500;
  _events = { emit: (ev: string, e: any) => this.emit(ev, e) };
  constructor(
    public game: FakeGame,
    public id: string,
    public name: string,
  ) {
    super();
  }
  get localID() {
    return this.id.split(':')[1];
  }
  get xp() {
    return this._xp;
  }
  get level() {
    return this._level;
  }
  get canStop() {
    return this.isActive;
  }
  get actionInterval() {
    return this.interval;
  }
  isMasteryActionUnlocked(a: Action) {
    return this.level >= a.level;
  }

  // Mastery: mirrors SkillWithMastery in skill.js (levels from fakeExp below).
  hasMastery = true;
  masteryLevelCap = 99;
  actionMastery = new Map<Action, { xp: number; level: number }>();
  _masteryPoolXP = new Map<unknown, number>();
  /** Pool checkpoints, % of the base cap (masteryPoolBonuses). */
  poolCheckpoints = [10, 25, 50, 95];
  getMasteryLevel(a: Action) {
    return this.actionMastery.get(a)?.level ?? 1;
  }
  getMasteryXP(a: Action) {
    return this.actionMastery.get(a)?.xp ?? 0;
  }
  getRealmsWithMastery() {
    return [...new Set(this.actions.allObjects.map((a) => a.realm))];
  }
  getBaseMasteryPoolCap(realm: unknown) {
    return this.actions.allObjects.filter((a) => a.realm === realm).length * 500000;
  }
  getMasteryPoolCap(realm: unknown) {
    return this.getBaseMasteryPoolCap(realm);
  }
  getMasteryPoolXP(realm: unknown) {
    return this._masteryPoolXP.get(realm) ?? 0;
  }
  getMasteryPoolProgress(realm: unknown) {
    return Math.min(100, (100 * this.getMasteryPoolXP(realm)) / this.getBaseMasteryPoolCap(realm));
  }
  getPoolBonusChange(realm: unknown, xp: number) {
    const count = (x: number) =>
      this.poolCheckpoints.filter((p) => (100 * x) / this.getBaseMasteryPoolCap(realm) >= p).length;
    const old = this.getMasteryPoolXP(realm);
    return count(old + xp) - count(old);
  }
  exchangePoolXPForActionXP(a: Action, xp: number) {
    const m = this.actionMastery.get(a) ?? { xp: 0, level: 1 };
    m.xp += xp;
    m.level = Math.min(this.masteryLevelCap, fakeExp.xpToLevel(m.xp));
    this.actionMastery.set(a, m);
    this._masteryPoolXP.set(a.realm, this.getMasteryPoolXP(a.realm) - xp);
  }
  addXP(n: number) {
    const before = this._level;
    this._xp += n;
    this._level = 1 + Math.floor(this._xp / 100);
    if (this._level !== before) this.emit('levelChanged', { oldLevel: before, newLevel: this._level });
  }
  start() {
    const canStart = !this.game.idleChecker(this);
    if (canStart) {
      if (!this.game.currentGamemode.enableInstantActions) {
        this.isActive = true;
        this.startActionTimer();
        this.game.activeAction = this;
      } else {
        // skill.js: instant actions perform 1 + "actions per click" right away, then stop.
        this.isActive = true;
        this.game.activeAction = this;
        const n = this.game.modifiers.getInstantActionsToPerform();
        for (let i = 0; i < n; i++) this.action();
        // skill.js rolls the April Fools "Out of Actions!" popup here (a global in main.js).
        (globalThis as { showActionsRunOutSwal?: () => void }).showActionsRunOutSwal?.();
        this.stop();
      }
    }
    return canStart;
  }
  stop() {
    if (!this.canStop) return false;
    this.isActive = false;
    this.actionTimer.stop();
    this.game.clearActiveAction();
    this.onStop();
    // skill.js: every stop asks for a save on the next tick.
    this.game.scheduleSave();
    return true;
  }
  onStop() {}
  startActionTimer() {
    this.actionTimer.start(this.actionInterval);
  }
  get masteryAction(): Action | undefined {
    return undefined;
  }
  preAction() {}
  postAction() {}
  /** Returns false if the skill should stop (bank full). */
  addActionRewards() {
    const action = this.masteryAction!;
    this.emit('action', { action });
    this.addXP(action.baseExperience);
    return this.game.bank.addItem(action.product, 1);
  }
  action() {
    this.preAction();
    const continueSkill = this.addActionRewards();
    this.postAction();
    if (continueSkill) this.startActionTimer();
    else this.stop();
  }
  tick() {
    this.actionTimer.tick();
  }
}

/** Mirrors CraftingSkill.action in skill.js */
export class CraftingSkill extends GatheringSkill {
  getCurrentRecipeCosts() {
    return this.getRecipeCosts(this.masteryAction!);
  }
  getRecipeCosts(recipe: Action) {
    const game = this.game;
    const items = recipe.itemCosts;
    return {
      getItemQuantityArray: () => items,
      getCurrencyQuantityArray: () => [],
      checkIfOwned: () => items.every(({ item, quantity }) => game.bank.getQty(item) >= quantity),
      consumeCosts: () => items.forEach(({ item, quantity }) => game.bank.removeItemQuantity(item, quantity)),
    };
  }
  action() {
    const recipeCosts = this.getCurrentRecipeCosts();
    if (!recipeCosts.checkIfOwned()) {
      this.stop();
      return;
    }
    this.preAction();
    recipeCosts.consumeCosts();
    const continueSkill = this.addActionRewards();
    this.postAction();
    const nextCosts = this.getCurrentRecipeCosts();
    if (nextCosts.checkIfOwned() && continueSkill) this.startActionTimer();
    else this.stop();
  }
}

export class ArtisanSkill extends CraftingSkill {
  selectedRecipe: Action | undefined;
  selectedRecipeInRealm = new Map();
  get masteryAction() {
    return this.selectedRecipe;
  }
}

export class Woodcutting extends GatheringSkill {
  activeTrees = new Set<Action>();
  treeCutLimit = 1;
  /** Mirrors woodcutting.js: level, requirements (and abyssal level, unused here). */
  isTreeUnlocked(t: Action) {
    return this.level >= t.level && this.game.checkRequirements(t.requirements);
  }
  get masteryAction() {
    return [...this.activeTrees][0];
  }
  onStop() {
    this.activeTrees.clear();
  }
}

/** Mirrors the stun flow in thieving2.js. */
export class Thieving extends GatheringSkill {
  stunState = 0;
  stunTimer = new Timer(() => this.stunned());
  currentNPC: Action | undefined;
  currentArea: any;
  areas = new Registry<any>();
  /** Test knob: the next N attempts fail (and stun). */
  failNext = 0;
  get masteryAction() {
    return this.currentNPC;
  }
  get stunInterval() {
    return 300;
  }
  get isStunned() {
    return this.stunState !== 0;
  }
  get canStop() {
    return super.canStop && !this.isStunned;
  }
  preAction() {
    if (this.failNext > 0) {
      this.failNext--;
      this.stunState = 1;
    }
  }
  addActionRewards() {
    const npc = this.currentNPC!;
    if (this.stunState === 0) {
      this.addXP(npc.baseExperience);
      this.game.gp.add(10);
    }
    this.emit('action', { successful: this.stunState === 0 });
    return true;
  }
  postAction() {
    if (this.stunState !== 1) return;
    if (!this.game.currentGamemode.enableInstantActions) this.stunTimer.start(this.stunInterval);
    else {
      // thieving2.js: in instant mode a stun just ends the click.
      this.stunState = 0;
      this.stop();
    }
  }
  startActionTimer() {
    if (this.stunState !== 1) super.startActionTimer();
  }
  stunned() {
    this.stunState = 0;
    if (this.game.settings.continueThievingOnStun) this.startActionTimer();
    else this.stop();
  }
  tick() {
    super.tick();
    this.stunTimer.tick();
  }
}

// ---------------------------------------------------------------------------
// Farming: mirrors farming2.js (v1.3.x)
// ---------------------------------------------------------------------------

export const PLOT = { Locked: 0, Empty: 1, Growing: 2, Grown: 3, Dead: 4 } as const;

export class FarmingCategory extends Obj {
  constructor(
    id: string,
    name: string,
    public giveXPOnPlant: boolean,
    public harvestMultiplier: number,
    public scaleXPWithQuantity: boolean,
  ) {
    super(id, name);
  }
}

export class Crop extends Action {
  baseQuantity = 1;
  constructor(
    id: string,
    name: string,
    level: number,
    baseExperience: number,
    product: Item,
    public category: FarmingCategory,
    public baseInterval: number,
    public seedCost: { item: Item; quantity: number },
  ) {
    super(id, name, level, baseExperience, product);
  }
}

export class CompostItem extends Item {
  constructor(
    id: string,
    name: string,
    public compostValue: number,
    public harvestBonus: number,
  ) {
    super(id, name);
  }
}

export class FarmingPlot extends Obj {
  state: number;
  compostLevel = 0;
  compostItem: CompostItem | undefined;
  plantedRecipe: Crop | undefined;
  growthTime = 0;
  abyssalLevel = 0;
  constructor(
    id: string,
    public category: FarmingCategory,
    public level: number,
    public currencyCosts: { currency: Currency; quantity: number }[] = [],
  ) {
    super(id, id.split(':')[1]!);
    this.state = currencyCosts.length === 0 && level === 1 ? PLOT.Empty : PLOT.Locked;
  }
}

class GrowthTimer extends Timer {
  plots: FarmingPlot[] = [];
}

export class Farming extends Emitter {
  _xp = 0;
  _level = 1;
  abyssalLevel = 0;
  isUnlocked = true;
  currentLevelCap = 99;
  actions = new Registry<Crop>();
  categories = new Registry<FarmingCategory>();
  plots = new Registry<FarmingPlot>();
  growthTimers = new Set<GrowthTimer>();
  growthTimerMap = new Map<FarmingPlot, GrowthTimer>();
  renderQueue = { growthState: new Set(), growthTime: new Set(), compost: new Set() };
  /** Test knob: the growth roll (rollPercentage(chance) is `rng() < chance`). */
  rng = () => 0;
  constructor(
    public game: FakeGame,
    public id: string,
    public name: string,
  ) {
    super();
  }
  get localID() {
    return this.id.split(':')[1];
  }
  get xp() {
    return this._xp;
  }
  get level() {
    return this._level;
  }
  addXP(n: number) {
    this._xp += n;
    this._level = 1 + Math.floor(this._xp / 100);
  }
  isMasteryActionUnlocked(a: Crop) {
    return this.level >= a.level;
  }
  getRecipeSeedCost(r: Crop) {
    return r.seedCost.quantity;
  }
  getPlotGrowthChance(plot: FarmingPlot) {
    return 50 + plot.compostLevel / 2;
  }
  getPlotGrowthTime(plot: FarmingPlot) {
    const t = this.growthTimerMap.get(plot);
    return t ? t.ticksLeft * TICK : 0;
  }
  growPlots(timer: GrowthTimer) {
    for (const plot of timer.plots) {
      plot.state = this.rng() < this.getPlotGrowthChance(plot) ? PLOT.Grown : PLOT.Dead;
      this.growthTimerMap.delete(plot);
    }
    this.removeGrowthTimer(timer);
  }
  removeGrowthTimer(timer: GrowthTimer) {
    this.growthTimers.delete(timer);
  }
  plantPlot(plot: FarmingPlot, recipe: Crop) {
    if (plot.state !== PLOT.Empty) return -1;
    const seeds = this.getRecipeSeedCost(recipe);
    if (this.game.bank.getQty(recipe.seedCost.item) < seeds) return -1;
    const interval = recipe.baseInterval;
    // farming2.js: instant actions mark the crop grown on the spot (the timer still runs).
    plot.state = this.game.currentGamemode.enableInstantActions ? PLOT.Grown : PLOT.Growing;
    plot.plantedRecipe = recipe;
    plot.growthTime = interval / 1000;
    this.game.bank.removeItemQuantity(recipe.seedCost.item, seeds);
    if (recipe.category.giveXPOnPlant) this.addXP(recipe.baseExperience);
    return interval;
  }
  plantRecipe(recipe: Crop, plot: FarmingPlot) {
    const interval = this.plantPlot(plot, recipe);
    if (interval <= 0) return;
    this.createGrowthTimer([plot], interval);
  }
  createGrowthTimer(plots: FarmingPlot[], interval: number) {
    const timer: GrowthTimer = new GrowthTimer(() => this.growPlots(timer));
    timer.plots = plots;
    this.growthTimers.add(timer);
    for (const p of plots) this.growthTimerMap.set(p, timer);
    timer.start(interval);
  }
  harvestPlot(plot: FarmingPlot) {
    if (plot.state !== PLOT.Grown || plot.plantedRecipe === undefined) return false;
    const recipe = plot.plantedRecipe;
    const qty = recipe.baseQuantity * recipe.category.harvestMultiplier;
    if (!this.game.bank.addItem(recipe.product, qty)) return false;
    this.addXP(recipe.baseExperience * (recipe.category.scaleXPWithQuantity ? qty : 1));
    this.resetPlot(plot);
    return true;
  }
  clearDeadPlot(plot: FarmingPlot) {
    if (plot.state !== PLOT.Dead || plot.plantedRecipe === undefined) return;
    this.resetPlot(plot);
  }
  /** Like the real one, it leaves the plot in its (finished) timer's map entry alone. */
  resetPlot(plot: FarmingPlot) {
    plot.state = PLOT.Empty;
    plot.plantedRecipe = undefined;
    plot.growthTime = 0;
    plot.compostItem = undefined;
    plot.compostLevel = 0;
  }
  compostPlot(plot: FarmingPlot, compost: CompostItem, amount: number) {
    if (plot.state !== PLOT.Empty) return false;
    const owned = this.game.bank.getQty(compost);
    if (plot.compostItem !== undefined && plot.compostItem.harvestBonus >= compost.harvestBonus) {
      if (plot.compostItem.harvestBonus > compost.harvestBonus || plot.compostLevel === 100) return false;
      amount = Math.min(amount, Math.ceil((100 - plot.compostLevel) / compost.compostValue), owned);
      if (amount <= 0) return false;
      plot.compostLevel = Math.min(100, plot.compostLevel + amount * compost.compostValue);
    } else {
      amount = Math.min(amount, Math.ceil(100 / compost.compostValue), owned);
      if (amount <= 0) return false;
      plot.compostLevel = Math.min(100, amount * compost.compostValue);
      plot.compostItem = compost;
    }
    this.game.bank.removeItemQuantity(compost, amount);
    return true;
  }
  getPlotUnlockCosts(plot: FarmingPlot) {
    return {
      getCurrencyQuantityArray: () => plot.currencyCosts,
      getItemQuantityArray: () => [],
      checkIfOwned: () => plot.currencyCosts.every(({ currency, quantity }) => currency.amount >= quantity),
      consumeCosts: () => plot.currencyCosts.forEach(({ currency, quantity }) => currency.remove(quantity)),
    };
  }
  unlockPlotOnClick(plot: FarmingPlot) {
    const costs = this.getPlotUnlockCosts(plot);
    if (!costs.checkIfOwned() || this.level < plot.level) return;
    costs.consumeCosts();
    plot.state = PLOT.Empty;
  }
  destroyPlot(plot: FarmingPlot) {
    if (plot.state !== PLOT.Growing) return;
    this.resetPlot(plot);
    const timer = this.growthTimerMap.get(plot)!;
    this.growthTimerMap.delete(plot);
    timer.plots.splice(timer.plots.indexOf(plot), 1);
    if (timer.plots.length === 0) this.removeGrowthTimer(timer);
  }
  /** passiveTick: growth timers run every tick, whatever else is going on. */
  tick() {
    for (const t of this.growthTimers) t.tick();
  }
}

/**
 * Real-time mode: a kill every 200ms (loot straight to the bank).
 * Instant mode (baseManager.js / character.js): spawn timer, then the enemy only moves when the
 * Attack button calls player.actOnClick() and enemy.actOnClick(). Each player act deals 1 damage
 * (enemies have 3 HP); deaths are checked once per tick (or by checkDeath()). Loot goes to the
 * loot container.
 */
class Combat extends Emitter {
  isActive = false;
  fightInProgress = false;
  selectedMonster: any;
  selectedArea: any;
  enemy: any;
  player: any;
  /** Test knob: damage the enemy deals per act. */
  enemyDamage = 0;
  playerActs = 0;
  enemyActs = 0;
  killTimer = new Timer(() => this.kill());
  spawnTimer = new Timer(() => this.spawn());
  loot: any;
  constructor(private game: FakeGame) {
    super();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const combat = this;
    this.player = {
      hitpoints: 100,
      stats: { maxHitpoints: 100, attackInterval: 600 },
      prayerPoints: 0,
      attackType: 'melee',
      autoEatThreshold: 0,
      food: { selectedSlot: 0, slots: [{ item: game.emptyFoodItem, quantity: 0 }] },
      selectedEquipmentSet: 0,
      equipment: { equippedItems: {} },
      activePrayers: new Set(),
      actOnClick() {
        if (!combat.fightInProgress) return;
        combat.playerActs++;
        combat.enemy.hitpoints -= 1;
      },
      getMonsterSpawnTime() {
        return 3000;
      },
    };
    this.enemy = {
      monster: undefined,
      hitpoints: 0,
      state: 0,
      stats: { maxHitpoints: 0 },
      actOnClick() {
        if (!combat.fightInProgress) return;
        combat.enemyActs++;
        combat.player.hitpoints -= combat.enemyDamage;
      },
    };
    const drops: { item: Item; quantity: number }[] = [];
    this.loot = {
      drops,
      lootAll: () => {
        for (const d of drops.splice(0)) this.game.bank.addItem(d.item, d.quantity);
      },
    };
  }
  private get instant() {
    return this.game.currentGamemode.enableInstantActions;
  }
  selectMonster(monster: any, area: any) {
    if (this.game.idleChecker(this)) return;
    this.selectedArea = area;
    this.selectedMonster = monster;
    this.enemy.monster = monster;
    this.isActive = true;
    this.game.activeAction = this;
    if (this.instant) this.loadNextEnemy();
    else this.killTimer.start(200);
  }
  loadNextEnemy() {
    this.enemy.state = 2;
    this.spawnTimer.start(this.player.getMonsterSpawnTime());
  }
  spawn() {
    this.fightInProgress = true;
    this.enemy.state = 1;
    this.enemy.hitpoints = this.enemy.stats.maxHitpoints = 3;
  }
  checkDeath() {
    if (this.player.hitpoints <= 0 && this.isActive) {
      this.player.hitpoints = this.player.stats.maxHitpoints;
      this.stop();
      return;
    }
    if (this.enemy.state === 1 && this.enemy.hitpoints <= 0) {
      this.enemy.state = 0;
      this.fightInProgress = false;
      this.loot.drops.push({ item: this.game.items.getObjectByID('test:Bones')!, quantity: 1 });
      this.emit('monsterKilled', { monster: this.selectedMonster });
      if (this.isActive) this.loadNextEnemy();
    }
  }
  /** Real order (combatManager.onEnemyDeath): loot drops, then 'monsterKilled', then the caller respawns. */
  kill() {
    this.game.bank.addItem(this.game.items.getObjectByID('test:Bones')!, 1);
    this.emit('monsterKilled', { monster: this.selectedMonster });
    if (this.isActive) this.killTimer.start(200);
  }
  stop() {
    if (!this.isActive) return false;
    this.isActive = false;
    this.fightInProgress = false;
    this.enemy.state = 0;
    this.killTimer.stop();
    this.spawnTimer.stop();
    this.selectedArea = undefined;
    this.game.clearActiveAction();
    return true;
  }
  tick() {
    this.killTimer.tick();
    this.spawnTimer.tick();
    this.checkDeath();
  }
}

export class FakeGame {
  characterName = 'Tester';
  currentGamemode = { id: 'melvorD:Standard', enableInstantActions: false };
  /** Test knob: extra actions per click (instant mode). */
  actionsPerClick = 0;
  modifiers = {
    getInstantActionsToPerform: () => (this.currentGamemode.enableInstantActions ? 1 + this.actionsPerClick : 0),
  };
  settings: any = { continueThievingOnStun: false };
  activeAction: any;
  isGolbinRaid = false;
  emptyFoodItem = new Item('melvorD:Empty_Food', 'Nothing');
  emptyEquipmentItem = new Item('melvorD:Empty_Equipment', 'Nothing');
  items = new Registry<Item>();
  skills = new Registry<any>();
  currencies = new Registry<Currency>();
  monsters = new Registry<any>();
  combatAreas = new Registry<any>();
  prayers = new Registry<any>();
  attackStyles = new Registry<any>();
  equipmentSlots = new Registry<any>();
  gp = this.currencies.register(new Currency('melvorD:GP', 'GP'));
  bank = new Bank(this);
  combat: Combat;
  woodcutting: Woodcutting;
  smithing: ArtisanSkill;
  thieving: Thieving;
  farming: Farming;
  unknownCombatArea = { id: 'melvorD:UnknownArea' };
  playerCombatLevel = 3;

  constructor() {
    const item = (id: string, name: string, sells = 1) => {
      const it = this.items.register(new Item(id, name));
      it.sellsFor = { currency: this.gp, quantity: sells };
      return it;
    };
    const logs = item('test:Oak_Logs', 'Oak Logs', 5);
    const ore = item('test:Copper_Ore', 'Copper Ore');
    const bar = item('test:Bronze_Bar', 'Bronze Bar', 3);
    item('test:Bones', 'Bones');

    this.woodcutting = this.skills.register(new Woodcutting(this, 'test:Woodcutting', 'Woodcutting'));
    this.woodcutting.actions.register(new Action('test:Oak', 'Oak Tree', 1, 15, logs));
    this.woodcutting.actions.register(new Action('test:Yew', 'Yew Tree', 60, 175, logs));

    this.smithing = this.skills.register(new ArtisanSkill(this, 'test:Smithing', 'Smithing'));
    this.smithing.actions.register(
      new Action('test:Bronze_Bar', 'Bronze Bar', 1, 5, bar, [{ item: ore, quantity: 1 }]),
    );

    this.thieving = this.skills.register(new Thieving(this, 'test:Thieving', 'Thieving'));
    const npc = this.thieving.actions.register(new Action('test:Man', 'Man', 1, 5, logs));
    this.thieving.areas.register({ id: 'test:Low', localID: 'Low', npcs: [npc] });

    // Farming: allotments (XP on planting, x2 harvest) and trees. Plot 3 is locked behind 500 GP.
    this.farming = this.skills.register(new Farming(this, 'test:Farming', 'Farming'));
    const allotment = this.farming.categories.register(
      new FarmingCategory('test:Allotment', 'Allotments', true, 2, true),
    );
    const treeKind = this.farming.categories.register(new FarmingCategory('test:Tree', 'Trees', false, 1, false));
    const potatoSeed = item('test:Potato_Seed', 'Potato Seeds');
    const oakSeed = item('test:Oak_Seed', 'Oak Tree Seeds');
    const potato = item('test:Potato', 'Potato');
    this.items.register(new CompostItem('test:Compost', 'Compost', 20, 0));
    this.items.register(new CompostItem('test:Weird_Gloop', 'Weird Gloop', 50, 10));
    this.farming.actions.register(
      new Crop('test:Potatoes', 'Potatoes', 1, 8, potato, allotment, 20_000, { item: potatoSeed, quantity: 3 }),
    );
    this.farming.actions.register(
      new Crop('test:Oak_Tree', 'Oak Tree', 1, 50, logs, treeKind, 40_000, { item: oakSeed, quantity: 1 }),
    );
    this.farming.actions.register(
      new Crop('test:Carrots', 'Carrots', 30, 20, potato, allotment, 20_000, { item: potatoSeed, quantity: 1 }),
    );
    this.farming.plots.register(new FarmingPlot('test:AllotmentPlot1', allotment, 1));
    this.farming.plots.register(new FarmingPlot('test:AllotmentPlot2', allotment, 1));
    this.farming.plots.register(
      new FarmingPlot('test:AllotmentPlot3', allotment, 1, [{ currency: this.gp, quantity: 500 }]),
    );
    this.farming.plots.register(new FarmingPlot('test:TreePlot1', treeKind, 1));

    const monster = this.monsters.register({ id: 'test:Chicken', localID: 'Chicken', name: 'Chicken' });
    const area = this.combatAreas.register({ id: 'test:Farm', localID: 'Farm', name: 'Farm', monsters: [monster] });
    (this as any).monsterArea = area;
    this.combat = new Combat(this);
  }

  getMonsterArea(_m: any) {
    return (this as any).monsterArea;
  }

  idleChecker(action: any) {
    if (this.activeAction === undefined) return false;
    if (this.activeAction !== action) return !this.activeAction.stop();
    return false;
  }
  clearActiveAction() {
    this.activeAction = undefined;
  }
  /** Test counter: how many times something asked the game to save (game.js saves on the next tick). */
  saveRequests = 0;
  scheduleSave() {
    this.saveRequests++;
  }
  checkRequirements(reqs: { met?: boolean }[] = []) {
    return reqs.every((r) => r.met !== false);
  }

  tick() {
    for (const s of this.skills.allObjects) s.tick();
    this.combat.tick();
  }
}

/** Melvor's `exp` table, simplified: level L starts at (L - 1) * 100 XP (matches addXP above). */
export const fakeExp = {
  levelToXP: (level: number) => (level - 1) * 100,
  xpToLevel: (xp: number) => 1 + Math.floor(xp / 100),
};

export const fakeClasses = { GatheringSkill, CraftingSkill, ArtisanSkill, exp: fakeExp };
