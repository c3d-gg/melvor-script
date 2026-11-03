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

export class Action extends Obj {
  realm = 'melvorD:Melvor';
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
  isTreeUnlocked(t: Action) {
    return this.level >= t.level;
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
  checkRequirements() {
    return true;
  }

  tick() {
    for (const s of this.skills.allObjects) s.tick();
    this.combat.tick();
  }
}

export const fakeClasses = { GatheringSkill, CraftingSkill, ArtisanSkill };
