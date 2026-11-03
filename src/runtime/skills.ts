/**
 * Per-skill adapters: translate `act(skill, targets)` into each skill's own
 * selection state. Each adapter mirrors what the game's UI click handlers do,
 * minus the toasts and the implicit start().
 */
import { RpcError, type Game, type GameObject, type RuntimeEnv } from './env.ts';
import { allObjects, resolveAction, resolveItem, idOf } from './lookup.ts';

export interface Resolved {
  actions: GameObject[];
  ids: string[];
  extra?: Record<string, GameObject | undefined>;
}

export interface SkillAdapter {
  /** Resolve + validate targets. Throws NOT_FOUND / LOCKED / BAD_REQUEST. Must not mutate game state. */
  resolve(skill: GameObject, targets: string[], options: Record<string, unknown>, game: Game): Resolved;
  /** Per-action costs for the resolved selection, for pre-flight checks. */
  costsFor?(skill: GameObject, r: Resolved, game: Game): GameObject | undefined;
  /** True when the (active) skill is already running exactly this selection. */
  isCurrent(skill: GameObject, r: Resolved): boolean;
  /** Apply the selection to a stopped skill. */
  apply(skill: GameObject, r: Resolved): void;
  /** True while the skill can't be stopped / a job shouldn't finish yet (thieving stun). */
  isBusy?(skill: GameObject): boolean;
  /**
   * Instant mode: a condition that must hold before the click (a depleted rock respawning).
   * The click waits for it instead of failing. Undefined = nothing to wait for.
   */
  waitUntil?(skill: GameObject, r: Resolved): { what: string; ready(): boolean } | undefined;
}

/** Level (and abyssal level) requirement only: what `isMasteryActionUnlocked` checks. */
function levelUnlocked(skill: GameObject, action: GameObject): boolean {
  if (typeof skill.isMasteryActionUnlocked !== 'function') return true;
  try {
    return !!skill.isMasteryActionUnlocked(action);
  } catch {
    return true;
  }
}

/**
 * Requirements besides level that the action's data lists, e.g. a Cartography discovery for
 * Atlas of Discovery trees (the game's `isTreeUnlocked` checks these; `isMasteryActionUnlocked` doesn't).
 */
function unmetRequirements(skill: GameObject, action: GameObject): GameObject[] {
  const reqs = action.requirements;
  if (!Array.isArray(reqs) || reqs.length === 0 || typeof skill.game?.checkRequirements !== 'function') return [];
  return reqs.filter((r) => {
    try {
      return !skill.game.checkRequirements([r], false);
    } catch {
      return false;
    }
  });
}

/** True when the player can do this action: level, abyssal level and any other requirements. */
export function isActionUnlocked(skill: GameObject, action: GameObject): boolean {
  return levelUnlocked(skill, action) && unmetRequirements(skill, action).length === 0;
}

function assertUnlocked(skill: GameObject, action: GameObject) {
  if (!levelUnlocked(skill, action)) {
    const abyssal = action.abyssalLevel > 0 ? ` and abyssal level ${action.abyssalLevel}` : '';
    throw new RpcError('LOCKED', `${action.name} requires ${skill.name} level ${action.level}${abyssal}`, {
      level: action.level,
      abyssalLevel: action.abyssalLevel,
    });
  }
  const unmet = unmetRequirements(skill, action);
  if (unmet.length > 0) {
    const what = unmet.map((r) => (typeof r.type === 'string' ? r.type : 'an unlock')).join(', ');
    throw new RpcError(
      'LOCKED',
      `${action.name} is locked: it needs ${what}, not just ${skill.name} level ${action.level}`,
      {
        level: action.level,
        requirements: unmet.map((r) => (typeof r.type === 'string' ? r.type : 'unknown')),
      },
    );
  }
}

function single(skill: GameObject, targets: string[]): Resolved {
  if (targets.length !== 1)
    throw new RpcError('BAD_REQUEST', `${skill.name} takes exactly one target, got ${targets.length}`);
  const action = resolveAction(skill, targets[0]);
  assertUnlocked(skill, action);
  return { actions: [action], ids: [action.id] };
}

function recipeCosts(skill: GameObject, recipe: GameObject): GameObject | undefined {
  if (typeof skill.getRecipeCosts === 'function') return skill.getRecipeCosts(recipe);
  return undefined;
}

const woodcutting: SkillAdapter = {
  resolve(skill, targets) {
    if (targets.length === 0) throw new RpcError('BAD_REQUEST', 'Woodcutting needs at least one tree');
    const trees = targets.map((t) => resolveAction(skill, t));
    const limit = skill.treeCutLimit ?? 1;
    if (trees.length > limit) throw new RpcError('LOCKED', `You can only cut ${limit} tree(s) at once`, { limit });
    if (new Set(trees).size !== trees.length) throw new RpcError('BAD_REQUEST', 'Duplicate trees');
    for (const tree of trees) {
      assertUnlocked(skill, tree); // explains why (level, abyssal level, other requirements)
      if (typeof skill.isTreeUnlocked === 'function' && !skill.isTreeUnlocked(tree)) {
        throw new RpcError('LOCKED', `${tree.name} is locked`, { level: tree.level });
      }
    }
    if (trees.some((t) => t.realm !== trees[0].realm))
      throw new RpcError('BAD_REQUEST', 'All trees must be in the same realm');
    return { actions: trees, ids: trees.map((t) => t.id) };
  },
  isCurrent(skill, r) {
    const active: Set<GameObject> = skill.activeTrees;
    return active.size === r.actions.length && r.actions.every((t) => active.has(t));
  },
  apply(skill, r) {
    skill.activeTrees.clear();
    for (const t of r.actions) skill.activeTrees.add(t);
    if (skill.renderQueue) skill.renderQueue.selectedTrees = true;
  },
};

const fishing: SkillAdapter = {
  resolve(skill, targets) {
    const r = single(skill, targets);
    const fish = r.actions[0];
    const area = allObjects(skill.areas).find((a) => Array.isArray(a.fish) && a.fish.includes(fish));
    if (!area) throw new RpcError('NOT_FOUND', `No fishing area contains ${fish.name}`);
    return { ...r, extra: { area } };
  },
  isCurrent(skill, r) {
    return skill.activeFishingArea === r.extra!.area && skill.activeFish === r.actions[0];
  },
  apply(skill, r) {
    const area = r.extra!.area;
    skill.selectedAreaFish.set(area, r.actions[0]);
    skill.activeFishingArea = area;
    if (skill.renderQueue) {
      skill.renderQueue.selectedAreaFish = true;
      skill.renderQueue.activeArea = true;
    }
  },
};

const mining: SkillAdapter = {
  resolve(skill, targets) {
    const r = single(skill, targets);
    const rock = r.actions[0];
    if (typeof skill.canMineOre === 'function' && !skill.canMineOre(rock)) {
      throw new RpcError('LOCKED', `You can't mine ${rock.name} yet`);
    }
    // A depleted rock is fine: the skill waits for the respawn, then mines.
    return r;
  },
  isCurrent(skill, r) {
    return skill.selectedRock === r.actions[0];
  },
  apply(skill, r) {
    skill.selectedRock = r.actions[0];
    skill.renderQueue?.rockStatus?.add?.(r.actions[0]);
  },
  waitUntil(_skill, r) {
    const rock = r.actions[0];
    if (!rock.isRespawning) return undefined;
    return { what: `${rock.name} to respawn`, ready: () => !rock.isRespawning };
  },
};

const thieving: SkillAdapter = {
  resolve(skill, targets, _opts, game) {
    const r = single(skill, targets);
    const npc = r.actions[0];
    const area = allObjects(skill.areas).find((a) => Array.isArray(a.npcs) && a.npcs.includes(npc));
    if (!area) throw new RpcError('NOT_FOUND', `No thieving area contains ${npc.name}`);
    const damageType = game.combat?.player?.damageType;
    if (damageType && typeof npc.canUseWithDamageType === 'function' && !npc.canUseWithDamageType(damageType)) {
      throw new RpcError(
        'LOCKED',
        `${npc.name} can't be pickpocketed with your current damage type (${damageType.name})`,
      );
    }
    return { ...r, extra: { area } };
  },
  isCurrent(skill, r) {
    return skill.currentNPC === r.actions[0] && skill.currentArea === r.extra!.area;
  },
  apply(skill, r) {
    skill.currentArea = r.extra!.area;
    skill.currentNPC = r.actions[0];
    if (skill.renderQueue) skill.renderQueue.stopButton = true;
  },
  isBusy(skill) {
    return skill.stunState === 1;
  },
};

const firemaking: SkillAdapter = {
  resolve(skill, targets) {
    return single(skill, targets);
  },
  costsFor(_skill, r) {
    // Firemaking burns exactly one log per action.
    const recipe = r.actions[0];
    return recipe.log ? { items: [{ item: recipe.log, quantity: 1 }] } : undefined;
  },
  isCurrent(skill, r) {
    return skill.selectedRecipe === r.actions[0];
  },
  apply(skill, r) {
    skill.selectedRecipe = r.actions[0];
    if (skill.renderQueue) {
      skill.renderQueue.selectedLog = true;
      skill.renderQueue.logQty = true;
      skill.renderQueue.logInfo = true;
    }
  },
};

const cooking: SkillAdapter = {
  resolve(skill, targets) {
    return single(skill, targets);
  },
  costsFor(skill, r) {
    return recipeCosts(skill, r.actions[0]);
  },
  isCurrent(skill, r) {
    const recipe = r.actions[0];
    return skill.activeCookingCategory === recipe.category && skill.selectedRecipes.get(recipe.category) === recipe;
  },
  apply(skill, r) {
    const recipe = r.actions[0];
    skill.selectedRecipes.set(recipe.category, recipe);
    skill.activeCookingCategory = recipe.category;
    skill.renderQueue?.selectedRecipes?.add?.(recipe.category);
  },
};

/** Smithing, Fletching, Crafting, Runecrafting, Herblore, Summoning (and modded artisan skills). */
const artisan: SkillAdapter = {
  resolve(skill, targets) {
    return single(skill, targets);
  },
  costsFor(skill, r) {
    return recipeCosts(skill, r.actions[0]);
  },
  isCurrent(skill, r) {
    return skill.selectedRecipe === r.actions[0];
  },
  apply(skill, r) {
    const recipe = r.actions[0];
    skill.selectedRecipe = recipe;
    skill.selectedRecipeInRealm?.set?.(recipe.realm, recipe);
    if (skill.renderQueue) skill.renderQueue.selectedRecipe = true;
  },
};

const astrology: SkillAdapter = {
  resolve(skill, targets) {
    return single(skill, targets);
  },
  isCurrent(skill, r) {
    return skill.studiedConstellation === r.actions[0];
  },
  apply(skill, r) {
    skill.studiedConstellation = r.actions[0];
  },
};

const harvesting: SkillAdapter = {
  resolve(skill, targets) {
    const r = single(skill, targets);
    if (typeof skill.canHarvestVein === 'function' && !skill.canHarvestVein(r.actions[0])) {
      throw new RpcError('LOCKED', `You can't harvest ${r.actions[0].name} yet`);
    }
    return r;
  },
  isCurrent(skill, r) {
    return skill.selectedVein === r.actions[0];
  },
  apply(skill, r) {
    skill.selectedVein = r.actions[0];
  },
};

const archaeology: SkillAdapter = {
  resolve(skill, targets) {
    const r = single(skill, targets);
    if (typeof skill.canExcavate === 'function' && !skill.canExcavate(r.actions[0])) {
      throw new RpcError(
        'LOCKED',
        `${r.actions[0].name} needs a dig site map with charges and at least one tool selected (set these up in the game UI)`,
      );
    }
    return r;
  },
  isCurrent(skill, r) {
    return skill.currentDigSite === r.actions[0];
  },
  apply(skill, r) {
    skill.currentDigSite = r.actions[0];
  },
};

const agility: SkillAdapter = {
  resolve(skill, targets) {
    if (targets.length !== 0) throw new RpcError('BAD_REQUEST', 'Agility runs your built course and takes no targets');
    return { actions: [], ids: [] };
  },
  isCurrent() {
    return true;
  },
  apply() {},
};

const altMagic: SkillAdapter = {
  resolve(skill, targets, options, game) {
    const r = single(skill, targets);
    const extra: Record<string, GameObject | undefined> = {};
    if (options.item !== undefined) extra.item = resolveItem(game, options.item);
    if (options.bar !== undefined) extra.bar = resolveAction(game.smithing, options.bar);
    return { ...r, extra };
  },
  isCurrent(skill, r) {
    return (
      skill.selectedSpell === r.actions[0] &&
      (r.extra?.item === undefined || skill.selectedConversionItem === r.extra.item) &&
      (r.extra?.bar === undefined || skill.selectedSmithingRecipe === r.extra.bar)
    );
  },
  apply(skill, r) {
    skill.selectedSpell = r.actions[0];
    skill.selectedConversionItem = r.extra?.item;
    skill.selectedSmithingRecipe = r.extra?.bar;
    if (skill.renderQueue) {
      skill.renderQueue.selectedSpellImage = true;
      skill.renderQueue.selectedSpellInfo = true;
    }
  },
};

const BY_LOCAL_ID: Record<string, SkillAdapter> = {
  Woodcutting: woodcutting,
  Fishing: fishing,
  Mining: mining,
  Thieving: thieving,
  Firemaking: firemaking,
  Cooking: cooking,
  Smithing: artisan,
  Fletching: artisan,
  Crafting: artisan,
  Runecrafting: artisan,
  Herblore: artisan,
  Summoning: artisan,
  Astrology: astrology,
  Harvesting: harvesting,
  Archaeology: archaeology,
  Agility: agility,
  Magic: altMagic,
};

export function adapterFor(env: RuntimeEnv, skill: GameObject): SkillAdapter {
  const known = BY_LOCAL_ID[skill.localID];
  if (known) return known;
  // Modded skills built on ArtisanSkill get the generic recipe adapter.
  if (
    'selectedRecipe' in skill &&
    typeof env.classes.ArtisanSkill === 'function' &&
    skill instanceof env.classes.ArtisanSkill
  ) {
    return artisan;
  }
  throw new RpcError('UNSUPPORTED', `${skill.name} can't be scripted yet`);
}

/** item id -> missing quantity, for a costs object (game Costs or our {items} shape). */
export function missingItems(game: Game, costs: GameObject | undefined, times = 1): Record<string, number> {
  const missing: Record<string, number> = {};
  if (!costs) return missing;
  const items: { item: GameObject; quantity: number }[] =
    typeof costs.getItemQuantityArray === 'function' ? costs.getItemQuantityArray() : (costs.items ?? []);
  for (const { item, quantity } of items) {
    const need = quantity * times;
    const have = game.bank.getQty(item);
    if (have < need) missing[item.id] = need - have;
  }
  if (typeof costs.getCurrencyQuantityArray === 'function') {
    for (const { currency, quantity } of costs.getCurrencyQuantityArray()) {
      const need = quantity * times;
      if (currency.amount < need) missing[currency.id] = need - currency.amount;
    }
  }
  return missing;
}

export { idOf };
