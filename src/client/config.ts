import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT } from '../shared/protocol.ts';

export interface ConnectionConfig {
  host: string;
  port: number;
  token: string;
  devRuntime?: string;
}

export function configPath(): string {
  return process.env.MELVOR_SCRIPT_CONFIG ?? join(homedir(), '.melvor-scripting', 'config.json');
}

export function readConfigFile(): Partial<ConnectionConfig> | null {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** Resolve host/port/token from env vars, falling back to the config file the game writes. */
export function resolveConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const file = readConfigFile() ?? {};
  const token = overrides.token ?? process.env.MELVOR_SCRIPT_TOKEN ?? file.token;
  if (!token) {
    throw new Error(
      `No connection token found at ${configPath()}.\n` +
        `Start Melvor Idle with the "Melvor Script" mod enabled and load a character once: the game creates this file.`,
    );
  }
  return {
    host: overrides.host ?? process.env.MELVOR_SCRIPT_HOST ?? file.host ?? '127.0.0.1',
    port:
      overrides.port ??
      (process.env.MELVOR_SCRIPT_PORT ? Number(process.env.MELVOR_SCRIPT_PORT) : undefined) ??
      file.port ??
      DEFAULT_PORT,
    token,
  };
}

/** Used by `bun run dev` to point the game at the locally built runtime. */
export function setDevRuntime(path: string | undefined) {
  const file = readConfigFile() ?? {};
  if (path === undefined) delete file.devRuntime;
  else file.devRuntime = path;
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(file, null, 2));
}
