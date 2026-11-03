// Melvor Script: mod bootstrap.
//
// This file stays tiny on purpose. It loads the real runtime (runtime.mjs), either
// the copy inside this mod, or, when ~/.melvor-scripting/config.json has a
// "devRuntime" path (set by `bun run dev`), straight from disk. That lets the
// runtime be rebuilt and hot-reloaded without re-uploading the mod.

const TAG = '[melvor-script]';

function nodeRequire() {
  const candidates = [
    () => require, // eslint-disable-line no-undef
    () => globalThis.require,
    () => globalThis.nw && globalThis.nw.require,
  ];
  for (const get of candidates) {
    try {
      const r = get();
      if (typeof r === 'function') return r;
    } catch {
      /* not available */
    }
  }
  return null;
}

function getNode() {
  const req = nodeRequire();
  if (!req) return null;
  try {
    return {
      http: req('http'),
      crypto: req('crypto'),
      fs: req('fs'),
      path: req('path'),
      os: req('os'),
      Buffer: req('buffer').Buffer,
      process: req('process'),
    };
  } catch (e) {
    console.warn(TAG, 'Node built-ins unavailable', e);
    return null;
  }
}

/** Melvor's classes are global lexical bindings: reachable by name, but not on `window`. */
function collectClasses() {
  const pick = (get) => {
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  /* eslint-disable no-undef */
  return {
    GatheringSkill: pick(() => GatheringSkill),
    CraftingSkill: pick(() => CraftingSkill),
    ArtisanSkill: pick(() => ArtisanSkill),
    CombatArea: pick(() => CombatArea),
    SlayerArea: pick(() => SlayerArea),
    Dungeon: pick(() => Dungeon),
    Stronghold: pick(() => Stronghold),
    AbyssDepth: pick(() => AbyssDepth),
    exp: pick(() => exp),
  };
  /* eslint-enable no-undef */
}

function readDevRuntimePath(node) {
  if (!node) return null;
  try {
    const file = node.path.join(node.os.homedir(), '.melvor-scripting', 'config.json');
    const cfg = JSON.parse(node.fs.readFileSync(file, 'utf8'));
    if (typeof cfg.devRuntime === 'string' && node.fs.existsSync(cfg.devRuntime)) return cfg.devRuntime;
  } catch {
    /* no config yet */
  }
  return null;
}

/**
 * In-game settings: sidebar → Mod Settings → Melvor Script. Added once per page (the runtime can
 * reload, settings can't be removed). Melvor only saves mod settings for mods installed from
 * mod.io, and per character, so the runtime keeps the real values in
 * ~/.melvor-scripting/config.json and copies them in here when it starts.
 */
function addSettings(ctx, changed) {
  try {
    const scripted = ctx.settings.section('Scripted Mode');
    scripted.add({
      type: 'number',
      name: 'speed',
      label: 'Speed',
      hint: 'After each action, the next one waits its normal time ÷ speed. 1 to 1000 (default 10).',
      default: 10,
      min: 1,
      max: 1000,
      onChange: (value) => {
        if (!Number.isFinite(value) || value < 1 || value > 1000) return 'Enter a number from 1 to 1000';
        changed('speed', value);
      },
    });
    const dev = ctx.settings.section('Developer');
    dev.add({
      type: 'switch',
      name: 'allowEval',
      label: 'Allow eval',
      hint: "Lets connected scripts run any JavaScript inside the game, including Node APIs (`bun run melvor eval` and the REPL use it). Scripts don't need it.",
      default: false,
      onChange: (value) => changed('allowEval', value),
    });
    const sectionOf = { speed: scripted, allowEval: dev };
    return {
      get: (name) => sectionOf[name].get(name),
      set: (name, value) => sectionOf[name].set(name, value),
    };
  } catch (e) {
    console.warn(TAG, 'could not add settings', e);
    return null;
  }
}

async function importRuntime(ctx, node) {
  const devPath = readDevRuntimePath(node);
  if (devPath) {
    try {
      const code = node.fs.readFileSync(devPath, 'utf8');
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try {
        return { mod: await import(url), source: `disk (${devPath})` };
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error(TAG, `failed to load dev runtime from ${devPath}; falling back to the bundled one`, e);
    }
  }
  return { mod: await ctx.loadModule('runtime.mjs'), source: 'bundled' };
}

export function setup(ctx) {
  const node = getNode();
  let runtime = null;
  let busy = null;
  const settings = addSettings(ctx, (name, value) => {
    try {
      runtime?.settingChanged?.(name, value); // (a dev runtime from before settings has no handler)
    } catch (e) {
      console.error(TAG, `setting ${name} failed`, e);
    }
  });

  async function load() {
    const { mod, source } = await importRuntime(ctx, node);
    const rt = mod.createRuntime({
      game, // eslint-disable-line no-undef
      ctx,
      node,
      classes: collectClasses(),
      runtimeSource: source,
      hud: true,
      settings,
      requestReload: () => void reload(),
      gameVersion: typeof gameVersion !== 'undefined' ? String(gameVersion) : undefined, // eslint-disable-line no-undef
    });
    await rt.start();
    runtime = rt;
    console.log(TAG, `runtime started (${source})`);
  }

  function reload() {
    if (busy) return busy;
    busy = (async () => {
      try {
        await runtime?.dispose();
      } catch (e) {
        console.error(TAG, 'dispose failed', e);
      }
      runtime = null;
      try {
        await load();
      } catch (e) {
        console.error(TAG, 'reload failed', e);
      }
    })().finally(() => {
      busy = null;
    });
    return busy;
  }

  ctx.onCharacterLoaded(async () => {
    try {
      await load();
    } catch (e) {
      console.error(TAG, 'failed to start', e);
    }
  });

  ctx.onInterfaceReady(() => {
    try {
      // eslint-disable-next-line no-undef
      sidebar.category('Modding', { after: 'General' }).item('Melvor Script', {
        icon: ctx.getResourceUrl('assets/icon.svg'),
        onClick: () => runtime?.toggleHud(),
      });
    } catch (e) {
      console.warn(TAG, 'could not add sidebar entry', e);
    }
  });

  // The Node context survives page reloads in NW.js: release the port when this page goes away.
  window.addEventListener('pagehide', () => {
    try {
      void runtime?.dispose();
    } catch {
      /* page is going away anyway */
    }
  });

  // Reachable from other mods as mod.api.scriptable
  ctx.api({
    reload,
    getRuntime: () => runtime,
  });
}
