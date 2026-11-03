/**
 * Convert arbitrary game values into JSON-safe data for `debug.eval`.
 * Game objects are deeply cyclic, so this is depth- and size-limited, and
 * collapses NamespacedObjects to `{ id, name }` once the depth budget runs out.
 */
export function toJSONSafe(value: unknown, depth = 2): unknown {
  const seen = new WeakSet<object>();

  const walk = (v: unknown, d: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v;
      case 'number':
        return Number.isFinite(v) ? v : String(v);
      case 'bigint':
        return v.toString();
      case 'symbol':
        return v.toString();
      case 'function':
        return `[Function ${(v as { name?: string }).name || 'anonymous'}]`;
    }
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return '[Circular]';

    if (isNamespaced(obj) && d <= 0) return { id: obj.id, name: safeName(obj) };
    if (d < 0) return `[${ctorName(obj)}]`;

    seen.add(obj);
    try {
      if (Array.isArray(obj)) return obj.slice(0, 500).map((x) => walk(x, d - 1));
      if (obj instanceof Map) {
        const out: unknown[] = [];
        let i = 0;
        for (const [k, val] of obj) {
          if (i++ >= 500) break;
          out.push([walk(k, 0), walk(val, d - 1)]);
        }
        return { $map: out };
      }
      if (obj instanceof Set) return { $set: [...obj].slice(0, 500).map((x) => walk(x, d - 1)) };
      if (typeof (obj as { nodeType?: unknown }).nodeType === 'number') return `[DOM ${ctorName(obj)}]`;
      if (typeof (obj as { then?: unknown }).then === 'function') return '[Promise]';

      const out: Record<string, unknown> = {};
      const name = ctorName(obj);
      if (name !== 'Object') out.$class = name;
      if (isNamespaced(obj)) {
        out.id = obj.id;
        out.name = safeName(obj);
      }
      let count = 0;
      for (const key of Object.keys(obj)) {
        if (count++ >= 200) {
          out.$truncated = true;
          break;
        }
        if (key === 'game' || key === '_events' || key.startsWith('renderQueue')) continue;
        try {
          out[key] = walk(obj[key], d - 1);
        } catch {
          out[key] = '[unreadable]';
        }
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };

  return walk(value, depth);
}

function isNamespaced(o: Record<string, unknown>): o is Record<string, unknown> & { id: string } {
  return typeof o.id === 'string' && typeof o.localID === 'string';
}

function safeName(o: Record<string, unknown>): unknown {
  try {
    return o.name;
  } catch {
    return undefined;
  }
}

function ctorName(o: object): string {
  try {
    return (o.constructor && o.constructor.name) || 'Object';
  } catch {
    return 'Object';
  }
}
