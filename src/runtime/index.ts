/**
 * Runtime entry point. Bundled to mod/runtime.mjs and loaded by mod/setup.mjs,
 * either from the mod zip or (in dev) straight from disk so it can be hot-reloaded.
 */
import {
  PROTOCOL_VERSION,
  type ActParams,
  type GameEventMessage,
  type HelloResult,
  type LogLevel,
  type RuntimeInfo,
} from '../shared/protocol.ts';
import { ActionController } from './actions.ts';
import { registerBank, registerShop } from './api/economy.ts';
import { CombatController, registerCombat } from './api/combat.ts';
import type { ApiContext } from './api/context.ts';
import { registerData } from './api/data.ts';
import { registerDebug } from './api/debug.ts';
import { registerPlayer } from './api/player.ts';
import { ClickController } from './clicks.ts';
import { configuredSpeed, loadOrCreateConfig, updateConfig, type ConnectionConfig } from './config.ts';
import { RpcError, safe, type GameObject, type RuntimeEnv, type SettingName } from './env.ts';
import { Hud } from './hud.ts';
import { allObjects } from './lookup.ts';
import { DEFAULT_RATE_LIMIT, RpcServer, type ClientSession } from './rpc-server.ts';
import { buildState, RUNTIME_VERSION, StateDiffer, type StateContext } from './state.ts';
import { WsServer } from './ws-server.ts';

export { RUNTIME_VERSION };
export type { RuntimeEnv };

const STATE_PUSH_MS = 200;
const STALE_KEY = '__melvorScriptCloseServer';
export const SCRIPTED_GAMEMODE_LOCAL_ID = 'Scripted';

export interface Runtime {
  /** Install hooks and start the server. Call once the character is loaded. */
  start(): Promise<void>;
  dispose(): Promise<void>;
  toggleHud(): void;
  info(): RuntimeInfo;
  /** A value changed in the in-game settings window (called by the bootstrap). Saved to config.json. */
  settingChanged(name: SettingName, value: unknown): void;
  /** Exposed for tests. */
  readonly actions: ActionController;
  readonly clicks: ClickController;
  readonly combat: CombatController;
  readonly config: ConnectionConfig | null;
}

export function createRuntime(env: RuntimeEnv): Runtime {
  const game = env.game;
  const differ = new StateDiffer();
  const restorers: (() => void)[] = [];
  let config: ConnectionConfig | null = null;
  let server: WsServer | null = null;
  let pushTimer: ReturnType<typeof setInterval> | null = null;
  let serverError: string | null = null;
  let started = false;
  let closeHook: (() => Promise<void>) | null = null;

  const hud = env.hud
    ? new Hud({
        onStopAll: () => stopAll('stopped from the in-game panel'),
        onToggleScriptMode: () => {
          try {
            setScriptMode(!actions.scriptMode);
          } catch (e) {
            log('warn', e instanceof Error ? e.message : String(e), 'runtime');
          }
        },
      })
    : null;

  const rpc = new RpcServer(
    {
      beforeRespond: () => flushState(),
      onSessionOpen: () => updateStatus(),
      onSessionClose: (s) => {
        const n =
          actions.cancel({ ownerId: s.id }, 'client disconnected') +
          clicks.cancel({ ownerId: s.id }, 'client disconnected');
        combat.cancelOwnedBy(s.id);
        log('info', `${s.name} disconnected${n ? ` (${n} job${n > 1 ? 's' : ''} cancelled)` : ''}`, 'runtime');
        updateStatus();
      },
      onRateLimited: (s) => log('warn', `${s.name} is making too many calls; extra calls are refused`, 'runtime'),
    },
    env.timing?.rateLimit ?? DEFAULT_RATE_LIMIT,
  );

  const actions = new ActionController(env, {
    onJobStarted: (job) => {
      emit({ type: 'jobStarted', job });
      renderJobs();
    },
    onJobFinished: (result) => {
      emit({ type: 'jobFinished', result });
      if (result.status !== 'completed') {
        log(
          'warn',
          `${displayName(result.skill)} job ${result.status}${result.reason ? `: ${result.reason}` : ''}`,
          'runtime',
        );
      }
      renderJobs();
    },
  });
  const combat = new CombatController(env);
  let flushQueued = false;
  const clicks = new ClickController(env, combat, {
    onJobStarted: (job) => {
      emit({ type: 'jobStarted', job });
      renderJobs();
    },
    onJobFinished: (r) => {
      if (r.status !== 'completed')
        log('warn', `${displayName(r.skill)} ${r.status}${r.reason ? `: ${r.reason}` : ''}`, 'runtime');
      renderJobs();
    },
    onCooldown: () => {
      // Usually mid-click: push once the click is over.
      if (flushQueued) return;
      flushQueued = true;
      setTimeout(() => {
        flushQueued = false;
        flushState();
      }, 0);
    },
  });

  const api: ApiContext = {
    env,
    rpc,
    actions,
    clicks,
    combat,
    flushState: () => flushState(),
    evalAllowed: () => config?.allowEval === true,
    log: (l, m, s) => log(l, m, s),
  };

  const stateContext: StateContext = {
    env,
    scriptMode: () => scriptModeOn(),
    jobs: () => [...actions.listJobs(), ...clicks.listJobs(), ...combat.listJobs()],
    clicks: () => ({
      instant: clicks.enabled,
      speed: clicks.enabled ? clicks.speed : 1,
      readyAt: clicks.readyAt,
      cooldownMs: clicks.lastCooldownMs,
    }),
  };

  // ---------------------------------------------------------------------------

  function log(level: LogLevel, message: string, source: string) {
    hud?.log(level, message, source);
    if (level === 'error') console.error(`[melvor-script] ${source}: ${message}`);
  }

  function emit(event: GameEventMessage) {
    rpc.broadcast('event', event);
  }

  function flushState() {
    if (rpc.sessions.size === 0) return;
    const sections = differ.diff(buildState(stateContext));
    if (sections) rpc.broadcast('state', { version: differ.version, sections });
  }

  /** Instant mode is Script Mode by nature: nothing ever idles. */
  function scriptModeOn() {
    return clicks.enabled || actions.scriptMode;
  }

  const nameCache = new Map<string, string>();
  function displayName(id: string): string {
    const cached = nameCache.get(id);
    if (cached) return cached;
    let name: string | undefined =
      safe(() => game.skills.getObjectByID(id)?.name, undefined) ??
      safe(() => game.items.getObjectByID(id)?.name, undefined);
    if (!name) {
      for (const s of allObjects(game.skills)) {
        const a = safe(() => s.actions?.getObjectByID(id), undefined);
        if (a) {
          name = safe(() => a.name, undefined);
          break;
        }
      }
    }
    const result = name ?? id;
    nameCache.set(id, result);
    return result;
  }

  function renderJobs() {
    hud?.setJobs(stateContext.jobs(), displayName);
  }

  function updateStatus() {
    if (!hud) return;
    if (serverError) {
      hud.setStatus(serverError, 'err');
      return;
    }
    if (!server) {
      hud.setStatus('server not running', 'off');
      return;
    }
    const clients = [...rpc.sessions].filter((s) => s.helloDone).map((s) => s.name);
    const mode = clicks.enabled ? `instant actions, cooldown = normal time ÷ ${clicks.speed}` : 'real-time actions';
    hud.setStatus(
      `listening on ws://${server.address}  ·  ${mode}\n${clients.length ? `connected: ${clients.join(', ')}` : 'no scripts connected'}  ·  runtime ${env.runtimeSource}`,
      clients.length ? 'on' : 'off',
    );
  }

  function renderMode() {
    hud?.setScriptMode(scriptModeOn(), clicks.enabled ? `instant ÷${clicks.speed}` : undefined);
  }

  /** Show the config.json values in the settings window (Melvor's own saved copy may be stale or missing). */
  function showSettings() {
    if (!env.settings || !config) return;
    try {
      env.settings.set('speed', configuredSpeed(config));
      env.settings.set('allowEval', config.allowEval === true);
    } catch (e) {
      log('warn', `couldn't show settings: ${e instanceof Error ? e.message : e}`, 'runtime');
    }
  }

  function settingChanged(name: SettingName, value: unknown) {
    if (!env.node || !config) return;
    try {
      if (name === 'speed') {
        const speed = configuredSpeed({ ...config, speed: Number(value) });
        if (speed === configuredSpeed(config)) return;
        config = updateConfig(env.node, { speed }, env.configPath);
        if (!clicks.enabled) return; // only the Scripted gamemode has a cooldown
        clicks.speed = speed;
        renderMode();
        updateStatus();
        flushState();
        log('info', `speed ${speed}: each action is followed by a cooldown of its normal time ÷ ${speed}`, 'runtime');
      } else if (name === 'allowEval') {
        const allow = value === true;
        if (allow === (config.allowEval === true)) return;
        config = updateConfig(env.node, { allowEval: allow }, env.configPath);
        log(
          allow ? 'warn' : 'info',
          allow ? 'eval allowed: connected clients can run any code in the game' : 'eval turned off',
          'runtime',
        );
      }
    } catch (e) {
      log('error', `couldn't save the ${name} setting: ${e instanceof Error ? e.message : e}`, 'runtime');
    }
  }

  function isScriptedGamemode() {
    const ns = env.ctx?.namespace;
    return !!ns && safe(() => game.currentGamemode.id === `${ns}:${SCRIPTED_GAMEMODE_LOCAL_ID}`, false);
  }

  function setScriptMode(enabled: boolean) {
    if (!enabled && (isScriptedGamemode() || clicks.enabled)) {
      throw new RpcError('LOCKED', 'Script Mode is always on with instant actions (nothing ever idles)');
    }
    if (clicks.enabled) return;
    actions.setScriptMode(enabled);
    try {
      env.ctx?.characterStorage?.setItem('scriptMode', enabled);
    } catch (e) {
      log('warn', `couldn't save Script Mode: ${e instanceof Error ? e.message : e}`, 'runtime');
    }
    hud?.setScriptMode(enabled);
    emit({ type: 'scriptMode', enabled });
    flushState();
  }

  function stopAll(reason: string): number {
    const n = actions.cancelAll(reason) + clicks.cancelAll(reason);
    combat.stop();
    actions.stopActiveSkill(reason);
    emit({ type: 'stopAll', reason });
    log('warn', `stop all: ${reason}`, 'runtime');
    flushState();
    return n;
  }

  function info(): RuntimeInfo {
    return {
      protocol: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      runtimeSource: env.runtimeSource,
      scriptMode: scriptModeOn(),
      instant: clicks.enabled,
      speed: clicks.enabled ? clicks.speed : 1,
      clients: [...rpc.sessions].filter((s) => s.helloDone).map((s) => ({ id: s.id, name: s.name })),
    };
  }

  function listen(emitter: GameObject, event: string, handler: (e: GameObject) => void) {
    if (!emitter || typeof emitter.on !== 'function') return;
    emitter.on(event, handler);
    restorers.push(() => emitter.off?.(event, handler));
  }

  function forwardGameEvents() {
    for (const skill of allObjects(game.skills)) {
      listen(skill, 'levelChanged', (e) => {
        emit({ type: 'levelUp', skill: skill.id, oldLevel: e.oldLevel, newLevel: e.newLevel });
        log('success', `${skill.name} level ${e.newLevel}`, 'game');
      });
      listen(skill, 'masteryLevelChanged', (e) =>
        emit({
          type: 'masteryLevelUp',
          skill: skill.id,
          action: safe(() => e.action.id, ''),
          oldLevel: e.oldLevel,
          newLevel: e.newLevel,
        }),
      );
    }
    listen(game.combat, 'monsterKilled', (e) => emit({ type: 'monsterKilled', monster: safe(() => e.monster.id, '') }));
    listen(game.combat, 'dungeonCompleted', (e) =>
      emit({ type: 'dungeonCompleted', dungeon: safe(() => e.dungeon.id, '') }),
    );
  }

  // ---------------------------------------------------------------------------
  // RPC methods
  // ---------------------------------------------------------------------------

  rpc.register('hello', (p: { client?: string; protocol?: number }, session: ClientSession): HelloResult => {
    if (p.protocol !== PROTOCOL_VERSION) {
      throw new RpcError(
        'BAD_REQUEST',
        `Protocol mismatch: game runtime speaks v${PROTOCOL_VERSION}, client speaks v${p.protocol}. Rebuild/update the side that's behind.`,
      );
    }
    session.name = typeof p.client === 'string' && p.client ? p.client.slice(0, 60) : `client-${session.id}`;
    // Bring existing clients up to date so the snapshot below is the shared baseline.
    // (Synchronous, so no game tick can land between the flush and the snapshot.)
    flushState();
    const state = buildState(stateContext);
    session.helloDone = true;
    log('info', `${session.name} connected`, 'runtime');
    updateStatus();
    return {
      protocol: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      runtimeSource: env.runtimeSource,
      clientId: session.id,
      state,
      stateVersion: differ.version,
    };
  });

  rpc.register('runtime.info', () => info());
  rpc.register('runtime.reload', () => {
    if (!env.requestReload)
      throw new RpcError('UNSUPPORTED', 'This runtime was not loaded by a bootstrap that supports reloading');
    setTimeout(() => env.requestReload?.(), 50);
    return { reloading: true };
  });
  rpc.register('runtime.setScriptMode', (p: { enabled: boolean }) => {
    setScriptMode(!!p.enabled);
    return { enabled: scriptModeOn() };
  });
  rpc.register('runtime.stopAll', (p: { reason?: string }, s: ClientSession) => ({
    cancelledJobs: stopAll(p.reason ?? `requested by ${s.name}`),
  }));

  rpc.register('state.get', () => buildState(stateContext));

  rpc.register('action.act', (p: ActParams, s: ClientSession) =>
    clicks.enabled ? clicks.act(p, { id: s.id, name: s.name }) : actions.act(p, { id: s.id, name: s.name }),
  );
  rpc.register('action.cancel', (p: { jobId?: number }, s: ClientSession) => {
    const filter = p.jobId !== undefined ? { jobId: p.jobId } : { ownerId: s.id };
    return { cancelled: actions.cancel(filter) + clicks.cancel(filter) };
  });
  rpc.register('action.stop', () => ({
    stopped: clicks.cancelAll('stopped by script') > 0 || actions.stopActiveSkill(),
  }));
  rpc.register('action.canDo', (p) => actions.canDo(p));

  rpc.register('ui.log', (p: { level?: LogLevel; message?: unknown }, s: ClientSession) => {
    const level: LogLevel = p.level && ['info', 'warn', 'error', 'success'].includes(p.level) ? p.level : 'info';
    log(level, String(p.message ?? '').slice(0, 2000), s.name);
  });

  registerBank(api);
  registerShop(api);
  registerCombat(api);
  registerPlayer(api);
  registerData(api);
  registerDebug(api);

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  async function start() {
    if (started) return;
    started = true;

    hud?.mount();
    let configError: string | null = null;
    if (env.node) {
      try {
        config = loadOrCreateConfig(env.node, env.configPath);
      } catch (e) {
        configError = `couldn't read/write config: ${e instanceof Error ? e.message : e}`;
      }
    }

    // Instant-action gamemodes (Scripted) get the click engine; everything else real-time jobs.
    if (ClickController.applies(game)) {
      clicks.speed = env.timing?.speed ?? configuredSpeed(config);
      clicks.install();
    } else {
      actions.install();
    }
    combat.install();
    forwardGameEvents();

    const stored = safe(() => env.ctx?.characterStorage?.getItem('scriptMode'), undefined);
    if (!clicks.enabled) actions.setScriptMode(isScriptedGamemode() || stored === true);
    renderMode();
    showSettings();

    if (!env.node) {
      serverError = 'Node APIs unavailable: scripting needs the Steam/desktop version of the game';
      updateStatus();
      log('error', serverError, 'runtime');
      return;
    }
    const node = env.node;
    if (configError || !config) {
      serverError = configError ?? "couldn't read/write config";
      updateStatus();
      log('error', serverError, 'runtime');
      return;
    }
    const cfg = config;
    const tokenBuf = node.Buffer.from(cfg.token, 'utf8');
    server = new WsServer(node, {
      host: cfg.host,
      port: cfg.port,
      authorize: (req) => {
        // Browsers always send Origin; refusing it stops web pages from talking to the game.
        if (req.headers.origin !== undefined) return 'origin not allowed';
        const given = node.Buffer.from(req.url.searchParams.get('token') ?? '', 'utf8');
        if (given.length !== tokenBuf.length || !node.crypto.timingSafeEqual(given, tokenBuf)) return 'bad token';
        return null;
      },
      onConnection: (conn) => rpc.attach(conn),
      onHttp: (path) =>
        path === '/status' ? { ok: true, protocol: PROTOCOL_VERSION, runtimeVersion: RUNTIME_VERSION } : undefined,
    });
    // A server left behind by a previous page load (NW.js keeps the Node context alive) would hold the port.
    const stale = node.process?.[STALE_KEY];
    if (typeof stale === 'function') {
      try {
        await (stale as () => Promise<void>)();
      } catch {
        /* already gone */
      }
    }
    try {
      await server.listen();
      const ours = server;
      closeHook = () => ours.close();
      if (node.process) node.process[STALE_KEY] = closeHook;
      serverError = null;
      log('success', `listening on ws://${server.address}`, 'runtime');
      if (clicks.enabled)
        log(
          'info',
          `instant actions: each action is followed by a cooldown of its normal time ÷ ${clicks.speed} (Speed: Mod Settings → Melvor Script)`,
          'runtime',
        );
    } catch (e) {
      const code = (e as { code?: string }).code;
      serverError =
        code === 'EADDRINUSE'
          ? `port ${cfg.port} is in use (another game window?). Change "port" in ~/.melvor-scripting/config.json`
          : `server failed to start: ${e instanceof Error ? e.message : e}`;
      server = null;
      log('error', serverError, 'runtime');
    }
    updateStatus();
    pushTimer = setInterval(() => {
      try {
        flushState();
      } catch (e) {
        console.error('[melvor-script] state push failed', e);
      }
    }, env.timing?.statePushMs ?? STATE_PUSH_MS);
  }

  async function dispose() {
    if (pushTimer) clearInterval(pushTimer);
    pushTimer = null;
    rpc.closeAll('runtime unloading');
    actions.dispose();
    clicks.dispose();
    combat.dispose();
    for (const r of restorers.splice(0).reverse()) r();
    const proc = env.node?.process;
    if (proc && closeHook && proc[STALE_KEY] === closeHook) delete proc[STALE_KEY];
    closeHook = null;
    await server?.close();
    server = null;
    hud?.unmount();
    started = false;
  }

  return {
    start,
    dispose,
    toggleHud: () => hud?.toggle(),
    info,
    settingChanged,
    actions,
    clicks,
    combat,
    get config() {
      return config;
    },
  };
}
