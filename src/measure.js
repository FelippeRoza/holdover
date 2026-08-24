// Orchestration: classify commits, date their arrival, blame HEAD once, then work
// out what happened to every line each commit added.

import { git, gitOrNull, defaultBranch, cloneDefects, toplevel } from './git.js';
import { classify, isMultiCommitSquash } from './attribution.js';
import { arrivalDates } from './arrival.js';
import { addedLines } from './added.js';
import { blameHead, textFilesAtHead, ignoredRevs, IGNORE_REVS_FILE } from './blame.js';
import { skipPath } from './added.js';
import { fateForCommits } from './fate.js';

const DAY = 86400;
const REC = '\x1e';

async function commitIdentities(cwd, branch, ignored,
  { includeBots = false, countSquashes = false } = {}) {
  const out = await git(cwd, [
    'log', branch, '--no-merges', '--topo-order',
    `--format=${REC}%H%n%an <%ae>%n%B`,
  ]);
  const rows = [];
  for (const block of out.split(REC)) {
    if (!block.trim()) continue;
    const nl1 = block.indexOf('\n');
    const nl2 = block.indexOf('\n', nl1 + 1);
    if (nl1 < 0 || nl2 < 0) continue;
    const sha = block.slice(0, nl1).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const author = block.slice(nl1 + 1, nl2);
    const message = block.slice(nl2 + 1);
    let klass = ignored.has(sha) ? 'excluded' : classify(message, author);
    // An agent trailer on a multi-commit squash covers a diff of mixed
    // authorship, and nothing in a clone can split it. Reported, not guessed at.
    if (klass === 'agent' && !countSquashes && isMultiCommitSquash(message)) klass = 'mixed';
    // The relaxed setting exists only for the decomposition: it reproduces what a
    // tool does when its human bucket is "everything no agent rule matched", which
    // sweeps every CI bot into the baseline.
    if (includeBots && klass === 'excluded' && !ignored.has(sha)) klass = 'human';
    rows.push({ sha, author, klass });
  }
  return rows;
}

/**
 * The per-commit line count above which a commit is clamped.
 *
 * One cap for the whole repository, computed from every measured commit of either
 * class, and then applied unchanged to every cohort. Two earlier versions were
 * both wrong:
 *
 *   - A per-cohort percentile is not monotone. The 90-day cohort is a subset of
 *     the 30-day one, but a smaller cohort has a higher percentile, so on one real
 *     repo the reported line count went 201,847 -> 256,999 -> 203,464 as the
 *     cohort *shrank*.
 *   - A per-class percentile is a one-sided discount. `ceil(0.99 * n) - 1` is
 *     `n - 1` for any n < 100, so p99 clamps nothing at all below 100 commits.
 *     Agent cohorts are usually under 100 commits and human cohorts usually over,
 *     so the clamp only ever hit the comparison group. On graphiti it clamped one
 *     human commit and zero agent commits, and that alone moved the reported gap
 *     from +10.0 pp to +13.6 pp.
 */
export function sharedCap(allRows, percentile) {
  if (!percentile || percentile >= 1 || allRows.length < 3) return Infinity;
  const sorted = allRows.map((r) => r.added).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1);
  return sorted[idx];
}

/**
 * Clamp any commit above `cap`, scaling its outcome counts to match. Scaling
 * assumes the clamped commit's kept/edited/gone split is the same in the part that
 * is counted as in the part that is dropped, which is an assumption, not a fact —
 * hence the reported count of clamped commits and trimmed lines.
 */
/** Scale parts to a new total, keeping their sum exact. */
function apportion(parts, total) {
  const sum = parts.reduce((a, b) => a + b, 0);
  if (!sum) return parts.map(() => 0);
  const exact = parts.map((p) => (p * total) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => [v - Math.floor(v), i])
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

/**
 * The cohort the report expands and the degeneracy gate looks at. One rule, or a
 * horizon list without 90 makes the gate examine a cohort nobody is shown.
 */
export function headlineCohort(cohorts) {
  return cohorts.find((c) => c.days === 90) ?? cohorts[Math.floor(cohorts.length / 2)];
}

export function winsorise(rows, cap) {
  if (!Number.isFinite(cap)) return { rows, capped: 0, trimmed: 0, cap };
  let capped = 0;
  let trimmed = 0;
  const out = rows.map((r) => {
    if (r.added <= cap) return r;
    const scale = cap / r.added;
    capped++;
    trimmed += r.added - cap;
    const [kept, edited, gone] = apportion([r.kept, r.edited, r.gone], cap);
    return {
      ...r,
      added: cap,
      addedInNewFiles: Math.round((r.addedInNewFiles ?? 0) * scale),
      keptInNewFiles: Math.round((r.keptInNewFiles ?? 0) * scale),
      kept,
      edited,
      gone,
      reattributed: Math.round(r.reattributed * scale),
      wasCapped: true,
    };
  });
  return { rows: out, capped, trimmed, cap };
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Two estimators, both reported, because they answer different questions and on
 * real repos they disagree by tens of points.
 *
 *   `lines`/`kept`  — pooled: what share of the lines written survived. This is
 *                     the quantity the tool is named for, and it is dominated by
 *                     the largest commits.
 *   `keptMedian`    — the keep rate of a typical commit, unweighted. On graphiti
 *                     the pooled agent figure is 80.0% and the per-commit median
 *                     is 48.8%, because five commits hold 69% of the lines.
 *
 * `top5Share` says how concentrated the cohort is, so the reader can see when the
 * pooled figure is really describing a handful of commits.
 */
function tally(rows) {
  const t = {
    commits: rows.length, lines: 0, kept: 0, edited: 0, gone: 0, reattributed: 0,
    keptMedian: null, top5Share: null, medianAgeDays: null, newFileShare: null,
  };
  let inNew = 0;
  for (const r of rows) {
    t.lines += r.added;
    inNew += Math.min(r.addedInNewFiles ?? 0, r.added);
    t.kept += r.kept;
    t.edited += r.edited;
    t.gone += r.gone;
    t.reattributed += r.reattributed;
  }
  t.keptMedian = median(rows.filter((r) => r.added > 0).map((r) => r.kept / r.added));
  if (t.lines) t.newFileShare = inNew / t.lines;
  if (t.lines) {
    const biggest = rows.map((r) => r.added).sort((a, b) => b - a).slice(0, 5)
      .reduce((a, b) => a + b, 0);
    t.top5Share = biggest / t.lines;
  }
  return t;
}

/**
 * Median age weighted by lines, not by commits. The unweighted version is the
 * wrong statistic for a claim about lines and it hid a real problem: on graphiti
 * the commit-unweighted medians were 282.5 and 298 days, 15 days apart, while the
 * line-weighted medians were 185.3 and 345.5 — nearly double the exposure on the
 * human side, in a comparison whose whole purpose is to control for exposure.
 */
function lineWeightedMedianAge(rows, reference) {
  const items = rows
    .filter((r) => r.arrival !== null && r.added > 0)
    .map((r) => ({ age: (reference - r.arrival) / DAY, w: r.added }))
    .sort((a, b) => a.age - b.age);
  const total = items.reduce((s, i) => s + i.w, 0);
  if (!total) return null;
  let acc = 0;
  for (const i of items) {
    acc += i.w;
    if (acc >= total / 2) return Number(i.age.toFixed(1));
  }
  return null;
}

export async function measure(startDir, opts = {}) {
  // Always measure from the repository root. `git log` is repo-wide but
  // `git ls-files -- .` is relative to the working directory, so a subdirectory
  // counted every line the repo ever added against only that subtree's files.
  const cwd = await toplevel(startDir);
  const horizons = opts.horizons ?? [30, 90, 180];
  const winsorAt = opts.winsor ?? 0.99;
  // Every one of these off is the strictest published definition; every one on is
  // holdover's. The decomposition walks between the two.
  const followMoves = opts.followMoves ?? true;
  const honourIgnoreRevs = opts.honourIgnoreRevs ?? true;
  const includeBots = opts.includeBots ?? false;
  const skip = (opts.includeNoise ?? false) ? () => false : skipPath;
  const matchAges = opts.matchAges ?? true;
  // Only the decomposition turns this on, to show what trailer-only attribution
  // on squash commits is worth.
  const countSquashes = opts.countSquashes ?? false;
  const progress = opts.onProgress ?? (() => {});

  const branch = opts.branch ?? await defaultBranch(cwd);

  // Read the tip before anything can bail out: an unmeasurable verdict is still
  // a verdict about one specific commit, and without the sha it cannot be
  // rechecked or told apart from the same repo a month later.
  const tipSha = (await git(cwd, ['rev-parse', branch])).trim();

  const defects = await cloneDefects(cwd);
  if (defects.length && !opts.allowPartial) {
    return {
      unmeasurable: `${defects.join(' and ')} — re-clone without --filter or --depth`,
      branch,
      head: tipSha,
      commits: null,
    };
  }

  progress('reading history');
  const ignored = honourIgnoreRevs ? await ignoredRevs(cwd, tipSha) : new Set();
  const identities = await commitIdentities(cwd, branch, ignored, { includeBots, countSquashes });
  const agents = identities.filter((r) => r.klass === 'agent');
  const humans = identities.filter((r) => r.klass === 'human');
  const mixed = identities.filter((r) => r.klass === 'mixed');
  const excluded = identities.filter((r) => r.klass === 'excluded');

  if (agents.length === 0) {
    return {
      unmeasurable: mixed.length
        ? `agent attribution found only on ${mixed.length} multi-commit squash commits, `
          + 'whose line-level authorship cannot be recovered from a clone'
        : 'no agent trailers or agent commit identities found',
      branch,
      head: tipSha,
      commits: {
        total: identities.length, agent: 0, human: humans.length,
        mixed: mixed.length, excluded: excluded.length,
      },
    };
  }

  progress('dating arrivals');
  const { arrival, violations, head } = await arrivalDates(cwd, branch);
  const reference = arrival.get(head);

  const wanted = new Set([...agents, ...humans, ...mixed].map((r) => r.sha));
  for (const sha of ignored) wanted.add(sha);
  progress('reading diffs');
  const added = await addedLines(cwd, branch, wanted, skip);

  progress('blaming HEAD');
  const files = await textFilesAtHead(cwd, head, skip);
  const blame = await blameHead(cwd, files, head, (n, total) => {
    if (n % 200 === 0) progress(`blaming HEAD (${n}/${total} files)`);
  }, { followMoves, honourIgnoreRevs });

  progress('tracing lines');
  const withLines = new Map();
  for (const sha of wanted) {
    const entry = added.get(sha);
    if (entry && entry.added > 0) withLines.set(sha, entry);
  }
  const headFiles = new Set(files);
  const fates = await fateForCommits(cwd, withLines, blame.surviving, blame.headPathFor, headFiles,
    head, (n, total) => { if (n % 500 === 0) progress(`tracing lines (${n}/${total} commits)`); });

  let ignoredLines = 0;
  for (const sha of ignored) ignoredLines += added.get(sha)?.added ?? 0;

  const klassOf = new Map(identities.map((r) => [r.sha, r.klass]));
  const byClass = { agent: [], human: [], mixed: [] };
  for (const f of fates) {
    const k = klassOf.get(f.sha);
    if (k !== 'agent' && k !== 'human' && k !== 'mixed') continue;
    // No `kept > added` guard here, and none is needed: `kept` counts a subset of
    // the very ranges that define `added`, so the inequality is structural. An
    // earlier version of this code carried such a guard and reported it in the
    // output, which was worse than useless — it could never fire, so it read as
    // evidence of a check that was not happening. The blame pass is checked
    // instead by the invariant in the test suite: every line in the measured tree
    // must be attributed exactly once. That invariant caught a parser that
    // over-counted by 1.7% on a real repo.
    byClass[k].push({ ...f, klass: k, arrival: arrival.get(f.sha) ?? null });
  }

  // Age is the confound that makes a naive baseline meaningless. On one real repo
  // the agent commits span the last few months while the human commits go back
  // years, so "all human lines at least 90 days old" is mostly code that has had
  // three years to be rewritten. Comparing that against three-month-old agent
  // lines compares ages, not authorship.
  //
  // So both classes are held to the same arrival window: from the earliest agent
  // arrival to the horizon cutoff. Human code older than any agent code is out of
  // frame, and the line-weighted median age of each side is reported so what is
  // left can be checked rather than trusted.
  const agentArrivals = byClass.agent.map((r) => r.arrival).filter((t) => t !== null);
  // reduce, not Math.min(...): the spread overflows the call stack above about
  // 100k arguments, which a repo with that many agent commits would reach.
  const windowStart = matchAges && agentArrivals.length
    ? agentArrivals.reduce((a, b) => (b < a ? b : a))
    : null;

  // One cap for the repository, from both classes pooled, so it is symmetric and
  // so cohort totals stay monotone in the horizon.
  const cap = sharedCap([...byClass.agent, ...byClass.human], winsorAt);

  const cohorts = horizons
    .slice()
    .sort((a, b) => a - b)
    .map((days) => {
      const cutoff = reference - days * DAY;
      const pick = (rows) => rows.filter((r) => r.arrival !== null
        && r.arrival <= cutoff
        && (windowStart === null || r.arrival >= windowStart));
      const side = (rows) => {
        const picked = pick(rows);
        const w = winsorise(picked, cap);
        return {
          ...tally(w.rows),
          capped: w.capped,
          trimmed: w.trimmed,
          medianAgeDays: lineWeightedMedianAge(picked, reference),
        };
      };
      return {
        days,
        windowStart,
        cap: Number.isFinite(cap) ? cap : null,
        agent: side(byClass.agent),
        human: side(byClass.human),
        mixed: side(byClass.mixed),
      };
    });

  const all = {
    agent: tally(winsorise(byClass.agent, cap).rows),
    human: tally(winsorise(byClass.human, cap).rows),
    mixed: tally(winsorise(byClass.mixed, cap).rows),
  };

  // A repo whose tree was replaced wholesale has nothing left from before the
  // replacement, so every cohort reads 0% for both classes and the difference is
  // 0.0 pp by construction. One real repo does exactly this: 0 of 427,394 agent
  // lines and 0 of 301,298 human lines kept, printed as "+0.0 pp". That is not a
  // finding, it is an absence of data, and it should not enter a panel as a paired
  // difference of zero.
  // Judged on a cohort that actually has both classes in it. Keying off a
  // positional guess meant a horizon list without 90 pointed the gate at an empty
  // cohort, where `lines > 0` is false and the gate silently did nothing.
  const judged = cohorts.filter((c) => c.agent.lines > 0 && c.human.lines > 0);
  const gate = judged.find((c) => c.days === 90)
    ?? judged.sort((a, b) => b.agent.lines - a.agent.lines)[0];
  const degenerate = gate
    && gate.agent.kept / gate.agent.lines < 0.01
    && gate.human.kept / gate.human.lines < 0.01;
  if (degenerate) {
    return {
      unmeasurable: 'the tree at this ref retains almost nothing from before the '
        + 'cohort — a wholesale replacement, not a survival rate',
      branch,
      head: tipSha,
      reference,
      commits: {
        total: identities.length, agent: agents.length, human: humans.length,
        mixed: mixed.length, excluded: excluded.length,
      },
    };
  }

  // A cohort with nothing in it is not a rate. The report used to print a table
  // of dashes and exit 0, which is the failure this tool exists to refuse. The
  // counts are still returned, they just do not amount to a keep rate.
  const barren = cohorts.every((c) => c.agent.lines === 0)
    ? `no agent lines have had ${Math.min(...horizons)} days on ${branch} yet`
    : null;

  return {
    ...(barren ? { unmeasurable: barren } : {}),
    branch,
    head,
    reference,
    settings: {
      followMoves, honourIgnoreRevs, includeBots, matchAges, countSquashes,
      includeNoise: !!opts.includeNoise, winsor: winsorAt, cap: Number.isFinite(cap) ? cap : null,
    },
    ignoreRevsHonoured: blame.ignoreRevs,
    ignoreRevsFile: blame.ignoreRevs ? IGNORE_REVS_FILE : null,
    commits: {
      total: identities.length,
      agent: agents.length,
      human: humans.length,
      mixed: mixed.length,
      excluded: excluded.length,
    },
    all,
    cohorts,
    // Per-commit rows, so anyone can re-analyse rather than take the two
    // estimators on trust — stratify on `addedInNewFiles`, cluster on `sha`,
    // reweight, or compute an interval. There is no way to check the headline
    // without this, so it is not optional.
    commitRows: [...byClass.agent, ...byClass.human, ...byClass.mixed]
      .map((r) => ({
        sha: r.sha,
        klass: r.klass,
        arrival: r.arrival,
        added: r.added,
        addedInNewFiles: r.addedInNewFiles ?? 0,
        keptInNewFiles: r.keptInNewFiles ?? 0,
        kept: r.kept,
        edited: r.edited,
        gone: r.gone,
        reattributed: r.reattributed,
      })),
    warnings: {
      dateViolations: violations.length,
      tipInFuture: reference > Math.floor(Date.now() / 1000) + DAY ? reference : null,
      filesSkipped: blame.skipped.length,
      winsorPercentile: winsorAt,
      ignoredRevs: ignored.size,
      // Every sha in .git-blame-ignore-revs is dropped from authorship entirely,
      // numerator and denominator. The file is committed by the repo owner and
      // nothing checks that it only holds formatting commits, so the volume it
      // removes is reported rather than left implicit.
      ignoredRevLines: ignoredLines,
    },
  };
}

export async function repoName(cwd) {
  const url = (await gitOrNull(cwd, ['config', '--get', 'remote.origin.url']))?.trim();
  if (url) {
    const m = url.match(/([^/:]+\/[^/]+?)(\.git)?$/);
    if (m) return m[1];
  }
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}
