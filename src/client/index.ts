/**
 * melvor-script: play Melvor Idle by writing TypeScript.
 *
 *   import { run, Trees, Items } from 'melvor-script';
 *
 *   // await style: each call resolves when you can act again
 *   run(async (m) => {
 *     while (m.bank.count(Items.Oak_Logs) < 100) await m.skills.woodcutting.cut(Trees.Oak);
 *   });
 *
 *   // loop style (Adventure Land): check state every tick, act when ready
 *   run((m) => {
 *     setInterval(() => {
 *       if (!m.ready) return;
 *       m.skills.woodcutting.cut(Trees.Oak);
 *     }, 100);
 *   });
 */
import { connect, type Melvor } from './melvor.ts';
import type { ConnectOptions } from './connection.ts';
import { MelvorError } from './errors.ts';

export * from './melvor.ts';
export * from './errors.ts';
export { Connection, type ConnectOptions } from './connection.ts';
export * from '../shared/ids.generated.ts';
export type * from '../shared/protocol.ts';

/**
 * Connect, run `main`, and handle the plumbing a script needs: readable errors, Ctrl+C,
 * and the in-game Stop button (which ends the script).
 *
 * The script ends when `main` has returned and nothing is left scheduled: no timers or
 * intervals, no pending calls, no `m.on` / `m.onState` listeners. So a `setInterval` loop
 * runs until you stop it, and a plain `async` script exits when it's done.
 *
 * An action you fire without awaiting that fails doesn't kill the loop: it prints a
 * warning (repeats are summarised). Errors thrown by your own code still stop the script.
 */
export function run(main: (m: Melvor) => unknown | Promise<unknown>, opts: ConnectOptions = {}): void {
  void (async () => {
    let m: Melvor;
    try {
      m = await connect(opts);
    } catch (e) {
      printError(e);
      process.exit(1);
    }
    let quitting = false;
    const quit = (code: number) => {
      if (quitting) return;
      quitting = true;
      void m.close().finally(() => process.exit(code));
    };
    process.once('SIGINT', () => {
      console.error('\n■ interrupted: cancelling jobs');
      quit(130);
    });
    m._listen('stopAll', (e) => {
      console.error(`■ stopped from the game: ${e.type === 'stopAll' ? e.reason : ''}`);
      quit(2);
    });
    m.connection.onClose((reason) => {
      if (quitting) return;
      console.error(`■ lost connection to the game: ${reason}`);
      process.exit(3);
    });
    const strays = new StrayWarnings();
    process.on('unhandledRejection', (reason) => {
      if (quitting) return;
      if (reason instanceof MelvorError && reason.code !== 'DISCONNECTED') {
        strays.report(reason);
        return;
      }
      printError(reason);
      quit(1);
    });
    process.on('uncaughtException', (e) => {
      if (quitting) return;
      printError(e);
      quit(1);
    });

    try {
      await main(m);
    } catch (e) {
      printError(e);
      quit(1);
      return;
    }
    // main() returned. Keep running while the script still has something scheduled.
    process.once('beforeExit', () => quit(0));
    m.connection.setBackground(true, () => m._holds);
  })();
}

/** Failed fire-and-forget actions: one line per distinct message, repeats summarised. */
class StrayWarnings {
  private seen = new Map<string, { count: number; last: number }>();
  private cooldownHinted = false;

  report(e: MelvorError) {
    if (e.code === 'COOLDOWN' || e.code === 'BUSY') {
      // The loop called an action while not ready: harmless, but say so once.
      if (!this.cooldownHinted) {
        this.cooldownHinted = true;
        console.error(`⚠ ${e.message}\n  (further calls made while not ready are ignored silently)`);
      }
      return;
    }
    const key = `${e.code}:${e.message}`;
    const now = Date.now();
    const s = this.seen.get(key) ?? { count: 0, last: 0 };
    s.count++;
    if (now - s.last >= 5000) {
      console.error(`⚠ ${e.name} [${e.code}]: ${e.message}${s.count > 1 ? `  (×${s.count})` : ''}`);
      if (s.count === 1) {
        const frames = userFrames(e);
        if (frames.length) console.error(frames.slice(0, 2).join('\n'));
      }
      s.last = now;
      s.count = 0;
    }
    this.seen.set(key, s);
  }
}

function userFrames(e: Error): string[] {
  // Only the frames from your own code: the call site is captured when the request is made.
  return (e.stack ?? '')
    .split('\n')
    .slice(1)
    .filter((l) => !/node_modules|node:internal|[\\/]src[\\/]client[\\/]/.test(l));
}

function printError(e: unknown) {
  if (e instanceof MelvorError) {
    console.error(`✖ ${e.name} [${e.code}]: ${e.message}`);
    if (e.missing) for (const [id, n] of Object.entries(e.missing)) console.error(`    missing ${n} x ${id}`);
    const frames = userFrames(e);
    if (frames.length) console.error(frames.join('\n'));
  } else {
    console.error('✖', e);
  }
}

export { connect };
