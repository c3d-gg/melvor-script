/**
 * Everything the runtime needs from the outside world, injected by the mod
 * bootstrap (mod/setup.mjs) so the runtime can be unit-tested against a fake game.
 */
import type * as FsNs from 'node:fs';
import type * as PathNs from 'node:path';
import type * as OsNs from 'node:os';
import type { ErrorCode } from '../shared/protocol.ts';
import type { NodeDeps } from './ws-server.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Game = any;
export type GameObject = any;

export interface CharacterStorage {
  getItem(key: string): unknown;
  setItem(key: string, value: unknown): void;
  removeItem(key: string): void;
}

export interface ModContext {
  namespace?: string;
  characterStorage?: CharacterStorage;
  getResourceUrl?(path: string): string;
}

export interface FullNodeDeps extends NodeDeps {
  fs: typeof FsNs;
  path: typeof PathNs;
  os: typeof OsNs;
  /**
   * Node's `process`. In NW.js the Node context outlives page reloads, so a server started
   * by a previous page can still hold the port; we park its close() here to clean it up.
   */
  process?: { [key: string]: unknown };
}

/** Names of the in-game settings the bootstrap registers (Mod Settings → Melvor Script). */
export type SettingName = 'speed' | 'farmingSpeed' | 'allowEval';

/**
 * The mod's in-game settings, registered once per page by mod/setup.mjs. Melvor saves mod
 * settings per character, and only for mods installed from mod.io, so the runtime keeps the
 * real values in config.json and copies them in here when it starts. Changes made in the
 * settings window reach the runtime through `Runtime.settingChanged`.
 */
export interface SettingsBridge {
  get(name: SettingName): unknown;
  set(name: SettingName, value: unknown): void;
}

export interface RuntimeEnv {
  game: Game;
  /** Melvor class constructors used for instanceof checks. Missing ones are treated as "never matches". */
  classes: Record<string, any>;
  ctx: ModContext | null;
  /** Node built-ins. null when running without Node (web build) - the server cannot start then. */
  node: FullNodeDeps | null;
  /** Where the runtime code was loaded from, for diagnostics ('bundled' | 'disk:<path>'). */
  runtimeSource: string;
  /** Override the config file location (tests). */
  configPath?: string;
  /** Create the in-game HUD (false in tests). */
  hud: boolean;
  /** Called by `runtime.reload`. Provided by the bootstrap. */
  requestReload?: () => void;
  /** In-game settings. Missing in tests and with an older bootstrap: config.json alone then. */
  settings?: SettingsBridge | null;
  /** Game version string, if known. */
  gameVersion?: string;
  /** Timing overrides (tests). */
  timing?: {
    graceMs?: number;
    busyPollMs?: number;
    statePushMs?: number;
    rateLimit?: { perSecond: number; burst: number };
    /** Instant-mode speed, overriding the config file. */
    speed?: number;
    /** Instant-mode farming speed, overriding the config file. */
    farmingSpeed?: number;
  };
}

export class RpcError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function isInstance(env: RuntimeEnv, value: unknown, className: string): boolean {
  const ctor = env.classes[className];
  return typeof ctor === 'function' && value instanceof ctor;
}

/** Run a getter, returning `fallback` if it throws or yields undefined/null. */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
