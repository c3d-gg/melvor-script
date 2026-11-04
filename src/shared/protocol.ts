/**
 * Wire protocol shared by the in-game runtime (server) and the Node client.
 *
 * Transport: WebSocket on 127.0.0.1, JSON text frames.
 *   client -> server  { id, method, params }            request
 *   server -> client  { id, result } | { id, error }    response
 *   server -> client  { method, params }                notification (no id)
 */

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 7337;

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcErrorShape {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: RpcErrorShape;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export type ErrorCode =
  /** A bad parameter (wrong type, ambiguous id, negative count...). */
  | 'BAD_REQUEST'
  /** The mod doesn't know this call: the client is newer than the mod. */
  | 'UNKNOWN_METHOD'
  /** No item, action, monster... with that id. */
  | 'NOT_FOUND'
  /** Not unlocked yet: level, requirements, realm, or a buy limit. */
  | 'LOCKED'
  /** Not enough materials. `error.missing` lists what's short. */
  | 'MISSING_ITEMS'
  /** Another action is still running. */
  | 'BUSY'
  /** Can't be done here (a skill without mastery, a mode that doesn't allow it...). */
  | 'UNSUPPORTED'
  /** The game refused, or a job ended early (`ActionStoppedError` / `FightStoppedError`). */
  | 'FAILED'
  /** The game isn't in the right state yet, e.g. `attack()` with no fight going. */
  | 'NOT_READY'
  /** Instant mode: the shared action cooldown hasn't finished. `data.readyInMs` says how long is left. */
  | 'COOLDOWN'
  /** Too many calls per second (a loop with no pacing). */
  | 'RATE_LIMITED'
  /** Turned off by the player's settings (e.g. eval without "Allow eval"). */
  | 'FORBIDDEN'
  /** Something threw unexpectedly inside the game or the mod. The message says what. */
  | 'INTERNAL';

// ---------------------------------------------------------------------------
// Game state snapshot (pushed to clients, read synchronously in scripts)
// ---------------------------------------------------------------------------

export interface SkillState {
  name: string;
  level: number;
  xp: number;
  /** XP needed to reach the next level (0 at cap). */
  xpToNext: number;
  levelCap: number;
  unlocked: boolean;
  abyssalLevel?: number;
  abyssalXP?: number;
  /** Mastery pool per realm id ('melvorD:Melvor', 'melvorItA:Abyssal'). Only on skills with mastery. */
  masteryPools?: Record<string, MasteryPoolState>;
}

export interface MasteryPoolState {
  /** XP in the pool. */
  xp: number;
  /** The most it can hold (with your pool-cap bonuses). */
  cap: number;
  /** Progress as the game shows it (0-100). Pool checkpoints give bonuses at 10, 25, 50 and 95. */
  percent: number;
}

export interface MasteryInfo {
  /** Mastery level, 1 to 99. */
  level: number;
  xp: number;
  /** Mastery XP still needed for the next level (0 at 99). */
  xpToNext: number;
}

export interface FoodSlotState {
  item: string | null;
  quantity: number;
}

export interface EquippedState {
  item: string;
  quantity: number;
}

export interface PlayerState {
  hp: number;
  maxHp: number;
  prayerPoints: number;
  combatLevel: number;
  attackType: string;
  autoEatThreshold: number;
  food: { selected: number; slots: FoodSlotState[] };
  equipmentSet: number;
  /** slot id -> equipped item. Empty slots are omitted. */
  equipment: Record<string, EquippedState>;
  activePrayers: string[];
}

export interface JobInfo {
  jobId: number;
  skill: string;
  targets: string[];
  requested: number | null;
  completed: number;
  startedAt: number;
  owner: string;
}

export interface ActionState {
  /** 'skill' when a skill is running, 'combat' when fighting, null when idle. */
  type: 'skill' | 'combat' | 'other' | null;
  /** Id of the active skill (e.g. 'melvorD:Woodcutting') or action. */
  id: string | null;
  /** Interval of the current action in ms, if a skill is running. */
  intervalMs: number | null;
  jobs: JobInfo[];
  /** Instant mode: when the shared cooldown ends (epoch ms, `Date.now()` clock). 0 = no cooldown yet. */
  readyAt: number;
  /** Instant mode: length of the last cooldown in ms. */
  cooldownMs: number;
}

export interface CombatState {
  active: boolean;
  area: string | null;
  monster: string | null;
  enemyHp: number;
  enemyMaxHp: number;
  /** An enemy is alive and can be attacked. */
  fighting: boolean;
  /** Waiting for the next enemy to spawn. */
  spawning: boolean;
  /** Items waiting in the loot container (collect with `combat.loot`). */
  loot: Record<string, number>;
  slayerTask: { monster: string; killsLeft: number } | null;
}

export interface MetaState {
  characterName: string;
  gamemode: string;
  scriptMode: boolean;
  /**
   * Instant actions (the Scripted gamemode): every action happens the moment it's issued,
   * then a cooldown of (its normal time / `speed`) applies to the next one.
   */
  instant: boolean;
  /** Instant mode: how many times faster than idle. Cooldown = normal interval / speed. */
  speed: number;
  gameVersion: string;
  runtimeVersion: string;
}

export interface GameState {
  meta: MetaState;
  skills: Record<string, SkillState>;
  /** itemId -> quantity. Items not in the bank are omitted. */
  bank: Record<string, number>;
  bankSpace: { used: number; max: number };
  /** currencyId -> amount (e.g. 'melvorD:GP'). */
  currencies: Record<string, number>;
  player: PlayerState;
  action: ActionState;
  combat: CombatState;
}

export type StateSection = keyof GameState;

export interface StateNotification {
  /** Monotonic counter, increments on every push. */
  version: number;
  /** Only the sections that changed since the last push. */
  sections: Partial<GameState>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ActParams {
  /** Skill id, e.g. 'melvorD:Woodcutting' (local id 'Woodcutting' also accepted). */
  skill: string;
  /** Action ids: tree / fish / rock / npc / recipe / spell ... Empty for agility. */
  targets: string[];
  /** Number of actions (instant mode: clicks) to perform. null = keep going until stopped or cancelled. */
  count: number | null;
  /** Extra per-skill options (e.g. alt magic `item`). */
  options?: Record<string, unknown>;
}

export type JobStatus = 'completed' | 'stopped' | 'cancelled';

export interface ActionResult {
  /** The job's id (as in the jobStarted / jobFinished events). */
  jobId: number;
  /** Skill id. */
  skill: string;
  /** Actions asked for (null = until stopped). */
  requested: number | null;
  /** Actions done (instant mode: clicks). */
  completed: number;
  /** Instant mode: actions the clicks performed. More than `completed` with "actions per click" bonuses. */
  actions?: number;
  /** 'completed', or 'stopped' / 'cancelled' if it ended early. */
  status: JobStatus;
  /** Why the job ended early (status !== 'completed'). */
  reason?: string;
  /** How long the job took. */
  durationMs: number;
  /** skillId -> xp gained during the job. */
  xp: Record<string, number>;
  /** itemId -> net bank change during the job (negative = consumed). */
  items: Record<string, number>;
  /** currencyId -> net change. */
  currencies: Record<string, number>;
  /** Instant mode: ms until the cooldown ends, measured when the reply was sent. */
  readyInMs?: number;
}

/** One combat click (instant mode): you act, then the enemy acts. */
export interface AttackResult {
  /** Attacks you made (more than 1 with "actions per click" bonuses). */
  actions: number;
  /** Enemies that died from this click. */
  kills: number;
  /** The enemy's hitpoints after the click. */
  enemyHp: number;
  /** Your hitpoints after the click. */
  hp: number;
  /** skillId -> xp gained. */
  xp: Record<string, number>;
  /** itemId -> items gained. */
  items: Record<string, number>;
  /** ms until you can act again. */
  readyInMs: number;
}

export interface CanDoResult {
  ok: boolean;
  reason?: string;
  missing?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

export interface ItemInfo {
  id: string;
  name: string;
  type: string;
  category: string;
  sellsFor: { currency: string; quantity: number };
  healsFor?: number;
  validSlots?: string[];
}

export interface QuantityInfo {
  id: string;
  quantity: number;
}

export interface ActionInfo {
  id: string;
  name: string;
  level: number;
  abyssalLevel: number;
  unlocked: boolean;
  baseExperience: number | null;
  baseIntervalMs: number | null;
  category: string | null;
  realm: string | null;
  costs: QuantityInfo[];
  products: QuantityInfo[];
  /** Extra skill-specific grouping (fishing area, thieving area). */
  group: string | null;
}

export interface MonsterInfo {
  id: string;
  name: string;
  combatLevel: number;
  hitpoints: number;
  areas: string[];
}

export interface AreaInfo {
  id: string;
  name: string;
  kind: 'combat' | 'slayer' | 'dungeon' | 'stronghold' | 'depth' | 'other';
  monsters: string[];
  unlocked: boolean;
}

export interface ShopPurchaseInfo {
  id: string;
  name: string;
  category: string;
  costs: { currencies: QuantityInfo[]; items: QuantityInfo[] };
  owned: number;
  buyLimit: number;
  unlocked: boolean;
}

export interface CombatStatusResult {
  active: boolean;
  area: string | null;
  monster: string | null;
}

export interface FightResult {
  kills: number;
  status: 'completed' | 'stopped' | 'cancelled';
  reason?: string;
  durationMs: number;
  items: Record<string, number>;
  xp: Record<string, number>;
  /** Instant mode: attack clicks made. */
  attacks?: number;
  /** Instant mode: ms until the cooldown ends, measured when the reply was sent. */
  readyInMs?: number;
}

export interface HelloResult {
  protocol: number;
  runtimeVersion: string;
  runtimeSource: string;
  clientId: number;
  state: GameState;
  stateVersion: number;
}

export interface RuntimeInfo {
  protocol: number;
  runtimeVersion: string;
  runtimeSource: string;
  scriptMode: boolean;
  instant: boolean;
  speed: number;
  clients: { id: number; name: string }[];
}

// ---------------------------------------------------------------------------
// Events (server -> client notification 'event')
// ---------------------------------------------------------------------------

export type GameEventMessage =
  | { type: 'levelUp'; skill: string; oldLevel: number; newLevel: number }
  | { type: 'masteryLevelUp'; skill: string; action: string; oldLevel: number; newLevel: number }
  | { type: 'monsterKilled'; monster: string }
  | { type: 'dungeonCompleted'; dungeon: string }
  | { type: 'jobStarted'; job: JobInfo }
  | { type: 'jobFinished'; result: ActionResult }
  | { type: 'scriptMode'; enabled: boolean }
  | { type: 'stopAll'; reason: string }
  | { type: 'log'; level: LogLevel; message: string; source: string };

export type GameEventType = GameEventMessage['type'];
export type LogLevel = 'info' | 'warn' | 'error' | 'success';

// ---------------------------------------------------------------------------
// Method map: method name -> [params, result]
// ---------------------------------------------------------------------------

export interface Methods {
  hello: [{ client: string; protocol: number }, HelloResult];

  'runtime.info': [void, RuntimeInfo];
  'runtime.reload': [void, { reloading: true }];
  'runtime.setScriptMode': [{ enabled: boolean }, { enabled: boolean }];
  'runtime.stopAll': [{ reason?: string }, { cancelledJobs: number }];

  'state.get': [void, GameState];

  'action.act': [ActParams, ActionResult];
  'action.cancel': [{ jobId?: number }, { cancelled: number }];
  'action.stop': [void, { stopped: boolean }];
  'action.canDo': [{ skill: string; targets: string[]; options?: Record<string, unknown> }, CanDoResult];

  /** quantity null = sell all. */
  'bank.sell': [{ item: string; quantity: number | null }, { sold: number; currency: string; gained: number }];
  'bank.open': [{ item: string; quantity: number }, { opened: number; items: Record<string, number> }];
  'bank.bury': [{ item: string; quantity: number }, { buried: number }];

  'shop.list': [void, ShopPurchaseInfo[]];
  'shop.buy': [{ purchase: string; quantity: number }, { bought: number; items: Record<string, number> }];

  'combat.fight': [{ monster: string; area?: string; kills?: number | null }, FightResult];
  'combat.dungeon': [{ dungeon: string; runs?: number | null }, FightResult];
  /** Instant mode only: one attack click. */
  'combat.attack': [void, AttackResult];
  /** Collect everything in the loot container. */
  'combat.loot': [void, { items: Record<string, number> }];
  'combat.stop': [void, { stopped: boolean }];
  'combat.status': [void, CombatStatusResult];

  'player.eat': [{ quantity?: number }, { hp: number }];
  'player.equipFood': [{ item: string; quantity: number }, { equipped: boolean }];
  'player.selectFood': [{ slot: number }, { selected: number }];
  'player.equip': [{ item: string; slot?: string; quantity?: number; set?: number }, { equipped: boolean }];
  'player.unequip': [{ slot: string; set?: number }, { unequipped: boolean }];
  'player.setEquipmentSet': [{ set: number }, { set: number }];
  'player.togglePrayer': [{ prayer: string }, { active: boolean }];
  'player.setAttackStyle': [{ style: string }, { style: string }];

  /** Mastery of the given actions (default: all of the skill's actions), keyed by action id. */
  'mastery.get': [{ skill: string; actions?: string[] }, Record<string, MasteryInfo>];
  /** Spend mastery pool XP on an action, like the game's "Spend Mastery XP" menu. */
  'mastery.spendPool': [
    { skill: string; action: string; levels?: number; allowCheckpointLoss?: boolean },
    MasteryInfo & { spent: number },
  ];

  'data.item': [{ id: string }, ItemInfo];
  'data.items': [{ ids?: string[]; type?: string; category?: string }, ItemInfo[]];
  'data.actions': [{ skill: string }, ActionInfo[]];
  'data.monsters': [void, MonsterInfo[]];
  'data.areas': [void, AreaInfo[]];
  'data.registries': [void, Record<string, { id: string; name?: string }[]>];

  'debug.eval': [{ code: string; depth?: number }, unknown];

  'ui.log': [{ level?: LogLevel; message: string }, void];
}

export type MethodName = keyof Methods;
export type ParamsOf<M extends MethodName> = Methods[M][0];
export type ResultOf<M extends MethodName> = Methods[M][1];
