/**
 *   bun run release [major|minor|patch|X.Y.Z] [--dry-run] [--yes]
 *
 * Cuts a release from the commits since the last `vX.Y.Z` tag:
 *   1. works out the next version from the Conventional Commit messages
 *      (feat → minor, fix/perf → patch, `!` or "BREAKING CHANGE:" → major; while 0.x, breaking → minor;
 *       a commit without a type counts as a patch, chore/docs/test/ci/build/style alone release nothing),
 *   2. writes package.json + CHANGELOG.md, then typechecks, tests, checks formatting and packs the mod,
 *   3. commits "chore(release): vX.Y.Z", tags vX.Y.Z and pushes both,
 *   4. publishes a GitHub release with the notes and dist/melvor-script-vX.Y.Z.zip attached.
 *
 * --dry-run prints the version and notes and changes nothing. Pass a bump or a version to override.
 */
import { $ } from 'bun';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/c3d-gg/melvor-script';
const PKG = join(ROOT, 'package.json');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
$.cwd(ROOT);

type Bump = 'major' | 'minor' | 'patch';
interface Commit {
  sha: string;
  type: string | null;
  scope: string | null;
  breaking: boolean;
  subject: string;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const assumeYes = args.includes('--yes');
const override = args.find((a) => !a.startsWith('--'));

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// version maths
// ---------------------------------------------------------------------------

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<subject>.+)$/;
const HIDDEN = new Set(['chore', 'docs', 'test', 'ci', 'build', 'style']);

export function parseCommit(sha: string, subject: string, body: string): Commit {
  const m = CONVENTIONAL.exec(subject.trim());
  const breaking = /^BREAKING[ -]CHANGE:/m.test(body) || !!m?.groups?.bang;
  if (!m?.groups) return { sha, type: null, scope: null, breaking, subject: subject.trim() };
  return { sha, type: m.groups.type!, scope: m.groups.scope ?? null, breaking, subject: m.groups.subject! };
}

export function bumpFor(commits: Commit[], current: string): Bump | null {
  if (commits.some((c) => c.breaking)) return current.startsWith('0.') ? 'minor' : 'major';
  if (commits.some((c) => c.type === 'feat')) return 'minor';
  if (commits.some((c) => c.type === null || !HIDDEN.has(c.type))) return 'patch';
  return null;
}

export function bumpVersion(version: string, bump: Bump): string {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function releaseNotes(version: string, commits: Commit[], date: string): string {
  const line = (c: Commit) =>
    `- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject} ([${c.sha.slice(0, 7)}](${REPO_URL}/commit/${c.sha}))`;
  const groups: [string, (c: Commit) => boolean][] = [
    ['⚠ Breaking changes', (c) => c.breaking],
    ['Features', (c) => !c.breaking && c.type === 'feat'],
    ['Fixes', (c) => !c.breaking && c.type === 'fix'],
    ['Performance', (c) => !c.breaking && c.type === 'perf'],
    [
      'Other changes',
      (c) => !c.breaking && !['feat', 'fix', 'perf'].includes(c.type ?? '') && !HIDDEN.has(c.type ?? ''),
    ],
  ];
  const out = [`## [${version}](${REPO_URL}/releases/tag/v${version}) - ${date}`];
  for (const [title, test] of groups) {
    const items = commits.filter(test);
    if (items.length) out.push('', `### ${title}`, '', ...items.map(line));
  }
  return out.join('\n');
}

const CHANGELOG_HEADER = `# Changelog

All notable changes, newest first. Versions follow [Semantic Versioning](https://semver.org) (while 0.x, a minor
bump may change behaviour). Entries are written by \`bun run release\` from
[Conventional Commit](https://www.conventionalcommits.org) messages.
`;

function withEntry(existing: string | null, entry: string): string {
  if (!existing) return `${CHANGELOG_HEADER}\n${entry}\n`;
  const at = existing.indexOf('\n## ');
  return at === -1
    ? `${existing.trimEnd()}\n\n${entry}\n`
    : `${existing.slice(0, at + 1)}${entry}\n\n${existing.slice(at + 1)}`;
}

// ---------------------------------------------------------------------------
// the release
// ---------------------------------------------------------------------------

/** Run quietly and return trimmed stdout. */
async function out(cmd: ReturnType<typeof $>): Promise<string> {
  return (await cmd.quiet().text()).trim();
}

async function main() {
  const dirty = (await out($`git status --porcelain`)) !== '';
  const branch = await out($`git rev-parse --abbrev-ref HEAD`);
  if (!dryRun) {
    if (dirty) fail('Commit or stash your changes first (the working tree is not clean).');
    if (branch !== 'main') fail(`Releases are cut from main (you are on ${branch}).`);
  } else if (dirty) {
    console.log('(dry run with uncommitted changes: they are not part of the release)');
  }
  await $`git fetch --quiet --tags origin`.quiet();
  if (Number(await out($`git rev-list --count ${'HEAD..origin/main'}`)) > 0)
    fail('main is behind origin/main: pull first.');

  // (Interpolated so the shell passes the pattern to git instead of expanding it as a glob.)
  const lastTag = (await $`git describe --tags --abbrev=0 --match ${'v[0-9]*'}`.quiet().nothrow().text()).trim();
  if (!lastTag) fail('No vX.Y.Z tag yet. Tag the starting point first, e.g. `git tag -a v0.1.0 <sha> -m v0.1.0`.');

  const raw = await out($`git log ${`${lastTag}..HEAD`} ${'--format=%H%x1f%s%x1f%b%x1e'}`);
  const commits = raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body] = r.split('\x1f') as [string, string, string?];
      return parseCommit(sha, subject, body ?? '');
    });
  if (commits.length === 0) fail(`Nothing to release: no commits since ${lastTag}.`);

  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as { version: string };
  const current = pkg.version;
  let next: string;
  if (override && /^\d+\.\d+\.\d+$/.test(override)) next = override;
  else if (override) {
    if (!['major', 'minor', 'patch'].includes(override))
      fail(`Unknown bump "${override}" (major, minor, patch or X.Y.Z).`);
    next = bumpVersion(current, override as Bump);
  } else {
    const bump = bumpFor(commits, current);
    if (!bump) fail(`Only chore/docs/test commits since ${lastTag}: nothing to release (pass a bump to force one).`);
    next = bumpVersion(current, bump);
  }
  if ((await out($`git tag --list ${`v${next}`}`)) !== '') fail(`v${next} already exists.`);

  const date = new Date().toISOString().slice(0, 10);
  const notes = releaseNotes(next, commits, date);
  console.log(`\n${current} → ${next}  (${commits.length} commit${commits.length > 1 ? 's' : ''} since ${lastTag})\n`);
  console.log(notes, '\n');
  if (dryRun) {
    console.log('(dry run: nothing changed)');
    return;
  }
  if (!assumeYes) {
    const answer = prompt(`Release v${next}? This tags and pushes it and creates a GitHub release. [y/N]`);
    if (!answer || !/^y(es)?$/i.test(answer.trim())) fail('Cancelled.');
  }

  // Files first, so the checks and the zip see the new version.
  writeFileSync(PKG, readFileSync(PKG, 'utf8').replace(/"version":\s*"[^"]+"/, `"version": "${next}"`));
  writeFileSync(CHANGELOG, withEntry(existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : null, notes));
  try {
    await $`bun fmt CHANGELOG.md`.quiet();
    await $`bun run typecheck`;
    await $`bun test`;
    await $`bun fmt --check`;
    await $`bun run pack`;
  } catch (e) {
    await $`git checkout -- package.json`.quiet().nothrow();
    if (await out($`git ls-files CHANGELOG.md`)) await $`git checkout -- CHANGELOG.md`.quiet().nothrow();
    else await $`git clean -fq -- CHANGELOG.md`.quiet().nothrow();
    fail(
      `Checks failed, release aborted (package.json and CHANGELOG.md restored).\n${e instanceof Error ? e.message : e}`,
    );
  }

  const zip = join(ROOT, 'dist', `melvor-script-v${next}.zip`);
  copyFileSync(join(ROOT, 'dist', 'melvor-script.zip'), zip);
  const notesFile = join(ROOT, 'dist', 'release-notes.md');
  writeFileSync(notesFile, notes.split('\n').slice(1).join('\n').trim() + '\n');

  await $`git add package.json CHANGELOG.md`;
  await $`git commit -q -m ${`chore(release): v${next}`}`;
  await $`git tag -a ${`v${next}`} -m ${`v${next}`}`;
  await $`git push -q origin main`;
  await $`git push -q origin ${`v${next}`}`;
  await $`gh release create ${`v${next}`} ${zip} --title ${`v${next}`} --notes-file ${notesFile}`;
  console.log(`\n✔ v${next} released: ${REPO_URL}/releases/tag/v${next}`);
}

if (import.meta.main) await main();
