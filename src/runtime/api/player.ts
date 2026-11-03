import { RpcError, safe, type GameObject } from '../env.ts';
import { resolveIn, resolveItem } from '../lookup.ts';
import { num, type ApiContext } from './context.ts';

export function registerPlayer(api: ApiContext) {
  const { rpc, env } = api;
  const player = (): GameObject => env.game.combat.player;

  rpc.register('player.eat', (p: { quantity?: number }) => {
    const pl = player();
    const times = p.quantity === undefined ? 1 : num(p.quantity, 'quantity', { min: 1, int: true });
    for (let i = 0; i < times; i++) pl.eatFood(1, true);
    return { hp: pl.hitpoints };
  });

  rpc.register('player.equipFood', (p: { item: string; quantity: number }) => {
    const g = env.game;
    const item = resolveItem(g, p.item);
    if (typeof item.healsFor !== 'number') throw new RpcError('BAD_REQUEST', `${item.name} is not food`);
    const quantity = Math.min(num(p.quantity, 'quantity', { min: 1, int: true }), g.bank.getQty(item));
    if (quantity < 1) throw new RpcError('MISSING_ITEMS', `You have no ${item.name}`);
    const ok = player().equipFood(item, quantity);
    if (ok === false) throw new RpcError('FAILED', 'No free food slot');
    if (ok === undefined) throw new RpcError('BUSY', "Can't change food right now");
    return { equipped: true };
  });

  rpc.register('player.selectFood', (p: { slot: number }) => {
    const slot = num(p.slot, 'slot', { min: 0, int: true });
    player().selectFood(slot);
    return { selected: player().food.selectedSlot };
  });

  rpc.register('player.equip', (p: { item: string; slot?: string; quantity?: number; set?: number }) => {
    const g = env.game;
    const pl = player();
    const item = resolveItem(g, p.item);
    if (!Array.isArray(item.validSlots) || item.validSlots.length === 0)
      throw new RpcError('BAD_REQUEST', `${item.name} can't be equipped`);
    if (g.bank.getQty(item) < 1) throw new RpcError('MISSING_ITEMS', `You have no ${item.name}`);
    const slot = p.slot !== undefined ? resolveIn(g.equipmentSlots, p.slot, 'equipment slot') : item.validSlots[0];
    if (!item.validSlots.includes(slot)) throw new RpcError('BAD_REQUEST', `${item.name} can't go in ${slot.id}`);
    const set = p.set === undefined ? pl.selectedEquipmentSet : num(p.set, 'set', { min: 0, int: true });
    const quantity = p.quantity === undefined ? 1 : num(p.quantity, 'quantity', { min: 1, int: true });
    const meets = safe(() => g.checkRequirements(item.equipRequirements, false), true);
    if (!meets) throw new RpcError('LOCKED', `You don't meet the requirements to equip ${item.name}`);
    const ok = pl.equipItem(item, set, slot, quantity);
    if (ok === false) throw new RpcError('BUSY', `Can't change equipment right now`);
    return { equipped: true };
  });

  rpc.register('player.unequip', (p: { slot: string; set?: number }) => {
    const g = env.game;
    const pl = player();
    const slot = resolveIn(g.equipmentSlots, p.slot, 'equipment slot');
    const set = p.set === undefined ? pl.selectedEquipmentSet : num(p.set, 'set', { min: 0, int: true });
    const ok = pl.unequipItem(set, slot);
    return { unequipped: ok !== false };
  });

  rpc.register('player.setEquipmentSet', (p: { set: number }) => {
    const pl = player();
    const set = num(p.set, 'set', { min: 0, int: true });
    if (set >= pl.equipmentSets.length)
      throw new RpcError('LOCKED', `You only have ${pl.equipmentSets.length} equipment sets`);
    pl.changeEquipmentSet(set);
    return { set: pl.selectedEquipmentSet };
  });

  rpc.register('player.togglePrayer', (p: { prayer: string }) => {
    const pl = player();
    const prayer = resolveIn(env.game.prayers, p.prayer, 'prayer');
    pl.togglePrayer(prayer);
    return { active: pl.activePrayers.has(prayer) };
  });

  rpc.register('player.setAttackStyle', (p: { style: string }) => {
    const pl = player();
    const style = resolveIn(env.game.attackStyles, p.style, 'attack style');
    pl.setAttackStyle(style.attackType, style);
    return { style: style.id };
  });
}
