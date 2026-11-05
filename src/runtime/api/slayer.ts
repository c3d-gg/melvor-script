/**
 * Slayer tasks: pick a tier, extend, and fight the task's monster until it's done.
 * Like the game's task menu, none of this uses the action cooldown (fighting does, as usual).
 */
import type { QuantityInfo, SlayerCategoryInfo, SlayerTaskState } from '../../shared/protocol.ts';
import { RpcError, safe, type GameObject } from '../env.ts';
import { allObjects, idOf, resolveIn } from '../lookup.ts';
import type { ClientSession } from '../rpc-server.ts';
import { missingItems } from '../skills.ts';
import { slayerTaskState } from '../state.ts';
import type { FightUntil } from './combat.ts';
import type { ApiContext } from './context.ts';

/** The game takes a second to "locate" a task; allow for a slow or busy game on top. */
const LOCATE_TIMEOUT_MS = 10_000;
const POLL_MS = 20;

export function registerSlayer(api: ApiContext) {
  const { rpc, env, combat, clicks } = api;

  const slayerTask = (): GameObject => {
    const t = safe(() => env.game.combat.slayerTask, undefined as GameObject);
    if (!t) throw new RpcError('UNSUPPORTED', 'This game has no slayer tasks');
    return t;
  };
  const locating = (t: GameObject) => safe(() => !!t.taskTimer.isActive, false);

  function currencyCosts(costs: GameObject): QuantityInfo[] {
    return safe(
      () =>
        (costs.getCurrencyQuantityArray() as { currency: GameObject; quantity: number }[]).map((c) => ({
          id: c.currency.id,
          quantity: c.quantity,
        })),
      [],
    );
  }

  function categoryInfo(t: GameObject, c: GameObject): SlayerCategoryInfo {
    const sel = safe(() => c.monsterSelection, undefined as GameObject);
    return {
      id: c.id,
      name: safe(() => String(c.name), c.localID),
      level: safe(() => c.level as number, 1),
      abyssalLevel: safe(() => c.abyssalLevel as number, 0),
      unlocked: lockReason(c) === null,
      rollCost: currencyCosts(safe(() => t.getRollCosts(c), undefined)),
      extensionCost: currencyCosts(safe(() => t.getExtensionCosts(c), undefined)),
      tasksCompleted: safe(() => c.tasksCompleted as number, 0),
      combatLevels: sel?.type === 'CombatLevel' ? { min: sel.minLevel ?? 1, max: sel.maxLevel ?? null } : null,
    };
  }

  /** Why a tier can't be picked right now, or null. */
  function lockReason(c: GameObject): string | null {
    const g = env.game;
    const slayer = g.slayer;
    if (!safe(() => slayer.isUnlocked !== false, true)) return 'Slayer is locked';
    if (safe(() => c.realm && c.realm.isUnlocked === false, false))
      return `${c.name} tasks are in the ${c.realm.name}, which you haven't unlocked`;
    const level = safe(() => c.level as number, 1);
    if (level > safe(() => slayer.currentLevelCap as number, Infinity))
      return `${c.name} tasks need Slayer level ${level}, above your level cap`;
    if (safe(() => slayer.level as number, 1) < level) return `${c.name} tasks need Slayer level ${level}`;
    const abyssal = safe(() => c.abyssalLevel as number, 0);
    if (abyssal > 0 && safe(() => slayer.abyssalLevel as number, 0) < abyssal)
      return `${c.name} tasks need abyssal Slayer level ${abyssal}`;
    return null;
  }

  /** Resolve once the game has finished picking a task. */
  async function waitForTask(t: GameObject): Promise<SlayerTaskState> {
    const end = Date.now() + LOCATE_TIMEOUT_MS;
    for (;;) {
      const state = locating(t) ? null : slayerTaskState(env.game);
      if (state) return state;
      if (!locating(t)) throw new RpcError('FAILED', 'The game stopped picking a slayer task');
      if (Date.now() > end)
        throw new RpcError('FAILED', `The game didn't pick a slayer task within ${LOCATE_TIMEOUT_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  rpc.register('slayer.categories', (): SlayerCategoryInfo[] => {
    const t = slayerTask();
    return allObjects(t.categories).map((c) => categoryInfo(t, c));
  });

  rpc.register('slayer.newTask', async (p: { category: string; keepCurrent?: boolean }) => {
    const g = env.game;
    const t = slayerTask();
    const category = resolveIn(t.categories, p.category, 'slayer task category');
    if (p.keepCurrent) {
      const current = slayerTaskState(g);
      if (current) return current;
    }
    // After a task is done the game picks the next one in the same tier for free: take that one.
    if (locating(t) && (p.keepCurrent || t.category === category)) return waitForTask(t);

    const locked = lockReason(category);
    if (locked) throw new RpcError('LOCKED', locked);
    const costs = t.getRollCosts(category);
    if (!costs.checkIfOwned())
      throw new RpcError('MISSING_ITEMS', `Can't afford a new ${category.name} task`, {
        missing: missingItems(g, costs),
      });
    if (safe(() => (t.getMonsterSelection(category) as GameObject[]).length, 1) === 0) {
      throw new RpcError(
        'FAILED',
        `No ${category.name} task is available: every monster in that tier is behind requirements you don't meet` +
          (safe(() => !!t.autoSlayer, false) ? ' (with Auto Slayer on, slayer areas need their items equipped)' : ''),
      );
    }
    // (category, pay the cost, don't open the menu, as a click: don't auto-start the fight.)
    t.selectTask(category, true, false, true);
    if (!locating(t))
      throw new RpcError('FAILED', `Couldn't get a ${category.name} task. Check the game for a message.`);
    return waitForTask(t);
  });

  rpc.register('slayer.extend', () => {
    const g = env.game;
    const t = slayerTask();
    if (!slayerTaskState(g)) throw new RpcError('NOT_READY', "You don't have a slayer task");
    if (t.extended) throw new RpcError('FAILED', 'This task has already been extended');
    const costs = t.getExtensionCosts(t.category);
    if (!costs.checkIfOwned())
      throw new RpcError('MISSING_ITEMS', "Can't afford to extend this task", { missing: missingItems(g, costs) });
    t.extendTask();
    if (!t.extended) throw new RpcError('FAILED', "The task wasn't extended. Check the game for a message.");
    return slayerTaskState(g)!;
  });

  rpc.register('slayer.fight', (_p, s: ClientSession) => {
    const g = env.game;
    const t = slayerTask();
    const state = slayerTaskState(g);
    if (!state)
      throw new RpcError('NOT_READY', "You don't have a slayer task. Get one first: m.combat.slayer.newTask(category)");
    const category = t.category;
    const monster = t.monster;
    const before = safe(() => category.tasksCompleted as number, 0);
    const check: FightUntil = () => {
      if (safe(() => category.tasksCompleted > before, false)) return { status: 'completed' };
      if (!t.active || t.monster !== monster) return { status: 'stopped', reason: 'your slayer task changed' };
      return null;
    };
    const until = { check, expected: state.killsLeft };
    const params = { monster: idOf(monster)! };
    return clicks.enabled ? clicks.fight(params, { id: s.id, name: s.name }, until) : combat.fight(params, s, until);
  });
}
