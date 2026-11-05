/** Bank and shop endpoints. */
import type { ShopPurchaseInfo } from '../../shared/protocol.ts';
import { RpcError, safe, type GameObject } from '../env.ts';
import { allObjects, resolveIn, resolveItem } from '../lookup.ts';
import { num, type ApiContext } from './context.ts';

/** Run `fn` while recording bank changes; returns item id -> net delta. */
export function captureBank(game: GameObject, fn: () => void): Record<string, number> {
  const delta: Record<string, number> = {};
  const onItem = (e: GameObject) => {
    if (e?.item) delta[e.item.id] = (delta[e.item.id] ?? 0) + (e.newQuantity ?? 0) - (e.oldQuantity ?? 0);
  };
  game.bank.on?.('itemChanged', onItem);
  try {
    fn();
  } finally {
    game.bank.off?.('itemChanged', onItem);
  }
  for (const k of Object.keys(delta)) if (delta[k] === 0) delete delta[k];
  return delta;
}

export function registerBank(api: ApiContext) {
  const { rpc, env } = api;
  const game = () => env.game;

  rpc.register('bank.sell', (p: { item: string; quantity: number | null }) => {
    const g = game();
    const item = resolveItem(g, p.item);
    const owned = g.bank.getQty(item);
    const quantity =
      p.quantity === null || p.quantity === undefined
        ? owned
        : Math.min(num(p.quantity, 'quantity', { min: 1, int: true }), owned);
    if (quantity < 1) throw new RpcError('MISSING_ITEMS', `You have no ${item.name}`);
    if (!safe(() => g.tutorial.complete, true) && safe(() => g.tutorial.bannedItemSales.has(item), false)) {
      throw new RpcError('LOCKED', `${item.name} can't be sold during the tutorial`);
    }
    if (safe(() => g.bank.items.get(item).locked, false))
      throw new RpcError('LOCKED', `${item.name} is locked in the bank`);
    const currency = item.sellsFor.currency;
    const before = currency.amount;
    g.bank.processItemSale(item, quantity);
    return { sold: quantity, currency: currency.id, gained: currency.amount - before };
  });

  rpc.register('bank.open', (p: { item: string; quantity: number }) => {
    const g = game();
    const item = resolveItem(g, p.item);
    const quantity = num(p.quantity, 'quantity', { min: 1, int: true });
    if (g.bank.getQty(item) < 1) throw new RpcError('MISSING_ITEMS', `You have no ${item.name}`);
    if (typeof item.dropTable !== 'object' || item.dropTable === null)
      throw new RpcError('BAD_REQUEST', `${item.name} can't be opened`);
    if (item.keyItem !== undefined && g.bank.getQty(item.keyItem.item) < item.keyItem.quantity) {
      throw new RpcError(
        'MISSING_ITEMS',
        `Opening ${item.name} needs ${item.keyItem.quantity} x ${item.keyItem.item.name}`,
      );
    }
    const before = g.bank.getQty(item);
    // processItemOpen skips the UI's modal + 500ms delay that openItemOnClick adds.
    const items = captureBank(g, () => g.bank.processItemOpen(item, quantity));
    delete items[item.id];
    return { opened: before - g.bank.getQty(item), items };
  });

  rpc.register('bank.bury', (p: { item: string; quantity: number }) => {
    const g = game();
    const item = resolveItem(g, p.item);
    const quantity = num(p.quantity, 'quantity', { min: 1, int: true });
    const before = g.bank.getQty(item);
    if (before < 1) throw new RpcError('MISSING_ITEMS', `You have no ${item.name}`);
    g.bank.buryItemOnClick(item, quantity);
    return { buried: before - g.bank.getQty(item) };
  });
}

export function registerShop(api: ApiContext) {
  const { rpc, env } = api;

  rpc.register('shop.list', (): ShopPurchaseInfo[] => {
    const g = env.game;
    const shop = g.shop;
    return allObjects(shop.purchases).map((p: GameObject) => {
      const costs = safe(() => shop.getPurchaseCosts(p, 1), undefined as GameObject);
      return {
        id: p.id,
        name: safe(() => p.name, p.localID),
        category: safe(() => p.category.id, ''),
        costs: {
          currencies: safe(
            () =>
              costs.getCurrencyQuantityArray().map((c: GameObject) => ({ id: c.currency.id, quantity: c.quantity })),
            [],
          ),
          items: safe(
            () => costs.getItemQuantityArray().map((c: GameObject) => ({ id: c.item.id, quantity: c.quantity })),
            [],
          ),
        },
        owned: safe(() => shop.getPurchaseCount(p), 0),
        buyLimit: safe(() => p.getBuyLimit(g.currentGamemode), Infinity),
        unlocked: safe(() => g.checkRequirements(p.purchaseRequirements), true),
      };
    });
  });

  rpc.register('shop.buy', (p: { purchase: string; quantity: number }) => {
    const g = env.game;
    const shop = g.shop;
    const purchase = resolveIn(shop.purchases, p.purchase, 'shop purchase');
    const quantity = num(p.quantity ?? 1, 'quantity', { min: 1, int: true });
    if (!safe(() => g.tutorial.complete, true) && !safe(() => g.tutorial.allowedShopPurchases.has(purchase), true)) {
      throw new RpcError('LOCKED', `${purchase.name} is locked until the tutorial is complete`);
    }
    if (safe(() => shop.isPurchaseAtBuyLimit(purchase), false))
      throw new RpcError('LOCKED', `${purchase.name} is at its buy limit`);
    if (!safe(() => g.checkRequirements(purchase.purchaseRequirements), true))
      throw new RpcError('LOCKED', `Requirements for ${purchase.name} aren't met`);

    const qty = purchase.allowQuantityPurchase ? quantity : 1;
    const costs = shop.getPurchaseCosts(purchase, qty);
    if (!costs.checkIfOwned()) {
      const missing: Record<string, number> = {};
      for (const { currency, quantity: q } of costs.getCurrencyQuantityArray())
        if (currency.amount < q) missing[currency.id] = q - currency.amount;
      for (const { item, quantity: q } of costs.getItemQuantityArray())
        if (g.bank.getQty(item) < q) missing[item.id] = q - g.bank.getQty(item);
      throw new RpcError('MISSING_ITEMS', `Can't afford ${qty} x ${purchase.name}`, { missing });
    }

    const countBefore = safe(() => shop.getPurchaseCount(purchase), 0);
    const currencyBefore = allObjects(g.currencies).map((c: GameObject) => c.amount);
    const hadDesc = Object.getOwnPropertyDescriptor(shop, 'buyQuantity');
    let items: Record<string, number> = {};
    try {
      // buyItemOnClick reads the UI's buy-quantity selector; override it for this call.
      Object.defineProperty(shop, 'buyQuantity', { value: qty, configurable: true, writable: true });
      items = captureBank(g, () => shop.buyItemOnClick(purchase, true));
    } finally {
      if (hadDesc) Object.defineProperty(shop, 'buyQuantity', hadDesc);
      else delete shop.buyQuantity;
    }
    const spent = allObjects(g.currencies).some((c: GameObject, i: number) => c.amount < currencyBefore[i]);
    const countAfter = safe(() => shop.getPurchaseCount(purchase), 0);
    if (!spent && countAfter === countBefore && Object.keys(items).length === 0) {
      throw new RpcError('FAILED', `Purchase of ${purchase.name} did not go through (bank full?)`);
    }
    return { bought: qty, items };
  });
}
