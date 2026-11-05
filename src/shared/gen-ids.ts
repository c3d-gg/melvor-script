/**
 * Generates src/shared/ids.generated.ts: string-literal unions + const maps
 * for every id a script can pass (items, trees, fish, recipes, monsters...).
 *
 * Fed either from the public game data JSON (tools/gen-ids.ts, offline) or
 * from the running game (`bun run melvor gen-types`, includes mods).
 */

export interface IdEntry {
  id: string;
  name?: string;
}

export type Registries = Record<string, IdEntry[]>;

interface Category {
  key: string;
  type: string;
  constName: string;
  doc: string;
}

export const CATEGORIES: Category[] = [
  { key: 'items', type: 'ItemId', constName: 'Items', doc: 'Every item in the game.' },
  { key: 'foods', type: 'FoodId', constName: 'Foods', doc: 'Items that heal when eaten.' },
  { key: 'skills', type: 'SkillId', constName: 'SkillIds', doc: 'Skills.' },
  { key: 'monsters', type: 'MonsterId', constName: 'Monsters', doc: 'Monsters.' },
  {
    key: 'combatAreas',
    type: 'CombatAreaId',
    constName: 'CombatAreas',
    doc: 'Combat areas, slayer areas, dungeons, strongholds and depths.',
  },
  { key: 'dungeons', type: 'DungeonId', constName: 'Dungeons', doc: 'Dungeons (including Abyss depths).' },
  { key: 'shopPurchases', type: 'ShopPurchaseId', constName: 'ShopPurchases', doc: 'Shop purchases.' },
  { key: 'prayers', type: 'PrayerId', constName: 'Prayers', doc: 'Prayers.' },
  { key: 'attackStyles', type: 'AttackStyleId', constName: 'AttackStyles', doc: 'Attack styles.' },
  { key: 'equipmentSlots', type: 'EquipmentSlotId', constName: 'EquipmentSlots', doc: 'Equipment slots.' },
  { key: 'actions:melvorD:Woodcutting', type: 'TreeId', constName: 'Trees', doc: 'Woodcutting trees.' },
  { key: 'actions:melvorD:Fishing', type: 'FishId', constName: 'Fish', doc: 'Fishing: fish.' },
  { key: 'actions:melvorD:Mining', type: 'RockId', constName: 'Rocks', doc: 'Mining rocks.' },
  { key: 'actions:melvorD:Thieving', type: 'NpcId', constName: 'ThievingNpcs', doc: 'Thieving NPCs.' },
  {
    key: 'actions:melvorD:Firemaking',
    type: 'LogId',
    constName: 'FiremakingLogs',
    doc: 'Firemaking: logs you can burn.',
  },
  { key: 'actions:melvorD:Cooking', type: 'CookingRecipeId', constName: 'CookingRecipes', doc: 'Cooking recipes.' },
  { key: 'actions:melvorD:Smithing', type: 'SmithingRecipeId', constName: 'SmithingRecipes', doc: 'Smithing recipes.' },
  {
    key: 'actions:melvorD:Fletching',
    type: 'FletchingRecipeId',
    constName: 'FletchingRecipes',
    doc: 'Fletching recipes.',
  },
  { key: 'actions:melvorD:Crafting', type: 'CraftingRecipeId', constName: 'CraftingRecipes', doc: 'Crafting recipes.' },
  {
    key: 'actions:melvorD:Runecrafting',
    type: 'RunecraftingRecipeId',
    constName: 'RunecraftingRecipes',
    doc: 'Runecrafting recipes.',
  },
  { key: 'actions:melvorD:Herblore', type: 'HerbloreRecipeId', constName: 'HerbloreRecipes', doc: 'Herblore recipes.' },
  {
    key: 'actions:melvorD:Summoning',
    type: 'SummoningRecipeId',
    constName: 'SummoningRecipes',
    doc: 'Summoning recipes.',
  },
  { key: 'actions:melvorD:Agility', type: 'ObstacleId', constName: 'Obstacles', doc: 'Agility obstacles.' },
  {
    key: 'actions:melvorD:Astrology',
    type: 'ConstellationId',
    constName: 'Constellations',
    doc: 'Astrology constellations.',
  },
  { key: 'actions:melvorD:Magic', type: 'AltSpellId', constName: 'AltSpells', doc: 'Alt. Magic spells.' },
  {
    key: 'actions:melvorAoD:Archaeology',
    type: 'DigSiteId',
    constName: 'DigSites',
    doc: 'Archaeology dig sites (Atlas of Discovery).',
  },
  {
    key: 'actions:melvorItA:Harvesting',
    type: 'VeinId',
    constName: 'Veins',
    doc: 'Harvesting veins (Into the Abyss).',
  },
  { key: 'actions:melvorD:Farming', type: 'CropId', constName: 'Crops', doc: 'Farming crops: what you plant.' },
  { key: 'farmingPlots', type: 'FarmingPlotId', constName: 'FarmingPlots', doc: 'Farming plots.' },
  {
    key: 'farmingCategories',
    type: 'FarmingCategoryId',
    constName: 'FarmingCategories',
    doc: 'Kinds of farming plot: allotments, herbs, trees, special plots.',
  },
];

const RESERVED = new Set(['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']);

function keyFor(id: string, taken: Set<string>): string {
  const [ns = '', local = id] = id.includes(':') ? id.split(/:(.*)/s) : ['', id];
  let base = local.replace(/[^A-Za-z0-9_$]/g, '_');
  if (/^[0-9]/.test(base)) base = `_${base}`;
  if (RESERVED.has(base)) base = `${base}_`;
  let key = base;
  if (taken.has(key)) key = `${base}__${ns.replace(/[^A-Za-z0-9_$]/g, '_')}`;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  taken.add(key);
  return key;
}

function docSafe(s: string): string {
  return s
    .replace(/\*\//g, '* /')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function generateIdsModule(registries: Registries, source: string): string {
  const out: string[] = [];
  out.push('/* eslint-disable */');
  out.push('// GENERATED FILE - do not edit by hand.');
  out.push(`// Source: ${source}`);
  out.push('// Regenerate with the game running (includes modded content):  bun run melvor gen-types');
  out.push('// Or offline from the public game data:                         bun run gen:ids');
  out.push('');
  for (const cat of CATEGORIES) {
    const entries = dedupe(registries[cat.key] ?? []);
    out.push(`/** ${cat.doc} */`);
    if (entries.length === 0) {
      out.push(`export const ${cat.constName} = {} as const;`);
      out.push(`export type ${cat.type} = string;`);
      out.push('');
      continue;
    }
    out.push(`export const ${cat.constName} = {`);
    const taken = new Set<string>();
    for (const e of entries) {
      const key = keyFor(e.id, taken);
      const doc = e.name ? `/** ${docSafe(e.name)} */ ` : '';
      out.push(`  ${doc}${key}: ${JSON.stringify(e.id)},`);
    }
    out.push('} as const;');
    out.push(`export type ${cat.type} = (typeof ${cat.constName})[keyof typeof ${cat.constName}];`);
    out.push('');
  }
  return out.join('\n');
}

function dedupe(entries: IdEntry[]): IdEntry[] {
  const seen = new Map<string, IdEntry>();
  for (const e of entries) if (e && typeof e.id === 'string' && !seen.has(e.id)) seen.set(e.id, e);
  return [...seen.values()];
}
