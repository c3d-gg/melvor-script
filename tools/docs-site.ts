/**
 *   bun run docs:site           generate the docs site's reference pages, id list and changelog page,
 *                               and the roadmap section of modio/description.html
 *   bun run docs:site --check   fail if the docs are incomplete or stale (CI runs this):
 *                                 - a public call or property without a doc comment
 *                                 - a call that no guide or lesson shows (see site/coverage.json)
 *                                 - an out-of-date entry in site/coverage.json
 *                                 - a mod page roadmap that doesn't match site/roadmap.json
 *   bun run docs:site --todo    rewrite the "todo" list in site/coverage.json to what's uncovered now
 *
 * Generated files (gitignored, don't edit): site/src/content/docs/reference/, site/src/content/docs/changelog.md
 * and site/public/ids.json. To change what the reference says, edit the doc comments in src/client/.
 * How the site is organised: site/CONTRIBUTING.md.
 */
import ts from 'typescript';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  ROOT,
  alias,
  cls,
  doc,
  fields,
  find,
  flat,
  iface,
  leadingDoc,
  md,
  members,
  source,
  type Member,
} from './api-source.ts';

const SITE = join(ROOT, 'site');
const DOCS = join(SITE, 'src/content/docs');
const REF = join(DOCS, 'reference');
const CHECK = process.argv.includes('--check');
const TODO = process.argv.includes('--todo');

// ---------------------------------------------------------------------------
// the API model
// ---------------------------------------------------------------------------

interface ApiMember extends Member {
  /** e.g. 'm.player.eat', or 'm.skills.*.level' for members every skill has. */
  id: string;
  /** Finds the member in guide and lesson text. */
  usage: RegExp;
}
interface Group {
  title?: string;
  intro?: string;
  members: ApiMember[];
}
interface RefPage {
  slug: string;
  title: string;
  description: string;
  order: number;
  intro: string;
  groups: Group[];
  /** Extra MDX after the groups. */
  after?: string;
}

const melvor = source('melvor');
const protocol = source('protocol');

function usageFor(path: string, name: string): RegExp {
  if (path === 'm') return new RegExp(`\\bm\\.${name}\\b`);
  if (path === 'm.skills.*') return new RegExp(`\\bskills\\.\\w+\\.${name}\\b|\\.get\\([^)]*\\)\\.${name}\\b`);
  const last = path.split('.').at(-1)!;
  return new RegExp(`\\b${last}\\.${name}\\b`);
}

function group(className: string, path: string, opts: { title?: string; intro?: string; skip?: string[] } = {}): Group {
  const c = cls(melvor, className);
  return {
    title: opts.title,
    intro: opts.intro ?? doc(c),
    members: members(c)
      .filter((m) => !opts.skip?.includes(m.name))
      .map((m) => ({ ...m, id: `${path}.${m.name}`, usage: usageFor(path, m.name) })),
  };
}

function firstSentence(text: string): string {
  const s = flat(text.split('\n\n')[0] ?? '');
  const end = s.search(/\.(\s|$)/);
  return (end > 0 ? s.slice(0, end + 1) : s).replace(/`/g, '');
}

function buildPages(): RefPage[] {
  const pages: RefPage[] = [];
  const index = source('index');

  // m, run() and connect()
  const fnSig = (f: ts.FunctionDeclaration) =>
    `${f.name!.text}(${f.parameters.map((p) => flat(p.getText())).join(', ')})${f.type ? `: ${flat(f.type.getText())}` : ''}`;
  const fn = (sf: ts.SourceFile, name: string, extra = ''): ApiMember => {
    const f = find(sf, name, ts.isFunctionDeclaration);
    return {
      kind: 'method',
      name,
      sig: fnSig(f),
      doc: doc(f) + extra,
      id: name,
      usage: new RegExp(`\\b${name}\\(`),
    };
  };
  const subApis = ['skills', 'bank', 'player', 'combat', 'potions', 'shop', 'data'];
  pages.push({
    slug: 'm',
    title: 'm',
    description: 'The object every script gets: pacing, events, logging, and the way into everything else.',
    order: 1,
    intro: `\`m\` is what your \`run\` callback gets (or what \`await connect()\` returns). Everything else hangs off it: ${subApis
      .map((s) => `[\`m.${s}\`](/reference/${s === 'combat' ? 'combat' : s}/)`)
      .join(', ')}.`,
    groups: [
      {
        title: 'Starting a script',
        members: [
          fn(index, 'run'),
          fn(melvor, 'connect', '\n\nUse it for one-off tools; `run` is what scripts usually want.'),
        ],
      },
      group('Melvor', 'm', { title: 'm', skip: subApis }),
    ],
  });

  // skills
  const skills = cls(melvor, 'Skills');
  const skillProps = skills.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !!m.type);
  const actionGroups: Group[] = [];
  const statOnly: string[] = [];
  for (const p of skillProps) {
    const name = (p.name as ts.Identifier).text;
    const type = p.type!.getText();
    if (type === 'Skill') {
      statOnly.push(`\`${name}\``);
      continue;
    }
    if (type === 'Farming') continue; // its own page
    const g = group(type, `m.skills.${name}`, { title: `m.skills.${name}` });
    actionGroups.push({ ...g, members: g.members.filter((m) => m.kind === 'method') });
  }
  pages.push({
    slug: 'skills',
    title: 'm.skills',
    description: 'Every skill: levels and XP, the actions each skill can do, and mastery.',
    order: 2,
    intro:
      'One object per skill: `m.skills.woodcutting`, `m.skills.mining`, and so on. Every skill has levels and XP; skills with actions also do things. Farming has [its own page](/reference/farming/).',
    groups: [
      // The skill objects themselves (m.skills.woodcutting...) are the sections below, not properties.
      group('Skills', 'm.skills', { title: 'm.skills', skip: skillProps.map((p) => (p.name as ts.Identifier).text) }),
      ...actionGroups,
      group('Skill', 'm.skills.*', {
        title: 'Every skill',
        intro: 'On every skill above, e.g. `m.skills.mining.level`.',
      }),
      group('ActionSkill', 'm.skills.*', {
        title: 'Every skill with actions',
        intro: "On every skill that does actions. `T` is that skill's id type (`TreeId` for woodcutting).",
      }),
      group('MasterySkill', 'm.skills.*', {
        title: 'Mastery',
        intro: 'On every skill with actions, and on `m.skills.farming` (where `T` is `CropId`).',
      }),
    ],
    after: `## Skills without scripted actions\n\nLevel and XP only, for now: ${statOnly.join(', ')}.`,
  });

  pages.push({
    slug: 'farming',
    title: 'm.skills.farming',
    description: 'Plots, planting, compost and harvesting.',
    order: 3,
    intro: doc(cls(melvor, 'Farming')),
    groups: [{ ...group('Farming', 'm.skills.farming'), intro: '' }],
  });

  const simple: [string, string, string, string][] = [
    ['bank', 'm.bank', 'Bank', 'What you have, and selling, opening and burying items.'],
    ['player', 'm.player', 'Player', 'HP, food, equipment, prayers, attack style and combat spells.'],
    ['combat', 'm.combat', 'Combat', 'Fighting monsters and dungeons, loot.'],
    ['slayer', 'm.combat.slayer', 'Slayer', 'Slayer tasks: get one, extend it, fight it.'],
    ['potions', 'm.potions', 'PotionManager', 'Drinking potions for combat or a skill.'],
    ['shop', 'm.shop', 'Shop', 'Buying from the shop.'],
    ['data', 'm.data', 'GameData', 'Looking up items, actions, monsters, areas and spells.'],
  ];
  simple.forEach(([slug, title, className, description], i) => {
    const g = group(className, title);
    pages.push({ slug, title, description, order: 4 + i, intro: g.intro ?? '', groups: [{ ...g, intro: '' }] });
  });
  return pages;
}

// ---------------------------------------------------------------------------
// writing MDX
// ---------------------------------------------------------------------------

/** Escape the characters MDX treats as code (`{ }`) or tags (`< >`), outside code spans. */
function prose(s: string): string {
  return s
    .split(/(`[^`]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/[{}<>]/g, (c) => `\\${c}`)))
    .join('');
}

/** A doc comment as MDX: indented lines become ```ts blocks, the rest is escaped prose. */
function mdx(text: string): string {
  let fence = false;
  return md(text)
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) {
        fence = !fence;
        return line;
      }
      return fence ? line : prose(line);
    })
    .join('\n');
}

const cell = (s: string) => prose(s.replace(/\|/g, '\\|').replace(/\n+/g, ' '));

interface DocPage {
  title: string;
  href: string;
  section: string;
  text: string;
}

/** Hand-written pages (not the reference), with the files they pull in through <Snippet file="...">. */
function docPages(): DocPage[] {
  const out: DocPage[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, e.name);
      if (e.isDirectory()) {
        if (file !== REF) walk(file);
        continue;
      }
      if (!/\.mdx?$/.test(e.name) || file === join(DOCS, 'changelog.md')) continue;
      const raw = readFileSync(file, 'utf8');
      const rel = relative(DOCS, file)
        .replace(/\\/g, '/')
        .replace(/\.mdx?$/, '');
      const href = `/${rel.replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/');
      const title = raw.match(/^title:\s*['"]?(.+?)['"]?\s*$/m)?.[1] ?? rel;
      const included = [...raw.matchAll(/<Snippet[^>]*?\bfile="([^"]+)"/g)].map((m) => {
        const path = join(ROOT, m[1]!);
        if (!existsSync(path)) throw new Error(`${relative(ROOT, file)}: <Snippet file="${m[1]}"> doesn't exist`);
        return readFileSync(path, 'utf8');
      });
      out.push({ title, href, section: rel.split('/')[0]!, text: [raw, ...included].join('\n') });
    }
  };
  walk(DOCS);
  return out;
}

const SECTION_LABEL: Record<string, string> = { learn: 'Lesson', guides: 'Guide', concepts: 'Concept', start: '' };

function usedIn(m: ApiMember, pages: DocPage[]): DocPage[] {
  return pages.filter((p) => m.usage.test(p.text) && p.href !== '/');
}

function usedLinks(m: ApiMember, pages: DocPage[]): string {
  return usedIn(m, pages)
    .map((p) => `[${prose(SECTION_LABEL[p.section] ? `${SECTION_LABEL[p.section]}: ${p.title}` : p.title)}](${p.href})`)
    .join(', ');
}

/** Properties as one compact table: name, type, description, and where guides use it. */
function propertyTable(props: ApiMember[], pages: DocPage[]): string {
  const rows = props.map((m) => {
    const type = m.sig.slice(m.name.length + 2);
    const used = usedLinks(m, pages);
    const about = cell(flat(m.doc)) + (used ? ` <span class="api-used">Used in ${used}.</span>` : '');
    return `| \`${m.name}\` | \`${type.replace(/\|/g, '\\|')}\` | ${about} |`;
  });
  return '| Property | Type | |\n| --- | --- | --- |\n' + rows.join('\n');
}

function memberMdx(m: ApiMember, pages: DocPage[]): string {
  const heading = m.kind === 'method' ? `${m.name}()` : m.name;
  const meta: string[] = [];
  if (m.pace === 'cooldown') meta.push('<Badge text="Cooldown" variant="caution" />');
  else if (m.pace === 'free') meta.push('<Badge text="No cooldown" variant="success" />');
  const used = usedLinks(m, pages);
  if (used) meta.push(`<span class="api-used">Used in ${used}</span>`);
  return [
    `### \`${heading}\``,
    meta.length ? `<div class="api-meta">\n\n${meta.join(' ')}\n\n</div>` : '',
    '```ts\n' + m.sig + '\n```',
    mdx(m.doc),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function frontmatter(title: string, description: string, order: number): string {
  const q = (s: string) => JSON.stringify(s);
  return `---\ntitle: ${q(title)}\ndescription: ${q(description)}\nsidebar:\n  order: ${order}\n---\n\n{/* Generated by tools/docs-site.ts from the doc comments in src/client/. Edit those, not this file. */}\n`;
}

function pageMdx(p: RefPage, pages: DocPage[]): string {
  const parts = [
    frontmatter(p.title, p.description, p.order),
    "import { Badge } from '@astrojs/starlight/components';",
  ];
  if (p.intro) parts.push(mdx(p.intro));
  for (const g of p.groups) {
    if (g.title) parts.push(`## \`${g.title}\``);
    if (g.intro) parts.push(mdx(g.intro));
    const props = g.members.filter((m) => m.kind === 'property');
    const methods = g.members.filter((m) => m.kind === 'method');
    if (props.length && !g.title) parts.push('## Properties');
    if (props.length)
      parts.push(
        '<p class="api-note">Synchronous: they read the live state the game pushes to your script.</p>',
        propertyTable(props, pages),
      );
    if (props.length && methods.length && !g.title) parts.push('## Methods');
    parts.push(...methods.map((m) => memberMdx(m, pages)));
  }
  if (p.after) parts.push(p.after);
  return parts.join('\n\n') + '\n';
}

function typeTable(name: string, node: ts.InterfaceDeclaration | ts.TypeLiteralNode, intro = ''): string {
  const rows = fields(node).map((f) => `| \`${f.name}\` | \`${f.type.replace(/\|/g, '\\|')}\` | ${cell(f.doc)} |`);
  const about = intro || (ts.isInterfaceDeclaration(node) ? doc(node) : '');
  return [`### \`${name}\``, about && mdx(about), '| Field | Type | |\n| --- | --- | --- |\n' + rows.join('\n')]
    .filter(Boolean)
    .join('\n\n');
}

function typesPage(): string {
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
    'SlayerCategoryInfo',
    'SpellInfo',
    'FarmingPlotInfo',
    'PlantResult',
    'HarvestResult',
    'RuntimeInfo',
  ];
  return [
    frontmatter('Options and results', 'The options skill actions take, and what calls resolve with.', 20),
    typeTable('ActOptions', iface(melvor, 'ActOptions'), 'The last argument of every skill action.'),
    ...results.map((n) => typeTable(n, iface(protocol, n))),
  ].join('\n\n');
}

function statePage(): string {
  const names = [
    'GameState',
    'MetaState',
    'SkillState',
    'PlayerState',
    'SpellSelectionState',
    'ActionState',
    'JobInfo',
    'CombatState',
    'SlayerTaskState',
    'PotionsState',
  ];
  return [
    frontmatter('m.state', 'The live mirror of the game behind every synchronous read.', 21),
    'The live mirror behind every synchronous read. The game pushes it several times a second and refreshes it before every call returns. Most scripts use the getters on `m.player`, `m.bank` and friends instead; `m.onState(fn)` and `m.waitFor(predicate)` watch it.',
    ...names.map((n) => typeTable(n, iface(protocol, n))),
  ].join('\n\n');
}

function eventsPage(): string {
  const events = alias(protocol, 'GameEventMessage').type as ts.UnionTypeNode;
  const rows = events.types.filter(ts.isTypeLiteralNode).map((t) => {
    const fs = fields(t);
    const type = fs.find((f) => f.name === 'type')!.type.replace(/'/g, '');
    const rest = fs.filter((f) => f.name !== 'type').map((f) => `${f.name}: ${f.type}`);
    return `| \`${type}\` | \`{ ${rest.join('; ').replace(/\|/g, '\\|')} }\` |`;
  });
  return [
    frontmatter('Events', 'Things the game tells your script about as they happen.', 22),
    'Subscribe with `m.on(type, handler)`, which returns a function that unsubscribes, or wait for one with `await m.once(type)`.',
    '| Type | Fields |\n| --- | --- |\n' + rows.join('\n'),
  ].join('\n\n');
}

function errorsPage(): string {
  const errors = source('errors');
  const codes = (alias(protocol, 'ErrorCode').type as ts.UnionTypeNode).types.map((t, i, all) => {
    const code = t.getText().replace(/'/g, '');
    return `| \`${code}\` | ${cell(leadingDoc(t, i ? all[i - 1]!.end : t.parent.pos))} |`;
  });
  codes.push(
    '| `DISCONNECTED` | The connection to the game closed. |',
    "| `TIMEOUT` | `whenReady` / `waitFor` didn't finish in time. |",
  );
  const classes = ['MelvorError', 'ActionStoppedError', 'FightStoppedError'].map((n) => {
    const c = cls(errors, n);
    const props = members(c).filter((m) => m.kind === 'property');
    return `### \`${n}\`\n\n${mdx(flat(doc(c)))}${props.length ? `\n\nHas ${props.map((p) => `\`${p.sig}\``).join(', ')}.` : ''}`;
  });
  return [
    frontmatter('Errors', 'Why a call failed, and the error classes scripts can catch.', 23),
    'A call that fails rejects with a `MelvorError`. Its `code` says why. The [errors concept page](/concepts/how-it-works/#when-a-call-fails) shows how to handle them.',
    '## Codes',
    '| Code | |\n| --- | --- |\n' + codes.join('\n'),
    '## Error classes',
    ...classes,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

interface IdMap {
  name: string;
  count: number;
  example: string;
  about: string;
}

/** Every id from ids.generated.ts, for the search page: { maps, ids: [map index, key, id, name][] }. */
function readIds(): { maps: IdMap[]; ids: [number, string, string, string][] } {
  const text = readFileSync(join(ROOT, 'src/shared/ids.generated.ts'), 'utf8');
  const maps: IdMap[] = [];
  const ids: [number, string, string, string][] = [];
  let about = '';
  for (const line of text.split('\n')) {
    const comment = line.match(/^\/\*\*\s*(.*?)\s*\*\/$/);
    if (comment) about = comment[1]!;
    const start = line.match(/^export const (\w+) = \{/);
    if (start) {
      maps.push({ name: start[1]!, count: 0, example: '', about });
      about = '';
      continue;
    }
    // `/** Oak Logs */ Oak_Logs: "melvorD:Oak_Logs",` (some maps have no name comment)
    const entry = line.match(/^\s*(?:\/\*\*\s*(.*?)\s*\*\/\s*)?(\w+):\s*"([^"]+)"/);
    if (entry && maps.length) {
      const map = maps.at(-1)!;
      if (!map.example) map.example = `${map.name}.${entry[2]}`;
      map.count++;
      ids.push([maps.length - 1, entry[2]!, entry[3]!, entry[1] ?? entry[2]!.replace(/_/g, ' ')]);
    }
  }
  return { maps, ids };
}

function idsPage(maps: IdMap[]): string {
  const rows = maps.map((m) => `| \`${m.name}\` | ${m.count} | \`${m.example}\` |`);
  return [
    frontmatter('Ids', 'Find the typed id for any item, monster, tree, recipe or spell.', 30),
    "import IdSearch from '../../../components/IdSearch.astro';",
    "Every item, monster, tree, recipe and spell has an id. Import the map (`import { Items, Monsters } from 'melvor-script'`) and pick from it: `Items.Oak_Logs`. VS Code completes them as you type, and a typo fails before the script runs.",
    'Search by name. Click a result to copy it.',
    '<IdSearch />',
    '## Every id map',
    "Each map has a matching type for function parameters: `Items` → `ItemId`, `Trees` → `TreeId`. They're generated from the game data; `bunx melvor gen-types` regenerates them from your running game, modded content included.",
    '| Map | Ids | Example |\n| --- | --- | --- |\n' + rows.join('\n'),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// reference overview, changelog, roadmap
// ---------------------------------------------------------------------------

function indexPage(pages: RefPage[]): string {
  const card = (href: string, title: string, description: string) =>
    `  <LinkCard href="${href}" title=${JSON.stringify(title)} description=${JSON.stringify(description)} />`;
  return [
    `---\ntitle: Reference\ndescription: Every call, property, result, event and error, generated from the source.\nsidebar:\n  order: 0\n  label: Overview\n---\n\n{/* Generated by tools/docs-site.ts. */}`,
    "import { Badge, CardGrid, LinkCard } from '@astrojs/starlight/components';",
    "Everything a script can do, generated from the code: it's always the same as what VS Code shows when you hover over a call. New to all this? The [guides](/guides/combat/) show these calls in use.",
    '## How to read it',
    '- <Badge text="Cooldown" variant="caution" /> An action. It uses the shared cooldown and resolves when you may act again. Calling it while `m.ready` is false fails at once.',
    '- <Badge text="No cooldown" variant="success" /> Talks to the game (or waits) without using the cooldown. Use it any time, even in the middle of an action.',
    '- Properties (no badge) are synchronous: they read the live state the game pushes to your script, so they cost nothing.',
    '- **Used in** links go to the guides and lessons that show a call in use.',
    '## The API',
    '<CardGrid>',
    ...pages.map((p) => card(`/reference/${p.slug}/`, p.title, p.description)),
    '</CardGrid>',
    '## Types',
    '<CardGrid>',
    card('/reference/types/', 'Options and results', 'What actions take and resolve with.'),
    card('/reference/state/', 'm.state', 'The live mirror of the game.'),
    card('/reference/events/', 'Events', 'm.on(type, handler)'),
    card('/reference/errors/', 'Errors', 'Error codes and classes.'),
    card('/reference/ids/', 'Ids', 'Search every typed id.'),
    '</CardGrid>',
  ].join('\n\n');
}

function changelogPage(): string {
  const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
    .replace(/^# Changelog\s*\n/, '')
    .replace(/^## \[([^\]]+)\]\(([^)]+)\) - (\S+)/gm, '## $1 ($3)\n\n[Release notes and download]($2)');
  return `---\ntitle: Changelog\ndescription: Every release, newest first.\n---\n\n<!-- Generated by tools/docs-site.ts from CHANGELOG.md. -->\n\n${text}`;
}

interface Roadmap {
  available: string[];
  next: { title: string; detail: string }[];
  later: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ROADMAP_START = '<!-- roadmap: generated from site/roadmap.json by `bun run docs:site`. Edit that file. -->';
const ROADMAP_END = '<!-- /roadmap -->';

/** "a, b, and c" */
export const andList = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}` : (items[0] ?? '');

function roadmapHtml(r: Roadmap): string {
  return [
    ROADMAP_START,
    '<h3>Roadmap</h3>',
    // The available items carry their own "and"s ("the bank and the shop"), so plain commas.
    `<p><strong>Available now:</strong> ${esc(r.available.join(', '))}.</p>`,
    '<p><strong>Coming next</strong>, in this order:</p>',
    '<ol>',
    ...r.next.map((n) => `<li><strong>${esc(n.title)}:</strong> ${esc(n.detail)}</li>`),
    `<li><strong>Later:</strong> ${esc(andList(r.later))}.</li>`,
    '</ol>',
    ROADMAP_END,
  ].join('\n');
}

/** `text` as `bun fmt` would write it to a file with this extension. */
function formatted(text: string, ext: string): string {
  const tmp = join(ROOT, `.docs-site-tmp${ext}`);
  writeFileSync(tmp, text);
  try {
    const r = Bun.spawnSync([process.execPath, 'fmt', tmp], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`bun fmt failed: ${r.stderr.toString()}`);
    return readFileSync(tmp, 'utf8');
  } finally {
    rmSync(tmp, { force: true });
  }
}

function descriptionWithRoadmap(r: Roadmap): string {
  const file = join(ROOT, 'modio/description.html');
  const html = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = html.indexOf(ROADMAP_START);
  const end = html.indexOf(ROADMAP_END);
  if (start < 0 || end < start) throw new Error(`modio/description.html has no roadmap markers (${ROADMAP_START})`);
  return formatted(html.slice(0, start) + roadmapHtml(r) + html.slice(end + ROADMAP_END.length), '.html');
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

interface Coverage {
  $comment?: string;
  /** Members that only the reference needs to show, with the reason. */
  referenceOnly: Record<string, string>;
  /** Members still waiting for a guide or lesson. This list may only shrink. */
  todo: string[];
}

function checkCoverage(all: ApiMember[], pages: DocPage[], cov: Coverage): { problems: string[]; uncovered: string[] } {
  const problems: string[] = [];
  const uncovered: string[] = [];
  const known = new Set(all.map((m) => m.id));
  for (const m of all) {
    if (!m.doc.trim())
      problems.push(`${m.id}: no doc comment. Add one in src/client/ (VS Code shows it on hover too).`);
    const covered = usedIn(m, pages).length > 0;
    if (covered) {
      if (cov.todo.includes(m.id))
        problems.push(`${m.id} is in a guide now: run \`bun run docs:site --todo\` to take it off the todo list.`);
      continue;
    }
    if (m.id in cov.referenceOnly) continue;
    uncovered.push(m.id);
    if (!cov.todo.includes(m.id))
      problems.push(
        `${m.id}: no guide or lesson shows it. Add it to the guide for its system (see site/CONTRIBUTING.md), or list it under "referenceOnly" in site/coverage.json with the reason.`,
      );
  }
  for (const id of [...Object.keys(cov.referenceOnly), ...cov.todo])
    if (!known.has(id)) problems.push(`site/coverage.json lists ${id}, which isn't in the API any more.`);
  return { problems, uncovered };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const refPages = buildPages();
const pages = docPages();
const allMembers = [
  ...new Map(refPages.flatMap((p) => p.groups.flatMap((g) => g.members)).map((m) => [m.id, m])).values(),
];
const covFile = join(SITE, 'coverage.json');
const cov: Coverage = JSON.parse(readFileSync(covFile, 'utf8'));
const roadmap: Roadmap = JSON.parse(readFileSync(join(SITE, 'roadmap.json'), 'utf8'));
const { maps, ids } = readIds();

if (TODO) {
  const { uncovered } = checkCoverage(allMembers, pages, { ...cov, todo: [] });
  writeFileSync(covFile, formatted(JSON.stringify({ ...cov, todo: uncovered.sort() }, null, 2) + '\n', '.json'));
  console.log(`site/coverage.json: ${uncovered.length} members still to cover.`);
  process.exit(0);
}

if (CHECK) {
  const { problems, uncovered } = checkCoverage(allMembers, pages, cov);
  for (const p of refPages)
    if (!p.intro.trim())
      problems.push(`${p.title}: its class has no doc comment, so the reference page has no introduction.`);
  const description = readFileSync(join(ROOT, 'modio/description.html'), 'utf8').replace(/\r\n/g, '\n');
  if (descriptionWithRoadmap(roadmap) !== description)
    problems.push('modio/description.html: the roadmap differs from site/roadmap.json. Run `bun run docs:site`.');
  if (problems.length) {
    console.error(`✖ The docs need attention:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const total = allMembers.length;
  console.log(
    `Docs OK: ${total - uncovered.length - Object.keys(cov.referenceOnly).length} of ${total} calls and properties are in a guide or lesson, ${Object.keys(cov.referenceOnly).length} are reference-only, ${uncovered.length} to do.`,
  );
  process.exit(0);
}

rmSync(REF, { recursive: true, force: true });
mkdirSync(REF, { recursive: true });
const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
for (const p of refPages) write(join(REF, `${p.slug}.mdx`), pageMdx(p, pages));
write(join(REF, 'index.mdx'), indexPage(refPages) + '\n');
write(join(REF, 'types.mdx'), typesPage() + '\n');
write(join(REF, 'state.mdx'), statePage() + '\n');
write(join(REF, 'events.mdx'), eventsPage() + '\n');
write(join(REF, 'errors.mdx'), errorsPage() + '\n');
write(join(REF, 'ids.mdx'), idsPage(maps) + '\n');
write(join(DOCS, 'changelog.md'), changelogPage());
write(join(SITE, 'public/ids.json'), JSON.stringify({ maps: maps.map((m) => m.name), ids }));
write(join(ROOT, 'modio/description.html'), descriptionWithRoadmap(roadmap));
console.log(
  `docs site: ${refPages.length + 6} reference pages, ${ids.length} ids, changelog, roadmap (${pages.length} hand-written pages scanned)`,
);
