import type { ActionController } from '../actions.ts';
import type { ClickController } from '../clicks.ts';
import type { RuntimeEnv } from '../env.ts';
import type { RpcServer } from '../rpc-server.ts';
import type { CombatController } from './combat.ts';

export interface ApiContext {
  env: RuntimeEnv;
  rpc: RpcServer;
  /** Real-time jobs (normal gamemodes). */
  actions: ActionController;
  /** Instant actions + cooldown (gamemodes with instant actions, e.g. Scripted). */
  clicks: ClickController;
  combat: CombatController;
  /** Push pending state diffs to clients right now. */
  flushState(): void;
  /** "Allow eval" setting (config.json `allowEval`). */
  evalAllowed(): boolean;
  log(level: 'info' | 'warn' | 'error' | 'success', message: string, source: string): void;
}

export function num(v: unknown, name: string, { min = -Infinity, int = false } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) {
    throw new TypeError(
      `${name} must be ${int ? 'an integer' : 'a number'}${min > -Infinity ? ` >= ${min}` : ''}, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}
