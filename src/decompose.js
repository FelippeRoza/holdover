// Why the published numbers disagree.
//
// Three circulating measurements of "does AI code survive" report roughly 46%, 47%
// and 82%. See METHODOLOGY.md for where each comes from.
// They are not measuring different repositories so much as different definitions.
// This walks from the strictest definition in the literature to holdover's, one
// change at a time, so the contribution of each choice is a number rather than an
// argument.
//
// Step 0 is deliberately the harshest defensible reading of the published work:
//   - any modification counts as death, exactly as the preprint defines it
//     ("a code unit dies when it is modified by a subsequent commit")
//   - blame without -C, as survival.py runs it
//   - no .git-blame-ignore-revs, which no published tool honours
//   - lockfiles, minified bundles and binaries counted, which is how a 35,486-line
//     GIF ends up in a survival rate
//   - CI bots counted as human authors, which is what "everything the agent rules
//     did not match" means in practice
//   - a trailer on a squashed pull request credits the agent with the whole diff,
//     which is what trailer-only attribution actually does
//   - all history at once, with no cohort by age and no age matching between the
//     agent and human sides
//   - no per-commit cap

import { measure } from './measure.js';

/** Each step turns on exactly one thing that the step before it had off. */
export const STEPS = [
  {
    key: 'strict',
    label: 'strictest published definition',
    note: 'any edit = death; no -C; no ignore-revs; lockfiles and binaries counted; bots counted as human; all history; no cap',
    opts: {
      followMoves: false, honourIgnoreRevs: false, includeBots: true, includeNoise: true,
      winsor: 1, horizons: null, matchAges: false, countSquashes: true,
    },
  },
  {
    key: 'noise',
    label: '+ drop lockfiles, bundles and binaries',
    note: 'blame reads a PNG as thousands of lines that numstat never counted',
    opts: { followMoves: false, honourIgnoreRevs: false, includeBots: true, winsor: 1, horizons: null, matchAges: false , countSquashes: true },
  },
  {
    key: 'bots',
    label: '+ take CI bots out of the human baseline',
    note: 'dependabot and friends are machine-written but not agent-written',
    opts: { followMoves: false, honourIgnoreRevs: false, winsor: 1, horizons: null, matchAges: false , countSquashes: true },
  },
  {
    key: 'moves',
    label: '+ follow content across files (-C)',
    note: 'a moved line is not a dead line',
    opts: { honourIgnoreRevs: false, winsor: 1, horizons: null, matchAges: false , countSquashes: true },
  },
  {
    key: 'ignorerevs',
    label: '+ honour .git-blame-ignore-revs',
    note: 'a formatter run is not an edit anyone made',
    opts: { winsor: 1, horizons: null, matchAges: false, countSquashes: true },
  },
  {
    key: 'squash',
    label: '+ stop crediting the agent with whole squashed PRs',
    note: 'GitHub puts the agent trailer on a diff of mixed authorship; those PRs become unattributable',
    opts: { winsor: 1, horizons: null, matchAges: false },
  },
  {
    key: 'cohort',
    label: '+ cohort by arrival on the default branch (90 days)',
    note: 'stops comparing a fresh branch against a two-year-old one',
    opts: { winsor: 1, horizons: [90], matchAges: false },
  },
  {
    key: 'ages',
    label: '+ hold both sides to the same arrival window',
    note: 'otherwise the human baseline is years of old code and the comparison is measuring age',
    opts: { winsor: 1, horizons: [90] },
  },
  {
    key: 'winsor',
    label: '+ winsorise per-commit volume at p99',
    note: 'one bulk commit cannot carry the repo',
    opts: { horizons: [90] },
  },
];

/**
 * @returns rows with the kept share under each definition. `dead` is
 *   edited + gone, which is what a two-state measurement reports; `kept` is the
 *   three-state figure. The gap between them is the cost of collapsing the states.
 */
export async function decompose(cwd, onStep) {
  const rows = [];
  for (const step of STEPS) {
    const horizons = step.opts.horizons ?? [1];
    const r = await measure(cwd, { ...step.opts, horizons });
    if (r.unmeasurable) { rows.push({ ...step, unmeasurable: r.unmeasurable }); continue; }

    const pick = (side) => (step.opts.horizons
      ? r.cohorts[r.cohorts.length - 1][side]
      : r.all[side]);
    const a = pick('agent');
    const h = pick('human');
    const row = {
      key: step.key,
      label: step.label,
      note: step.note,
      agent: { n: a.lines, kept: a.kept, edited: a.edited, gone: a.gone },
      human: { n: h.lines, kept: h.kept, edited: h.edited, gone: h.gone },
    };
    rows.push(row);
    if (onStep) onStep(row);
  }
  return rows;
}

export function renderDecomposition(rows, name) {
  const L = [`${name} — what each definitional choice is worth`, ''];
  L.push('  AI lines kept, under each definition. "2-state" scores any edit as death,');
  L.push('  which is what the published numbers do. "3-state" is holdover\'s reading.');
  L.push('');
  const rate = (num, den) => (den ? `${((num / den) * 100).toFixed(1)}%` : '—');
  L.push('  ' + 'definition'.padEnd(50)
    + 'AI n'.padStart(9) + 'kept'.padStart(8) + '+edit'.padStart(8)
    + 'human n'.padStart(10) + 'kept'.padStart(8) + '  gap');
  for (const r of rows) {
    if (r.unmeasurable) { L.push(`  ${r.label.padEnd(50)}${r.unmeasurable}`); continue; }
    const a = r.agent;
    const h = r.human;
    const gap = (a.n && h.n)
      ? `${(((a.kept / a.n) - (h.kept / h.n)) * 100 >= 0 ? '+' : '')}${(((a.kept / a.n) - (h.kept / h.n)) * 100).toFixed(1)}`
      : '—';
    L.push('  ' + r.label.padEnd(50)
      + a.n.toLocaleString('en-US').padStart(9)
      + rate(a.kept, a.n).padStart(8)
      + rate(a.kept + a.edited, a.n).padStart(8)
      + h.n.toLocaleString('en-US').padStart(10)
      + rate(h.kept, h.n).padStart(8)
      + gap.padStart(7));
  }
  L.push('');
  L.push('  This ladder is sequential, so each row is worth what it is worth *in that');
  L.push('  position*. A choice already implied by an earlier row shows as 0.0 here even');
  L.push('  when removing it from the finished measurement would move the number a lot;');
  L.push('  age matching is the clearest case. Read the ladder for the order of');
  L.push('  magnitude, not as an attribution of variance.');
  L.push('');
  L.push('  kept  = still credited to the commit that wrote it, or unchanged at HEAD.');
  L.push('  +edit = kept or edited, i.e. the line\'s spot survived in some form.');
  L.push('  gap   = AI kept minus human kept, in percentage points, same repo same window.');
  L.push('');
  L.push('  Not in this table, and larger than anything in it on some repos: the unit of');
  L.push('  analysis (pooled lines vs per-commit median) and the split between new and');
  L.push('  existing files. Both are printed by the default report.');
  return L.join('\n');
}
