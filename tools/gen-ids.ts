/**
 * Offline id generation from Melvor's public game data files.
 * Downloads them into .cache/gamedata (once), then writes src/shared/ids.generated.ts.
 *
 *   bun run gen:ids              # use cached data if present
 *   bun run gen:ids --refresh # re-download
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIdsModule, type IdEntry, type Registries } from '../src/shared/gen-ids.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'gamedata');
const BASE_URL = 'https://steam.melvoridle.com/assets/data';
const FILES = ['melvorDemo', 'melvorFull', 'melvorTotH', 'melvorExpansion2', 'melvorItA'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

async function loadFile(name: string, refresh: boolean): Promise<Json> {
  const path = join(CACHE, `${name}.json`);
  if (!refresh && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const res = await fetch(`${BASE_URL}/${name}.json`);
  if (!res.ok) throw new Error(`Download of ${name}.json failed: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(path, text);
  return JSON.parse(text);
}

const full = (ns: string, id: string) => (id.includes(':') ? id : `${ns}:${id}`);

/** Which key of a skill's data block holds its actions. */
const ACTION_KEYS: Record<string, string> = {
  'melvorD:Woodcutting': 'trees',
  'melvorD:Fishing': 'fish',
  'melvorD:Mining': 'rockData',
  'melvorD:Thieving': 'npcs',
  'melvorD:Firemaking': 'logs',
  'melvorD:Cooking': 'recipes',
  'melvorD:Smithing': 'recipes',
  'melvorD:Fletching': 'recipes',
  'melvorD:Crafting': 'recipes',
  'melvorD:Runecrafting': 'recipes',
  'melvorD:Herblore': 'recipes',
  'melvorD:Summoning': 'recipes',
  'melvorD:Agility': 'obstacles',
  'melvorD:Astrology': 'recipes',
  'melvorD:Magic': 'altSpells',
  'melvorAoD:Archaeology': 'digSites',
  'melvorItA:Harvesting': 'veinData',
  'melvorD:Farming': 'recipes',
};

async function main() {
  const refresh = process.argv.includes('--refresh');
  const files = await Promise.all(FILES.map((f) => loadFile(f, refresh)));

  const itemNames = new Map<string, string>();
  for (const f of files) for (const it of f.data.items ?? []) itemNames.set(full(f.namespace, it.id), it.name);

  const reg: Registries = {};
  const push = (key: string, e: IdEntry) => (reg[key] ??= []).push(e);

  for (const f of files) {
    const ns: string = f.namespace;
    const d = f.data;
    for (const it of d.items ?? []) {
      const id = full(ns, it.id);
      push('items', { id, name: it.name });
      if (typeof it.healsFor === 'number') push('foods', { id, name: it.name });
      if (it.itemType === 'Potion') push('potions', { id, name: it.name });
    }
    for (const m of [...(d.monsters ?? []), ...(d.itmMonsters ?? [])])
      if (m?.id) push('monsters', { id: full(ns, m.id), name: m.name });
    for (const key of ['combatAreas', 'slayerAreas', 'dungeons', 'strongholds', 'abyssDepths']) {
      for (const a of d[key] ?? []) {
        push('combatAreas', { id: full(ns, a.id), name: a.name });
        if (key === 'dungeons' || key === 'abyssDepths') push('dungeons', { id: full(ns, a.id), name: a.name });
      }
    }
    for (const p of d.shopPurchases ?? []) {
      const name =
        p.customName ?? (p.contains?.items?.[0] ? itemNames.get(full(ns, p.contains.items[0].id)) : undefined);
      push('shopPurchases', { id: full(ns, p.id), name });
    }
    for (const p of d.prayers ?? []) push('prayers', { id: full(ns, p.id), name: p.name });
    for (const s of d.attackStyles ?? []) push('attackStyles', { id: full(ns, s.id), name: s.name });
    for (const s of d.equipmentSlots ?? []) push('equipmentSlots', { id: full(ns, s.id), name: s.emptyName ?? s.id });
    for (const sp of d.attackSpells ?? []) push('attackSpells', { id: full(ns, sp.id), name: sp.name });
    for (const sp of d.curseSpells ?? []) push('curseSpells', { id: full(ns, sp.id), name: sp.name });
    for (const sp of d.auroraSpells ?? []) push('auroraSpells', { id: full(ns, sp.id), name: sp.name });
    for (const c of d.slayerTaskCategories ?? []) push('slayerCategories', { id: full(ns, c.id), name: c.name });

    for (const block of d.skillData ?? []) {
      const skillId: string = block.skillID;
      push('skills', { id: skillId, name: skillId.split(':')[1] });
      if (skillId === 'melvorD:Farming') {
        for (const p of block.data?.plots ?? []) push('farmingPlots', { id: full(ns, p.id) });
        for (const c of block.data?.categories ?? []) push('farmingCategories', { id: full(ns, c.id), name: c.name });
      }
      const actionKey = ACTION_KEYS[skillId];
      if (!actionKey) continue;
      for (const a of block.data?.[actionKey] ?? []) {
        if (!a?.id) continue;
        const productId = a.productID ?? a.logID ?? a.productId;
        const name =
          a.name ?? (productId ? itemNames.get(productId.includes(':') ? productId : full(ns, productId)) : undefined);
        push(`actions:${skillId}`, { id: full(ns, a.id), name });
      }
    }
  }
  // Combat skills have no skillData actions but are still skills.
  for (const s of ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer']) {
    push('skills', { id: `melvorD:${s}`, name: s });
  }

  const out = join(ROOT, 'src', 'shared', 'ids.generated.ts');
  writeFileSync(out, generateIdsModule(reg, `public game data (${FILES.join(', ')})`));
  const counts = Object.entries(reg)
    .map(([k, v]) => `${k}=${v.length}`)
    .join(' ');
  console.log(`wrote ${out}\n${counts}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
