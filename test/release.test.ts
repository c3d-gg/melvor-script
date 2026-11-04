/** The version maths behind `bun run release` (tools/release.ts). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bumpFor, bumpVersion, parseCommit, releaseNotes } from '../tools/release.ts';

const c = (subject: string, body = '') => parseCommit('0123456789abcdef', subject, body);

describe('release versioning', () => {
  it('parses Conventional Commit subjects (type, scope, !)', () => {
    assert.deepEqual(c('feat(combat): leave combat after fights'), {
      sha: '0123456789abcdef',
      type: 'feat',
      scope: 'combat',
      breaking: false,
      subject: 'leave combat after fights',
    });
    assert.equal(c('fix!: rename the speed setting').breaking, true);
    assert.equal(c('refactor: x', 'BREAKING CHANGE: the old API is gone').breaking, true);
    assert.equal(c('Scripted clicks skip the popup').type, null);
  });

  it('picks the bump from the commits (pre-1.0: breaking is a minor bump)', () => {
    assert.equal(bumpFor([c('fix: a'), c('feat: b')], '0.3.0'), 'minor');
    assert.equal(bumpFor([c('fix: a'), c('docs: b')], '0.3.0'), 'patch');
    assert.equal(bumpFor([c('No type at all')], '0.3.0'), 'patch');
    assert.equal(bumpFor([c('chore: a'), c('test: b')], '0.3.0'), null);
    assert.equal(bumpFor([c('feat!: a')], '0.3.0'), 'minor');
    assert.equal(bumpFor([c('feat!: a')], '1.2.3'), 'major');
  });

  it('bumps versions', () => {
    assert.equal(bumpVersion('0.2.0', 'minor'), '0.3.0');
    assert.equal(bumpVersion('0.2.7', 'patch'), '0.2.8');
    assert.equal(bumpVersion('1.4.2', 'major'), '2.0.0');
  });

  it('groups release notes and hides chores', () => {
    const notes = releaseNotes(
      '0.3.0',
      [c('feat: new thing'), c('fix(ui): broken thing'), c('chore: tidy'), c('Plain message')],
      '2026-11-03',
    );
    assert.match(notes, /^## \[0\.3\.0\]\(.+\/releases\/tag\/v0\.3\.0\) - 2026-11-03/);
    assert.match(notes, /### Features\n\n- new thing \(\[0123456\]/);
    assert.match(notes, /### Fixes\n\n- \*\*ui:\*\* broken thing/);
    assert.match(notes, /### Other changes\n\n- Plain message/);
    assert.doesNotMatch(notes, /tidy/);
  });
});
