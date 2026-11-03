/**
 * ActionController - the "click to play" engine.
 *
 * Melvor's idle loop lives in GatheringSkill: start() starts a timer, the timer
 * calls action(), and action() restarts the timer forever. We wrap action(),
 * start() and stop() on every skill *instance* (so every subclass override is
 * covered and other mods' prototype patches still apply) and decide, after each
 * action, whether the skill may continue:
 *
 *   - A script "job" (`act(skill, targets, count)`) lets the skill run for
 *     `count` actions at the normal interval, then finishes.
 *   - In Script Mode, anything without a job gets exactly one action per start
 *     (a UI click = one action), and nothing repeats on its own.
 *   - After a job finishes the timer keeps running for a short grace period, so
 *     `while (...) await cut(tree)` chains actions back-to-back with no dead time.
 *     If no follow-up job arrives the skill stops; an action that completes during
 *     the grace window is discarded, so it can never be gained for free.
 */
import type { ActParams, ActionResult, CanDoResult, JobInfo, JobStatus } from '../shared/protocol.ts';
import { RpcError, isInstance, type GameObject, type RuntimeEnv } from './env.ts';
import { allObjects, resolveSkill } from './lookup.ts';
import { adapterFor, missingItems, type Resolved, type SkillAdapter } from './skills.ts';

const DEFAULT_GRACE_MS = 250;
const DEFAULT_BUSY_POLL_MS = 100;

interface Owner {
  id: number;
  name: string;
}

interface Job {
  id: number;
  skill: GameObject;
  adapter: SkillAdapter;
  resolved: Resolved;
  requested: number | null;
  completed: number;
  startedAt: number;
  owner: Owner | null;
  xp: Record<string, number>;
  items: Record<string, number>;
  currencies: Record<string, number>;
  /** Count reached but the skill is busy (thieving stun): finish once it clears. */
  finishing: boolean;
  /** The skill was stopped from inside its own action(); finish after the action's gains are recorded. */
  pendingStop: { status: JobStatus; reason?: string } | null;
  done: boolean;
  resolve(result: ActionResult): void;
  promise: Promise<ActionResult>;
}

export interface ActionControllerHooks {
  onJobStarted(job: JobInfo): void;
  onJobFinished(result: ActionResult): void;
}

type Fn = (...args: unknown[]) => unknown;

export class ActionController {
  private _scriptMode = false;
  private jobs = new Map<GameObject, Job>();
  private grace = new Map<GameObject, ReturnType<typeof setTimeout>>();
  private allowance = new Map<GameObject, number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private restorers: (() => void)[] = [];
  private skills: GameObject[] = [];
  private jobStarting = false;
  private stopContext: { status: JobStatus; reason: string } | null = null;
  private capturing: Job | null = null;
  private inActionSkill: GameObject | null = null;
  private nextJobId = 1;

  constructor(
    private env: RuntimeEnv,
    private hooks: ActionControllerHooks,
  ) {}

  private get game() {
    return this.env.game;
  }

  private get graceMs() {
    return this.env.timing?.graceMs ?? DEFAULT_GRACE_MS;
  }

  private get busyPollMs() {
    return this.env.timing?.busyPollMs ?? DEFAULT_BUSY_POLL_MS;
  }

  get scriptMode() {
    return this._scriptMode;
  }

  /** Skills that support jobs (all GatheringSkill instances). */
  get actionSkills(): readonly GameObject[] {
    return this.skills;
  }

  // -------------------------------------------------------------------------
  // install / dispose
  // -------------------------------------------------------------------------

  install() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ctl = this;
    for (const skill of allObjects(this.game.skills)) {
      if (!isInstance(this.env, skill, 'GatheringSkill')) continue;
      this.skills.push(skill);
      this.wrap(
        skill,
        'action',
        (impl) =>
          function (this: GameObject, ...args: unknown[]) {
            return ctl.onAction(this, impl, args);
          },
      );
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
        'stop',
        (impl) =>
          function (this: GameObject, ...args: unknown[]) {
            return ctl.onStop(this, impl, args);
          },
      );
      if (typeof skill.stunned === 'function') {
        // Thieving: a stun ends the skill unless "continue thieving on stun" is set.
        // While a job still has actions left, behave as if it were set.
        this.wrap(
          skill,
          'stunned',
          (impl) =>
            function (this: GameObject, ...args: unknown[]) {
              const job = ctl.jobs.get(this);
              if (job && !job.finishing)
                return ctl.withSetting('continueThievingOnStun', true, () => impl.apply(this, args));
              return impl.apply(this, args);
            },
        );
      }
      this.listen(skill, 'action', () => {
        if (this.inActionSkill !== skill) return;
        const job = this.jobs.get(skill);
        if (job) job.completed++;
      });
    }
    this.listen(this.game.bank, 'itemChanged', (e: GameObject) => {
      const job = this.capturing;
      if (job && e?.item) add(job.items, e.item.id, (e.newQuantity ?? 0) - (e.oldQuantity ?? 0));
    });
  }

  dispose() {
    for (const job of [...this.jobs.values()]) {
      this.finishJob(job, 'cancelled', 'scripting runtime unloaded');
      this.quietStop(job.skill);
    }
    for (const t of this.grace.values()) clearTimeout(t);
    for (const t of this.timers) clearTimeout(t);
    this.grace.clear();
    this.timers.clear();
    for (const restore of this.restorers.splice(0).reverse()) {
      try {
        restore();
      } catch (e) {
        console.error('[melvor-script] restore failed', e);
      }
    }
    this.skills = [];
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

  // -------------------------------------------------------------------------
  // wrapped methods
  // -------------------------------------------------------------------------

  private onAction(skill: GameObject, impl: Fn, args: unknown[]) {
    const job = this.jobs.get(skill);
    if (!job) {
      if (this.grace.has(skill)) {
        // The timer finished inside the grace window with no follow-up job: discard the action.
        this.clearGrace(skill);
        this.quietStop(skill);
        return;
      }
      if (this._scriptMode) {
        const left = this.allowance.get(skill) ?? 0;
        if (left <= 0) {
          this.quietStop(skill);
          return;
        }
        this.allowance.set(skill, left - 1);
      }
    }

    const xpBefore = job ? this.snapshotXP() : null;
    const currBefore = job ? this.snapshotCurrencies() : null;
    const prevCapture = this.capturing;
    const prevIn = this.inActionSkill;
    this.capturing = job ?? null;
    this.inActionSkill = skill;
    try {
      return impl.apply(skill, args);
    } finally {
      this.capturing = prevCapture;
      this.inActionSkill = prevIn;
      if (job && xpBefore && currBefore) this.recordDeltas(job, xpBefore, currBefore);
      this.afterAction(skill, job);
    }
  }

  private afterAction(skill: GameObject, job: Job | undefined) {
    if (job) {
      if (job.done) return;
      if (job.pendingStop) {
        this.finishJob(job, job.pendingStop.status, job.pendingStop.reason);
        return;
      }
      if (job.requested !== null && job.completed >= job.requested) this.completeJob(job);
      return;
    }
    // Script Mode, no job: a manual start buys exactly one action.
    if (this._scriptMode && skill.isActive && (this.allowance.get(skill) ?? 0) <= 0) this.quietStop(skill);
  }

  private onStart(skill: GameObject, impl: Fn, args: unknown[]) {
    if (!this.jobStarting) {
      // Started by the player (UI click), the game, or another mod.
      this.clearGrace(skill);
      if (this._scriptMode && !this.jobs.has(skill)) this.allowance.set(skill, 1);
    }
    return impl.apply(skill, args);
  }

  private onStop(skill: GameObject, impl: Fn, args: unknown[]) {
    const ok = impl.apply(skill, args);
    if (!ok) return ok;
    this.clearGrace(skill);
    this.allowance.delete(skill);
    const job = this.jobs.get(skill);
    if (job && !job.done) {
      let status: JobStatus;
      let reason: string | undefined;
      if (job.finishing) {
        status = 'completed';
      } else if (this.stopContext) {
        status = this.stopContext.status;
        reason = this.stopContext.reason;
      } else {
        status = 'stopped';
        reason = this.inferStopReason(job);
      }
      if (this.inActionSkill === skill) job.pendingStop = { status, reason };
      else this.finishJob(job, status, reason);
    }
    return ok;
  }

  // -------------------------------------------------------------------------
  // jobs
  // -------------------------------------------------------------------------

  act(params: ActParams, owner: Owner | null): Promise<ActionResult> {
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

    this.clearGrace(skill);
    const resume = skill.isActive && adapter.isCurrent(skill, resolved);
    const previous = this.jobs.get(skill);
    if (previous) this.finishJob(previous, 'cancelled', 'superseded by a newer job');

    if (!resume) {
      if (skill.isActive && !this.stopWith(skill, 'cancelled', 'superseded by a newer job')) {
        throw new RpcError('BUSY', `${skill.name} can't be stopped right now`);
      }
      adapter.apply(skill, resolved);
    }

    const job = this.createJob(skill, adapter, resolved, count, owner);
    this.jobs.set(skill, job);

    if (!resume) {
      let started = false;
      this.jobStarting = true;
      this.stopContext = { status: 'cancelled', reason: `superseded by ${skill.name}` };
      try {
        started = skill.start() !== false;
      } finally {
        this.jobStarting = false;
        this.stopContext = null;
      }
      if (!started || !skill.isActive) {
        this.jobs.delete(skill);
        job.done = true;
        throw new RpcError('BUSY', `Couldn't start ${skill.name}: the current action couldn't be stopped`);
      }
    }
    this.hooks.onJobStarted(this.jobInfo(job));
    return job.promise;
  }

  canDo(params: { skill: string; targets: string[]; options?: Record<string, unknown> }): CanDoResult {
    try {
      const skill = resolveSkill(this.game, params.skill);
      if (!this.skills.includes(skill)) return { ok: false, reason: `${skill.name} has no scriptable actions` };
      const adapter = adapterFor(this.env, skill);
      const resolved = adapter.resolve(skill, (params.targets ?? []).map(String), params.options ?? {}, this.game);
      const missing = missingItems(this.game, adapter.costsFor?.(skill, resolved, this.game));
      if (Object.keys(missing).length > 0) return { ok: false, reason: 'missing materials', missing };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Cancel one job (by id) or every job owned by `owner`. Stops the affected skills. */
  cancel(filter: { jobId?: number; ownerId?: number }, reason = 'cancelled by script'): number {
    let n = 0;
    for (const job of [...this.jobs.values()]) {
      if (filter.jobId !== undefined && job.id !== filter.jobId) continue;
      if (filter.ownerId !== undefined && job.owner?.id !== filter.ownerId) continue;
      this.finishJob(job, 'cancelled', reason);
      this.quietStop(job.skill);
      n++;
    }
    return n;
  }

  cancelAll(reason: string): number {
    return this.cancel({}, reason);
  }

  /** Stop whatever skill is active (and its job). Returns true if something stopped. */
  stopActiveSkill(reason = 'stopped by script'): boolean {
    let stopped = false;
    for (const skill of this.skills) {
      if (!skill.isActive) continue;
      stopped = this.stopWith(skill, 'cancelled', reason) || stopped;
    }
    return stopped;
  }

  setScriptMode(enabled: boolean) {
    this._scriptMode = enabled;
    if (!enabled) return;
    for (const skill of this.skills) {
      if (skill.isActive && !this.jobs.has(skill)) this.quietStop(skill);
    }
  }

  listJobs(): JobInfo[] {
    return [...this.jobs.values()].map((j) => this.jobInfo(j));
  }

  private createJob(
    skill: GameObject,
    adapter: SkillAdapter,
    resolved: Resolved,
    count: number | null,
    owner: Owner | null,
  ): Job {
    let resolve!: (r: ActionResult) => void;
    const promise = new Promise<ActionResult>((r) => (resolve = r));
    return {
      id: this.nextJobId++,
      skill,
      adapter,
      resolved,
      requested: count,
      completed: 0,
      startedAt: Date.now(),
      owner,
      xp: {},
      items: {},
      currencies: {},
      finishing: false,
      pendingStop: null,
      done: false,
      resolve,
      promise,
    };
  }

  private completeJob(job: Job) {
    if (job.adapter.isBusy?.(job.skill)) {
      // e.g. stunned while thieving: the stun is part of the action's real-time cost.
      if (!job.finishing) {
        job.finishing = true;
        const poll = () => {
          if (job.done) return;
          if (job.adapter.isBusy?.(job.skill)) this.later(poll, this.busyPollMs);
          else {
            this.finishJob(job, 'completed');
            this.startGrace(job.skill);
          }
        };
        this.later(poll, this.busyPollMs);
      }
      return;
    }
    this.finishJob(job, 'completed');
    this.startGrace(job.skill);
  }

  private finishJob(job: Job, status: JobStatus, reason?: string) {
    if (this.jobs.get(job.skill) === job) this.jobs.delete(job.skill);
    if (job.done) return;
    job.done = true;
    const result: ActionResult = {
      jobId: job.id,
      skill: job.skill.id,
      requested: job.requested,
      completed: job.completed,
      status,
      durationMs: Date.now() - job.startedAt,
      xp: job.xp,
      items: prune(job.items),
      currencies: prune(job.currencies),
    };
    if (reason !== undefined && status !== 'completed') result.reason = reason;
    try {
      this.hooks.onJobFinished(result);
    } finally {
      job.resolve(result);
    }
  }

  private jobInfo(job: Job): JobInfo {
    return {
      jobId: job.id,
      skill: job.skill.id,
      targets: job.resolved.ids,
      requested: job.requested,
      completed: job.completed,
      startedAt: job.startedAt,
      owner: job.owner?.name ?? 'game',
    };
  }

  private inferStopReason(job: Job): string {
    const game = this.game;
    try {
      if (game.bank.occupiedSlots >= game.bank.maximumSlots) return 'bank full';
    } catch {
      /* ignore */
    }
    try {
      const missing = missingItems(game, job.adapter.costsFor?.(job.skill, job.resolved, game));
      const names = Object.keys(missing);
      if (names.length > 0) return `out of materials (${names.join(', ')})`;
    } catch {
      /* ignore */
    }
    if (game.activeAction && game.activeAction !== job.skill)
      return `interrupted by ${game.activeAction.name ?? 'another action'}`;
    return 'stopped by the game or the player';
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private stopWith(skill: GameObject, status: JobStatus, reason: string): boolean {
    const prev = this.stopContext;
    this.stopContext = { status, reason };
    try {
      return skill.stop() !== false;
    } finally {
      this.stopContext = prev;
    }
  }

  /** Stop a skill without a toast, waiting out states that block stopping (thieving stun). */
  private quietStop(skill: GameObject) {
    if (!skill.isActive) return;
    let busy = false;
    try {
      busy = !!adapterFor(this.env, skill).isBusy?.(skill);
    } catch {
      /* unsupported skill: not busy */
    }
    if (busy) {
      this.later(() => {
        if (!this.jobs.has(skill)) this.quietStop(skill);
      }, this.busyPollMs);
      return;
    }
    skill.stop();
  }

  private startGrace(skill: GameObject) {
    if (!skill.isActive) return;
    this.clearGrace(skill);
    const t = setTimeout(() => {
      this.grace.delete(skill);
      if (!this.jobs.has(skill)) this.quietStop(skill);
    }, this.graceMs);
    this.grace.set(skill, t);
  }

  private clearGrace(skill: GameObject) {
    const t = this.grace.get(skill);
    if (t !== undefined) {
      clearTimeout(t);
      this.grace.delete(skill);
    }
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private withSetting<T>(key: string, value: unknown, fn: () => T): T {
    const settings = this.game.settings;
    if (!settings) return fn();
    const own = Object.prototype.hasOwnProperty.call(settings, key);
    const prev = own ? settings[key] : undefined;
    Object.defineProperty(settings, key, { value, configurable: true, writable: true, enumerable: own });
    try {
      return fn();
    } finally {
      if (own)
        Object.defineProperty(settings, key, { value: prev, configurable: true, writable: true, enumerable: true });
      else delete settings[key];
    }
  }

  private snapshotXP(): Map<GameObject, number> {
    const m = new Map<GameObject, number>();
    for (const s of allObjects(this.game.skills)) m.set(s, s.xp ?? 0);
    return m;
  }

  private snapshotCurrencies(): Map<GameObject, number> {
    const m = new Map<GameObject, number>();
    for (const c of allObjects(this.game.currencies)) m.set(c, c.amount ?? 0);
    return m;
  }

  private recordDeltas(job: Job, xp: Map<GameObject, number>, curr: Map<GameObject, number>) {
    for (const [s, before] of xp) {
      const d = (s.xp ?? 0) - before;
      if (d !== 0) add(job.xp, s.id, d);
    }
    for (const [c, before] of curr) {
      const d = (c.amount ?? 0) - before;
      if (d !== 0) add(job.currencies, c.id, d);
    }
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
