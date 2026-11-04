/**
 *   bun run docs            write docs/API.md from the client's types and doc comments
 *   bun run docs --check    fail if docs/API.md is out of date (CI and releases run this)
 *
 * The reference is generated, so it can't drift from the code: to improve a description,
 * edit the doc comment in src/ (VS Code shows the same text on hover) and rerun.
 */
import ts from 'typescript';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const OUT = join(ROOT, 'docs', 'API.md');
const FILES = {
  index: 'src/client/index.ts',
  melvor: 'src/client/melvor.ts',
  errors: 'src/client/errors.ts',
  protocol: 'src/shared/protocol.ts',
  ids: 'src/shared/ids.generated.ts',
};

const program = ts.createProgram(
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
const checker = program.getTypeChecker();
const source = (key: keyof typeof FILES) => {
  const sf = program.getSourceFile(`${ROOT}/${FILES[key]}`);
  if (!sf) throw new Error(`can't load ${FILES[key]}`);
  return sf;
};

// ---------------------------------------------------------------------------
// reading the source
// ---------------------------------------------------------------------------

type Named = ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.FunctionDeclaration;

function find<T extends Named>(sf: ts.SourceFile, name: string, is: (n: ts.Node) => n is T): T {
  for (const st of sf.statements) if (is(st) && st.name?.text === name) return st;
  throw new Error(`${name} not found in ${sf.fileName}`);
}
const cls = (sf: ts.SourceFile, name: string) => find(sf, name, ts.isClassDeclaration);
const iface = (sf: ts.SourceFile, name: string) => find(sf, name, ts.isInterfaceDeclaration);
const alias = (sf: ts.SourceFile, name: string) => find(sf, name, ts.isTypeAliasDeclaration);

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function isInternal(node: ts.Node): boolean {
  return ts.getJSDocTags(node).some((t) => t.tagName.text === 'internal');
}

/** The doc comment on a declaration (without tags). */
function doc(node: ts.Node & { name?: ts.Node }): string {
  const sym = node.name ? checker.getSymbolAtLocation(node.name) : undefined;
  if (sym) return ts.displayPartsToString(sym.getDocumentationComment(checker)).trim();
  return leadingDoc(node);
}

/** A `/** ... *\/` comment right before a node that isn't a JSDoc host (union members). */
function leadingDoc(node: ts.Node, from = node.pos): string {
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
const local = (s: string) => s.replace(/import\("[^"]*"\)\./g, '');

function typeText(node: ts.Node, typeNode: ts.TypeNode | undefined): string {
  if (typeNode) return flat(typeNode.getText());
  return local(checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation));
}

interface Member {
  kind: 'property' | 'method';
  name: string;
  sig: string;
  doc: string;
}

function isPublic(node: ts.Node): boolean {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return !(flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
}

/** A class's own public members (not inherited ones), in source order. */
function members(c: ts.ClassDeclaration): Member[] {
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
      out.push({ kind: 'method', name, sig: `${name}${tps}(${params}): ${ret}`, doc: doc(m) });
    } else if (ts.isGetAccessor(m) || ts.isPropertyDeclaration(m)) {
      out.push({ kind: 'property', name, sig: `${name}: ${typeText(m, m.type)}`, doc: doc(m) });
    }
  }
  return out;
}

/** Fields of an interface (or an object type literal). */
function fields(node: ts.InterfaceDeclaration | ts.TypeLiteralNode): { name: string; type: string; doc: string }[] {
  return node.members.filter(ts.isPropertySignature).map((p) => ({
    name: `${p.name.getText()}${p.questionToken ? '?' : ''}`,
    type: flat(p.type?.getText() ?? 'unknown'),
    doc: doc(p),
  }));
}

// ---------------------------------------------------------------------------
// writing markdown
// ---------------------------------------------------------------------------

/** Doc text as markdown: indented lines in a comment are code examples. */
function md(text: string, indent = ''): string {
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

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

function memberList(list: Member[], prefix = ''): string {
  return list
    .map((m) => {
      const body = md(m.doc, '  ');
      return `- **\`${prefix}${m.sig}\`**${body ? `\n${body}` : ''}`;
    })
    .join('\n');
}

function classSection(title: string, c: ts.ClassDeclaration, skip: string[] = []): string {
  const list = members(c).filter((m) => !skip.includes(m.name));
  const props = list.filter((m) => m.kind === 'property');
  const methods = list.filter((m) => m.kind === 'method');
  const parts = [`## ${title}`];
  const intro = doc(c);
  if (intro) parts.push(md(intro));
  if (props.length) parts.push('**Properties** (synchronous, from the live state)', memberList(props));
  if (methods.length) parts.push('**Methods**', memberList(methods));
  return parts.join('\n\n');
}

function typeTable(name: string, node: ts.InterfaceDeclaration | ts.TypeLiteralNode, intro = ''): string {
  const rows = fields(node).map((f) => `| \`${f.name}\` | \`${cell(f.type)}\` | ${cell(f.doc)} |`);
  const head = `### \`${name}\``;
  const about = intro || (ts.isInterfaceDeclaration(node) ? doc(node) : '');
  return [head, about && md(about), '| Field | Type | |\n| --- | --- | --- |\n' + rows.join('\n')]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

function build(): string {
  const melvor = source('melvor');
  const protocol = source('protocol');
  const errors = source('errors');
  const index = source('index');
  const ids = source('ids');
  const sections: string[] = [];

  sections.push(`# API reference

Everything a script can do. \`m\` is the object your \`run\` callback gets (or that \`await connect()\` returns).

- **Reads are synchronous.** \`m.state\` mirrors the game: it's pushed several times a second and refreshed before every call returns. \`m.bank.count(...)\`, \`m.skills.woodcutting.level\` and friends read from it.
- **Actions are async and paced.** Skill actions and combat (\`attack\`, \`fight\`, \`dungeon\`) resolve when you may act again. Calling one while \`!m.ready\` rejects at once with \`COOLDOWN\` or \`BUSY\`. Everything else (bank, shop, eating, equipment, mastery spending, data lookups) is free.
- **Ids are typed.** \`Items.Oak_Logs\`, \`Trees.Oak\`, \`Monsters.Chicken\` ... a typo fails at compile time. See [Ids](#ids).

This page is generated from the source by \`bun run docs\`. The descriptions are the doc comments VS Code shows on hover.

**Contents:** [Starting a script](#starting-a-script) · [m](#m) · [m.skills](#mskills) · [m.bank](#mbank) · [m.player](#mplayer) · [m.combat](#mcombat) · [m.shop](#mshop) · [m.data](#mdata) · [Options and results](#options-and-results) · [m.state](#mstate) · [Events](#events) · [Errors](#errors) · [Ids](#ids)`);

  // run / connect
  const run = find(index, 'run', ts.isFunctionDeclaration);
  const connect = find(melvor, 'connect', ts.isFunctionDeclaration);
  const fnSig = (f: ts.FunctionDeclaration) =>
    `${f.name!.text}(${f.parameters.map((p) => flat(p.getText())).join(', ')})${f.type ? `: ${flat(f.type.getText())}` : ''}`;
  sections.push(
    [
      '## Starting a script',
      `- **\`${fnSig(run)}\`**\n${md(doc(run), '  ')}`,
      `- **\`${fnSig(connect)}\`**\n${md(doc(connect), '  ')} Use it for one-off tools; \`run\` is what scripts usually want.`,
      '`ConnectOptions`: `name` (shown in the in-game panel), `timeoutMs`, and `host` / `port` / `token` (default: `~/.melvor-scripting/config.json`).',
    ].join('\n\n'),
  );

  const subApis = ['skills', 'bank', 'player', 'combat', 'shop', 'data'];
  sections.push(
    classSection('m', cls(melvor, 'Melvor'), subApis).replace(
      '## m\n',
      `## m\n\nSub-APIs: ${subApis.map((s) => `[\`m.${s}\`](#m${s})`).join(', ')}.\n`,
    ),
  );

  // skills
  const skills = cls(melvor, 'Skills');
  const skillProps = skills.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !!m.type);
  const actionRows: string[] = [];
  const statOnly: string[] = [];
  for (const p of skillProps) {
    const name = (p.name as ts.Identifier).text;
    const type = p.type!.getText();
    if (type === 'Skill') {
      statOnly.push(`\`${name}\``);
      continue;
    }
    for (const m of members(cls(melvor, type)).filter((x) => x.kind === 'method'))
      actionRows.push(`| \`m.skills.${name}\` | \`${cell(m.sig)}\` | ${cell(m.doc)} |`);
  }
  sections.push(
    [
      '## m.skills',
      memberList(members(skills).filter((m) => m.kind === 'method')),
      '### Skill actions',
      'Each returns a [`Promise<ActionResult>`](#actionresult) that resolves when you may act again. `opts` is [`ActOptions`](#actoptions).',
      '| Skill | Action | |\n| --- | --- | --- |\n' + actionRows.join('\n'),
      `Level and XP only (no scripted actions yet): ${statOnly.join(', ')}.`,
      '### Every skill',
      'On all of the above, e.g. `m.skills.mining.level`.',
      memberList(members(cls(melvor, 'Skill'))),
      '### Every skill with actions',
      "On every skill in the actions table, plus `m.skills.get(id)`. `T` is that skill's id type (`TreeId` for woodcutting).",
      memberList(members(cls(melvor, 'ActionSkill'))),
    ].join('\n\n'),
  );

  for (const [title, name] of [
    ['m.bank', 'Bank'],
    ['m.player', 'Player'],
    ['m.combat', 'Combat'],
    ['m.shop', 'Shop'],
    ['m.data', 'GameData'],
  ] as const)
    sections.push(classSection(title, cls(melvor, name)));

  // options and results
  const results = [
    'ActionResult',
    'AttackResult',
    'FightResult',
    'CanDoResult',
    'MasteryInfo',
    'MasteryPoolState',
    'ItemInfo',
    'ActionInfo',
    'MonsterInfo',
    'AreaInfo',
    'ShopPurchaseInfo',
    'RuntimeInfo',
  ];
  sections.push(
    [
      '## Options and results',
      typeTable('ActOptions', iface(melvor, 'ActOptions'), 'The last argument of every skill action.'),
      ...results.map((n) => typeTable(n, iface(protocol, n))),
    ].join('\n\n'),
  );

  // state
  sections.push(
    [
      '## m.state',
      'The live mirror behind every synchronous read. Most scripts use the getters above instead; `m.onState(fn)` and `m.waitFor(predicate)` watch it.',
      ...['GameState', 'MetaState', 'SkillState', 'PlayerState', 'ActionState', 'JobInfo', 'CombatState'].map((n) =>
        typeTable(n, iface(protocol, n)),
      ),
    ].join('\n\n'),
  );

  // events
  const events = alias(protocol, 'GameEventMessage').type as ts.UnionTypeNode;
  const eventRows = events.types.filter(ts.isTypeLiteralNode).map((t) => {
    const fs = fields(t);
    const type = fs.find((f) => f.name === 'type')!.type.replace(/'/g, '');
    const rest = fs.filter((f) => f.name !== 'type').map((f) => `${f.name}: ${f.type}`);
    return `| \`${type}\` | \`{ ${cell(rest.join('; '))} }\` |`;
  });
  sections.push(
    [
      '## Events',
      'Subscribe with `m.on(type, handler)` (returns an unsubscribe function) or wait for one with `await m.once(type)`.',
      '| Type | Fields |\n| --- | --- |\n' + eventRows.join('\n'),
    ].join('\n\n'),
  );

  // errors
  const codes = (alias(protocol, 'ErrorCode').type as ts.UnionTypeNode).types.map((t, i, all) => {
    const code = t.getText().replace(/'/g, '');
    return `| \`${code}\` | ${cell(leadingDoc(t, i ? all[i - 1]!.end : t.parent.pos))} |`;
  });
  codes.push(
    '| `DISCONNECTED` | The connection to the game closed. |',
    "| `TIMEOUT` | `whenReady` / `waitFor` didn't finish in time. |",
  );
  sections.push(
    [
      '## Errors',
      'Failed calls reject with a `MelvorError`. Its `code` says why:',
      '| Code | |\n| --- | --- |\n' + codes.join('\n'),
      ...['MelvorError', 'ActionStoppedError', 'FightStoppedError'].map((n) => {
        const c = cls(errors, n);
        const props = members(c).filter((m) => m.kind === 'property');
        return `- **\`${n}\`**: ${flat(doc(c))}${props.length ? ` Has ${props.map((p) => `\`${p.sig}\``).join(', ')}.` : ''}`;
      }),
    ].join('\n\n'),
  );

  // ids
  const idRows: string[] = [];
  for (const st of ids.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const obj = ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer;
      if (!ts.isObjectLiteralExpression(obj)) continue;
      const first = obj.properties.find(ts.isPropertyAssignment);
      const example = first ? `${d.name.text}.${first.name.getText()}` : '';
      const about = leadingDoc(st) || doc(d);
      idRows.push(`| \`${d.name.text}\` | ${obj.properties.length} | \`${example}\` | ${cell(about)} |`);
    }
  }
  sections.push(
    [
      '## Ids',
      "Const maps of every id in the game, from `import { Items, Trees, ... } from 'melvor-script'`. Each has a matching type (`ItemId`, `TreeId`, ...). They're generated from the game data; `bunx melvor gen-types` regenerates them from your running game, modded content included.",
      '| Map | Ids | Example | |\n| --- | --- | --- | --- |\n' + idRows.join('\n'),
    ].join('\n\n'),
  );

  return sections.join('\n\n') + '\n';
}

/** The page as `bun fmt` writes it, so `bun fmt --check` and `--check` here agree. */
function formatted(text: string): string {
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = join(ROOT, 'docs', 'API.tmp.md');
  writeFileSync(tmp, text);
  try {
    const r = Bun.spawnSync([process.execPath, 'fmt', tmp], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`bun fmt failed: ${r.stderr.toString()}`);
    return readFileSync(tmp, 'utf8');
  } finally {
    rmSync(tmp, { force: true });
  }
}

const page = formatted(build());
if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current.replace(/\r\n/g, '\n') !== page) {
    console.error('✖ docs/API.md is out of date: run `bun run docs`.');
    process.exit(1);
  }
  console.log('docs/API.md is up to date.');
} else {
  writeFileSync(OUT, page);
  console.log(`wrote docs/API.md (${page.split('\n').length} lines)`);
}
