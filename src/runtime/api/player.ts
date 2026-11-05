import { RpcError, safe, type GameObject } from '../env.ts';
import { resolveIn, resolveItem } from '../lookup.ts';
import { spellSelection } from '../state.ts';
import { num, type ApiContext } from './context.ts';

/** Why the player can't select a combat spell, or null if they can. */
export function spellLockReason(game: GameObject, spell: GameObject): string | null {
  const pl = game.combat.player;
  if (safe(() => pl.canUseCombatSpell(spell) === true, true)) return null;
  const magic = game.altMagic;
  if (safe(() => magic.level < spell.level, false)) return `${spell.name} needs Magic level ${spell.level}`;
  if (safe(() => (magic.abyssalLevel ?? 0) < (spell.abyssalLevel ?? 0), false))
    return `${spell.name} needs abyssal Magic level ${spell.abyssalLevel}`;
  if (spell.requiredItem && !safe(() => pl.equipment.checkForItem(spell.requiredItem), false))
    return `${spell.name} needs ${spell.requiredItem.name} equipped`;
  return `Requirements for ${spell.name} aren't met`;
}

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

  rpc.register('player.setSpells', (p: { attack?: string; curse?: string | null; aurora?: string | null }) => {
    const g = env.game;
    const pl = player();
    if (p.attack === null) throw new RpcError('BAD_REQUEST', "attack can't be null: pick another attack spell");
    // Check everything before changing anything, so a refused call leaves the selection as it was.
    const attack = p.attack === undefined ? undefined : resolveIn(g.attackSpells, p.attack, 'attack spell');
    const curse = p.curse === undefined || p.curse === null ? p.curse : resolveIn(g.curseSpells, p.curse, 'curse');
    const aurora =
      p.aurora === undefined || p.aurora === null ? p.aurora : resolveIn(g.auroraSpells, p.aurora, 'aurora');
    for (const spell of [attack, curse, aurora]) {
      const locked = spell ? spellLockReason(g, spell) : null;
      if (locked) throw new RpcError('LOCKED', locked);
    }
    if (attack && !safe(() => attack.spellbook.canUseWithDamageType(pl.damageType) !== false, true))
      throw new RpcError('LOCKED', `${attack.spellbook.name} spells can't be used with ${pl.damageType.name}`);

    // Like player.js toggleCurse/toggleAurora: the attack spell's book has to allow them, and then
    // you need magic attacks (canCurse follows the book once the stats are recomputed) or an item
    // that allows them with other attack types (canCurse/canAurora come from its modifiers).
    const book = (attack ?? safe(() => pl.spellSelection.attack, undefined as GameObject))?.spellbook;
    const magic = pl.attackType === 'magic';
    for (const [spell, kind, allowed, can] of [
      [curse, 'curses', book?.allowCurses, pl.canCurse],
      [aurora, 'auroras', book?.allowAuroras, pl.canAurora],
    ] as const) {
      if (!spell) continue;
      if (allowed === false) throw new RpcError('FAILED', `${book.name} can't be used with ${kind}`);
      if (!magic && !can)
        throw new RpcError(
          'FAILED',
          `${kind[0]!.toUpperCase()}${kind.slice(1)} need magic attacks (equip a magic weapon), or an item that allows them with other attacks`,
        );
    }

    if (attack) pl.selectAttackSpell(attack, false);
    // toggleCurse / toggleAurora flip the selection, so only call them when it should change.
    const sel = pl.spellSelection;
    if (curse === null && sel.curse !== undefined) pl.toggleCurse(sel.curse, false);
    else if (curse && sel.curse !== curse) pl.toggleCurse(curse, false);
    if (aurora === null && sel.aurora !== undefined) pl.toggleAurora(sel.aurora, false);
    else if (aurora && sel.aurora !== aurora) pl.toggleAurora(aurora, false);

    const now = spellSelection(g);
    for (const [kind, want] of [
      ['attack', attack],
      ['curse', curse],
      ['aurora', aurora],
    ] as const) {
      if (want !== undefined && now[kind] !== (want === null ? null : want.id))
        throw new RpcError('FAILED', `The game didn't select ${want === null ? `no ${kind}` : want.name}`);
    }
    return now;
  });
}
