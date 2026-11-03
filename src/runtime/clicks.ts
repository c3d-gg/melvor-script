/**
 * ClickController: "click to play" with a cooldown, for gamemodes with instant actions.
 *
 * Melvor's own instant-action rules (the `enableInstantActions` gamemode flag, which our
 * Scripted gamemode turns on) change how the game plays:
 *   - skill.start() performs the action right away (1 + any "actions per click") and stops;
 *   - combat only moves when you click Attack: you act, then the enemy acts;
 *   - mining rocks respawn in 0.25s.
 * Nothing idles, so by itself that is unlimited speed. We add one shared cooldown: after a
 * click, the next one can't happen until (that action's normal interval / speed) has passed.
 * Speed bonuses still matter (a better axe means a shorter cooldown), and scripts and the
 * player's own mouse clicks go through the same gate.
 *
 * For scripts:
 *   - act(): `count` clicks on a skill target, spaced by the cooldown (count 1 = one click).
 *   - attack(): one combat click. fight() / dungeon(): attack clicks until N kills.
 * The first click of a request happens inside the request, so errors (LOCKED, MISSING_ITEMS,
 * COOLDOWN) come back as call errors. Later clicks of a batch run on timers, and a failure
 * there ends the batch with a reason, like real-time jobs do.
 */
import type { ActParams, ActionResult, AttackResult, FightResult, JobInfo, JobStatus } from '../shared/protocol.ts';
import type { CombatController } from './api/combat.ts';
import { RpcError, isInstance, safe, type GameObject, type RuntimeEnv } from './env.ts';
import { allObjects, resolveSkill } from './lookup.ts';
import { adapterFor, missingItems, type Resolved, type SkillAdapter } from './skills.ts';

export const DEFAULT_SPEED = 10;
/** A request arriving this close to the end of the cooldown waits instead of failing (timer jitter). */
const COOLDOWN_TOLERANCE_MS = 30;
const MIN_COOLDOWN_MS = 50;
/** Longest a click waits for a rock to respawn or an enemy to spawn. */
const MAX_WAIT_MS = 10_000;
const POLL_MS = 20;
/** The game never spawns enemies faster than this. */
const MIN_SPAWN_MS = 250;
const ENEMY_ALIVE = 1;

interface Owner {
  id: number;
  name: string;
}

interface Outcome {
  started: boolean;
  actions: number;
  kills: number;
  /** Thieving: the attempt failed (the stun is added to the cooldown). */
  failed: boolean;
  /** The game couldn't give every reward (bank full). */
  bankFull: boolean;
  xp: Record<string, number>;
  items: Record<string, number>;
  currencies: Record<string, number>;
}

interface JobSpec {
  kind: 'skill' | 'combat';
  skill: GameObject | null;
  adapter: SkillAdapter | null;
  resolved: Resolved | null;
  targetIds: string[];
  /** Stop after this many clicks (null = no limit). */
  maxClicks: number | null;
  /** Stop after this many kills (null = no limit). */
  targetKills: number | null;
  owner: Owner | null;
}

interface Summary {
  status: JobStatus;
  reason?: string;
}

interface ClickJob extends JobSpec {
  id: number;
  clicks: number;
  actions: number;
  kills: number;
  startedAt: number;
  xp: Record<string, number>;
  items: Record<string, number>;
  currencies: Record<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
  resolve(s: Summary): void;
  promise: Promise<Summary>;
}

export interface ClickControllerHooks {
  onJobStarted(job: JobInfo): void;
  onJobFinished(info: { jobId: number; skill: string; status: JobStatus; reason?: string }): void;
  /** The cooldown changed (push state so clients see it). */
  onCooldown(): void;
}

type Fn = (...args: unknown[]) => unknown;

/** Marks "a combat click is running" (skills use the skill object itself). */
const COMBAT_CLICK = Object.freeze({ combat: true });

export class ClickController {
  /** True when the gamemode has instant actions and this controller is installed. */
  enabled = false;
  /** Cooldown = normal interval / speed. */
  speed = DEFAULT_SPEED;
  /** Epoch ms (Date.now) when the next click may happen. */
  readyAt = 0;
  lastCooldownMs = 0;

  private skills: GameObject[] = [];
  private job: ClickJob | null = null;
  private starting = false;
  private inClick: GameObject | null = null;
  private capture: Outcome | null = null;
  private combatSession: { allowed: boolean } | null = null;
  private restorers: (() => void)[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastNotice = 0;
  private nextJobId = 1;

  constructor(
    private env: RuntimeEnv,
    private combat: CombatController,
    private hooks: ClickControllerHooks,
  ) {}

  private get game() {
    return this.env.game;
  }

  /** Does the current gamemode use instant actions? */
  static applies(game: GameObject): boolean {
    return safe(() => game.currentGamemode.enableInstantActions === true, false);
  }

  // ---------------------------------------------------------------------------
  // install / dispose
  // ---------------------------------------------------------------------------

  install() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ctl = this;
    this.enabled = true;
    for (const skill of allObjects(this.game.skills)) {
      if (!isInstance(this.env, skill, 'GatheringSkill')) continue;
      this.skills.push(skill);
      // A started skill was left running by a save from before instant mode: instant mode never idles.
      if (skill.isActive) safe(() => skill.stop(), undefined);
      this.wrap(
        skill,
        'start',
        (impl) =>
          function (this: GameObject, ...args: unknown[]) {
            return ctl.onStart(this, impl, args);
          },
      );
      this.wrap(
        skill,
        'action',
        (impl) =>
          function (this: GameObject, ...args: unknown[]) {
            if (ctl.inClick === this) return impl.apply(this, args);
            // Fired by a leftover timer, outside any click. Nothing repeats on its own here.
            if (this.isActive) this.stop();
            return undefined;
          },
      );
      if (typeof skill.addActionRewards === 'function') {
        this.wrap(
          skill,
          'addActionRewards',
          (impl) =>
            function (this: GameObject, ...args: unknown[]) {
              const ok = impl.apply(this, args);
              if (ok === false && ctl.capture && ctl.inClick === this) ctl.capture.bankFull = true;
              return ok;
            },
        );
      }
      this.listen(skill, 'action', (e) => {
        if (this.inClick !== skill || !this.capture) return;
        this.capture.actions++;
        if (e?.successful === false) this.capture.failed = true;
      });
    }
    this.listen(this.game.bank, 'itemChanged', (e) => {
      const out = this.capture;
      if (out && e?.item) add(out.items, e.item.id, (e.newQuantity ?? 0) - (e.oldQuantity ?? 0));
    });

    const combat = this.game.combat;
    if (combat) {
      this.listen(combat, 'monsterKilled', () => {
        if (this.capture) this.capture.kills++;
      });
      const player = combat.player;
      const enemy = combat.enemy;
      // The Attack button: player.actOnClick() once per action, then enemy.actOnClick().
      if (player && typeof player.actOnClick === 'function') {
        this.wrap(
          player,
          'actOnClick',
          (impl) =>
            function (this: GameObject, ...args: unknown[]) {
              if (ctl.inClick) return impl.apply(this, args);
              if (ctl.humanAttack().allowed) return impl.apply(this, args);
              return undefined;
            },
        );
      }
      if (enemy && typeof enemy.actOnClick === 'function') {
        this.wrap(
          enemy,
          'actOnClick',
          (impl) =>
            function (this: GameObject, ...args: unknown[]) {
              if (!ctl.inClick && ctl.combatSession && !ctl.combatSession.allowed) return undefined;
              return impl.apply(this, args);
            },
        );
      }
      // Enemies respawn `speed` times faster too, so fights aren't mostly waiting.
      if (player && typeof player.getMonsterSpawnTime === 'function') {
        this.wrap(
          player,
          'getMonsterSpawnTime',
          (impl) =>
            function (this: GameObject, ...args: unknown[]) {
              const ms = impl.apply(this, args) as number;
              return typeof ms === 'number' ? Math.max(MIN_SPAWN_MS, ms / ctl.speed) : ms;
            },
        );
      }
    }
  }

  dispose() {
    if (this.job) this.finishJob(this.job, 'cancelled', 'scripting runtime unloaded');
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const restore of this.restorers.splice(0).reverse()) {
      try {
        restore();
      } catch (e) {
        console.error('[melvor-script] restore failed', e);
      }
    }
    this.skills = [];
    this.enabled = false;
  }

  private wrap(obj: GameObject, name: string, make: (impl: Fn) => Fn) {
    const hadOwn = Object.prototype.hasOwnProperty.call(obj, name);
    const prevOwn = hadOwn ? obj[name] : undefined;
    // Look the implementation up on every call so later prototype patches by other mods still apply.
    const impl: Fn = function (this: unknown, ...args: unknown[]) {
      const fn: Fn = hadOwn ? prevOwn : Object.getPrototypeOf(obj)[name];
      return fn.apply(this, args);
    };
    obj[name] = make(impl);
    this.restorers.push(() => {
      if (hadOwn) obj[name] = prevOwn;
      else delete obj[name];
    });
  }

  private listen(emitter: GameObject, event: string, handler: (e: GameObject) => void) {
    if (!emitter || typeof emitter.on !== 'function') return;
    emitter.on(event, handler);
    this.restorers.push(() => emitter.off?.(event, handler));
  }

  // ---------------------------------------------------------------------------
  // the player's own clicks
  // ---------------------------------------------------------------------------

  private onStart(skill: GameObject, impl: Fn, args: unknown[]) {
    if (this.inClick) return impl.apply(skill, args); // our own click
    // The player clicked something (or the game / another mod started the skill).
    const left = this.readyAt - Date.now();
    if (left > 0) {
      this.notice(skill, left);
      // The click handler already selected the target (e.g. added the tree). Undo that like a
      // finished click would, or the player's next click would deselect it instead of acting.
      safe(() => skill.onStop?.(), undefined);
      return false;
    }
    if (this.job) this.finishJob(this.job, 'cancelled', 'interrupted by the player');
    const interval = this.intervalOf(skill);
    const stun = this.stunOf(skill);
    const out = this.runClick(skill, () => impl.apply(skill, args) !== false);
    if (out.actions > 0) this.startCooldown(this.cooldownFor(interval + (out.failed ? stun : 0)));
    return out.started;
  }

  /** One Attack-button press by the player: allowed once per cooldown. */
  private humanAttack(): { allowed: boolean } {
    if (!this.combatSession) {
      const left = this.readyAt - Date.now();
      const allowed = left <= 0;
      if (allowed) {
        if (this.job) this.finishJob(this.job, 'cancelled', 'interrupted by the player');
        this.startCooldown(this.cooldownFor(this.attackInterval()));
      } else {
        this.notice(
          safe(() => this.game.attack, undefined),
          left,
        );
      }
      const session = { allowed };
      this.combatSession = session;
      // The button handler is synchronous: the press is over once it returns.
      queueMicrotask(() => {
        if (this.combatSession === session) this.combatSession = null;
      });
    }
    return this.combatSession;
  }

  private notice(skill: GameObject, leftMs: number) {
    const now = Date.now();
    if (now - this.lastNotice < 400) return;
    this.lastNotice = now;
    try {
      this.game.combat?.notifications?.add?.({
        type: 'Player',
        args: [skill, `On cooldown (${(leftMs / 1000).toFixed(1)}s)`, 'danger'],
      });
    } catch {
      /* cosmetic */
    }
  }

  // ---------------------------------------------------------------------------
  // script API
  // ---------------------------------------------------------------------------

  get supportedSkills(): readonly GameObject[] {
    return this.skills;
  }

  /** ms until the next click may happen (0 = now). */
  readyInMs(): number {
    return Math.max(0, Math.ceil(this.readyAt - Date.now()));
  }

  async act(params: ActParams, owner: Owner | null): Promise<ActionResult> {
    const game = this.game;
    const skill = resolveSkill(game, params.skill);
    if (!this.skills.includes(skill)) {
      throw new RpcError(
        'UNSUPPORTED',
        `${skill.name} has no scriptable actions (combat, farming and township have their own APIs)`,
      );
    }
    const count = params.count ?? null;
    if (count !== null && !(Number.isInteger(count) && count >= 1)) {
      throw new RpcError(
        'BAD_REQUEST',
        `count must be a positive integer or null, got ${JSON.stringify(params.count)}`,
      );
    }
    if (game.isGolbinRaid) throw new RpcError('BUSY', 'Golbin Raid is running');
    const adapter = adapterFor(this.env, skill);
    const targets = Array.isArray(params.targets) ? params.targets.map(String) : [];
    const resolved = adapter.resolve(skill, targets, params.options ?? {}, game);
    const missing = missingItems(game, adapter.costsFor?.(skill, resolved, game));
    if (Object.keys(missing).length > 0) {
      throw new RpcError('MISSING_ITEMS', `Not enough materials for ${describe(skill, resolved)}`, { missing });
    }
    const job = await this.begin({
      kind: 'skill',
      skill,
      adapter,
      resolved,
      targetIds: resolved.ids,
      maxClicks: count,
      targetKills: null,
      owner,
    });
    await this.firstClick(job);
    const s = await job.promise;
    return {
      jobId: job.id,
      skill: skill.id,
      requested: count,
      completed: job.clicks,
      actions: job.actions,
      status: s.status,
      ...(s.reason !== undefined && s.status !== 'completed' ? { reason: s.reason } : {}),
      durationMs: Date.now() - job.startedAt,
      xp: prune(job.xp),
      items: prune(job.items),
      currencies: prune(job.currencies),
      readyInMs: this.readyInMs(),
    };
  }

  async attack(owner: Owner | null): Promise<AttackResult> {
    if (!this.inCombat())
      throw new RpcError('NOT_READY', "You're not fighting anything. Start a fight first: m.combat.fight(monster)");
    const job = await this.begin({
      kind: 'combat',
      skill: null,
      adapter: null,
      resolved: null,
      targetIds: this.combatTargets(),
      maxClicks: 1,
      targetKills: null,
      owner,
    });
    await this.firstClick(job);
    await job.promise;
    const c = this.game.combat;
    return {
      actions: job.actions,
      kills: job.kills,
      enemyHp: safe(() => c.enemy.hitpoints, 0),
      hp: safe(() => c.player.hitpoints, 0),
      xp: prune(job.xp),
      items: prune(job.items),
      readyInMs: this.readyInMs(),
    };
  }

  /** Start fighting a monster; with `kills`, attack until that many have died. */
  async fight(
    params: { monster: string; area?: string; kills?: number | null },
    owner: Owner | null,
  ): Promise<FightResult> {
    const kills = this.killCount(params.kills, 'kills');
    if (kills === null) {
      // Just entering combat: not a click, so no cooldown, but it does end a running batch.
      if (this.job) this.finishJob(this.job, 'cancelled', 'superseded by a fight');
      this.combat.selectMonster(params, true);
      return {
        kills: 0,
        status: 'completed',
        durationMs: 0,
        items: {},
        xp: {},
        attacks: 0,
        readyInMs: this.readyInMs(),
      };
    }
    return this.runFight(kills, owner, () => this.combat.selectMonster(params, true));
  }

  async dungeon(params: { dungeon: string; runs?: number | null }, owner: Owner | null): Promise<FightResult> {
    const runs = this.killCount(params.runs, 'runs');
    if (runs === null) {
      if (this.job) this.finishJob(this.job, 'cancelled', 'superseded by a fight');
      this.combat.selectDungeon(params);
      return {
        kills: 0,
        status: 'completed',
        durationMs: 0,
        items: {},
        xp: {},
        attacks: 0,
        readyInMs: this.readyInMs(),
      };
    }
    return this.runFight(runs * this.combat.dungeonSize(params), owner, () => this.combat.selectDungeon(params));
  }

  /** Cancel one job (by id) or every job owned by a client. */
  cancel(filter: { jobId?: number; ownerId?: number }, reason = 'cancelled by script'): number {
    const job = this.job;
    if (!job) return 0;
    if (filter.jobId !== undefined && job.id !== filter.jobId) return 0;
    if (filter.ownerId !== undefined && job.owner?.id !== filter.ownerId) return 0;
    this.finishJob(job, 'cancelled', reason);
    return 1;
  }

  cancelAll(reason: string): number {
    return this.cancel({}, reason);
  }

  cancelCombat(reason: string) {
    if (this.job?.kind === 'combat') this.finishJob(this.job, 'cancelled', reason);
  }

  listJobs(): JobInfo[] {
    const job = this.job;
    if (!job || job.done) return [];
    return [this.jobInfo(job)];
  }

  // ---------------------------------------------------------------------------
  // jobs
  // ---------------------------------------------------------------------------

  private async runFight(kills: number, owner: Owner | null, select: () => void): Promise<FightResult> {
    const job = await this.begin(
      {
        kind: 'combat',
        skill: null,
        adapter: null,
        resolved: null,
        targetIds: [],
        maxClicks: null,
        targetKills: kills,
        owner,
      },
      select,
    );
    await this.firstClick(job);
    const s = await job.promise;
    // A real-time fight ends by stopping combat, which collects the loot. Do the same here.
    for (const [id, n] of Object.entries(this.combat.loot())) add(job.items, id, n);
    return {
      kills: job.kills,
      status: s.status,
      ...(s.reason !== undefined && s.status !== 'completed' ? { reason: s.reason } : {}),
      durationMs: Date.now() - job.startedAt,
      items: prune(job.items),
      xp: prune(job.xp),
      attacks: job.clicks,
      readyInMs: this.readyInMs(),
    };
  }

  /**
   * Claim the (single) action slot: fail fast on cooldown, cancel a waiting batch,
   * wait out the last few ms of the cooldown, then create the job.
   */
  private async begin(spec: JobSpec, prepare?: () => void): Promise<ClickJob> {
    if (this.game.isGolbinRaid) throw new RpcError('BUSY', 'Golbin Raid is running');
    if (this.starting) throw new RpcError('BUSY', 'Another action is being started');
    this.failIfCoolingDown();
    this.starting = true;
    try {
      if (this.job) this.finishJob(this.job, 'cancelled', 'superseded by a newer action');
      const left = this.readyAt - Date.now();
      if (left > 0) await this.sleep(left);
      prepare?.();
      if (spec.kind === 'combat' && spec.targetIds.length === 0) spec = { ...spec, targetIds: this.combatTargets() };
      const job = this.createJob(spec);
      this.job = job;
      return job;
    } finally {
      this.starting = false;
    }
  }

  private failIfCoolingDown() {
    const left = this.readyAt - Date.now();
    if (left > COOLDOWN_TOLERANCE_MS) {
      const ms = Math.ceil(left);
      throw new RpcError('COOLDOWN', `On cooldown for another ${ms}ms`, { readyInMs: ms });
    }
  }

  private createJob(spec: JobSpec): ClickJob {
    let resolve!: (s: Summary) => void;
    const promise = new Promise<Summary>((r) => (resolve = r));
    return {
      ...spec,
      id: this.nextJobId++,
      clicks: 0,
      actions: 0,
      kills: 0,
      startedAt: Date.now(),
      xp: {},
      items: {},
      currencies: {},
      timer: null,
      done: false,
      resolve,
      promise,
    };
  }

  /** The first click runs inside the request: its errors are the request's errors. */
  private async firstClick(job: ClickJob) {
    let out: Outcome;
    try {
      out = await this.clickOnce(job);
    } catch (e) {
      // Never really started: drop it without a jobFinished event.
      job.done = true;
      if (this.job === job) this.job = null;
      job.resolve({ status: 'cancelled', reason: 'failed to start' });
      throw e;
    }
    if (this.isBatch(job)) this.hooks.onJobStarted(this.jobInfo(job));
    this.afterClick(job, out);
  }

  private isBatch(job: ClickJob) {
    return job.maxClicks !== 1;
  }

  private async clickOnce(job: ClickJob): Promise<Outcome> {
    return job.kind === 'skill' ? this.clickSkill(job) : this.clickAttack(job);
  }

  private async clickSkill(job: ClickJob): Promise<Outcome> {
    const skill = job.skill!;
    const adapter = job.adapter!;
    const resolved = job.resolved!;
    const wait = adapter.waitUntil?.(skill, resolved);
    if (wait) await this.waitFor(wait.ready, wait.what, job);
    await this.waitForCooldown(job);
    const game = this.game;
    const missing = missingItems(game, adapter.costsFor?.(skill, resolved, game));
    if (Object.keys(missing).length > 0) {
      throw new RpcError('MISSING_ITEMS', `Not enough materials for ${describe(skill, resolved)}`, { missing });
    }
    if (skill.isActive) skill.stop();
    adapter.apply(skill, resolved);
    const interval = this.intervalOf(skill);
    const stun = this.stunOf(skill);
    const out = this.runClick(skill, () => skill.start() !== false);
    if (!out.started)
      throw new RpcError('BUSY', `${skill.name} couldn't start (the current action couldn't be stopped)`);
    if (out.actions > 0) this.startCooldown(this.cooldownFor(interval + (out.failed ? stun : 0)));
    return out;
  }

  private async clickAttack(job: ClickJob): Promise<Outcome> {
    const c = this.game.combat;
    if (!this.inCombat()) throw new RpcError('NOT_READY', 'Combat ended (you fled, died, or started something else)');
    if (!this.enemyAlive())
      await this.waitFor(() => this.enemyAlive() || !this.inCombat(), 'the next enemy to spawn', job);
    if (!this.inCombat()) throw new RpcError('NOT_READY', 'Combat ended (you fled, died, or started something else)');
    await this.waitForCooldown(job);
    const interval = this.attackInterval();
    const out = this.runClick(COMBAT_CLICK, () => {
      const n = Math.max(1, Math.floor(safe(() => this.game.modifiers.getInstantActionsToPerform() as number, 1)));
      for (let i = 0; i < n; i++) c.player.actOnClick();
      c.enemy.actOnClick();
      // The game checks for deaths once per tick; do it now so this click's kill and loot are part of its result.
      c.checkDeath?.();
      return n;
    });
    this.startCooldown(this.cooldownFor(interval));
    return out;
  }

  private afterClick(job: ClickJob, out: Outcome) {
    if (job.done) return;
    job.clicks++;
    job.actions += out.actions;
    job.kills += out.kills;
    for (const [k, v] of Object.entries(out.xp)) add(job.xp, k, v);
    for (const [k, v] of Object.entries(out.items)) add(job.items, k, v);
    for (const [k, v] of Object.entries(out.currencies)) add(job.currencies, k, v);

    if (job.targetKills !== null && job.kills >= job.targetKills) return this.finishJob(job, 'completed');
    if (job.maxClicks !== null && job.clicks >= job.maxClicks) return this.finishJob(job, 'completed');
    if (job.kind === 'skill') {
      if (out.bankFull) return this.finishJob(job, 'stopped', 'bank full');
      const missing = missingItems(this.game, job.adapter!.costsFor?.(job.skill, job.resolved!, this.game));
      const names = Object.keys(missing);
      if (names.length > 0) return this.finishJob(job, 'stopped', `out of materials (${names.join(', ')})`);
    } else if (!this.inCombat()) {
      const dead = safe(() => this.game.combat.player.hitpoints <= 0, false);
      return this.finishJob(job, 'stopped', dead ? 'you died' : 'combat ended');
    }
    this.scheduleNext(job);
  }

  private scheduleNext(job: ClickJob) {
    if (job.done) return;
    job.timer = setTimeout(
      () => {
        job.timer = null;
        void this.nextClick(job);
      },
      Math.max(0, this.readyAt - Date.now()),
    );
  }

  private async nextClick(job: ClickJob) {
    if (job.done || this.job !== job) return;
    let out: Outcome;
    try {
      out = await this.clickOnce(job);
    } catch (e) {
      if (!job.done) this.finishJob(job, 'stopped', e instanceof Error ? e.message : String(e));
      return;
    }
    this.afterClick(job, out);
  }

  private finishJob(job: ClickJob, status: JobStatus, reason?: string) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (this.job === job) this.job = null;
    if (job.done) return;
    job.done = true;
    if (this.isBatch(job)) {
      try {
        this.hooks.onJobFinished({
          jobId: job.id,
          skill: job.skill?.id ?? 'combat',
          status,
          ...(reason !== undefined && status !== 'completed' ? { reason } : {}),
        });
      } catch (e) {
        console.error('[melvor-script] onJobFinished threw', e);
      }
    }
    job.resolve({ status, reason });
  }

  private jobInfo(job: ClickJob): JobInfo {
    return {
      jobId: job.id,
      skill: job.skill?.id ?? 'combat',
      targets: job.targetIds,
      requested: job.kind === 'combat' ? job.targetKills : job.maxClicks,
      completed: job.kind === 'combat' ? job.kills : job.clicks,
      startedAt: job.startedAt,
      owner: job.owner?.name ?? 'game',
    };
  }

  // ---------------------------------------------------------------------------
  // clicks and cooldown
  // ---------------------------------------------------------------------------

  /** Run one click with gains captured. `fn` returns false if nothing started, or the number of actions it did. */
  private runClick(marker: GameObject, fn: () => boolean | number): Outcome {
    const out: Outcome = {
      started: false,
      actions: 0,
      kills: 0,
      failed: false,
      bankFull: false,
      xp: {},
      items: {},
      currencies: {},
    };
    const xpBefore = new Map<GameObject, number>();
    for (const s of allObjects(this.game.skills))
      xpBefore.set(
        s,
        safe(() => s.xp as number, 0),
      );
    const currBefore = new Map<GameObject, number>();
    for (const c of allObjects(this.game.currencies))
      currBefore.set(
        c,
        safe(() => c.amount as number, 0),
      );
    const prevIn = this.inClick;
    const prevCapture = this.capture;
    this.inClick = marker;
    this.capture = out;
    try {
      const r = fn();
      out.started = r !== false;
      if (typeof r === 'number') out.actions = r;
    } finally {
      this.inClick = prevIn;
      this.capture = prevCapture;
      for (const [s, before] of xpBefore) {
        const d = safe(() => s.xp as number, 0) - before;
        if (d !== 0) add(out.xp, s.id, d);
      }
      for (const [c, before] of currBefore) {
        const d = safe(() => c.amount as number, 0) - before;
        if (d !== 0) add(out.currencies, c.id, d);
      }
    }
    // Every skill emits 'action', but if one doesn't, any gain still counts as an action.
    if (out.started && out.actions === 0 && (Object.keys(out.xp).length > 0 || Object.keys(out.items).length > 0))
      out.actions = 1;
    return out;
  }

  private startCooldown(ms: number) {
    this.readyAt = Math.max(this.readyAt, Date.now() + ms);
    this.lastCooldownMs = ms;
    this.hooks.onCooldown();
  }

  private cooldownFor(intervalMs: number) {
    return Math.max(MIN_COOLDOWN_MS, Math.round(intervalMs / this.speed));
  }

  private intervalOf(skill: GameObject): number {
    const v = safe(() => skill.actionInterval as number, NaN);
    if (Number.isFinite(v) && v > 0) return v;
    const c = safe(() => skill.currentActionInterval as number, NaN);
    return Number.isFinite(c) && c > 0 ? c : 3000;
  }

  private stunOf(skill: GameObject): number {
    const v = safe(() => skill.stunInterval as number, 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  private attackInterval(): number {
    const v = safe(() => this.game.combat.player.stats.attackInterval as number, NaN);
    return Number.isFinite(v) && v > 0 ? v : 2400;
  }

  private inCombat(): boolean {
    return safe(() => !!this.game.combat.isActive, false);
  }

  private enemyAlive(): boolean {
    const c = this.game.combat;
    return safe(() => !!c.fightInProgress && (c.enemy.state === undefined || c.enemy.state === ENEMY_ALIVE), false);
  }

  private combatTargets(): string[] {
    const id = safe(
      () => this.game.combat.selectedMonster?.id ?? this.game.combat.enemy.monster?.id,
      undefined as string | undefined,
    );
    return id ? [id] : [];
  }

  private killCount(v: number | null | undefined, name: string): number | null {
    if (v === undefined || v === null) return null;
    if (!(Number.isInteger(v) && v >= 1))
      throw new RpcError('BAD_REQUEST', `${name} must be a positive integer, got ${JSON.stringify(v)}`);
    return v;
  }

  /** Inside a job, wait out any cooldown (the player may have clicked while we waited for a respawn). */
  private async waitForCooldown(job: ClickJob) {
    for (;;) {
      if (job.done) throw new RpcError('FAILED', 'cancelled');
      const left = this.readyAt - Date.now();
      if (left <= 0) return;
      await this.sleep(left);
    }
  }

  private async waitFor(ready: () => boolean, what: string, job: ClickJob) {
    const end = Date.now() + MAX_WAIT_MS;
    while (!ready()) {
      if (job.done) throw new RpcError('FAILED', 'cancelled');
      if (Date.now() > end) throw new RpcError('BUSY', `Gave up waiting for ${what}`);
      await this.sleep(POLL_MS);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      this.timers.add(t);
    });
  }
}

function add(map: Record<string, number>, key: string, delta: number) {
  map[key] = (map[key] ?? 0) + delta;
}

function prune(map: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) if (v !== 0) out[k] = v;
  return out;
}

function describe(skill: GameObject, r: Resolved): string {
  const names = r.actions.map((a) => a.name).join(', ');
  return names ? `${skill.name}: ${names}` : skill.name;
}
