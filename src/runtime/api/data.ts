/** Read-only game data: items, skill actions, monsters, areas, and id registries (for type generation). */
import type { ActionInfo, AreaInfo, ItemInfo, MonsterInfo, QuantityInfo } from '../../shared/protocol.ts';
import { isInstance, safe, type GameObject, type RuntimeEnv } from '../env.ts';
import { allObjects, idOf, resolveItem, resolveSkill } from '../lookup.ts';
import { isActionUnlocked } from '../skills.ts';
import type { ApiContext } from './context.ts';

export function itemInfo(item: GameObject): ItemInfo {
  const info: ItemInfo = {
    id: item.id,
    name: safe(() => item.name, item.localID),
    type: safe(() => item.type, ''),
    category: safe(() => item.category, ''),
    sellsFor: {
      currency: safe(() => item.sellsFor.currency.id, 'melvorD:GP'),
      quantity: safe(() => item.sellsFor.quantity, 0),
    },
  };
  if (typeof item.healsFor === 'number') info.healsFor = item.healsFor;
  if (Array.isArray(item.validSlots)) info.validSlots = item.validSlots.map((s: GameObject) => s.id);
  return info;
}

function quantities(list: unknown): QuantityInfo[] {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && x.item).map((x) => ({ id: x.item.id, quantity: x.quantity ?? 1 }));
}

function actionInfo(env: RuntimeEnv, skill: GameObject, a: GameObject): ActionInfo {
  const products: QuantityInfo[] = [];
  const product = safe(() => a.product, undefined as GameObject);
  if (product?.id) products.push({ id: product.id, quantity: safe(() => a.baseQuantity, 1) });
  const logs = safe(() => a.log ?? a.logs, undefined as GameObject);
  const fishProduct = safe(() => a.product ?? a.item, undefined as GameObject);
  if (products.length === 0 && fishProduct?.id) products.push({ id: fishProduct.id, quantity: 1 });
  const costs = quantities(safe(() => a.itemCosts, []));
  if (logs?.id && !Array.isArray(logs) && localSkillId(skill) === 'Firemaking')
    costs.push({ id: logs.id, quantity: 1 });
  // Farming: the seeds a planting takes (before seed-cost bonuses).
  const seeds = safe(() => a.seedCost, undefined as GameObject);
  if (seeds?.item?.id) costs.push({ id: seeds.item.id, quantity: seeds.quantity ?? 1 });

  let group: string | null = null;
  if (localSkillId(skill) === 'Fishing')
    group = safe(() => idOf(allObjects(skill.areas).find((ar) => ar.fish?.includes(a))), null);
  if (localSkillId(skill) === 'Thieving')
    group = safe(() => idOf(allObjects(skill.areas).find((ar) => ar.npcs?.includes(a))), null);

  return {
    id: a.id,
    name: safe(() => a.name, a.localID),
    level: safe(() => a.level, 1),
    abyssalLevel: safe(() => a.abyssalLevel, 0),
    unlocked: isActionUnlocked(skill, a),
    baseExperience: safe(() => a.baseExperience, null as unknown as number),
    baseIntervalMs: safe(() => a.baseInterval ?? a.baseIntervalMs ?? null, null),
    category: safe(() => idOf(a.category), null),
    realm: safe(() => idOf(a.realm), null),
    costs,
    products,
    group,
  };
}

function localSkillId(skill: GameObject): string {
  return skill.localID;
}

function areaKind(env: RuntimeEnv, area: GameObject): AreaInfo['kind'] {
  if (isInstance(env, area, 'AbyssDepth')) return 'depth';
  if (isInstance(env, area, 'Dungeon')) return 'dungeon';
  if (isInstance(env, area, 'Stronghold')) return 'stronghold';
  if (isInstance(env, area, 'SlayerArea')) return 'slayer';
  if (isInstance(env, area, 'CombatArea')) return 'combat';
  return 'other';
}

export function registerData(api: ApiContext) {
  const { rpc, env } = api;

  rpc.register('data.item', (p: { id: string }) => itemInfo(resolveItem(env.game, p.id)));

  rpc.register('data.items', (p: { ids?: string[]; type?: string; category?: string }) => {
    const items = Array.isArray(p.ids) ? p.ids.map((id) => resolveItem(env.game, id)) : allObjects(env.game.items);
    return items
      .map(itemInfo)
      .filter(
        (i) => (p.type === undefined || i.type === p.type) && (p.category === undefined || i.category === p.category),
      );
  });

  rpc.register('data.actions', (p: { skill: string }) => {
    const skill = resolveSkill(env.game, p.skill);
    if (!skill.actions) return [];
    return allObjects(skill.actions).map((a) => actionInfo(env, skill, a));
  });

  rpc.register('data.monsters', (): MonsterInfo[] => {
    const g = env.game;
    const areasByMonster = new Map<GameObject, string[]>();
    for (const area of allObjects(g.combatAreas)) {
      for (const m of safe(() => area.monsters as GameObject[], [])) {
        const list = areasByMonster.get(m) ?? [];
        list.push(area.id);
        areasByMonster.set(m, list);
      }
    }
    return allObjects(g.monsters).map((m) => ({
      id: m.id,
      name: safe(() => m.name, m.localID),
      combatLevel: safe(() => m.combatLevel, 0),
      hitpoints: safe(() => m.levels.Hitpoints * 10, 0),
      areas: areasByMonster.get(m) ?? [],
    }));
  });

  rpc.register('data.areas', (): AreaInfo[] => {
    const g = env.game;
    return allObjects(g.combatAreas).map((a) => ({
      id: a.id,
      name: safe(() => a.name, a.localID),
      kind: areaKind(env, a),
      monsters: safe(() => (a.monsters as GameObject[]).map((m) => m.id), []),
      unlocked: safe(() => g.checkRequirements(a.entryRequirements, false), true),
    }));
  });

  rpc.register('data.registries', () => {
    const g = env.game;
    type Entry = { id: string; name?: string };
    const entry = (o: GameObject): Entry => ({
      id: o.id,
      name: safe(() => String(o.name), undefined as unknown as string),
    });
    const ids = (reg: GameObject): Entry[] => allObjects(reg).map(entry);
    const out: Record<string, Entry[]> = {
      items: ids(g.items),
      skills: ids(g.skills),
      monsters: ids(g.monsters),
      combatAreas: ids(g.combatAreas),
      dungeons: allObjects(g.combatAreas)
        .filter((a) => isInstance(env, a, 'Dungeon'))
        .map(entry),
      shopPurchases: ids(safe(() => g.shop.purchases, undefined)),
      prayers: ids(g.prayers),
      attackStyles: ids(g.attackStyles),
      equipmentSlots: ids(g.equipmentSlots),
      currencies: ids(g.currencies),
      foods: allObjects(g.items)
        .filter((i) => typeof i.healsFor === 'number')
        .map(entry),
      farmingPlots: ids(safe(() => g.farming.plots, undefined)).map((e) => ({ id: e.id })),
      farmingCategories: ids(safe(() => g.farming.categories, undefined)),
    };
    for (const skill of allObjects(g.skills)) {
      if (skill.actions) out[`actions:${skill.id}`] = ids(skill.actions);
    }
    return out;
  });
}
