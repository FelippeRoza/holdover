// Splitting the lines that are no longer credited to their author into `edited`
// and `gone`.
//
// This distinction is the whole point. Collapsing it is what makes the published
// numbers disagree: a preprint that scores any modification as death reports AI
// lines "dying" 53.9% of the time, and there a one-character rename scores exactly
// the same as deleting the file. Both are real outcomes and they mean opposite
// things.
//
// Definitions, at line granularity, for a line L that commit C added to file P:
//
//   kept    L is still at HEAD, unchanged apart from whitespace. Either blame
//           credits it to C — following moves between files, ignoring the revs the
//           repo asks to ignore — or the diff from C to HEAD does not touch it.
//   edited  L is not credited to C any more, but the diff from C's version of P to
//           HEAD's version replaced L rather than removing it: the hunk covering L
//           also adds lines. The author's contribution to that spot survives in
//           changed form.
//   gone    P is not at HEAD under any name, or the hunk covering L only deletes.
//
// The second clause matters. A line can be present at HEAD unchanged yet credited
// elsewhere, because an intermediate commit deleted it and another re-added it, so
// blame credits the re-adder. An earlier version called that `edited`, which was
// indefensible: the line is right there, unchanged. It counts as `kept`, and the
// count is reported separately as `reattributed`, 10.3% of one real repo's agent
// cohort — so the choice is visible rather than buried.
//
// `-w` on both the blame and the diff, so a reindent does not read as a rewrite.
// Both sides must agree on it or the numerator and denominator measure different
// things. This is why `kept` is "unchanged apart from whitespace" and not
// "byte-identical".

import { git, mapLimit, CONCURRENCY } from './git.js';

/** Expand inclusive [start, end] ranges into line numbers. */
function expand(ranges) {
  const lines = [];
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) lines.push(i);
  return lines;
}

/** Is `line` inside any of these sorted, inclusive ranges? */
function inRanges(ranges, line) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line < ranges[mid][0]) hi = mid - 1;
    else if (line > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Parse `git diff -U0` output into old-side hunks, keyed by the old path.
 *
 * Hunk coordinates on the `-` side are in the old commit's version of the file,
 * which is the same space the added-line numbers are in, so no remapping is
 * needed. `-U0` omits a count when it is 1, which is the trap in this format.
 *
 * @returns {Map<string, Array<{start: number, end: number, adds: number}>>}
 */
export function parseHunks(diff, singlePath = null) {
  const byPath = new Map();
  let path = singlePath;
  let inHeader = false;
  if (path) byPath.set(path, []);

  for (const line of diff.split('\n')) {
    // With -U0 every body line begins with + or -, so file content of the form
    // `-- a/x` arrives as the line `--- a/x` and would be read as a path header.
    // A real header only ever follows a `diff --git` line, so that gates it.
    if (line.startsWith('diff --git ')) { inHeader = true; continue; }
    if (line.startsWith('--- ') && inHeader) {
      inHeader = false;
      if (singlePath) continue; // blob-to-blob: the caller already knows the path
      const p = line.slice(4);
      path = p === '/dev/null' ? null : p.replace(/^a\//, '');
      if (path && !byPath.has(path)) byPath.set(path, []);
      continue;
    }
    if (!path || !line.startsWith('@@')) continue;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (oldCount === 0) continue; // pure insertion: it removes nothing
    byPath.get(path).push({ start: oldStart, end: oldStart + oldCount - 1, adds: newCount });
  }
  return byPath;
}

function coveringHunk(hunks, line) {
  let lo = 0;
  let hi = hunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line < hunks[mid].start) hi = mid - 1;
    else if (line > hunks[mid].end) lo = mid + 1;
    else return hunks[mid];
  }
  return null;
}

/**
 * Where a commit's added lines ended up.
 *
 * Paths still present at HEAD under the same name are covered by one tree diff
 * for the whole commit. Only a path that has moved needs its own blob-to-blob
 * diff — a tree diff narrowed by pathspec cannot see the rename target, so it
 * would report a moved file as wholly deleted and every line in it as gone.
 */
const PATHSPEC_BATCH = 500;

const chunk = (xs, n) => Array.from(
  { length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function commitFate(cwd, sha, files, survivingByPath, headPathFor, headFiles, tip, newPaths) {
  const out = { kept: 0, edited: 0, gone: 0, reattributed: 0, keptInNewFiles: 0 };
  const isNew = (path) => !!newPaths?.has(path);

  /** @type {Array<{path: string, orphans: number[]}>} */
  const present = [];
  /** @type {Array<{path: string, successor: string, orphans: number[]}>} */
  const moved = [];

  for (const [path, ranges] of files) {
    const survivors = survivingByPath?.get(path);
    const lines = expand(ranges);
    const orphans = survivors ? lines.filter((l) => !inRanges(survivors, l)) : lines;
    out.kept += lines.length - orphans.length;
    if (isNew(path)) out.keptInNewFiles += lines.length - orphans.length;
    if (orphans.length === 0) continue;

    if (headFiles.has(path)) {
      present.push({ path, orphans });
      continue;
    }
    // Blame already found any move: if some of this commit's lines from `path`
    // survive at HEAD, they name the file they ended up in.
    const successor = headPathFor.get(path);
    if (successor && headFiles.has(successor)) moved.push({ path, successor, orphans });
    else out.gone += orphans.length;
  }

  const tally = (orphans, hunks, path) => {
    // A hunk can replace at most as many lines as it adds. With -U0 a deletion and
    // an adjacent insertion are one hunk, so `adds > 0` alone scored 99 deleted
    // lines as edited against a single added one.
    const budget = new Map();
    for (const line of orphans) {
      const hunk = hunks ? coveringHunk(hunks, line) : null;
      // No hunk covers it: the line is unchanged between that commit and HEAD, so
      // it is still there even though blame credits someone else.
      if (!hunk) {
        out.kept++;
        out.reattributed++;
        if (isNew(path)) out.keptInNewFiles++;
        continue;
      }
      const left = budget.get(hunk) ?? hunk.adds;
      if (left > 0) { out.edited++; budget.set(hunk, left - 1); }
      else out.gone++;
    }
  };

  // Chunked because one pathspec per file blows past ARG_MAX on a commit that
  // adds thousands of files, and a failed diff used to book every line as gone.
  for (const batch of chunk(present, PATHSPEC_BATCH)) {
    const diff = await git(cwd, [
      'diff', '-U0', '-w', '--no-color', '--no-textconv', '--no-renames',
      sha, tip, '--', ...batch.map((p) => p.path),
    ]);
    const byPath = parseHunks(diff);
    for (const p of batch) tally(p.orphans, byPath.get(p.path) ?? [], p.path);
  }

  for (const m of moved) {
    const diff = await git(cwd, [
      'diff', '-U0', '-w', '--no-color', '--no-textconv',
      `${sha}:${m.path}`, `${tip}:${m.successor}`,
    ]);
    tally(m.orphans, parseHunks(diff, m.path).get(m.path) ?? [], m.path);
  }

  return out;
}

export async function fateForCommits(cwd, commits, surviving, headPathFor, headFiles, tip, onProgress) {
  let done = 0;
  return mapLimit([...commits.keys()], CONCURRENCY, async (sha) => {
    const entry = commits.get(sha);
    const fate = await commitFate(cwd, sha, entry.files, surviving.get(sha), headPathFor, headFiles, tip, entry.newPaths);
    done++;
    if (onProgress) onProgress(done, commits.size);
    return { sha, ...fate, added: entry.added, addedInNewFiles: entry.addedInNewFiles };
  });
}
