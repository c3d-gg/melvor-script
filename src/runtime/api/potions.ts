/**
 * Potions: one per action (combat or a skill), used up charge by charge.
 * Free like eating: drinking or swapping a potion never touches the action cooldown.
 */
import { RpcError, safe, type GameObject } from '../env.ts';
import { resolveIn, resolveItem } from '../lookup.ts';
import type { ApiContext } from './context.ts';

/** PotionItem without an instanceof check (the class isn't passed to the runtime). */
export function isPotion(item: GameObject): boolean {
  return (
    !!item && typeof item.charges === 'number' && typeof item.action?.id === 'string' && Array.isArray(item.consumesOn)
  );
}

export function registerPotions(api: ApiContext) {
  const { rpc, env } = api;

  const manager = (): GameObject => {
    const pm = safe(() => env.game.potions, undefined as GameObject);
    if (!pm) throw new RpcError('UNSUPPORTED', 'This game has no potions');
    return pm;
  };
  /** 'melvorD:Combat' or a skill id ('Woodcutting' works too, if it's unambiguous). */
  const resolveAction = (id: unknown): GameObject => resolveIn(env.game.actions, id, 'action');

  rpc.register('potions.use', (p: { item: string }) => {
    const g = env.game;
    const pm = manager();
    const item = resolveItem(g, p.item);
    if (!isPotion(item)) throw new RpcError('BAD_REQUEST', `${item.name} is not a potion`);
    if (g.bank.getQty(item) < 1)
      throw new RpcError('MISSING_ITEMS', `You have no ${item.name}`, { missing: { [item.id]: 1 } });
    if (safe(() => !!g.isGolbinRaid, false)) throw new RpcError('BUSY', 'Golbin Raid is running');
    pm.usePotion(item);
    const active = safe(() => pm.activePotions.get(item.action), undefined as GameObject);
    if (!active || active.item !== item) throw new RpcError('FAILED', `${item.name} wasn't used`);
    return { action: item.action.id as string, item: item.id as string, charges: active.charges as number };
  });

  rpc.register('potions.remove', (p: { action: string }) => {
    const pm = manager();
    const action = resolveAction(p.action);
    if (!pm.activePotions.has(action)) return { removed: false };
    pm.removePotion(action);
    return { removed: !pm.activePotions.has(action) };
  });

  rpc.register('potions.setAutoReuse', (p: { action: string; enabled: boolean }) => {
    if (typeof p.enabled !== 'boolean')
      throw new RpcError('BAD_REQUEST', `enabled must be true or false, got ${JSON.stringify(p.enabled)}`);
    const pm = manager();
    const action = resolveAction(p.action);
    if (!!pm.autoReusePotionsForAction(action) !== p.enabled) pm.toggleAutoReusePotion(action);
    return { enabled: !!pm.autoReusePotionsForAction(action) };
  });
}
