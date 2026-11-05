/**
 * Builds the GameState snapshot that is mirrored into every client, so scripts
 * can read state synchronously (`m.bank.count(id)`, `m.skills.mining.level`).
 * Each section is diffed as a JSON string and only changed sections are pushed.
 */
import type { ActionState, CombatState, GameState, PlayerState, SkillState, StateSection } from '../shared/protocol.ts';
import { safe, type GameObject, type RuntimeEnv } from './env.ts';
import { allObjects, idOf } from './lookup.ts';
import { masteryPools } from './mastery.ts';
import { version } from '../../package.json';

/** The package version: `bun run release` bumps it in package.json, the only place it lives. */
export const RUNTIME_VERSION: string = version;

export interface StateContext {
  env: RuntimeEnv;
  scriptMode(): boolean;
  jobs(): ActionState['jobs'];
  /** Instant mode details (speed 1 / readyAt 0 in real-time mode). */
  clicks(): { instant: boolean; speed: number; readyAt: number; cooldownMs: number };
  /** Instant mode: crops grow in their normal time / this (1 in real-time mode). */
  farmingSpeed?(): number;
}

export function buildState(sc: StateContext): GameState {
  const game = sc.env.game;
  const clicks = sc.clicks();
  return {
    meta: {
      characterName: safe(() => game.characterName, ''),
      gamemode: safe(() => game.currentGamemode.id, ''),
      scriptMode: sc.scriptMode(),
      instant: clicks.instant,
      speed: clicks.speed,
      farmingSpeed: sc.farmingSpeed?.() ?? 1,
      gameVersion: sc.env.gameVersion ?? safe(() => String(game.lastLoadedGameVersion), ''),
      runtimeVersion: RUNTIME_VERSION,
    },
    skills: buildSkills(sc.env),
    bank: buildBank(game),
    bankSpace: {
      used: safe(() => game.bank.occupiedSlots, 0),
      max: safe(() => game.bank.maximumSlots, 0),
    },
    currencies: buildCurrencies(game),
    player: buildPlayer(game),
    action: { ...buildAction(sc), readyAt: clicks.readyAt, cooldownMs: clicks.cooldownMs },
    combat: buildCombat(game),
  };
}

function buildSkills(env: RuntimeEnv): Record<string, SkillState> {
  const exp = env.classes.exp;
  const out: Record<string, SkillState> = {};
  for (const s of allObjects(env.game.skills)) {
    const level = safe(() => s.level as number, 1);
    const xp = safe(() => s.xp as number, 0);
    const cap = safe(() => s.currentLevelCap as number, 99);
    const st: SkillState = {
      name: safe(() => s.name, s.localID),
      level,
      xp,
      xpToNext: level < cap ? safe(() => Math.max(0, Math.ceil(exp.levelToXP(level + 1) - xp)), 0) : 0,
      levelCap: cap,
      unlocked: safe(() => s.isUnlocked as boolean, true),
    };
    if (safe(() => s.hasAbyssalLevels as boolean, false)) {
      st.abyssalLevel = safe(() => s.abyssalLevel, 0);
      st.abyssalXP = safe(() => s.abyssalXP, 0);
    }
    const pools = masteryPools(s);
    if (pools) st.masteryPools = pools;
    out[s.id] = st;
  }
  return out;
}

function buildBank(game: GameObject): Record<string, number> {
  const out: Record<string, number> = {};
  const items: Map<GameObject, GameObject> | undefined = safe(() => game.bank.items, undefined);
  if (items && typeof items.forEach === 'function') {
    items.forEach((bankItem, item) => {
      if (bankItem.quantity > 0) out[item.id] = bankItem.quantity;
    });
  }
  return out;
}

function buildCurrencies(game: GameObject): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of allObjects(game.currencies)) out[c.id] = safe(() => c.amount, 0);
  return out;
}

function buildPlayer(game: GameObject): PlayerState {
  const p = safe(() => game.combat.player, undefined as GameObject);
  const empty = safe(() => game.emptyFoodItem, undefined as GameObject);
  const equipment: PlayerState['equipment'] = {};
  const equipped = safe(() => p.equipment.equippedItems as Record<string, GameObject>, {});
  for (const [slotId, slot] of Object.entries(equipped)) {
    const item = safe(() => slot.item, undefined as GameObject);
    // Skip empty slots and slots merely occupied by a 2-handed item equipped elsewhere.
    if (
      !item ||
      item === game.emptyEquipmentItem ||
      safe(() => slot.isEmpty, false) ||
      safe(() => slot.occupiedBy !== undefined, false)
    )
      continue;
    equipment[slotId] = { item: item.id, quantity: safe(() => slot.quantity, 1) };
  }
  return {
    hp: safe(() => p.hitpoints, 0),
    maxHp: safe(() => p.stats.maxHitpoints, 0),
    prayerPoints: safe(() => p.prayerPoints, 0),
    combatLevel: safe(() => game.playerCombatLevel, 0),
    attackType: safe(() => p.attackType, 'melee'),
    autoEatThreshold: safe(() => p.autoEatThreshold, 0),
    food: {
      selected: safe(() => p.food.selectedSlot, 0),
      slots: safe(
        () =>
          (p.food.slots as GameObject[]).map((s) => ({
            item: s.item === empty ? null : idOf(s.item),
            quantity: s.item === empty ? 0 : s.quantity,
          })),
        [],
      ),
    },
    equipmentSet: safe(() => p.selectedEquipmentSet, 0),
    equipment,
    activePrayers: safe(() => [...(p.activePrayers as Set<GameObject>)].map((x) => x.id), []),
  };
}

function buildAction(sc: StateContext): Omit<ActionState, 'readyAt' | 'cooldownMs'> {
  const game = sc.env.game;
  const active = safe(() => game.activeAction, undefined as GameObject);
  let type: ActionState['type'] = null;
  let intervalMs: number | null = null;
  if (active) {
    if (active === game.combat) type = 'combat';
    else if (typeof active.actionTimer === 'object') {
      type = 'skill';
      intervalMs = safe(() => active.currentActionInterval as number, null as unknown as number);
    } else type = 'other';
  }
  return { type, id: active ? safe(() => active.id ?? null, null) : null, intervalMs, jobs: sc.jobs() };
}

function buildCombat(game: GameObject): CombatState {
  const c = safe(() => game.combat, undefined as GameObject);
  const task = safe(() => c.slayerTask, undefined as GameObject);
  const taskMonster = safe(() => task.monster, undefined as GameObject);
  const active = safe(() => !!c.isActive || game.activeAction === c, false);
  const enemyState = safe(() => c.enemy.state as number | undefined, undefined);
  const fighting =
    active && safe(() => !!c.fightInProgress, false) && (enemyState === undefined || enemyState === ENEMY_ALIVE);
  const loot: Record<string, number> = {};
  for (const drop of safe(() => c.loot.drops as GameObject[], [])) {
    const id = safe(() => drop.item.id as string, '');
    if (id) loot[id] = (loot[id] ?? 0) + safe(() => drop.quantity as number, 0);
  }
  return {
    active,
    area: safe(() => idOf(c.selectedArea), null),
    monster: safe(() => idOf(c.enemy.monster), null),
    enemyHp: safe(() => c.enemy.hitpoints, 0),
    enemyMaxHp: safe(() => c.enemy.stats.maxHitpoints, 0),
    fighting,
    spawning: active && !fighting && safe(() => !!c.spawnTimer?.isActive || enemyState === ENEMY_SPAWNING, false),
    loot,
    slayerTask: taskMonster ? { monster: taskMonster.id, killsLeft: safe(() => task.killsLeft, 0) } : null,
  };
}

/** Melvor's EnemyState enum. */
const ENEMY_ALIVE = 1;
const ENEMY_SPAWNING = 2;

/** Tracks the last pushed JSON per section and yields only what changed. */
export class StateDiffer {
  private last = new Map<StateSection, string>();
  version = 0;

  diff(state: GameState): Partial<GameState> | null {
    const changed: Partial<GameState> = {};
    let any = false;
    for (const key of Object.keys(state) as StateSection[]) {
      const json = JSON.stringify(state[key]);
      if (this.last.get(key) !== json) {
        this.last.set(key, json);
        (changed as Record<string, unknown>)[key] = state[key];
        any = true;
      }
    }
    if (!any) return null;
    this.version++;
    return changed;
  }

  /** Mark everything as sent (used when a full snapshot goes out in `hello`). */
  prime(state: GameState) {
    for (const key of Object.keys(state) as StateSection[]) this.last.set(key, JSON.stringify(state[key]));
    this.version++;
  }
}
