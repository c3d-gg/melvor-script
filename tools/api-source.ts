/**
 * Reads the client's public API from the TypeScript source: classes, members, doc comments and
 * types. Shared by tools/api-docs.ts (docs/API.md) and tools/docs-site.ts (the docs site).
 */
import ts from 'typescript';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
export const FILES = {
  index: 'src/client/index.ts',
  melvor: 'src/client/melvor.ts',
  errors: 'src/client/errors.ts',
  protocol: 'src/shared/protocol.ts',
  ids: 'src/shared/ids.generated.ts',
};

export const program = ts.createProgram(
  Object.values(FILES).map((f) => `${ROOT}/${f}`),
  {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    strict: true,
    noEmit: true,
    types: [],
  },
);
export const checker = program.getTypeChecker();
export const source = (key: keyof typeof FILES) => {
  const sf = program.getSourceFile(`${ROOT}/${FILES[key]}`);
  if (!sf) throw new Error(`can't load ${FILES[key]}`);
  return sf;
};

// ---------------------------------------------------------------------------
// reading the source
// ---------------------------------------------------------------------------

export type Named = ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.FunctionDeclaration;

export function find<T extends Named>(sf: ts.SourceFile, name: string, is: (n: ts.Node) => n is T): T {
  for (const st of sf.statements) if (is(st) && st.name?.text === name) return st;
  throw new Error(`${name} not found in ${sf.fileName}`);
}
export const cls = (sf: ts.SourceFile, name: string) => find(sf, name, ts.isClassDeclaration);
export const iface = (sf: ts.SourceFile, name: string) => find(sf, name, ts.isInterfaceDeclaration);
export const alias = (sf: ts.SourceFile, name: string) => find(sf, name, ts.isTypeAliasDeclaration);

export const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

export function isInternal(node: ts.Node): boolean {
  return ts.getJSDocTags(node).some((t) => t.tagName.text === 'internal');
}

/** The doc comment on a declaration (without tags). */
export function doc(node: ts.Node & { name?: ts.Node }): string {
  const sym = node.name ? checker.getSymbolAtLocation(node.name) : undefined;
  if (sym) return ts.displayPartsToString(sym.getDocumentationComment(checker)).trim();
  return leadingDoc(node);
}

/** A `/** ... *\/` comment right before a node that isn't a JSDoc host (union members). */
export function leadingDoc(node: ts.Node, from = node.pos): string {
  // The last doc comment between `from` and the node. A union member's comment sits before
  // its `|`, outside the member's own range, so callers pass where the previous member ended.
  const text = node.getSourceFile().text.slice(from, node.getStart());
  const last = [...text.matchAll(/\/\*\*([\s\S]*?)\*\//g)].at(-1);
  if (!last) return '';
  return last[1]!
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim();
}

/** Inferred types name other files as import("C:/...").Type: keep just the name. */
export const local = (s: string) => s.replace(/import\("[^"]*"\)\./g, '');

export function typeText(node: ts.Node, typeNode: ts.TypeNode | undefined): string {
  if (typeNode) return flat(typeNode.getText());
  return local(checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation));
}

export interface Member {
  kind: 'property' | 'method';
  name: string;
  sig: string;
  doc: string;
  /**
   * Methods only. 'cooldown': an action that uses (and waits for) the shared cooldown.
   * 'free': talks to the game or waits, with no cooldown. Undefined: synchronous.
   */
  pace?: 'cooldown' | 'free';
}

/** The class a class extends, when it's declared in the same file. */
function parentClass(c: ts.ClassDeclaration): ts.ClassDeclaration | undefined {
  const name = c.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression.getText();
  if (!name) return undefined;
  for (const st of c.getSourceFile().statements) if (ts.isClassDeclaration(st) && st.name?.text === name) return st;
  return undefined;
}

/** A method as `this.name` would find it from `c`: its own, or inherited. */
function methodFrom(c: ts.ClassDeclaration, name: string): ts.MethodDeclaration | undefined {
  for (let k: ts.ClassDeclaration | undefined = c; k; k = parentClass(k)) {
    const m = k.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && x.name.getText() === name);
    if (m) return m;
  }
  return undefined;
}

/**
 * True when calling the method uses the action cooldown: its body goes through the client's
 * pacing (`_paced`, `_act`), directly or through another method of the same object.
 */
export function isPaced(c: ts.ClassDeclaration, m: ts.MethodDeclaration, seen = new Set<ts.Node>()): boolean {
  if (seen.has(m)) return false;
  seen.add(m);
  const body = m.body?.getText() ?? '';
  if (/\b_(paced|act)\(/.test(body)) return true;
  for (const [, name] of body.matchAll(/\bthis\.(\w+)\(/g)) {
    const target = methodFrom(c, name!);
    if (target && isPaced(c, target, seen)) return true;
  }
  return false;
}

export function isPublic(node: ts.Node): boolean {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return !(flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
}

/** A class's own public members (not inherited ones), in source order. */
export function members(c: ts.ClassDeclaration): Member[] {
  const out: Member[] = [];
  for (const m of c.members) {
    if (ts.isConstructorDeclaration(m)) {
      // `readonly id: SkillId` constructor parameters are properties too.
      for (const p of m.parameters) {
        const flags = ts.getCombinedModifierFlags(p);
        if (!(flags & (ts.ModifierFlags.Readonly | ts.ModifierFlags.Public)) || !isPublic(p)) continue;
        if (!ts.isIdentifier(p.name) || p.name.text.startsWith('_')) continue;
        out.push({ kind: 'property', name: p.name.text, sig: `${p.name.text}: ${typeText(p, p.type)}`, doc: doc(p) });
      }
      continue;
    }
    if (!m.name || !ts.isIdentifier(m.name) || m.name.text.startsWith('_') || !isPublic(m) || isInternal(m)) continue;
    const name = m.name.text;
    if (ts.isMethodDeclaration(m)) {
      const sig = checker.getSignatureFromDeclaration(m)!;
      const ret = m.type
        ? flat(m.type.getText())
        : local(checker.typeToString(checker.getReturnTypeOfSignature(sig), m, ts.TypeFormatFlags.NoTruncation));
      const tps = m.typeParameters ? `<${m.typeParameters.map((t) => flat(t.getText())).join(', ')}>` : '';
      const params = m.parameters.map((p) => flat(p.getText())).join(', ');
      const async = ret.startsWith('Promise<') || !!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword);
      const pace = isPaced(c, m) ? 'cooldown' : async ? 'free' : undefined;
      out.push({ kind: 'method', name, sig: `${name}${tps}(${params}): ${ret}`, doc: doc(m), pace });
    } else if (ts.isGetAccessor(m) || ts.isPropertyDeclaration(m)) {
      out.push({ kind: 'property', name, sig: `${name}: ${typeText(m, m.type)}`, doc: doc(m) });
    }
  }
  return out;
}

/** Fields of an interface (or an object type literal). */
export function fields(
  node: ts.InterfaceDeclaration | ts.TypeLiteralNode,
): { name: string; type: string; doc: string }[] {
  return node.members.filter(ts.isPropertySignature).map((p) => ({
    name: `${p.name.getText()}${p.questionToken ? '?' : ''}`,
    type: flat(p.type?.getText() ?? 'unknown'),
    doc: doc(p),
  }));
}

/** Doc text as markdown: indented lines in a comment are code examples. */
export function md(text: string, indent = ''): string {
  if (!text) return '';
  const lines = text.split('\n');
  const out: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (!code) return;
    const pad = Math.min(...code.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
    out.push('```ts', ...code.map((l) => l.slice(pad)).filter((l, i, a) => l || i < a.length - 1), '```');
    code = null;
  };
  for (const l of lines) {
    if (/^ {2,}\S/.test(l) || (code && !l.trim())) (code ??= []).push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return out.map((l) => (l ? indent + l : l)).join('\n');
}
