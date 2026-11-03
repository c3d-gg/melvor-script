import type { FightResult, JobInfo } from '../../shared/protocol.ts';
import { RpcError, isInstance, safe, type GameObject, type RuntimeEnv } from '../env.ts';
import { allObjects, idOf, resolveIn } from '../lookup.ts';
import type { ClientSession } from '../rpc-server.ts';
import type { ApiContext } from './context.ts';

interface FightJob {
  id: number;
  target: number | null;
  kills: number;
  startedAt: number;
  ownerId: number | null;
  items: Record<string, number>;
  xpBefore: Map<GameObject, number>;
  resolve(r: FightResult): void;
  done: boolean;
  stopScheduled: boolean;
}

/**
 * Combat keeps running on its own (like normal Melvor), but scripts can ask
 * for "N kills, then stop" and get a summary of loot and xp back.
 */
export class CombatController {
  private job: FightJob | null = null;
  private restorers: (() => void)[] = [];
  private stopping = false;
  private deferred: ReturnType<typeof setTimeout> | null = null;
  private nextJobId = 1;
  private jobOwner = '';

  constructor(private env: RuntimeEnv) {}

  private get game() {
    return this.env.game;
  }

  install() {
    const combat = this.game.combat;
    if (!combat) return;
    const onKill = () => {
      const job = this.job;
      if (!job) return;
      job.kills++;
      if (job.target !== null && job.kills >= job.target && !job.stopScheduled) {
        // 'monsterKilled' fires inside CombatManager.onEnemyDeath(), before the game decides what
        // happens next. Stopping right here would cut that flow in half, so stop after this tick.
        // stop() also collects the loot container, which still counts towards this job.
        job.stopScheduled = true;
        this.deferred = setTimeout(() => {
          this.deferred = null;
          if (this.job !== job) return;
          this.stopCombat();
          this.finish('completed');
        }, 0);
      }
    };
    combat.on?.('monsterKilled', onKill);
    this.restorers.push(() => combat.off?.('monsterKilled', onKill));

    const onItem = (e: GameObject) => {
      if (this.job && e?.item) {
        const d = (e.newQuantity ?? 0) - (e.oldQuantity ?? 0);
        this.job.items[e.item.id] = (this.job.items[e.item.id] ?? 0) + d;
      }
    };
    this.game.bank?.on?.('itemChanged', onItem);
    this.restorers.push(() => this.game.bank?.off?.('itemChanged', onItem));

    // Notice when combat stops for any other reason (death, player clicked Run, area change).
    const hadOwn = Object.prototype.hasOwnProperty.call(combat, 'stop');
    const prevOwn = hadOwn ? combat.stop : undefined;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ctl = this;
    combat.stop = function (this: GameObject, ...args: unknown[]) {
      const impl = hadOwn ? prevOwn : Object.getPrototypeOf(combat).stop;
      const ok = impl.apply(this, args);
      if (ok && ctl.job && !ctl.stopping) ctl.finish('stopped', 'combat ended (fled, died, or another action started)');
      return ok;
    };
    this.restorers.push(() => {
      if (hadOwn) combat.stop = prevOwn;
      else delete combat.stop;
    });
  }

  dispose() {
    if (this.deferred) clearTimeout(this.deferred);
    this.deferred = null;
    this.finish('cancelled', 'scripting runtime unloaded');
    for (const r of this.restorers.splice(0).reverse()) r();
  }

  get active(): boolean {
    return safe(() => !!this.game.combat.isActive || this.game.activeAction === this.game.combat, false);
  }

  status() {
    const c = this.game.combat;
    return {
      active: this.active,
      area: safe(() => idOf(c.selectedArea), null),
      monster: safe(() => idOf(c.enemy.monster), null),
    };
  }

  fight(
    params: { monster: string; area?: string; kills?: number | null },
    session: ClientSession | null,
  ): Promise<FightResult> | FightResult {
    this.finish('cancelled', 'superseded by a new fight');
    this.selectMonster(params, false);
    return this.startJob(params.kills ?? null, session);
  }

  dungeon(
    params: { dungeon: string; runs?: number | null },
    session: ClientSession | null,
  ): Promise<FightResult> | FightResult {
    this.finish('cancelled', 'superseded by a new fight');
    const perRun = this.selectDungeon(params);
    const runs = params.runs ?? null;
    return this.startJob(runs === null ? null : runs * perRun, session);
  }

  /**
   * Start fighting a monster (the game spawns it after the usual delay).
   * With `keepIfSame`, an ongoing fight against the same monster in the same area is left alone.
   */
  selectMonster(params: { monster: string; area?: string }, keepIfSame: boolean) {
    const game = this.game;
    const monster = resolveIn(game.monsters, params.monster, 'monster');
    const area =
      params.area !== undefined
        ? resolveIn(game.combatAreas, params.area, 'combat area')
        : safe(() => game.getMonsterArea(monster), undefined);
    if (!area || area === game.unknownCombatArea)
      throw new RpcError('NOT_FOUND', `No combat area contains ${monster.name}; pass { area } explicitly`);
    if (isInstance(this.env, area, 'Dungeon'))
      throw new RpcError('BAD_REQUEST', `${area.name} is a dungeon: use combat.dungeon()`);
    if (Array.isArray(area.monsters) && !area.monsters.includes(monster))
      throw new RpcError('BAD_REQUEST', `${monster.name} is not in ${area.name}`);
    if (keepIfSame && this.active && game.combat.selectedMonster === monster && game.combat.selectedArea === area)
      return;
    game.combat.selectMonster(monster, area);
    if (!this.active || game.combat.selectedMonster !== monster) {
      throw new RpcError(
        'FAILED',
        `Couldn't start fighting ${monster.name} in ${area.name} (requirements, damage type or tutorial). Check the game for a message.`,
      );
    }
  }

  /** Enter a dungeon. Returns how many monsters one run has. */
  selectDungeon(params: { dungeon: string }): number {
    const game = this.game;
    const dungeon = this.resolveDungeon(params);
    game.combat.selectDungeon(dungeon);
    if (!this.active || game.combat.selectedArea !== dungeon) {
      throw new RpcError(
        'FAILED',
        `Couldn't enter ${dungeon.name} (requirements or damage type). Check the game for a message.`,
      );
    }
    return this.dungeonSize(params);
  }

  /** How many monsters one run of a dungeon has. */
  dungeonSize(params: { dungeon: string }): number {
    const dungeon = this.resolveDungeon(params);
    return safe(() => (dungeon.monsters as GameObject[]).length, 1);
  }

  private resolveDungeon(params: { dungeon: string }): GameObject {
    const dungeon = resolveIn(this.game.combatAreas, params.dungeon, 'dungeon');
    if (!isInstance(this.env, dungeon, 'Dungeon'))
      throw new RpcError('BAD_REQUEST', `${dungeon.name} is not a dungeon`);
    return dungeon;
  }

  /** Move everything from the loot container to the bank. Returns what arrived. */
  loot(): Record<string, number> {
    const loot = safe(() => this.game.combat.loot, undefined as GameObject);
    if (!loot || typeof loot.lootAll !== 'function') return {};
    const items: Record<string, number> = {};
    const onItem = (e: GameObject) => {
      if (e?.item) items[e.item.id] = (items[e.item.id] ?? 0) + (e.newQuantity ?? 0) - (e.oldQuantity ?? 0);
    };
    this.game.bank?.on?.('itemChanged', onItem);
    try {
      loot.lootAll();
    } finally {
      this.game.bank?.off?.('itemChanged', onItem);
    }
    for (const k of Object.keys(items)) if (items[k] === 0) delete items[k];
    return items;
  }

  stop(): boolean {
    this.finish('cancelled', 'stopped by script');
    return this.stopCombat();
  }

  cancelOwnedBy(sessionId: number) {
    if (this.job && this.job.ownerId === sessionId) {
      this.finish('cancelled', 'client disconnected');
      this.stopCombat();
    }
  }

  private startJob(target: number | null, session: ClientSession | null): Promise<FightResult> | FightResult {
    const startedAt = Date.now();
    if (target === null) return { kills: 0, status: 'completed', durationMs: 0, items: {}, xp: {} };
    const xpBefore = new Map<GameObject, number>();
    for (const s of allObjects(this.game.skills)) xpBefore.set(s, s.xp ?? 0);
    this.jobOwner = session?.name ?? 'game';
    return new Promise<FightResult>((resolve) => {
      this.job = {
        id: this.nextJobId++,
        target,
        kills: 0,
        startedAt,
        ownerId: session?.id ?? null,
        items: {},
        xpBefore,
        resolve,
        done: false,
        stopScheduled: false,
      };
    });
  }

  /** A real-time "N kills" fight shows up as a job, so `m.ready` is false while it runs. */
  listJobs(): JobInfo[] {
    const job = this.job;
    if (!job || job.done) return [];
    return [
      {
        jobId: -job.id,
        skill: 'combat',
        targets: safe(() => [this.game.combat.selectedMonster.id as string], []),
        requested: job.target,
        completed: job.kills,
        startedAt: job.startedAt,
        owner: this.jobOwner,
      },
    ];
  }

  private finish(status: FightResult['status'], reason?: string) {
    const job = this.job;
    if (!job || job.done) return;
    job.done = true;
    this.job = null;
    const xp: Record<string, number> = {};
    for (const [s, before] of job.xpBefore) {
      const d = (s.xp ?? 0) - before;
      if (d !== 0) xp[s.id] = d;
    }
    const items: Record<string, number> = {};
    for (const [k, v] of Object.entries(job.items)) if (v !== 0) items[k] = v;
    const result: FightResult = { kills: job.kills, status, durationMs: Date.now() - job.startedAt, items, xp };
    if (reason && status !== 'completed') result.reason = reason;
    job.resolve(result);
  }

  private stopCombat(): boolean {
    if (!this.active) return false;
    this.stopping = true;
    try {
      return this.game.combat.stop() !== false;
    } finally {
      this.stopping = false;
    }
  }
}

export function registerCombat(api: ApiContext) {
  const { rpc, combat, clicks } = api;
  // In instant mode combat only advances when you click, so fights become batches of attack clicks.
  rpc.register('combat.fight', (p, s) => (clicks.enabled ? clicks.fight(p, owner(s)) : combat.fight(p, s)));
  rpc.register('combat.dungeon', (p, s) => (clicks.enabled ? clicks.dungeon(p, owner(s)) : combat.dungeon(p, s)));
  rpc.register('combat.attack', (_p, s) => {
    if (!clicks.enabled)
      throw new RpcError(
        'UNSUPPORTED',
        'attack() is for instant mode (the Scripted gamemode). Here combat attacks on its own: use fight().',
      );
    return clicks.attack(owner(s));
  });
  rpc.register('combat.loot', () => ({ items: combat.loot() }));
  rpc.register('combat.stop', () => {
    clicks.cancelCombat('stopped by script');
    return { stopped: combat.stop() };
  });
  rpc.register('combat.status', () => combat.status());
}

function owner(s: ClientSession) {
  return { id: s.id, name: s.name };
}
