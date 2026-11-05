/**
 * Instant mode (gamemodes with enableInstantActions, e.g. Scripted): every action is a click
 * that happens at once, followed by a shared cooldown of (interval / speed).
 * Fake intervals: woodcutting 500ms, thieving 500ms + 300ms stun, attacks 600ms; speed 10.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime, type Runtime } from '../src/runtime/index.ts';
import type { SettingsBridge } from '../src/runtime/env.ts';
import { connect, ActionStoppedError, MelvorError, type Melvor } from '../src/client/index.ts';
import { Action, FakeGame, fakeClasses } from './fake-game.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'y'.repeat(48);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'melvor-script-instant-'));
const configPath = path.join(tmp, 'config.json');
let port = 0;

let game: FakeGame;
let rt: Runtime;
let ticker: ReturnType<typeof setInterval>;
let clients: Melvor[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until(): timed out');
    await sleep(5);
  }
}
const item = (id: string) => game.items.getObjectByID(id)!;
const logs = () => game.bank.getQty(item('test:Oak_Logs'));
const storage = () => {
  const m = new Map<string, unknown>();
  return {
    getItem: (k: string) => m.get(k),
    setItem: (k: string, v: unknown) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

function makeRuntime(
  g: FakeGame,
  { settings, ...extra }: { rateLimit?: { perSecond: number; burst: number }; settings?: SettingsBridge } = {},
) {
  return createRuntime({
    game: g,
    classes: fakeClasses,
    ctx: { namespace: 'scriptable', characterStorage: storage() },
    node: { http, crypto, fs, path, os, Buffer },
    runtimeSource: 'test',
    configPath,
    hud: false,
    settings,
    timing: { statePushMs: 20, speed: 10, ...extra },
  });
}

async function client(name = 'test') {
  const m = await connect({ host: '127.0.0.1', port, token: TOKEN, name });
  clients.push(m);
  return m;
}

before(async () => {
  port = await new Promise<number>((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  // Fresh config each test (the settings tests write to it).
  fs.writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port, token: TOKEN }));
  game = new FakeGame();
  game.currentGamemode.enableInstantActions = true;
  rt = makeRuntime(game);
  await rt.start();
  ticker = setInterval(() => {
    for (let i = 0; i < 3; i++) game.tick();
  }, 2);
});

afterEach(async () => {
  clearInterval(ticker);
  for (const m of clients) await m.close().catch(() => {});
  clients = [];
  await rt.dispose();
});

describe('instant skills', () => {
  it('a click is instant and resolves when the cooldown (interval / speed) is over', async () => {
    const m = await client();
    assert.equal(m.instant, true);
    assert.equal(m.speed, 10);
    assert.equal(m.scriptMode, true);
    const t0 = Date.now();
    const r = await m.skills.get('test:Woodcutting').act('test:Oak');
    const took = Date.now() - t0;
    assert.equal(r.completed, 1);
    assert.equal(r.actions, 1);
    assert.deepEqual(r.items, { 'test:Oak_Logs': 1 });
    assert.equal(r.xp['test:Woodcutting'], 15);
    assert.ok(took >= 45, `resolved after ${took}ms, expected the 50ms cooldown`);
    assert.equal(m.ready, true);
    assert.equal(game.woodcutting.isActive, false);
    assert.equal(m.state.action.cooldownMs, 50);
  });

  it('nothing idles: one click is one action', async () => {
    const m = await client();
    await m.skills.get('test:Woodcutting').act('test:Oak');
    await sleep(120);
    assert.equal(logs(), 1);
    assert.equal(game.woodcutting.isActive, false);
  });

  it("clicks don't make the game save after every action; everything else still does", async () => {
    // skill.stop() calls game.scheduleSave(), and the game saves on the next tick: at speed 50 that was
    // ~10 full saves a second, which grew the game's memory until it crashed. The timed autosave covers clicks.
    const m = await client();
    const wc = m.skills.get('test:Woodcutting');
    for (let i = 0; i < 3; i++) await wc.act('test:Oak');
    assert.equal(logs(), 3);
    assert.equal(game.saveRequests, 0);
    game.scheduleSave();
    assert.equal(game.saveRequests, 1);
    // Unloading the runtime puts the game's own scheduleSave back.
    await rt.dispose();
    assert.equal(Object.prototype.hasOwnProperty.call(game, 'scheduleSave'), false);
    rt = makeRuntime(game);
    await rt.start();
  });

  it('acting during the cooldown fails at once: locally (COOLDOWN) and in the game', async () => {
    const m = await client();
    // A raw call returns right after the click, so the cooldown is still running.
    const first = await m.connection.call('action.act', { skill: 'test:Woodcutting', targets: ['test:Oak'], count: 1 });
    assert.ok((first.readyInMs ?? 0) > 30);
    assert.equal(m.ready, false);
    assert.ok(m.cooldown > 0);
    await assert.rejects(m.skills.get('test:Woodcutting').act('test:Oak'), (e: MelvorError) => e.code === 'COOLDOWN');
    await assert.rejects(
      m.connection.call('action.act', { skill: 'test:Woodcutting', targets: ['test:Oak'], count: 1 }),
      (e: MelvorError) => {
        assert.equal(e.code, 'COOLDOWN');
        assert.ok((e.data as { readyInMs: number }).readyInMs > 0);
        return true;
      },
    );
    assert.equal(logs(), 1);
    await m.whenReady({ timeoutMs: 1000 });
    await m.skills.get('test:Woodcutting').act('test:Oak');
    assert.equal(logs(), 2);
  });

  it('a second call while one is in flight is refused (BUSY)', async () => {
    const m = await client();
    const p = m.skills.get('test:Woodcutting').act('test:Oak');
    await assert.rejects(m.skills.get('test:Woodcutting').act('test:Oak'), (e: MelvorError) => e.code === 'BUSY');
    await p;
    assert.equal(logs(), 1);
  });

  it('count = several clicks spaced by the cooldown, in one request', async () => {
    const m = await client();
    const t0 = Date.now();
    const r = await m.skills.get('test:Woodcutting').act('test:Oak', { count: 4 });
    assert.equal(r.completed, 4);
    assert.deepEqual(r.items, { 'test:Oak_Logs': 4 });
    assert.ok(Date.now() - t0 >= 4 * 45, 'four cooldowns');
  });

  it('"actions per click" bonuses: more actions, same cooldown', async () => {
    const m = await client();
    game.actionsPerClick = 2;
    const r = await m.skills.get('test:Woodcutting').act('test:Oak');
    assert.equal(r.completed, 1);
    assert.equal(r.actions, 3);
    assert.equal(logs(), 3);
    assert.equal(m.state.action.cooldownMs, 50);
  });

  it('a failed pickpocket adds the stun to the cooldown', async () => {
    const m = await client();
    game.thieving.failNext = 1;
    await m.skills.get('test:Thieving').act('test:Man');
    assert.equal(m.state.action.cooldownMs, 80); // (500 + 300) / 10
    await m.skills.get('test:Thieving').act('test:Man');
    assert.equal(m.state.action.cooldownMs, 50);
    assert.equal(game.thieving.isStunned, false);
  });

  it('a batch ends early with a reason when materials run out', async () => {
    const m = await client();
    game.bank.addItem(item('test:Copper_Ore'), 2);
    await assert.rejects(
      m.skills.get('test:Smithing').act('test:Bronze_Bar', { count: 5 }),
      (e: ActionStoppedError) => {
        assert.equal(e.result.status, 'stopped');
        assert.equal(e.result.completed, 2);
        assert.match(e.result.reason ?? '', /out of materials/);
        return true;
      },
    );
    await assert.rejects(
      m.skills.get('test:Smithing').act('test:Bronze_Bar'),
      (e: MelvorError) => e.code === 'MISSING_ITEMS',
    );
  });

  it('scripted clicks skip the "Out of Actions!" joke popup; the player\'s own clicks keep it', async () => {
    const g = globalThis as { showActionsRunOutSwal?: () => void };
    let rolls = 0;
    const joke = () => void rolls++;
    g.showActionsRunOutSwal = joke;
    try {
      const m = await client();
      await m.skills.get('test:Woodcutting').act('test:Oak');
      await m.skills.get('test:Woodcutting').act('test:Oak', { count: 3 });
      assert.equal(rolls, 0, 'no rolls for scripted clicks');
      assert.equal(g.showActionsRunOutSwal, joke, 'the game function is put back after each click');

      await m.whenReady({ timeoutMs: 1000 });
      game.woodcutting.activeTrees.add(game.woodcutting.actions.getObjectByID('test:Oak')!);
      assert.equal(game.woodcutting.start(), true); // a click in the game UI
      assert.equal(rolls, 1, 'the player still gets the roll');
    } finally {
      delete g.showActionsRunOutSwal;
    }
  });

  it("the player's own clicks share the cooldown", async () => {
    const m = await client();
    const oak = game.woodcutting.actions.getObjectByID('test:Oak')!;
    game.woodcutting.activeTrees.add(oak);
    assert.equal(game.woodcutting.start(), true);
    assert.equal(logs(), 1);
    game.woodcutting.activeTrees.add(oak);
    assert.equal(game.woodcutting.start(), false, 'second click during the cooldown does nothing');
    assert.equal(logs(), 1);
    assert.equal(game.woodcutting.activeTrees.size, 0, 'the blocked click leaves nothing selected');
    await until(() => !m.ready);
    await assert.rejects(m.skills.get('test:Woodcutting').act('test:Oak'), (e: MelvorError) => e.code === 'COOLDOWN');
    await m.whenReady({ timeoutMs: 1000 });
    await m.skills.get('test:Woodcutting').act('test:Oak');
    assert.equal(logs(), 2);
  });

  it('a skill left running by an old save is stopped, and its timer never pays out', async () => {
    await rt.dispose();
    const g = new FakeGame();
    g.currentGamemode.enableInstantActions = true;
    g.woodcutting.activeTrees.add(g.woodcutting.actions.getObjectByID('test:Oak')!);
    g.woodcutting.isActive = true;
    g.woodcutting.startActionTimer();
    game = g;
    rt = makeRuntime(g);
    await rt.start();
    assert.equal(g.woodcutting.isActive, false);
    // Even if a stray timer fires, action() outside a click does nothing.
    g.woodcutting.actionTimer.start(50);
    await sleep(40);
    assert.equal(g.bank.getQty(g.items.getObjectByID('test:Oak_Logs')!), 0);
  });
});

describe('instant combat', () => {
  it('attack() is one turn: you act, then the enemy acts', async () => {
    const m = await client();
    await assert.rejects(m.combat.attack(), (e: MelvorError) => e.code === 'NOT_READY');
    await m.combat.start('test:Chicken' as never);
    const r = await m.combat.attack(); // waits for the spawn
    assert.equal(r.actions, 1);
    assert.equal(r.enemyHp, 2);
    assert.equal(game.combat.playerActs, 1);
    assert.equal(game.combat.enemyActs, 1);
    assert.equal(m.state.action.cooldownMs, 60); // 600 / 10
    // Nothing happens between clicks.
    await sleep(60);
    assert.equal(game.combat.playerActs, 1);
  });

  it('fight N kills: attack clicks until they die, loot collected, then leave combat', async () => {
    const m = await client();
    const r = await m.combat.fight('test:Chicken' as never, { kills: 2 });
    assert.equal(r.kills, 2);
    assert.equal(r.attacks, 6); // 3 HP each
    assert.deepEqual(r.items, { 'test:Bones': 2 });
    assert.equal(game.bank.getQty(item('test:Bones')), 2);
    assert.equal(game.combat.isActive, false, 'leaves combat once the kills are done, like real-time fights');
  });

  it('a kill registers within the click that dealt it', async () => {
    const m = await client();
    await m.combat.start('test:Chicken' as never);
    await m.combat.attack();
    await m.combat.attack();
    const r = await m.combat.attack();
    assert.equal(r.kills, 1);
    assert.deepEqual(m.combat.loot, { 'test:Bones': 1 });
    assert.deepEqual((await m.combat.collectLoot()).items, { 'test:Bones': 1 });
  });

  it("the player's Attack button respects the cooldown", async () => {
    const m = await client();
    await m.combat.start('test:Chicken' as never);
    await until(() => game.combat.fightInProgress);
    const press = () => {
      game.combat.player.actOnClick();
      game.combat.enemy.actOnClick();
    };
    press();
    assert.deepEqual([game.combat.playerActs, game.combat.enemyActs], [1, 1]);
    await sleep(0);
    press(); // a new press during the cooldown: neither side acts
    assert.deepEqual([game.combat.playerActs, game.combat.enemyActs], [1, 1]);
    // Scripts learn about the player's clicks from the next state push.
    await until(() => !m.ready);
    await m.whenReady({ timeoutMs: 1000 });
    press();
    assert.deepEqual([game.combat.playerActs, game.combat.enemyActs], [2, 2]);
  });

  it('enemies respawn `speed` times faster', async () => {
    await client();
    assert.equal(game.combat.player.getMonsterSpawnTime(), 300);
  });
});

describe('pacing', () => {
  it('refuses floods of calls (rate limit)', async () => {
    await rt.dispose();
    game = new FakeGame();
    game.currentGamemode.enableInstantActions = true;
    rt = makeRuntime(game, { rateLimit: { perSecond: 5, burst: 5 } });
    await rt.start();
    const m = await client();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => m.connection.call('runtime.info')));
    const limited = results.filter((r) => r.status === 'rejected' && (r.reason as MelvorError).code === 'RATE_LIMITED');
    assert.ok(limited.length >= 5, `${limited.length} refused`);
  });

  it('a setInterval script runs until it stops itself; stray failures only warn', async () => {
    const script = path.join(tmp, 'loop.ts');
    fs.writeFileSync(
      script,
      `import { run } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'client', 'index.ts')).href)};
run((m) => {
  let clicks = 0;
  m.skills.get('test:Woodcutting').act('test:Yew'); // locked: fire-and-forget failure
  const t = setInterval(() => {
    if (!m.ready) return;
    m.skills.get('test:Woodcutting').act('test:Oak');
    if (++clicks >= 3) clearInterval(t);
  }, 5);
});
`,
    );
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: {
        ...process.env,
        MELVOR_SCRIPT_HOST: '127.0.0.1',
        MELVOR_SCRIPT_PORT: String(port),
        MELVOR_SCRIPT_TOKEN: TOKEN,
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => (child.kill(), reject(new Error(`script didn't exit. stderr:\n${stderr}`))),
        15000,
      );
      child.on('exit', (c) => (clearTimeout(timer), resolve(c)));
    });
    assert.equal(code, 0, stderr);
    assert.equal(logs(), 3);
    assert.match(stderr, /LOCKED/);
  });
});

describe('settings (Mod Settings → Melvor Script)', () => {
  it('Speed is shown in the settings window, changes the cooldown live and is saved to config.json', async () => {
    await rt.dispose();
    const shown = new Map<string, unknown>();
    rt = makeRuntime(game, { settings: { get: (n) => shown.get(n), set: (n, v) => void shown.set(n, v) } });
    await rt.start();
    // config.json is the source of truth: its values are copied into the window at start.
    assert.equal(shown.get('speed'), 10);
    assert.equal(shown.get('allowEval'), false);

    const m = await client();
    rt.settingChanged('speed', 5);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).speed, 5);
    await m.waitFor((s) => s.meta.speed === 5, { timeoutMs: 1000 });
    await m.skills.get('test:Woodcutting').act('test:Oak');
    assert.equal(m.state.action.cooldownMs, 100); // 500ms / 5

    rt.settingChanged('speed', 1e6); // clamped like the config file
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).speed, 1000);
    // The rest of the file is kept.
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).token, TOKEN);
  });
});

describe('unlocks', () => {
  it('an action locked by more than level (e.g. a Cartography discovery) is listed as locked and refused with the reason', async () => {
    const tree = new Action('test:Ritual', 'Ritual Tree', 1, 10, item('test:Oak_Logs'));
    tree.requirements = [{ type: 'CartographyPOIDiscovery', met: false }];
    game.woodcutting.actions.register(tree);
    const m = await client();
    const wc = m.skills.get('test:Woodcutting');
    assert.equal((await wc.actions(true)).find((a) => a.id === 'test:Ritual')?.unlocked, false);
    await assert.rejects(
      wc.act('test:Ritual'),
      (e: MelvorError) => e.code === 'LOCKED' && /CartographyPOIDiscovery/.test(e.message),
    );
    assert.equal(logs(), 0);

    tree.requirements[0]!.met = true;
    assert.equal((await wc.actions(true)).find((a) => a.id === 'test:Ritual')?.unlocked, true);
  });
});

describe('realms', () => {
  it("an action in a realm you haven't unlocked (Into the Abyss) is listed as locked and refused", async () => {
    const realm = { id: 'test:Eternal', name: 'Eternal Realm', isUnlocked: false };
    const tree = new Action('test:Starwood', 'Starwood Tree', 0, 10, item('test:Oak_Logs'));
    (tree as unknown as { realm: unknown }).realm = realm;
    game.woodcutting.actions.register(tree);
    const m = await client();
    const wc = m.skills.get('test:Woodcutting');
    const listed = (await wc.actions(true)).find((a) => a.id === 'test:Starwood');
    assert.equal(listed?.unlocked, false);
    assert.equal(listed?.realm, 'test:Eternal');
    await assert.rejects(
      wc.act('test:Starwood'),
      (e: MelvorError) => e.code === 'LOCKED' && /Eternal Realm, which you haven't unlocked/.test(e.message),
    );
    assert.equal(logs(), 0);

    realm.isUnlocked = true;
    assert.equal((await wc.actions(true)).find((a) => a.id === 'test:Starwood')?.unlocked, true);
  });
});
