import { RpcError, type Game, type GameObject } from './env.ts';

export function allObjects(registry: GameObject): GameObject[] {
  if (!registry) return [];
  if (Array.isArray(registry.allObjects)) return registry.allObjects;
  if (registry.registeredObjects instanceof Map) return [...registry.registeredObjects.values()];
  if (typeof registry.forEach === 'function') {
    const out: GameObject[] = [];
    registry.forEach((o: GameObject) => out.push(o));
    return out;
  }
  return [];
}

/**
 * Look up a namespaced object by full id ('melvorD:Oak_Logs') or, for
 * convenience, by local id ('Oak_Logs') when that is unambiguous.
 */
export function resolveIn(registry: GameObject, id: unknown, kind: string): GameObject {
  if (typeof id !== 'string' || id.length === 0)
    throw new RpcError('BAD_REQUEST', `Expected a ${kind} id, got ${JSON.stringify(id)}`);
  const direct = registry?.getObjectByID?.(id);
  if (direct !== undefined) return direct;
  if (!id.includes(':')) {
    const matches = allObjects(registry).filter((o) => o.localID === id);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new RpcError('BAD_REQUEST', `${kind} '${id}' is ambiguous: ${matches.map((m) => m.id).join(', ')}`);
    }
  }
  throw new RpcError('NOT_FOUND', `Unknown ${kind} '${id}'`);
}

export function resolveSkill(game: Game, id: unknown): GameObject {
  return resolveIn(game.skills, id, 'skill');
}

export function resolveItem(game: Game, id: unknown): GameObject {
  return resolveIn(game.items, id, 'item');
}

export function resolveAction(skill: GameObject, id: unknown): GameObject {
  return resolveIn(skill.actions, id, `${skill.name} action`);
}

export function idOf(o: GameObject | undefined | null): string | null {
  return o && typeof o.id === 'string' ? o.id : null;
}
