#!/usr/bin/env bun
/**
 * melvor CLI:  `bun run melvor <command>` in this repo, `bunx melvor <command>` where it is installed
 *
 *   init                   set up this folder for writing scripts (after bun add github:c3d-gg/melvor-script)
 *   status                 connection + character summary
 *   eval <js>              run JavaScript inside the game, print the result
 *   repl                   interactive shell with `m` (the API) and `.game <js>`
 *   watch                  stream game events (level ups, jobs, logs)
 *   gen-types              regenerate typed ids from the running game (includes mods)
 *   stop                   cancel all jobs and stop the current action
 *   script-mode [on|off]   show or set Script Mode
 *   reload                 hot-reload the in-game runtime
 *   use-bundled            stop loading the runtime from disk (undo `bun run dev`)
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import repl from 'node:repl';
import { inspect } from 'node:util';
import { connect, MelvorError, type Melvor } from '../client/index.ts';
import { configPath, setDevRuntime } from '../client/config.ts';
import { generateIdsModule } from '../shared/gen-ids.ts';
import { init } from './init.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [cmd = 'help', ...rest] = process.argv.slice(2);

const HELP = `usage: melvor <command>   (bun run melvor … in this repo, bunx melvor … where it is installed)

  init                   set up this folder for writing scripts (scripts/hello.ts, tsconfig, VS Code F5)
  status                 connection + character summary
  eval <js>              run JavaScript inside the game, print the result
  repl                   interactive shell: \`m\` is the API, \`.game <js>\` evaluates in the game
  watch                  stream game events (level ups, jobs, script logs)
  gen-types              regenerate typed ids from the running game (includes mods)
  stop                   cancel all jobs and stop the current action
  script-mode [on|off]   show or set Script Mode
  reload                 hot-reload the in-game runtime
  use-bundled            stop loading the runtime from disk (undo \`bun run dev\`)
`;

async function withGame<T>(fn: (m: Melvor) => Promise<T>): Promise<T> {
  const m = await connect({ name: `cli:${cmd}` });
  try {
    return await fn(m);
  } finally {
    await m.close();
  }
}

const show = (v: unknown) => console.log(inspect(v, { depth: 6, colors: process.stdout.isTTY, maxArrayLength: 200 }));

async function main() {
  switch (cmd) {
    case 'status':
      return withGame(async (m) => {
        const info = await m.info();
        const s = m.state;
        console.log(`connected to runtime ${info.runtimeVersion} (${info.runtimeSource}), protocol v${info.protocol}`);
        console.log(
          `character: ${s.meta.characterName}  gamemode: ${s.meta.gamemode}  script mode: ${s.meta.scriptMode ? 'ON' : 'off'}`,
        );
        console.log(
          s.meta.instant
            ? `actions: instant, cooldown = normal time ÷ ${s.meta.speed}${m.cooldown ? `  (cooling down: ${m.cooldown}ms)` : ''}`
            : 'actions: real-time (normal speed)',
        );
        console.log(
          `hp ${s.player.hp}/${s.player.maxHp}  combat lvl ${s.player.combatLevel}  gp ${m.gp.toLocaleString()}  bank ${s.bankSpace.used}/${s.bankSpace.max}`,
        );
        console.log(
          `action: ${s.action.type ?? 'idle'}${s.action.id ? ` (${s.action.id})` : ''}${s.action.jobs.length ? `  jobs: ${s.action.jobs.length}` : ''}`,
        );
        const skills = Object.entries(s.skills)
          .filter(([, v]) => v.unlocked)
          .map(([, v]) => `${v.name} ${v.level}`)
          .join('  ');
        console.log(`skills: ${skills}`);
        console.log(`clients: ${info.clients.map((c) => c.name).join(', ')}`);
      });

    case 'eval': {
      const code = rest.join(' ');
      if (!code) throw new Error('usage: melvor eval "<javascript>"');
      return withGame(async (m) => show(await m.eval(code, 3)));
    }

    case 'repl': {
      const m = await connect({ name: 'repl' });
      console.log(
        `connected as "${m.name}". \`m\` is the API (try m.skills.woodcutting.level, await m.bank.sell(...)).`,
      );
      console.log('`.game <js>` evaluates inside the game. Ctrl+D to exit.');
      const r = repl.start({ prompt: 'melvor> ', useGlobal: false });
      r.context.m = m;
      r.defineCommand('game', {
        help: 'Evaluate JavaScript inside the game',
        action(code: string) {
          this.clearBufferedCommand();
          m.eval(code, 3)
            .then((v) => show(v))
            .catch((e) => console.error(e instanceof MelvorError ? `${e.code}: ${e.message}` : e))
            .finally(() => this.displayPrompt());
        },
      });
      r.on('exit', () => void m.close().then(() => process.exit(0)));
      return;
    }

    case 'watch': {
      const m = await connect({ name: 'watch' });
      console.log('watching game events (Ctrl+C to stop)…');
      const t = () => new Date().toLocaleTimeString();
      m.on('levelUp', (e) =>
        console.log(`${t()}  ⬆ ${m.state.skills[e.skill]?.name ?? e.skill} ${e.oldLevel} → ${e.newLevel}`),
      );
      m.on('jobStarted', (e) =>
        console.log(
          `${t()}  ▶ job ${e.job.jobId} ${e.job.skill} ${e.job.targets.join(',')} x${e.job.requested ?? '∞'} (${e.job.owner})`,
        ),
      );
      m.on('jobFinished', (e) =>
        console.log(
          `${t()}  ■ job ${e.result.jobId} ${e.result.status} ${e.result.completed}/${e.result.requested ?? '∞'}${e.result.reason ? ` - ${e.result.reason}` : ''}`,
        ),
      );
      m.on('monsterKilled', (e) => console.log(`${t()}  ⚔ killed ${e.monster}`));
      m.on('stopAll', (e) => console.log(`${t()}  ■ stop all: ${e.reason}`));
      m.on('scriptMode', (e) => console.log(`${t()}  script mode ${e.enabled ? 'on' : 'off'}`));
      m.connection.onClose((r) => {
        console.log(`disconnected: ${r}`);
        process.exit(0);
      });
      process.once('SIGINT', () => void m.close().then(() => process.exit(0)));
      return;
    }

    case 'gen-types':
      return withGame(async (m) => {
        const reg = await m.connection.call('data.registries');
        const out = join(ROOT, 'src', 'shared', 'ids.generated.ts');
        writeFileSync(
          out,
          generateIdsModule(reg, `live game (${m.state.meta.characterName}, runtime ${m.runtimeVersion})`),
        );
        console.log(
          `wrote ${out}: ${reg.items?.length ?? 0} items, ${reg.monsters?.length ?? 0} monsters, ${Object.keys(reg).length} registries`,
        );
      });

    case 'init':
      console.log(`setting up ${process.cwd()} for melvor-script:`);
      return init(process.cwd(), ROOT);

    case 'stop':
      return withGame(async (m) => show(await m.stopAll('stopped from the CLI')));

    case 'script-mode':
      return withGame(async (m) => {
        if (rest[0] === 'on' || rest[0] === 'off') await m.setScriptMode(rest[0] === 'on');
        console.log(`script mode: ${m.state.meta.scriptMode ? 'ON' : 'off'}`);
      });

    case 'reload':
      return withGame(async (m) => {
        await m.reloadRuntime();
        console.log('runtime reload requested');
      });

    case 'use-bundled':
      setDevRuntime(undefined);
      console.log(
        `cleared devRuntime in ${configPath()}; the game loads the runtime bundled in the mod (after \`bun run melvor reload\` or a restart)`,
      );
      return;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof MelvorError ? `✖ [${e.code}] ${e.message}` : e instanceof Error ? `✖ ${e.message}` : e);
  process.exit(1);
});
