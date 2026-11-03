import { RpcError } from '../env.ts';
import { toJSONSafe } from '../serialize.ts';
import type { ApiContext } from './context.ts';

/**
 * `debug.eval` - run JavaScript inside the game and get JSON back.
 * The Steam build ships with devtools disabled, so this is the console.
 * `code` may be an expression (`game.woodcutting.level`) or a function body
 * with `return` / `await`.
 *
 * It runs with Node access, so it's off until the player turns on "Allow eval" in
 * Mod Settings → Melvor Script. Scripts don't need it: the typed API covers play.
 */
export const EVAL_OFF_MESSAGE =
  'eval is turned off. To use it, turn on "Allow eval" in the game: sidebar → Mod Settings → Melvor Script.';

export function registerDebug(api: ApiContext) {
  const { rpc, env } = api;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as FunctionConstructor;

  rpc.register('debug.eval', async (p: { code: string; depth?: number }) => {
    if (!api.evalAllowed()) throw new RpcError('FORBIDDEN', EVAL_OFF_MESSAGE);
    if (typeof p.code !== 'string') throw new RpcError('BAD_REQUEST', 'code must be a string');
    const params = ['game', 'env', 'require'];
    let fn: (...args: unknown[]) => Promise<unknown>;
    try {
      fn = new AsyncFunction(...params, `return (${p.code}\n);`) as never;
    } catch {
      fn = new AsyncFunction(...params, p.code) as never;
    }
    const nodeRequire = (globalThis as { require?: unknown }).require;
    const value = await fn(env.game, env, nodeRequire);
    return toJSONSafe(value, typeof p.depth === 'number' ? p.depth : 2);
  });
}
