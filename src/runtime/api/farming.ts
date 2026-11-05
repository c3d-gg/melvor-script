/**
 * Farming: plots, planting, harvesting, compost.
 *
 * Farming isn't an action the player "runs": crops grow on their own timers while you do other
 * things. So like banking, every farming call is free (no action cooldown) and never interrupts
 * the action in progress. What limits farming is the growth time.
 *
 * Instant mode (Scripted gamemode): the game's own instant-action rule makes a crop grown the moment
 * it's planted, yet still starts its growth timer, and when that timer ends it re-rolls the plot.
 * That can kill a crop you've replanted since, or leave an empty plot stuck as "grown" for good
 * (farming2.js plantPlot / growPlots). FarmingController takes growth over instead: crops grow
 * normally, in (their growth time / farming speed), in parallel, and can still die. A harvest is
 * worth what it is in normal play (XP, mastery and pet chances use the unscaled growth time).
 */
import type { FarmingPlotInfo, FarmingPlotStatus, HarvestResult, QuantityInfo } from '../../shared/protocol.ts';
import { RpcError, safe, type Game, type GameObject, type RuntimeEnv } from '../env.ts';
import { allObjects, idOf, resolveIn, resolveItem } from '../lookup.ts';
import { assertUnlocked, missingItems } from '../skills.ts';
import { captureBank } from './economy.ts';
import { num, type ApiContext } from './context.ts';

/** FarmingPlotState in farming2.js. */
export const PlotState = { Locked: 0, Empty: 1, Growing: 2, Grown: 3, Dead: 4 } as const;
const STATUS: FarmingPlotStatus[] = ['locked', 'empty', 'growing', 'grown', 'dead'];
export const DEFAULT_FARMING_SPEED = 10;
/** Shortest growth time at any farming speed. */
const MIN_GROWTH_MS = 1000;

type Fn = (...args: unknown[]) => unknown;

export interface FarmingHooks {
  /** Growth timers finished: plot ids that grew and that died. */
  onCropsGrown(grown: string[], died: string[]): void;
}

export class FarmingController {
  /** Instant mode: crops grow in their normal time / speed. */
  speed = DEFAULT_FARMING_SPEED;
  /** True when growth is taken over (gamemodes with instant actions). */
  scaled = false;
  private restorers: (() => void)[] = [];

  constructor(
    private env: RuntimeEnv,
    private hooks: FarmingHooks,
  ) {}

  private get farming(): GameObject | undefined {
    return safe(() => this.env.game.farming, undefined);
  }

  /** `instant`: the gamemode has instant actions, so take over crop growth. */
  install(instant: boolean) {
    const farming = this.farming;
    if (!farming) return;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ctl = this;
    if (typeof farming.growPlots === 'function') {
      this.wrap(
        farming,
        'growPlots',
        (impl) =>
          function (this: GameObject, timer: GameObject) {
            const plots: GameObject[] = safe(() => [...timer.plots], []);
            const r = impl.call(this, timer);
            const grown = plots.filter((p) => p.state === PlotState.Grown).map((p) => p.id);
            const died = plots.filter((p) => p.state === PlotState.Dead).map((p) => p.id);
            if (grown.length || died.length) {
              try {
                ctl.hooks.onCropsGrown(grown, died);
              } catch (e) {
                console.error('[melvor-script] onCropsGrown threw', e);
              }
            }
            return r;
          },
      );
    }
    if (!instant || typeof farming.plantPlot !== 'function') return;
    this.scaled = true;
    this.repair(farming);
    this.wrap(
      farming,
      'plantPlot',
      (impl) =>
        function (this: GameObject, plot: GameObject, ...rest: unknown[]) {
          const interval = impl.call(this, plot, ...rest);
          if (typeof interval !== 'number' || interval <= 0) return interval;
          // Instant mode marked it grown already: let it grow. plot.growthTime keeps the full time
          // (rewards use it); the returned interval is what the growth timer runs for.
          if (plot.state === PlotState.Grown) plot.state = PlotState.Growing;
          return Math.max(MIN_GROWTH_MS, Math.round(interval / ctl.speed));
        },
    );
  }

  /** Undo what instant mode left behind before we took over growth. */
  private repair(farming: GameObject) {
    const timers: Set<GameObject> | undefined = safe(() => farming.growthTimers, undefined);
    const timerOf: Map<GameObject, GameObject> | undefined = safe(() => farming.growthTimerMap, undefined);
    if (!timers || !timerOf) return;
    const render = (plot: GameObject) => safe(() => farming.renderQueue.growthState.add(plot), undefined);
    // A plot harvested on the spot stays in its old timer (harvesting doesn't remove it), which would
    // later re-roll whatever grows there by then. Only plots still waiting on this timer stay in it.
    for (const timer of [...timers]) {
      const plots: GameObject[] = safe(() => [...timer.plots], []);
      const waiting = (p: GameObject) =>
        timerOf.get(p) === timer && (p.state === PlotState.Growing || p.state === PlotState.Grown);
      const keep = plots.filter(waiting);
      if (keep.length === plots.length) continue;
      for (const p of plots) if (!waiting(p) && timerOf.get(p) === timer) timerOf.delete(p);
      timer.plots = keep;
      if (keep.length === 0) safe(() => farming.removeGrowthTimer(timer), undefined);
    }
    for (const plot of allObjects(farming.plots)) {
      const grownOrDead = plot.state === PlotState.Grown || plot.state === PlotState.Dead;
      if (grownOrDead && !plot.plantedRecipe) {
        // Re-rolled after its harvest: "grown" with nothing in it, so it can't be harvested or planted.
        plot.state = PlotState.Empty;
        render(plot);
      } else if (plot.state === PlotState.Grown && timerOf.has(plot)) {
        // Planted in instant mode and still timing: its timer decides how it turns out.
        plot.state = PlotState.Growing;
        render(plot);
      }
    }
  }

  dispose() {
    for (const restore of this.restorers.splice(0).reverse()) {
      try {
        restore();
      } catch (e) {
        console.error('[melvor-script] restore failed', e);
      }
    }
    this.scaled = false;
  }

  private wrap(obj: GameObject, name: string, make: (impl: Fn) => Fn) {
    const hadOwn = Object.prototype.hasOwnProperty.call(obj, name);
    const prevOwn = hadOwn ? obj[name] : undefined;
    const impl: Fn = function (this: unknown, ...args: unknown[]) {
      const fn: Fn = hadOwn ? prevOwn : Object.getPrototypeOf(obj)[name];
      return fn.apply(this, args);
    };
    obj[name] = make(impl);
    this.restorers.push(() => {
      if (hadOwn) obj[name] = prevOwn;
      else delete obj[name];
    });
  }
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

function quantities(list: { currency?: GameObject; item?: GameObject; quantity: number }[]): QuantityInfo[] {
  return list.map((q) => ({ id: (q.currency ?? q.item).id, quantity: q.quantity }));
}

function plotName(plot: GameObject): string {
  return plot.localID ?? plot.id;
}

export function plotInfo(game: Game, plot: GameObject): FarmingPlotInfo {
  const farming = game.farming;
  const state: number = safe(() => plot.state, PlotState.Empty);
  const compostLevel: number = safe(() => plot.compostLevel, 0);
  const costs = state === PlotState.Locked ? safe(() => farming.getPlotUnlockCosts(plot), undefined) : undefined;
  return {
    id: plot.id,
    category: safe(() => plot.category.id, ''),
    status: STATUS[state] ?? 'empty',
    crop: state >= PlotState.Growing ? idOf(plot.plantedRecipe) : null,
    readyInMs:
      state === PlotState.Growing ? safe(() => Math.max(0, Math.round(farming.getPlotGrowthTime(plot))), 0) : 0,
    growthChance: safe(() => farming.getPlotGrowthChance(plot) as number, 50 + compostLevel / 2),
    compost: plot.compostItem ? { item: plot.compostItem.id, level: compostLevel } : null,
    level: safe(() => plot.level, 1),
    abyssalLevel: safe(() => plot.abyssalLevel, 0),
    unlockCosts: {
      currencies: costs ? safe(() => quantities(costs.getCurrencyQuantityArray()), []) : [],
      items: costs ? safe(() => quantities(costs.getItemQuantityArray()), []) : [],
    },
  };
}

/** Run `fn`, returning the bank changes and the XP each skill gained. */
function capture(game: Game, fn: () => void): { items: Record<string, number>; xp: Record<string, number> } {
  const skills = allObjects(game.skills);
  const before = skills.map((s) => safe(() => s.xp as number, 0));
  const items = captureBank(game, fn);
  const xp: Record<string, number> = {};
  skills.forEach((s, i) => {
    const d = safe(() => s.xp as number, 0) - before[i]!;
    if (d !== 0) xp[s.id] = d;
  });
  return { items, xp };
}

function addAll(into: Record<string, number>, from: Record<string, number>) {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

export function registerFarming(api: ApiContext) {
  const { rpc, env } = api;

  const farmingOf = (): GameObject => {
    const farming = safe(() => env.game.farming, undefined);
    if (!farming?.plots) throw new RpcError('UNSUPPORTED', 'This game has no Farming');
    return farming;
  };
  const plotOf = (farming: GameObject, id: unknown) => resolveIn(farming.plots, id, 'farming plot');
  const cropOf = (farming: GameObject, id: unknown) => resolveIn(farming.actions, id, 'crop');

  function assertPlantable(farming: GameObject, plot: GameObject, crop: GameObject) {
    if (plot.state === PlotState.Locked)
      throw new RpcError('LOCKED', `${plotName(plot)} is locked: unlock it first (unlockPlot)`);
    if (plot.state !== PlotState.Empty) {
      const what = safe(() => plot.plantedRecipe.name, 'a crop');
      throw new RpcError('NOT_READY', `${plotName(plot)} already has ${what} in it (${STATUS[plot.state]})`, {
        status: STATUS[plot.state],
      });
    }
    if (crop.category !== plot.category) {
      throw new RpcError(
        'BAD_REQUEST',
        `${crop.name} grows in ${safe(() => crop.category.name, 'another kind of plot')}; ${plotName(plot)} is for ${safe(() => plot.category.name, 'something else')}`,
      );
    }
    assertUnlocked(farming, crop);
  }

  function seedsFor(farming: GameObject, crop: GameObject): { item: GameObject; need: number } {
    return {
      item: crop.seedCost.item,
      need: safe(() => farming.getRecipeSeedCost(crop) as number, crop.seedCost.quantity),
    };
  }

  function missingSeeds(farming: GameObject, crop: GameObject): RpcError | null {
    const { item, need } = seedsFor(farming, crop);
    const have = env.game.bank.getQty(item);
    if (have >= need) return null;
    return new RpcError('MISSING_ITEMS', `Planting ${crop.name} takes ${need} x ${item.name}; you have ${have}`, {
      missing: { [item.id]: need - have },
    });
  }

  /** plantRecipe is the seed modal's Plant button: plantPlot, then the plot's growth timer. */
  function plant(farming: GameObject, plot: GameObject, crop: GameObject): Record<string, number> {
    const { xp } = capture(env.game, () => farming.plantRecipe(crop, plot));
    if (plot.state === PlotState.Empty) throw new RpcError('FAILED', `The game didn't plant ${crop.name}`);
    return xp;
  }

  function harvestInto(farming: GameObject, plot: GameObject, out: HarvestResult) {
    if (plot.state === PlotState.Dead) {
      farming.clearDeadPlot(plot);
      out.died.push(plot.id);
      return;
    }
    let ok = false;
    const got = capture(env.game, () => (ok = farming.harvestPlot(plot) !== false));
    addAll(out.items, got.items);
    addAll(out.xp, got.xp);
    // harvestPlot refuses (and leaves the crop) when the bank has no room for it.
    (ok ? out.harvested : out.bankFull).push(plot.id);
  }

  const emptyHarvest = (): HarvestResult => ({ harvested: [], died: [], items: {}, xp: {}, bankFull: [] });

  rpc.register('farming.plots', (p: { category?: string }) => {
    const farming = farmingOf();
    const category = p?.category !== undefined ? resolveIn(farming.categories, p.category, 'farming category') : null;
    return allObjects(farming.plots)
      .filter((plot) => !category || plot.category === category)
      .map((plot) => plotInfo(env.game, plot));
  });

  rpc.register('farming.plant', (p: { plot: string; crop: string }) => {
    const farming = farmingOf();
    const plot = plotOf(farming, p.plot);
    const crop = cropOf(farming, p.crop);
    assertPlantable(farming, plot, crop);
    const short = missingSeeds(farming, crop);
    if (short) throw short;
    const seed = crop.seedCost.item;
    const before = env.game.bank.getQty(seed);
    const xp = plant(farming, plot, crop);
    api.flushState();
    return { plot: plotInfo(env.game, plot), seeds: before - env.game.bank.getQty(seed), xp };
  });

  rpc.register('farming.plantAll', (p: { crop: string }) => {
    const farming = farmingOf();
    const crop = cropOf(farming, p.crop);
    assertUnlocked(farming, crop);
    const empty = allObjects(farming.plots).filter(
      (plot) => plot.category === crop.category && plot.state === PlotState.Empty,
    );
    const seed = crop.seedCost.item;
    const before = env.game.bank.getQty(seed);
    const planted: string[] = [];
    const xp: Record<string, number> = {};
    for (const plot of empty) {
      const short = missingSeeds(farming, crop);
      if (short) {
        if (planted.length === 0) throw short;
        break;
      }
      addAll(xp, plant(farming, plot, crop));
      planted.push(plot.id);
    }
    api.flushState();
    return { planted, seeds: before - env.game.bank.getQty(seed), xp };
  });

  rpc.register('farming.harvest', (p: { plot: string }) => {
    const farming = farmingOf();
    const plot = plotOf(farming, p.plot);
    if (plot.state === PlotState.Growing) {
      const readyInMs = plotInfo(env.game, plot).readyInMs;
      throw new RpcError('NOT_READY', `${plotName(plot)} is still growing (ready in ${Math.ceil(readyInMs / 1000)}s)`, {
        readyInMs,
      });
    }
    if (plot.state !== PlotState.Grown && plot.state !== PlotState.Dead)
      throw new RpcError('NOT_READY', `${plotName(plot)} has nothing to harvest (${STATUS[plot.state] ?? 'empty'})`);
    const out = emptyHarvest();
    harvestInto(farming, plot, out);
    api.flushState();
    return out;
  });

  rpc.register('farming.harvestAll', (p: { category?: string }) => {
    const farming = farmingOf();
    const category = p?.category !== undefined ? resolveIn(farming.categories, p.category, 'farming category') : null;
    const out = emptyHarvest();
    for (const plot of allObjects(farming.plots)) {
      if (category && plot.category !== category) continue;
      if (plot.state === PlotState.Grown || plot.state === PlotState.Dead) harvestInto(farming, plot, out);
    }
    api.flushState();
    return out;
  });

  rpc.register('farming.compost', (p: { plot: string; item: string; quantity: number | null }) => {
    const g = env.game;
    const farming = farmingOf();
    const plot = plotOf(farming, p.plot);
    const item = resolveItem(g, p.item);
    if (typeof item.compostValue !== 'number') throw new RpcError('BAD_REQUEST', `${item.name} isn't compost`);
    const quantity =
      p.quantity === null || p.quantity === undefined ? Infinity : num(p.quantity, 'quantity', { min: 1, int: true });
    if (plot.state === PlotState.Locked) throw new RpcError('LOCKED', `${plotName(plot)} is locked`);
    if (plot.state !== PlotState.Empty)
      throw new RpcError(
        'NOT_READY',
        `Compost goes on an empty plot, before planting; ${plotName(plot)} is ${STATUS[plot.state]}`,
      );
    const current = plot.compostItem;
    if (current && current.harvestBonus > item.harvestBonus)
      throw new RpcError('FAILED', `${plotName(plot)} already has ${current.name}, which is better than ${item.name}`);
    if (current && current.harvestBonus === item.harvestBonus && plot.compostLevel >= 100)
      throw new RpcError('FAILED', `${plotName(plot)} is already fully composted`);
    const free = item.id === 'melvorD:Compost' && safe(() => g.modifiers.freeCompost > 0, false);
    const before = g.bank.getQty(item);
    if (!free && before < 1)
      throw new RpcError('MISSING_ITEMS', `You have no ${item.name}`, { missing: { [item.id]: 1 } });
    if (!farming.compostPlot(plot, item, quantity)) throw new RpcError('FAILED', `The game didn't apply ${item.name}`);
    api.flushState();
    return { used: before - g.bank.getQty(item), level: plot.compostLevel };
  });

  rpc.register('farming.unlockPlot', (p: { plot: string }) => {
    const farming = farmingOf();
    const plot = plotOf(farming, p.plot);
    if (plot.state !== PlotState.Locked) throw new RpcError('FAILED', `${plotName(plot)} is already unlocked`);
    if (farming.level < plot.level || safe(() => farming.abyssalLevel, 0) < safe(() => plot.abyssalLevel, 0)) {
      const abyssal = plot.abyssalLevel > 0 ? ` and abyssal level ${plot.abyssalLevel}` : '';
      throw new RpcError('LOCKED', `${plotName(plot)} needs Farming level ${plot.level}${abyssal}`, {
        level: plot.level,
        abyssalLevel: plot.abyssalLevel ?? 0,
      });
    }
    const costs = farming.getPlotUnlockCosts(plot);
    if (!costs.checkIfOwned()) {
      throw new RpcError('MISSING_ITEMS', `Can't afford to unlock ${plotName(plot)}`, {
        missing: missingItems(env.game, costs),
      });
    }
    try {
      farming.unlockPlotOnClick(plot);
    } catch (e) {
      // It redraws the Farming page afterwards; the unlock itself is what matters.
      if (plot.state === PlotState.Locked) throw e;
    }
    if (plot.state === PlotState.Locked) throw new RpcError('FAILED', `The game didn't unlock ${plotName(plot)}`);
    api.flushState();
    return plotInfo(env.game, plot);
  });

  rpc.register('farming.destroy', (p: { plot: string }) => {
    const farming = farmingOf();
    const plot = plotOf(farming, p.plot);
    if (plot.state !== PlotState.Growing)
      throw new RpcError(
        'NOT_READY',
        `Only a growing crop can be dug up; ${plotName(plot)} is ${STATUS[plot.state] ?? 'empty'}`,
      );
    farming.destroyPlot(plot);
    return plotInfo(env.game, plot);
  });
}
