import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, winsorise, sharedCap } from '../src/measure.js';
import { parseHunks } from '../src/fate.js';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

let FX;
before(async () => {
  FX = await mkdtemp(join(tmpdir(), 'holdover-fixtures-'));
  await exec('bash', [join(here, 'fixtures.sh'), join(FX, 'repos')], { maxBuffer: 1 << 24 });
  FX = join(FX, 'repos');
});

const run = (name, opts = {}) =>
  measure(join(FX, name), { horizons: [1], winsor: 1, ...opts });

test('three states are counted separately, not collapsed', async () => {
  // 3 files x 10 agent lines. A human then rewrites one line of edit.py, removes
  // another, and deletes delete.py outright.
  const r = await run('editedgone');
  assert.equal(r.all.agent.lines, 30);
  assert.equal(r.all.agent.kept, 18);   // keep.py entire, plus 8 of edit.py
  assert.equal(r.all.agent.edited, 1);  // the rewritten line
  assert.equal(r.all.agent.gone, 11);   // 1 removed line + all of delete.py
});

test('a rename does not kill lines', async () => {
  const r = await run('renames');
  assert.equal(r.all.agent.lines, 10);
  assert.equal(r.all.agent.kept, 10);
});

test('a bulk directory move keeps every line, and adds none', async () => {
  // Without -M the mover would be credited with authoring 60 new lines and the
  // agent with losing 60. A single move commit was 55% of one repo's AI lines.
  const r = await run('bulkmove');
  assert.equal(r.all.agent.lines, 60);
  assert.equal(r.all.agent.kept, 60);
  assert.equal(r.all.human.lines, 0);
});

test('squash merge keeps the hoisted trailer measurable', async () => {
  const r = await run('squash');
  assert.equal(r.commits.agent, 1);
  assert.equal(r.all.agent.lines, 12);
  assert.equal(r.all.agent.kept, 12);
});

test('rebase merge is measured, and arrival is the rebase date', async () => {
  const r = await run('rebase');
  assert.equal(r.all.agent.lines, 12);
  assert.equal(r.all.agent.kept, 12);
  // The commit was authored 2025-01-05 and replayed onto main on 2025-05-01.
  // Arrival must be the later date, or the cohort is a year out.
  const arrivalISO = new Date(r.reference * 1000).toISOString().slice(0, 10);
  assert.equal(arrivalISO, '2025-05-01');
});

test('merge commit dates the branch by when the merge landed', async () => {
  // The agent commit's own committer date is 2025-01-05; the merge is 2025-06-01.
  // A 90-day horizon measured from the merge must not include it early.
  const r = await measure(join(FX, 'mergecommit'), { horizons: [1, 30], winsor: 1 });
  assert.equal(r.all.agent.lines, 12);
  const at30 = r.cohorts.find((c) => c.days === 30);
  assert.equal(at30.agent.lines, 0, 'nothing is 30 days old when arrival is the merge');
});

test('a reformat run does not read as an edit when the repo asks it to be ignored', async () => {
  const r = await run('reformat');
  assert.equal(r.ignoreRevsHonoured, true);
  assert.equal(r.all.agent.lines, 20);
  assert.equal(r.all.agent.kept, 20);
  assert.equal(r.warnings.ignoredRevs, 1);
  // The ignored commit is not measured as an author either.
  assert.equal(r.commits.excluded, 1);
});

test('binaries are excluded from both sides', async () => {
  // blame reads a PNG as thousands of lines while numstat reports it as "-",
  // and that asymmetry alone can push a rate past 200%.
  const r = await run('binary');
  assert.equal(r.all.agent.lines, 10);
  assert.equal(r.all.agent.kept, 10);
});

test('bots, lockfiles and keyword-in-prose commits do not become data', async () => {
  const r = await run('noise');
  assert.equal(r.commits.agent, 1);
  assert.equal(r.commits.excluded, 1);       // dependabot
  assert.equal(r.all.agent.lines, 10);
  assert.equal(r.all.human.lines, 11);       // 400 lockfile lines are not counted
});

test('a squashed PR of mixed authorship is not credited to the agent', async () => {
  // The agent wrote 12 of 100 lines in the PR. Trailer attribution claims all 100 —
  // an 8.3x overcount, and it strips the other 88 from the baseline it compares
  // against. On getzep/graphiti this case carried 87% of the apparent agent lines.
  const r = await run('mixedsquash');
  assert.match(r.unmeasurable, /squash/, 'must refuse rather than claim 100 lines');
  assert.equal(r.commits.mixed, 1);
  assert.equal(r.commits.agent, 0);

  // With the correction disabled, the overcount is visible — this is the number
  // every trailer-only tool reports.
  const naive = await run('mixedsquash', { countSquashes: true });
  assert.equal(naive.all.agent.lines, 100);
});

test('a single-commit squash is still attributed', async () => {
  // One commit, one author: the hoisted trailer does describe the whole diff.
  const r = await run('singlesquash');
  assert.equal(r.commits.mixed, 0);
  assert.equal(r.commits.agent, 1);
  assert.equal(r.all.agent.lines, 12);
});

test('non-ASCII paths, subdirectories and diff-shaped content all survive', async () => {
  // Three separate parser traps, each of which silently scored real lines as gone:
  // core.quotePath escaping the path on one side but not the other; ls-files being
  // relative to the working directory while git log is repo-wide; and a content
  // line `-- a/x` arriving as `--- a/x` under -U0.
  const cwd = join(FX, 'awkward');
  const r = await measure(cwd, { horizons: [1], winsor: 1 });
  assert.equal(r.all.agent.lines, 12);
  assert.equal(r.all.agent.kept, 12, 'nothing was touched, so nothing may be lost');

  // Same answer from a subdirectory.
  const fromSub = await measure(join(cwd, 'pkg'), { horizons: [1], winsor: 1 });
  assert.equal(fromSub.all.agent.kept, 12);
});

test('a line deleted and re-added identically is kept, not edited', async () => {
  // blame credits the commit that restored it, but the line is right there,
  // unchanged. Calling that `edited` was indefensible; it was 11.1% of one real
  // repo's agent cohort.
  const r = await run('readded');
  assert.equal(r.all.agent.lines, 10);
  assert.equal(r.all.agent.kept, 10);
  assert.equal(r.all.agent.reattributed, 10, 'and the reattribution is reported');
  assert.equal(r.all.agent.edited, 0);
});

test('a wholesale tree replacement is unmeasurable, not a 0% tie', async () => {
  // Both classes read 0% kept, so the difference is 0.0 pp by construction. One
  // real repo does this: 0 of 427,394 agent lines and 0 of 301,298 human lines.
  // That is an absence of data, not a finding of parity.
  const r = await measure(join(FX, 'replaced'), { horizons: [90], winsor: 1 });
  assert.match(r.unmeasurable, /retains almost nothing/);
  // An unmeasurable verdict is still a verdict about one commit. Without the sha
  // it cannot be rechecked, or told apart from the same repo measured later.
  assert.match(r.head, /^[0-9a-f]{40}$/);
});

test('the new-file share of each cohort is reported', async () => {
  // The dominant confound: a line in a file its own commit created has nothing to
  // rewrite it. Standardising on this took one repo's gap from +10.0 to +0.6 pp.
  const r = await measure(join(FX, 'editedgone'), { horizons: [1], winsor: 1 });
  assert.equal(r.cohorts[0].agent.newFileShare, 1, 'the agent created all three files');
  // The human commit only edited existing files, so none of its lines are in new
  // ones. It sits outside the 1-day cohort, so check it on the whole history.
  assert.equal(r.all.human.newFileShare, 0);
});

test('a repo with no agent attribution is unmeasurable, not zero', async () => {
  const r = await run('notrailers');
  assert.match(r.unmeasurable, /no agent/);
  assert.equal(r.all, undefined);
  assert.match(r.head, /^[0-9a-f]{40}$/);
});

test('every reported rate carries its own n', async () => {
  const r = await measure(join(FX, 'editedgone'), { horizons: [1, 30, 180], winsor: 1 });
  for (const c of r.cohorts) {
    assert.equal(typeof c.agent.lines, 'number');
    assert.equal(typeof c.human.lines, 'number');
    assert.equal(c.agent.kept + c.agent.edited + c.agent.gone, c.agent.lines);
  }
});

test('winsorising clamps one dominating commit and reports it', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    added: i === 0 ? 100000 : 10, kept: i === 0 ? 100000 : 10, edited: 0, gone: 0, reattributed: 0,
  }));
  const { rows: out, capped, trimmed } = winsorise(rows, sharedCap(rows, 0.99));
  assert.equal(capped, 1);
  assert.ok(trimmed > 99000);
  assert.equal(out[0].added, 10);
});

test('the cap fires below 100 commits, and is the same for both classes', () => {
  // A per-class p99 was a no-op for any n < 100, because ceil(0.99*n)-1 == n-1.
  // Agent cohorts are usually under 100 commits and human cohorts over, so the
  // clamp only ever hit the baseline. One shared cap removes that asymmetry.
  const agent = Array.from({ length: 40 }, (_, i) => ({
    added: i === 0 ? 100000 : 10, kept: 0, edited: 0, gone: 0, reattributed: 0,
  }));
  const humanRows = Array.from({ length: 200 }, () => ({
    added: 10, kept: 0, edited: 0, gone: 0, reattributed: 0,
  }));
  const cap = sharedCap([...agent, ...humanRows], 0.99);
  assert.ok(Number.isFinite(cap), 'a cap must exist');
  assert.equal(winsorise(agent, cap).capped, 1, 'the huge agent commit must be clamped');
  assert.equal(winsorise(humanRows, cap).capped, 0);
});

test('cohort line totals are monotone in the horizon', async () => {
  // A per-cohort percentile is not monotone: the 90-day cohort is a subset of the
  // 30-day one, yet on a real repo the reported total went 201,847 -> 256,999 ->
  // 203,464 as the cohort shrank, because a smaller cohort has a higher p99.
  const r = await measure(join(FX, 'editedgone'), { horizons: [1, 30, 180], winsor: 0.99 });
  for (const side of ['agent', 'human']) {
    for (let i = 1; i < r.cohorts.length; i++) {
      assert.ok(r.cohorts[i][side].lines <= r.cohorts[i - 1][side].lines,
        `${side}: ${r.cohorts[i].days}d must not exceed ${r.cohorts[i - 1].days}d`);
    }
  }
});

test('winsorising does nothing when there is nothing to clamp', () => {
  const rows = [{ added: 10, kept: 5, edited: 0, gone: 5, reattributed: 0 }];
  assert.equal(winsorise(rows, sharedCap(rows, 0.99)).capped, 0);
});

test('hunk parsing distinguishes replacement from removal', () => {
  // -U0 omits the count when it is 1, which is the whole trap in this format.
  const diff = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n'
    + '@@ -2 +2 @@\n-old\n+new\n@@ -4 +3,0 @@\n-removed\n@@ -0,0 +9,2 @@\n+a\n+b\n';
  assert.deepEqual(parseHunks(diff).get('x.py'), [
    { start: 2, end: 2, adds: 1 },   // replaced -> edited
    { start: 4, end: 4, adds: 0 },   // removed  -> gone
  ]);                                 // the pure insertion removes nothing
});

test('diff-shaped file content is not read as a path header', () => {
  // With -U0 every body line starts with + or -, so content `-- a/evil.py`
  // arrives as `--- a/evil.py`. Only a header inside a `diff --git` block counts.
  const diff = 'diff --git a/real.py b/real.py\n--- a/real.py\n+++ b/real.py\n'
    + '@@ -1 +1 @@\n--- a/evil.py\n+++ b/evil.py\n@@ -9,2 +9,0 @@\n-p\n-q\n';
  const byPath = parseHunks(diff);
  assert.deepEqual([...byPath.keys()], ['real.py']);
  assert.deepEqual(byPath.get('real.py'), [
    { start: 1, end: 1, adds: 1 },
    { start: 9, end: 10, adds: 0 },
  ]);
});

test('hunk parsing keeps multi-file diffs apart', () => {
  const diff = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x\n+y\n'
    + 'diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -5,2 +4,0 @@\n-p\n-q\n';
  const byPath = parseHunks(diff);
  assert.deepEqual(byPath.get('a.py'), [{ start: 1, end: 1, adds: 1 }]);
  assert.deepEqual(byPath.get('b.py'), [{ start: 5, end: 6, adds: 0 }]);
});

test('every line at HEAD is attributed exactly once', async () => {
  // The decisive check on the blame parser: if this holds, no line is double
  // counted and none is dropped. An earlier parser over-counted by 1.7% of lines
  // on a real repo and this is what caught it.
  const { blameHead, textFilesAtHead } = await import('../src/blame.js');
  const { git } = await import('../src/git.js');
  for (const name of ['editedgone', 'renames', 'bulkmove', 'reformat', 'noise']) {
    const cwd = join(FX, name);
    const files = await textFilesAtHead(cwd, 'HEAD');
    const b = await blameHead(cwd, files, 'HEAD');
    let attributed = 0;
    for (const byPath of b.surviving.values()) {
      for (const ranges of byPath.values()) {
        for (const [a, z] of ranges) attributed += z - a + 1;
      }
    }
    let actual = 0;
    for (const f of files) {
      const txt = await git(cwd, ['show', `HEAD:${f}`]);
      if (!txt.length) continue;
      actual += txt.endsWith('\n') ? txt.split('\n').length - 1 : txt.split('\n').length;
    }
    assert.equal(attributed, actual, `${name}: blame must cover HEAD exactly`);
  }
});

test('the three states always sum to the lines written', async () => {
  // A rate over 100%, or states that do not add up, is the signature of the two
  // sides measuring different things — a binary read as text, or a diff that did
  // not line up with the ranges it was supposed to cover.
  for (const name of ['editedgone', 'renames', 'bulkmove', 'squash', 'noise', 'binary', 'awkward']) {
    const r = await run(name);
    if (r.unmeasurable) continue;
    for (const side of ['agent', 'human']) {
      const t = r.all[side];
      assert.ok(t.kept <= t.lines, `${name}/${side}: kept must not exceed added`);
      assert.equal(t.kept + t.edited + t.gone, t.lines, `${name}/${side}: states must sum`);
    }
  }
});

test('per-commit rows are exposed so the headline can be rechecked', async () => {
  // Without these there is no way to stratify, cluster or reweight, and the two
  // printed estimators have to be taken on trust.
  const r = await run('editedgone');
  assert.ok(Array.isArray(r.commitRows) && r.commitRows.length > 0);
  const totals = r.commitRows.filter((x) => x.klass === 'agent')
    .reduce((a, x) => a + x.added, 0);
  assert.equal(totals, r.all.agent.lines);
  for (const row of r.commitRows) {
    assert.equal(typeof row.addedInNewFiles, 'number');
    assert.ok(row.addedInNewFiles <= row.added);
  }
});

test('a report larger than the pipe buffer survives the pipe', async () => {
  // `process.exit` with a report already handed to `process.stdout` drops
  // whatever the pipe has not accepted yet — 64 KiB on macOS — so this passed
  // to a terminal and to a file, and silently truncated `holdover --json | jq`.
  // Many horizons is the cheap way to a report bigger than the buffer.
  const horizons = Array.from({ length: 250 }, (_, i) => i + 1).join(',');
  const { stdout } = await exec('node',
    [join(here, '..', 'src', 'cli.js'), join(FX, 'editedgone'),
      '--json', '--quiet', '--horizons', horizons],
    { maxBuffer: 1 << 26 });
  assert.ok(stdout.length > 65536, `report was ${stdout.length} bytes, expected > 64 KiB`);
  assert.equal(JSON.parse(stdout).cohorts.length, 250);
});

test('an empty cohort is refused, not printed as dashes', async () => {
  // A repo whose agent commits are all younger than the shortest horizon has no
  // keep rate. The report used to print a table of dashes and exit 0.
  const r = await measure(join(FX, 'editedgone'), { horizons: [3650], winsor: 1 });
  assert.match(r.unmeasurable, /have had/);
  assert.ok(r.all.agent.lines > 0, 'the counts are still returned');
});

test('winsorising keeps the three states summing to the clamped total', async () => {
  const rows = [{ added: 9, kept: 3, edited: 3, gone: 3, reattributed: 0 }];
  const { rows: [r] } = winsorise(rows, 4);
  assert.equal(r.added, 4);
  assert.equal(r.kept + r.edited + r.gone, 4);
});

test('kept lines are split by whether their file was new', async () => {
  // The dominant confound: a line in a file its own commit created has nothing to
  // rewrite it, so the split has to be available per commit, not just in aggregate.
  const r = await measure(join(FX, 'editedgone'), { horizons: [1], winsor: 1 });
  const agent = r.commitRows.filter((x) => x.klass === 'agent');
  assert.ok(agent.length > 0);
  for (const row of agent) {
    assert.ok(row.keptInNewFiles <= row.kept);
    assert.ok(row.keptInNewFiles <= row.addedInNewFiles);
  }
  // The agent commit created all three files, so every kept line is in a new one.
  assert.equal(agent[0].keptInNewFiles, agent[0].kept);
});
