/**
 * End-to-end: real WebSocket server + RPC + ActionController inside the runtime,
 * driven by the real client SDK, against a fake game that ticks 25x faster than real time.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { createRuntime, type Runtime } from '../src/runtime/index.ts';
import {
  connect,
  ActionStoppedError,
  MelvorError,
  type CropId,
  type FarmingPlotId,
  type Melvor,
} from '../src/client/index.ts';
import { FakeGame, MELVOR_REALM, fakeClasses } from './fake-game.ts';

const TOKEN = 'x'.repeat(48);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'melvor-script-test-'));
const configPath = path.join(tmp, 'config.json');
let port = 0;

let game: FakeGame;
let rt: Runtime;
let ticker: ReturnType<typeof setInterval>;
let clients: Melvor[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until cond() is true (timer resolution on Windows is ~15ms, so avoid exact sleeps). */
async function until(cond: () => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until(): timed out');
    await sleep(5);
  }
}
const logs = () => game.bank.getQty(game.items.getObjectByID('test:Oak_Logs')!);
const storage = () => {
  const m = new Map<string, unknown>();
  return {
    getItem: (k: string) => m.get(k),
    setItem: (k: string, v: unknown) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

async function client(name = 'test') {
  const m = await connect({ host: '127.0.0.1', port, token: TOKEN, name });
  clients.push(m);
  return m;
}

before(async () => {
  // Grab a free port.
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
  // Fresh config each test (settings tests write to it).
  fs.writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port, token: TOKEN }));
  game = new FakeGame();
  rt = createRuntime({
    game,
    classes: fakeClasses,
    ctx: { namespace: 'scriptable', characterStorage: storage() },
    node: { http, crypto, fs, path, os, Buffer },
    runtimeSource: 'test',
    configPath,
    hud: false,
    timing: { graceMs: 40, busyPollMs: 5, statePushMs: 20 },
  });
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

describe('connection security', () => {
  it('rejects a wrong token', async () => {
    await assert.rejects(connect({ host: '127.0.0.1', port, token: 'nope' }), /bad token/);
  });

  it('rejects browsers (any Origin header)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: 'https://evil.example' });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    ws.terminate();
    assert.equal(status, 403);
  });

  it('serves /status without a token but not to browsers', async () => {
    const get = (headers: Record<string, string>) =>
      new Promise<number>((resolve) =>
        http.get(
          { host: '127.0.0.1', port, path: '/status', headers },
          (res) => (res.resume(), resolve(res.statusCode ?? 0)),
        ),
      );
    assert.equal(await get({}), 200);
    assert.equal(await get({ origin: 'https://evil.example' }), 403);
  });
});

describe('state sync', () => {
  it('hello delivers a full snapshot', async () => {
    const m = await client();
    assert.equal(m.state.meta.characterName, 'Tester');
    assert.equal(m.state.skills['test:Woodcutting'].level, 1);
    assert.deepEqual(m.state.bank, {});
  });

  it('state reflects changes made in the game', async () => {
    const m = await client();
    game.bank.addItem(game.items.getObjectByID('test:Copper_Ore')!, 7);
    await m.waitFor((s) => s.bank['test:Copper_Ore'] === 7, { timeoutMs: 1000 });
  });

  it('eval is refused until "Allow eval" is turned on', async () => {
    const m = await client();
    await assert.rejects(m.eval('1 + 1'), (e: MelvorError) => e.code === 'FORBIDDEN' && /Allow eval/.test(e.message));
  });

  it('eval runs code in the game once allowed (and the choice is saved)', async () => {
    rt.settingChanged('allowEval', true);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).allowEval, true);
    const m = await client();
    assert.equal(await m.eval('game.characterName'), 'Tester');
    assert.equal(await m.eval('const a = 2; return a * 21;'), 42);
    rt.settingChanged('allowEval', false);
    await assert.rejects(m.eval('1 + 1'), /FORBIDDEN|Allow eval/);
  });
});

describe('skill jobs', () => {
  it('performs exactly `count` actions and reports gains', async () => {
    const m = await client();
    const r = await m.skills.get('test:Woodcutting').act('test:Oak', { count: 3 });
    assert.equal(r.status, 'completed');
    assert.equal(r.completed, 3);
    assert.deepEqual(r.items, { 'test:Oak_Logs': 3 });
    assert.equal(r.xp['test:Woodcutting'], 45);
    // State was flushed before the reply: synchronous read is already up to date.
    assert.equal(m.bank.count('test:Oak_Logs' as never), 3);
  });

  it('chains back-to-back jobs without restarting the timer', async () => {
    const m = await client();
    let starts = 0;
    const proto = Object.getPrototypeOf(game.woodcutting);
    const orig = proto.start;
    proto.start = function (this: unknown, ...a: unknown[]) {
      starts++;
      return orig.apply(this, a);
    };
    try {
      const wc = m.skills.get('test:Woodcutting');
      for (let i = 0; i < 3; i++) await wc.act('test:Oak');
      assert.equal(starts, 1);
      assert.equal(m.bank.count('test:Oak_Logs' as never), 3);
    } finally {
      proto.start = orig;
    }
  });

  it('stops after the grace period and never grants a free action', async () => {
    const m = await client();
    await m.skills.get('test:Woodcutting').act('test:Oak');
    await sleep(150); // grace (40ms) + several action intervals (~20ms each)
    assert.equal(game.woodcutting.isActive, false);
    assert.equal(game.bank.getQty(game.items.getObjectByID('test:Oak_Logs')!), 1);
  });

  it('refuses locked actions and missing materials before starting', async () => {
    const m = await client();
    await assert.rejects(m.skills.get('test:Woodcutting').act('test:Yew'), (e: MelvorError) => e.code === 'LOCKED');
    await assert.rejects(m.skills.get('test:Smithing').act('test:Bronze_Bar'), (e: MelvorError) => {
      assert.equal(e.code, 'MISSING_ITEMS');
      assert.deepEqual(e.missing, { 'test:Copper_Ore': 1 });
      return true;
    });
    assert.equal(game.smithing.isActive, false);
  });

  it('ends early with a reason when materials run out', async () => {
    const m = await client();
    game.bank.addItem(game.items.getObjectByID('test:Copper_Ore')!, 2);
    await assert.rejects(
      m.skills.get('test:Smithing').act('test:Bronze_Bar', { count: 5 }),
      (e: ActionStoppedError) => {
        assert.equal(e.result.status, 'stopped');
        assert.equal(e.result.completed, 2);
        assert.match(e.result.reason ?? '', /out of materials/);
        assert.deepEqual(e.result.items, { 'test:Copper_Ore': -2, 'test:Bronze_Bar': 2 });
        return true;
      },
    );
  });

  it('allowStop resolves instead of throwing', async () => {
    const m = await client();
    game.bank.addItem(game.items.getObjectByID('test:Copper_Ore')!, 1);
    const r = await m.skills.get('test:Smithing').act('test:Bronze_Bar', { count: 3, allowStop: true });
    assert.equal(r.status, 'stopped');
    assert.equal(r.completed, 1);
  });

  it('the client refuses a second action while one is running (nothing reaches the game)', async () => {
    const m = await client();
    const long = m.skills.get('test:Woodcutting').act('test:Oak', { count: 100, allowStop: true });
    assert.equal(m.ready, false);
    await assert.rejects(m.skills.get('test:Smithing').act('test:Bronze_Bar'), (e: MelvorError) => e.code === 'BUSY');
    await m.cancelJobs();
    assert.equal((await long).status, 'cancelled');
    await m.whenReady({ timeoutMs: 1000 });
    assert.equal(m.ready, true);
  });

  it('the game still lets a new job supersede the running one', async () => {
    const m = await client();
    game.bank.addItem(game.items.getObjectByID('test:Copper_Ore')!, 5);
    const long = m.skills.get('test:Woodcutting').act('test:Oak', { count: 100 });
    await sleep(30);
    // Straight to the game, past the client's own check (as another tool or a raw call would).
    const smith = m.connection.call('action.act', { skill: 'test:Smithing', targets: ['test:Bronze_Bar'], count: 1 });
    await assert.rejects(
      long,
      (e: ActionStoppedError) => e.result.status === 'cancelled' && /superseded/.test(e.result.reason ?? ''),
    );
    assert.equal((await smith).completed, 1);
  });

  it('AbortSignal cancels a job', async () => {
    const m = await client();
    const ac = new AbortController();
    const p = m.skills.get('test:Woodcutting').act('test:Oak', { count: Infinity, signal: ac.signal, allowStop: true });
    await until(() => logs() >= 1);
    ac.abort();
    const r = await p;
    assert.equal(r.status, 'cancelled');
    assert.ok(r.completed >= 1);
    await until(() => !game.woodcutting.isActive, 1000);
  });

  it('disconnecting cancels the client’s jobs and stops the skill', async () => {
    const m = await client();
    void m.skills
      .get('test:Woodcutting')
      .act('test:Oak', { count: 100 })
      .catch(() => {});
    await sleep(40);
    assert.equal(game.woodcutting.isActive, true);
    await m.close();
    await sleep(30);
    assert.equal(game.woodcutting.isActive, false);
  });
});

describe('script mode', () => {
  it('a manual start (UI click) performs exactly one action', async () => {
    rt.actions.setScriptMode(true);
    game.woodcutting.activeTrees.add(game.woodcutting.actions.getObjectByID('test:Oak')!);
    game.woodcutting.start();
    await sleep(200);
    assert.equal(game.woodcutting.isActive, false);
    assert.equal(game.bank.getQty(game.items.getObjectByID('test:Oak_Logs')!), 1);
  });

  it('without script mode the game idles normally', async () => {
    game.woodcutting.activeTrees.add(game.woodcutting.actions.getObjectByID('test:Oak')!);
    game.woodcutting.start();
    await until(() => logs() >= 3);
    assert.equal(game.woodcutting.isActive, true);
  });

  it('turning script mode on stops idle skills', async () => {
    const m = await client();
    game.woodcutting.activeTrees.add(game.woodcutting.actions.getObjectByID('test:Oak')!);
    game.woodcutting.start();
    await m.setScriptMode(true);
    assert.equal(game.woodcutting.isActive, false);
    assert.equal(m.scriptMode, true);
  });
});

describe('thieving stuns', () => {
  it('a job finishing on a stun waits for the stun to clear', async () => {
    const m = await client();
    game.thieving.failNext = 1;
    const r = await m.skills.get('test:Thieving').act('test:Man');
    assert.equal(r.completed, 1);
    assert.equal(game.thieving.isStunned, false);
  });

  it('a stun mid-job does not end the job, even with continueThievingOnStun off', async () => {
    const m = await client();
    game.thieving.failNext = 1;
    const r = await m.skills.get('test:Thieving').act('test:Man', { count: 3 });
    assert.equal(r.status, 'completed');
    assert.equal(r.completed, 3);
    assert.equal(game.settings.continueThievingOnStun, false); // restored
    assert.equal(Object.prototype.hasOwnProperty.call(game.settings, 'continueThievingOnStun'), true);
  });
});

describe('mastery', () => {
  const oak = () => game.woodcutting.actions.getObjectByID('test:Oak')!;
  const setPool = (xp: number) => game.woodcutting._masteryPoolXP.set(MELVOR_REALM, xp);

  it('reads action mastery and the pool', async () => {
    game.woodcutting.actionMastery.set(oak(), { xp: 250, level: 3 });
    setPool(100_000); // 2 trees x 500k base cap: 10%
    const m = await client();
    const wc = m.skills.get('test:Woodcutting');
    assert.deepEqual(await wc.mastery('test:Oak'), { level: 3, xp: 250, xpToNext: 50 });
    const all = await wc.masteries();
    assert.deepEqual(Object.keys(all).sort(), ['test:Oak', 'test:Yew']);
    assert.equal(all['test:Yew']!.level, 1);
    assert.deepEqual(wc.masteryPool, { xp: 100_000, cap: 1_000_000, percent: 10 });
  });

  it('spends pool XP, but not past a pool checkpoint unless told to', async () => {
    setPool(100_050); // just above the 10% checkpoint
    const m = await client();
    const wc = m.skills.get('test:Woodcutting');
    // Level 1 -> 2 costs 101 XP, which would drop the pool to 9.99%.
    await assert.rejects(wc.spendMasteryPool('test:Oak'), /below a checkpoint/);
    assert.equal(game.woodcutting.getMasteryLevel(oak()), 1);
    const r = await wc.spendMasteryPool('test:Oak', 1, { allowCheckpointLoss: true });
    assert.deepEqual(r, { level: 2, xp: 101, xpToNext: 99, spent: 101 });
    assert.equal(game.woodcutting.getMasteryPoolXP(MELVOR_REALM), 99_949);
    assert.equal(wc.masteryPool?.xp, 99_949); // state was flushed before the reply
  });

  it('refuses a short pool, a maxed action and skills without mastery', async () => {
    setPool(50);
    const m = await client();
    const wc = m.skills.get('test:Woodcutting');
    await assert.rejects(wc.spendMasteryPool('test:Oak'), /needs 101 pool XP; the pool has 50/);
    game.woodcutting.actionMastery.set(oak(), { xp: 1e7, level: 99 });
    setPool(1e7);
    await assert.rejects(wc.spendMasteryPool('test:Oak'), /already mastery level 99/);
    (game.thieving as { hasMastery: boolean }).hasMastery = false;
    await assert.rejects(m.skills.get('test:Thieving').mastery('test:Man'), /has no mastery/);
  });
});

describe('combat, bank, lifecycle', () => {
  it('fight N kills then stop', async () => {
    const m = await client();
    const r = await m.combat.fight('test:Chicken' as never, { kills: 2 });
    assert.equal(r.kills, 2);
    assert.deepEqual(r.items, { 'test:Bones': 2 });
    assert.equal(game.combat.isActive, false);
  });

  it('sells items', async () => {
    const m = await client();
    game.bank.addItem(game.items.getObjectByID('test:Oak_Logs')!, 4);
    const r = await m.bank.sell('test:Oak_Logs' as never);
    assert.deepEqual(r, { sold: 4, currency: 'melvorD:GP', gained: 20 });
    assert.equal(m.gp, 20);
    assert.equal(m.bank.count('test:Oak_Logs' as never), 0);
  });

  it('a new runtime evicts a server left behind by a previous page load', async () => {
    // Simulate NW.js: the page reloads without dispose(), but Node's `process` survives.
    await rt.dispose();
    const proc: Record<string, unknown> = {};
    const mk = () =>
      createRuntime({
        game: new FakeGame(),
        classes: fakeClasses,
        ctx: null,
        node: { http, crypto, fs, path, os, Buffer, process: proc },
        runtimeSource: 'test',
        configPath,
        hud: false,
      });
    const first = mk();
    await first.start(); // never disposed: the "old page"
    rt = mk();
    await rt.start();
    const m = await client();
    assert.equal(m.state.meta.characterName, 'Tester');
    // The old page's timers would die with it; here we clean up by hand. Must not unhook the new server.
    await first.dispose();
    assert.equal(typeof proc.__melvorScriptCloseServer, 'function');
  });

  it('dispose restores every wrapped method', async () => {
    await rt.dispose();
    for (const s of [game.woodcutting, game.smithing, game.thieving]) {
      for (const k of ['action', 'start', 'stop', 'stunned'])
        assert.equal(Object.prototype.hasOwnProperty.call(s, k), false, `${s.id}.${k}`);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(game.combat, 'stop'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(game.farming, 'growPlots'), false);
  });
});

describe('farming (real-time)', () => {
  it('crops grow in their normal time: farming speed is only for the Scripted gamemode', async () => {
    const m = await client();
    game.bank.addItem(game.items.getObjectByID('test:Potato_Seed')!, 3);
    const { plot } = await m.skills.farming.plant('test:AllotmentPlot1' as FarmingPlotId, 'test:Potatoes' as CropId);
    assert.equal(plot.status, 'growing');
    assert.ok(Math.abs(plot.readyInMs - 20_000) <= 100, `readyInMs ${plot.readyInMs}`);
    assert.equal(m.farmingSpeed, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(game.farming, 'plantPlot'), false); // left alone
  });
});
