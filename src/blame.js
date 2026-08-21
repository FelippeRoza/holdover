// One blame pass over every text file at HEAD. This is what says a line is still
// there.
//
// Flags, and why exactly these:
//
//   -C   Follows content across files. It implies -M, so writing `-M -C` is
//        noise. Measured on two real repos, -C moves 7.9% (flask, 5,556 commits)
//        and 9.5% (django, 34,884 commits) of lines to an older and correct
//        commit, for 1.4x and 2.75x the serial runtime. Parallelised across cores
//        that cost disappears: `-C` at full width is cheaper than no flags
//        serial, 0.92s vs 6.09s and 4.67s vs 17.95s on the same two samples.
//
//        A rename does NOT need -M: git follows a file's path history with no
//        flags at all, regardless of diff.renames. What -M actually buys is
//        movement of a block within one file.
//
//   -C -C and -C -C -C are deliberately not used. They change a further 0.35%
//        and 0.29% of lines on flask, 0.57% and 0.84% on django, and the last
//        one costs 23x. That is a fine trade for a forensic question about one
//        file and a bad default for a whole repo.
//
//   --ignore-revs-file   Worth more than every -C level combined and costs
//        nothing. Honouring django's committed .git-blame-ignore-revs moves
//        16.87% of sampled lines off the wrong commit; one 2022 Black run alone
//        owned 16.3%. A fresh clone does not honour the file — git only reads it
//        when asked, and says nothing when it is present and unused.

import { git, gitOrNull, mapLimit, CONCURRENCY } from './git.js';
import { skipPath } from './added.js';

export const IGNORE_REVS_FILE = '.git-blame-ignore-revs';

export async function blameArgs(cwd, { followMoves = true, honourIgnoreRevs = true, tip = 'HEAD' } = {}) {
  // --incremental, not --porcelain or --line-porcelain. All three carry the same
  // information for this purpose, but the volume differs by an order of magnitude
  // and the parsing is single-threaded, so on a large repo the format IS the
  // bottleneck: 14-way parallel blame over codex-rs was only 3.2x faster than
  // serial, because Node was busy parsing ~23 million lines of line-porcelain.
  // On one real file: line-porcelain 177,829 bytes, porcelain 46,962,
  // incremental 21,267.
  //
  // --porcelain is not usable here: it states a commit's metadata once and omits
  // it for later groups, which silently drops `filename` when one commit's lines
  // survive under two different original paths. --incremental repeats `filename`
  // on every group, and reports a whole run of consecutive lines in one header,
  // so ranges can be stored instead of individual line numbers.
  // -w costs nothing measurable (0.98-1.08x on two real repos) and stops a
  // reindent reading as a rewrite. The diff side in fate.js passes -w too; if only
  // one side had it the numerator and denominator would measure different things.
  const args = ['blame', '--incremental', '-w', ...(followMoves ? ['-C'] : [])];
  if (!honourIgnoreRevs) return { args, ignoreRevs: false };
  const present = await gitOrNull(cwd, ['cat-file', '-e', `${tip}:${IGNORE_REVS_FILE}`]);
  return { args, ignoreRevs: present !== null };
}

/**
 * The revs the repo asks blame to skip. They are also excluded from authorship:
 * having told blame to pretend a mass-reformat did not happen, it would be
 * incoherent to then measure that commit's own lines and score it 0% kept.
 */
export async function ignoredRevs(cwd, tip = 'HEAD') {
  const raw = await gitOrNull(cwd, ['show', `${tip}:${IGNORE_REVS_FILE}`]);
  if (raw === null) return new Set();
  const out = new Set();
  for (const line of raw.split('\n')) {
    const sha = line.replace(/#.*$/, '').trim();
    if (/^[0-9a-f]{40}$/.test(sha)) out.add(sha);
  }
  return out;
}

/**
 * Files in the measured ref's tree. Read from the tree rather than the index, so
 * the result does not depend on which branch is checked out or on a dirty working
 * copy: `--branch` used to change the denominator while every other pass read the
 * checked-out HEAD.
 */
export async function textFilesAtHead(cwd, tip, skip = skipPath) {
  const out = await git(cwd, ['ls-tree', '-r', '-z', '--name-only', tip]);
  return out.split('\0').filter((f) => f && !skip(f));
}

/**
 * @returns {{surviving: Map<string, Map<string, Set<number>>>, skipped: string[]}}
 *   surviving: sha -> original path -> sorted ranges of original line numbers
 *   still present at HEAD.
 *   The original path and line number come from blame's porcelain header, so a
 *   line that moved file still reports where it came from.
 */
export async function blameHead(cwd, files, tip, onProgress, flags) {
  const { args, ignoreRevs } = await blameArgs(cwd, { ...flags, tip });
  const full = ignoreRevs ? [...args, `--ignore-revs-file=${IGNORE_REVS_FILE}`] : args;

  /** sha -> original path -> sorted inclusive [start, end] ranges of original lines */
  /** @type {Map<string, Map<string, Array<[number, number]>>>} */
  const surviving = new Map();
  // originalPath -> headPath -> how many lines came that way. A path's move
  // destination is a property of the path, not of any one commit, so this is
  // collected once globally and resolved to the most common target.
  /** @type {Map<string, Map<string, number>>} */
  const moved = new Map();
  const skipped = [];
  let done = 0;

  await mapLimit(files, CONCURRENCY, async (file) => {
    const out = await gitOrNull(cwd, [...full, tip, '--', file]);
    done++;
    if (onProgress) onProgress(done, files.length);
    if (out === null) { skipped.push(file); return; }

    // --incremental: "<sha> <origLine> <finalLine> <numLines>" opens a group and
    // "filename <path>" names the file those lines came from. Everything between
    // is commit metadata this tool does not need.
    let sha = null;
    let origLine = 0;
    let count = 0;
    for (const line of out.split('\n')) {
      const header = line.match(/^([0-9a-f]{40}) (\d+) (\d+) (\d+)$/);
      if (header) {
        sha = header[1];
        origLine = Number(header[2]);
        count = Number(header[4]);
        continue;
      }
      if (!sha || !line.startsWith('filename ')) continue;
      const path = line.slice('filename '.length);

      let byPath = surviving.get(sha);
      if (!byPath) { byPath = new Map(); surviving.set(sha, byPath); }
      let ranges = byPath.get(path);
      if (!ranges) { ranges = []; byPath.set(path, ranges); }
      ranges.push([origLine, origLine + count - 1]);

      let targets = moved.get(path);
      if (!targets) { targets = new Map(); moved.set(path, targets); }
      targets.set(file, (targets.get(file) || 0) + count);
      sha = null;
    }
  });

  // Sort each range list once, so membership is a binary search later.
  for (const byPath of surviving.values()) {
    for (const ranges of byPath.values()) ranges.sort((a, b) => a[0] - b[0]);
  }

  // Resolve each original path to the HEAD path most of its lines ended up in.
  /** @type {Map<string, string>} */
  const headPathFor = new Map();
  for (const [orig, targets] of moved) {
    let best = null;
    let bestN = -1;
    for (const [head, n] of targets) if (n > bestN) { best = head; bestN = n; }
    headPathFor.set(orig, best);
  }

  return { surviving, headPathFor, skipped, ignoreRevs };
}
