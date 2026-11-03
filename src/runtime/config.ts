import { DEFAULT_PORT } from '../shared/protocol.ts';
import type { FullNodeDeps } from './env.ts';

/**
 * Shared connection config at ~/.melvor-scripting/config.json.
 * The game creates it (with a random token); the client reads it.
 */
export interface ConnectionConfig {
  host: string;
  port: number;
  token: string;
  /** Absolute path to a runtime.mjs to load instead of the bundled copy (set by `bun run dev`). */
  devRuntime?: string;
  /**
   * Instant mode (Scripted gamemode): how many times faster than idle. After each action the
   * next one waits (its normal interval / speed). Set in game: Mod Settings → Melvor Script.
   */
  speed?: number;
  /**
   * Let clients run arbitrary JavaScript in the game (`debug.eval`, used by `bun run melvor eval`
   * and the REPL). Off unless turned on in Mod Settings → Melvor Script.
   */
  allowEval?: boolean;
}

export const DEFAULT_CONFIG_SPEED = 10;

/** The configured speed, clamped to something sane. */
export function configuredSpeed(config: ConnectionConfig | null): number {
  const s = config?.speed;
  return typeof s === 'number' && Number.isFinite(s) ? Math.min(1000, Math.max(1, s)) : DEFAULT_CONFIG_SPEED;
}

export function defaultConfigPath(node: FullNodeDeps) {
  return node.path.join(node.os.homedir(), '.melvor-scripting', 'config.json');
}

export function loadOrCreateConfig(node: FullNodeDeps, configPath = defaultConfigPath(node)): ConnectionConfig {
  const { fs, path, crypto } = node;
  let existing: Partial<ConnectionConfig> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    /* missing or unreadable: recreate */
  }
  const config: ConnectionConfig = {
    ...existing,
    host: typeof existing.host === 'string' ? existing.host : '127.0.0.1',
    port: typeof existing.port === 'number' ? existing.port : DEFAULT_PORT,
    token:
      typeof existing.token === 'string' && existing.token.length >= 32
        ? existing.token
        : crypto.randomBytes(24).toString('hex'),
    speed: typeof existing.speed === 'number' ? existing.speed : DEFAULT_CONFIG_SPEED,
    allowEval: existing.allowEval === true,
  };
  if (JSON.stringify(config) !== JSON.stringify(existing)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }
  return config;
}

/** Merge `patch` into the config file. Re-reads it first: the client writes to it too (devRuntime). */
export function updateConfig(
  node: FullNodeDeps,
  patch: Partial<ConnectionConfig>,
  configPath = defaultConfigPath(node),
): ConnectionConfig {
  const config = { ...loadOrCreateConfig(node, configPath), ...patch };
  node.fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return config;
}
