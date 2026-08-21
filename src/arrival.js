// When did a commit's changes arrive on the default branch?
//
// Not the author date: it is set by whoever ran `git commit` and survives rebase,
// cherry-pick and `--date=2010-06-06`, so it is both forgeable and stale. A repo
// in the wild carries a 2009 author date on a commit whose trailer names a model
// released in 2026.
//
// Not the committer date on its own either. Measured against 13,655 server-side
// push timestamps from GitHub's activity API on a real 18,143-commit repo, the
// commit's own committer date is within a minute of the truth only 75.3% of the
// time, and is up to 27.3 days early — because in merge-commit style the branch
// commits keep the dates they had before the merge.
//
// The rule that holds in all three GitHub merge styles:
//
//   a commit on the first-parent trunk arrives at its own committer date;
//   any other commit arrives when the oldest trunk commit that has it as an
//   ancestor arrived — that is, when the merge that brought it in landed.
//
// Same validation: 99.28% within one minute, 99.92% within a day. The residual is
// almost entirely commits pushed straight to the branch, where arrival is bounded
// by how long the author waited before pushing, and that gap is not recoverable
// from a clone at all.

import { git, gitLines } from './git.js';

/**
 * @returns {{arrival: Map<string, number>, trunk: Set<string>, violations: Array}}
 *   arrival is a unix timestamp in seconds, keyed by full sha.
 */
export async function arrivalDates(cwd, branch) {
  /** @type {Map<string, {ct: number, parents: string[]}>} */
  const commits = new Map();
  await gitLines(cwd, ['log', '--format=%H %ct %P', branch], (line) => {
    if (!line) return;
    const parts = line.split(' ');
    if (parts.length < 2) return;
    commits.set(parts[0], { ct: Number(parts[1]), parents: parts.slice(2) });
  });

  // Walk first parents from the tip to get the trunk, newest first.
  // The tip is resolved explicitly rather than taken as git log's first line:
  // log orders by commit date by default, so one forged future date is enough to
  // put some other commit first.
  const head = (await git(cwd, ['rev-parse', branch])).trim();
  const trunkOrder = [];
  const trunk = new Set();
  for (let sha = head; sha && commits.has(sha) && !trunk.has(sha);) {
    trunk.add(sha);
    trunkOrder.push(sha);
    sha = commits.get(sha).parents[0];
  }

  const arrival = new Map();

  // Oldest trunk commit first, so the earliest merge to reach a side commit is
  // the one that assigns its arrival and later merges never overwrite it.
  for (let i = trunkOrder.length - 1; i >= 0; i--) {
    const t = trunkOrder[i];
    const landed = commits.get(t).ct;
    arrival.set(t, landed);

    // Everything reachable from this trunk commit's other parents arrived here.
    const stack = commits.get(t).parents.slice(1);
    while (stack.length) {
      const sha = stack.pop();
      if (arrival.has(sha) || !commits.has(sha)) continue;
      arrival.set(sha, landed);
      for (const p of commits.get(sha).parents) {
        if (!arrival.has(p)) stack.push(p);
      }
    }
  }

  // A trunk whose arrival dates go backwards means a forged or wrong committer
  // date on the trunk itself. Clamping is worse than reporting: cummax spreads a
  // future date over the whole tail, cummin spreads a backdate over the whole
  // head, and isotonic regression averages the two liars into a third wrong
  // answer. So: detect, report, change nothing.
  const violations = [];
  for (let i = trunkOrder.length - 1; i > 0; i--) {
    const prev = arrival.get(trunkOrder[i]);
    const cur = arrival.get(trunkOrder[i - 1]);
    if (cur < prev) violations.push({ sha: trunkOrder[i - 1], date: cur, previous: prev });
  }

  return { arrival, trunk, violations, head };
}
