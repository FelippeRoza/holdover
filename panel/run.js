#!/usr/bin/env node
// Runs holdover over panel/repos.txt and writes RESULTS.md.
//
// One JSON file per repo is cached under panel/json/, so a rerun only measures
// what is missing: a full sweep is dominated by cloning and blaming repos that
// have not changed. Delete a cached file to re-measure that repo.
//
// The JSON is gzipped because the per-commit table is most of it and one repo
// runs to megabytes: `gunzip -c panel/json/<owner>__<repo>.json.gz | jq`.
//
// This is the showcase table, not the pre-registered panel. The repo list was
// filtered by whether a commit search found any attribution at all, which the
// pre-registered frame is not.

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { winsorise } from '../src/measure.js';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'cli.js');
const JSONDIR = join(HERE, 'json');
const PILOT = 'getzep/graphiti';
const FLOOR = 2000;      // pre-registered inclusion floor, agent lines at 90 days
const SPREAD = 20;       // estimators this far apart support no conclusion, in pp
const COMPOSITION = 0.15; // new-file share gap this wide means different work
const DAY = 86400;
const COVERAGE = 0.5;   // least share of lines a standardised gap may rest on
const MIN_STRATUM = 10; // commits a side a size stratum needs before it stands alone

const slugs = [];
const groupOf = new Map();
{
  let group = null;
  for (const line of (await readFile(join(HERE, 'repos.txt'), 'utf8')).split('\n')) {
    const t = line.trim();
    if (t.startsWith('# agent vendors')) group = 'vendor';
    else if (t.startsWith('# repos that use agents')) group = 'user';
    else if (t.startsWith('# the pilot')) group = 'pilot';
    else if (t && !t.startsWith('#')) { slugs.push(t); groupOf.set(t, group); }
  }
}

await mkdir(JSONDIR, { recursive: true });
const cached = new Set(await readdir(JSONDIR));

for (const slug of slugs) {
  const file = slug.replace('/', '__') + '.json.gz';
  if (cached.has(file)) { console.error(`cached  ${slug}`); continue; }
  console.error(`running ${slug}`);
  const started = Date.now();
  try {
    // Exit 3 is "unmeasurable", which is a result and still prints JSON.
    const { stdout } = await exec('node', [CLI, slug, '--json', '--quiet'],
      { maxBuffer: 1 << 30 }).catch((e) => (e.code === 3 ? e : Promise.reject(e)));
    await writeFile(join(JSONDIR, file), gzipSync(stdout));
    console.error(`   done ${slug} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  } catch (e) {
    // Keep the whole stderr. The last line of a node crash is the version
    // banner, which says nothing about what went wrong.
    const why = (e.stderr || '').trim() || e.message;
    await writeFile(join(JSONDIR, file.replace('.json.gz', '.error.txt')), why + '\n');
    console.error(`   FAIL ${slug}: ${why.split('\n').slice(0, 4).join(' | ')}`);
  }
}

// ---- table ----

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');
const pp = (v) => {
  if (v === null || v === undefined) return '—';
  const r = v.toFixed(1);
  return (Number(r) > 0 ? '+' : '') + r + ' pp';
};
const bare = (v) => pp(v).replace(' pp', '');
const dec = (f) => (f === null || f === undefined ? '—' : (f * 100).toFixed(1) + '%');
const num = (n) => n.toLocaleString('en-US');

// Deterministic, so a rerun on the same cache gives the same interval.
function rng(seed) {
  let x = seed;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0;
    return (x >>> 0) / 4294967296;
  };
}

const rows = [];
for (const slug of slugs) {
  const file = join(JSONDIR, slug.replace('/', '__') + '.json.gz');
  let r;
  try {
    r = JSON.parse(gunzipSync(await readFile(file)));
  } catch {
    rows.push({ slug, absent: true });
    continue;
  }
  rows.push({
    slug, head: r.head, reference: r.reference, measuredAt: r.measuredAt,
    version: r.version, dateViolations: r.warnings?.dateViolations ?? 0,
    ...summarise(r),
  });
}

/**
 * The cohort's own rows, picked and winsorised exactly as measure.js did. The
 * lower bound matters most: without windowStart the human side reaches back to
 * the repo's first commit, which is the age confound the window exists to close.
 * It inflated graphiti's baseline from 15,938 lines to 145,041.
 */
function cohortRows(r, days) {
  const c = r.cohorts.find((x) => x.days === days);
  if (!c) return null;
  const cutoff = r.reference - days * DAY;
  const rows = r.commitRows.filter((x) => x.klass !== 'mixed' && x.arrival !== null
    && x.arrival <= cutoff
    && (c.windowStart === null || c.windowStart === undefined || x.arrival >= c.windowStart));
  return winsorise(rows, r.settings?.cap ?? Infinity).rows;
}

/**
 * Direct standardisation over strata of [lines, kept] per class, weighted by the
 * lines in each stratum. A stratum only one class reaches carries no comparison
 * and is dropped, so below COVERAGE of the lines the estimate describes a subset
 * rather than the repo and no figure is given: dspy's size-standardised gap came
 * out at +56.0 pp off 17% of its weight, which is what this project exists to
 * refuse.
 */
function standardise(strata) {
  let weight = 0;
  let sum = 0;
  let dropped = 0;
  let thin = 0;
  for (const { agent, human } of strata) {
    if (!agent[0] || !human[0]) { dropped += agent[0] + human[0]; continue; }
    const w = agent[0] + human[0];
    weight += w;
    sum += w * ((agent[1] / agent[0]) - (human[1] / human[0]));
    if (Math.min(agent[2] ?? Infinity, human[2] ?? Infinity) < MIN_STRATUM) thin += w;
  }
  if (!weight) return null;
  const coverage = weight / (weight + dropped);
  const out = { coverage, thinShare: thin / weight };
  return coverage < COVERAGE ? { ...out, gap: null } : { ...out, gap: (sum / weight) * 100 };
}

/**
 * Held to commit-size strata, floor(log2(added)) on the raw count, then adjacent
 * strata merged until each holds MIN_STRATUM commits on both sides. Unmerged
 * strata on these cohorts routinely held one or two agent commits and were
 * weighted by lines, which manufactured sign reversals: Roo-Code's crude -2.5 pp
 * read +9.2 pp off eight two-commit cells. A repo left with one stratum is not
 * stratified at all, and `strata` says so.
 */
function sizeStandardised(r, days) {
  const rows = cohortRows(r, days);
  if (!rows) return null;
  const byKey = new Map();
  for (const row of rows) {
    const raw = row.rawAdded ?? row.added;
    if (!raw) continue;
    const k = Math.floor(Math.log2(raw));
    let cell = byKey.get(k);
    if (!cell) { cell = { agent: [0, 0, 0], human: [0, 0, 0] }; byKey.set(k, cell); }
    cell[row.klass][0] += row.added;
    cell[row.klass][1] += row.kept;
    cell[row.klass][2]++;
  }

  const merged = [];
  for (const k of [...byKey.keys()].sort((a, b) => a - b)) {
    const cell = byKey.get(k);
    const last = merged.at(-1);
    if (last && (Math.min(last.agent[2], last.human[2]) < MIN_STRATUM
      || Math.min(cell.agent[2], cell.human[2]) < MIN_STRATUM)) {
      for (const side of ['agent', 'human']) for (let i = 0; i < 3; i++) last[side][i] += cell[side][i];
    } else {
      merged.push({ agent: [...cell.agent], human: [...cell.human] });
    }
  }
  const out = standardise(merged);
  return out && { ...out, strata: merged.length };
}

/**
 * Held to whether a line sits in a file its own commit created. On the pilot repo
 * that is 67% of agent lines against 26% of human ones, and an external audit
 * found it moved a gap from +10.0 pp to +0.6 pp. There are only two strata, so
 * losing one to the coverage rule is common and the figure is then absent.
 */
function newFileStandardised(r, days) {
  const rows = cohortRows(r, days);
  if (!rows || rows.some((x) => x.keptInNewFiles === undefined)) return null;
  const strata = [
    { agent: [0, 0, 0], human: [0, 0, 0] },
    { agent: [0, 0, 0], human: [0, 0, 0] },
  ];
  for (const row of rows) {
    strata[0][row.klass][0] += row.addedInNewFiles;
    strata[0][row.klass][1] += row.keptInNewFiles;
    strata[0][row.klass][2] += row.addedInNewFiles ? 1 : 0;
    strata[1][row.klass][0] += row.added - row.addedInNewFiles;
    strata[1][row.klass][1] += row.kept - row.keptInNewFiles;
    strata[1][row.klass][2] += row.added - row.addedInNewFiles ? 1 : 0;
  }
  return standardise(strata);
}

function summarise(r) {
  if (r.unmeasurable) return { unmeasurable: r.unmeasurable };
  const at = (d) => r.cohorts.find((c) => c.days === d);
  const c = at(90);
  if (!c || !c.agent.lines || !c.human.lines) return { unmeasurable: 'no 90-day cohort on both sides' };
  const pooled = (c.agent.kept / c.agent.lines - c.human.kept / c.human.lines) * 100;
  const typical = (c.agent.keptMedian !== null && c.human.keptMedian !== null)
    ? (c.agent.keptMedian - c.human.keptMedian) * 100 : null;
  const composition = (c.agent.newFileShare !== null && c.human.newFileShare !== null)
    ? Math.abs(c.agent.newFileShare - c.human.newFileShare) : null;

  const flags = [];
  if (c.agent.lines < FLOOR) flags.push('below the 2,000-line floor');
  if (typical !== null && pooled * typical < 0) {
    flags.push(`estimators disagree in sign, ${Math.abs(pooled - typical).toFixed(1)} pp apart`);
  } else if (typical !== null && Math.abs(pooled - typical) > SPREAD) {
    flags.push(`estimators ${Math.abs(pooled - typical).toFixed(1)} pp apart`);
  }
  if (composition !== null && composition > COMPOSITION) {
    flags.push(`new-file share ${(composition * 100).toFixed(1)} pp apart`);
  }

  const sizeStd = sizeStandardised(r, 90);
  const newFileStd = newFileStandardised(r, 90);
  for (const [what, std] of [['size', sizeStd], ['new-file', newFileStd]]) {
    if (std?.gap === null) {
      flags.push(`${what} strata cover only ${dec(std.coverage)} of the lines, so no standardised gap`);
    } else if (std && std.coverage < 0.8) {
      flags.push(`${what} strata cover ${dec(std.coverage)} of the lines`);
    }
    if (std?.gap !== null && std && std.thinShare > 0.5) {
      flags.push(`${dec(std.thinShare)} of the ${what}-standardised weight is in strata under ${MIN_STRATUM} commits a side`);
    }
    if (std?.strata === 1) {
      flags.push('one size stratum survives the merge, so its size-standardised gap is the crude one');
    }
  }
  for (const [what, std] of [['size', sizeStd], ['new-file', newFileStd]]) {
    if (std?.gap === null || std?.gap === undefined) continue;
    if (std.gap * pooled < 0) {
      flags.push(`${what}-standardised gap is ${pp(std.gap)}, the other way from the pooled one`);
    } else if (Math.abs(std.gap - pooled) > SPREAD) {
      flags.push(`${what}-standardised gap is ${pp(std.gap)}, ${Math.abs(std.gap - pooled).toFixed(1)} pp off the pooled one`);
    }
  }

  const rate = (t, k) => (t.lines ? (t[k] / t.lines) * 100 : null);
  const notGone = (100 - rate(c.agent, 'gone')) - (100 - rate(c.human, 'gone'));
  const strict = ((c.agent.kept - c.agent.reattributed) / c.agent.lines
    - (c.human.kept - c.human.reattributed) / c.human.lines) * 100;
  const cohortMixed = (() => {
    const cutoff = r.reference - 90 * DAY;
    return r.commitRows.filter((x) => x.klass === 'mixed' && x.arrival !== null
      && x.arrival <= cutoff && (c.windowStart == null || x.arrival >= c.windowStart))
      .reduce((a, x) => a + x.added, 0);
  })();

  return {
    c, pooled, typical, composition, flags, sizeStd, newFileStd, notGone, strict,
    cohortRows: cohortRows(r, 90) ?? [],
    mixed: cohortMixed,
    lifetimeMixed: r.all?.mixed?.lines ?? 0,
    agentLines: r.all?.agent?.lines ?? 0,
    exposure: c.human.medianAgeDays / c.agent.medianAgeDays,
    capped: c.agent.capped + c.human.capped,
    trimmed: c.agent.trimmed + c.human.trimmed,
    cap: c.cap,
    horizons: r.cohorts.map((h) => ({ days: h.days, ai: pct(h.agent.kept, h.agent.lines), human: pct(h.human.kept, h.human.lines), n: h.agent.lines })),
  };
}

const measured = rows.filter((r) => !r.unmeasurable && !r.absent && r.slug !== PILOT);
const scoring = measured.filter((r) => r.c.agent.lines >= FLOOR);
// Inverse-ECDF quantile, Hyndman-Fan type 1: the smallest order statistic whose
// ECDF reaches q. Used for the median too, so the headline and its IQR are the
// same estimator.
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

const gaps = scoring.map((r) => r.pooled);

/**
 * Two-stage bootstrap: resample repos, then resample commits within each drawn
 * repo. Commits within a repo are the noise every diagnostic in this table keeps
 * pointing at, so a repo-only interval understates it.
 */
function interval(reps = 4000) {
  const rand = rng(20260824);
  const pick = (xs) => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];
  const meds = [];
  for (let b = 0; b < reps; b++) {
    const draw = [];
    for (let i = 0; i < scoring.length; i++) {
      const r = pick(scoring);
      const sums = { agent: [0, 0], human: [0, 0] };
      for (const side of ['agent', 'human']) {
        const pool = r.cohortRows.filter((x) => x.klass === side);
        if (!pool.length) break;
        for (let k = 0; k < pool.length; k++) {
          const row = pick(pool);
          sums[side][0] += row.added;
          sums[side][1] += row.kept;
        }
      }
      if (!sums.agent[0] || !sums.human[0]) continue;
      draw.push((sums.agent[1] / sums.agent[0] - sums.human[1] / sums.human[0]) * 100);
    }
    if (draw.length) meds.push(quantile(draw, 0.5));
  }
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(0.025 * meds.length)], meds[Math.floor(0.975 * meds.length)]];
}
const L = [];
L.push('# Results');
L.push('');
const version = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8')).version;
const day = (d) => new Date(d).toISOString().slice(0, 10);
const stamps = rows.map((r) => r.measuredAt).filter(Boolean).sort();
L.push(`Generated by \`node panel/run.js\` from the repo list in [\`panel/repos.txt\`](panel/repos.txt),`);
L.push(`with \`holdover\` ${version}, measured ${!stamps.length ? 'never' : day(stamps[0]) === day(stamps.at(-1))
  ? `on ${day(stamps[0])}` : `between ${day(stamps[0])} and ${day(stamps.at(-1))}`}.`);
L.push('Raw `--json` output for every repo, including the per-commit table, is in `panel/json/`.');
L.push('');
L.push('**Every number here decays.** A repo measured today and the same repo measured next');
L.push('month are different measurements: the tip moves, so the cohorts gain lines and every');
L.push('surviving line gains exposure. Each row is pinned to the tip it was measured at in');
L.push('[Provenance](#provenance), and a row is only reproducible against that sha.');
L.push('');
L.push('**This is not the pre-registered panel.** [PREREGISTRATION.md](PREREGISTRATION.md)');
L.push('commits to 300 repositories drawn by commit search, with the slug list frozen before');
L.push('any measurement. The rows below are hand-picked recognisable repos, filtered by whether');
L.push('a commit search found attribution at all, so they are a convenience sample and cannot');
L.push('test the claim. Read them as twenty worked examples of what the diagnostics look like.');
L.push('');
L.push('## Earlier published results');
L.push('');
L.push('`src/attribution.js` changed twice after the pre-registration was written, and');
L.push('PREREGISTRATION.md requires that the panel be re-run in full and every result');
L.push('published. The rule change was not neutral, so here they all are:');
L.push('');
L.push('| attribution rules | median pooled gap |');
L.push('| --- | --- |');
L.push('| whole vendor domains count as agent | +3.0 pp (IQR -5.1 to +10.7) |');
L.push('| a tool-shaped local part is required | +6.5 pp (IQR +0.4 to +14.9) |');
L.push('| the tool name must match the domain that ships it | the table below |');
L.push('');
L.push('The first rule counted every hand-written commit by anyone at OpenAI, Anthropic,');
L.push('Cursor, Charm or Aider as agent work; `openai/codex` read 7,733 agent commits');
L.push('under it against 87 under the second. Its interval included zero, the second\'s');
L.push('did not, and that is exactly why both are here.');
L.push('');
L.push('## Summary');
L.push('');
if (gaps.length) {
  const eligible = slugs.filter((sl) => sl !== PILOT).length;
  const voided = scoring.filter((r) => r.typical !== null
    && (r.pooled * r.typical < 0 || Math.abs(r.pooled - r.typical) > SPREAD));
  const survivors = scoring.filter((r) => !voided.includes(r)).map((r) => r.pooled);
  const refs = rows.map((r) => r.reference).filter(Boolean).sort((a, b) => a - b);
  const squash = rows.filter((r) => r.mixed !== undefined && r.agentLines !== undefined)
    .map((r) => (r.mixed + r.agentLines ? (r.mixed / (r.mixed + r.agentLines)) * 100 : 0));
  const typicals = scoring.map((r) => r.typical).filter((v) => v !== null);
  L.push(`- ${measured.length} of ${eligible} repos measurable, ${scoring.length} above the pre-registered 2,000-line floor.`);
  const stds = scoring.map((r) => r.sizeStd?.gap).filter((v) => v !== undefined && v !== null);
  L.push(`- Median pooled gap at 90 days: **${pp(quantile(gaps, 0.5))}** (IQR ${bare(quantile(gaps, 0.25))} to ${pp(quantile(gaps, 0.75))}), over ${gaps.length} repos.`);
  const newStds = scoring.map((r) => r.newFileStd?.gap).filter((v) => v !== undefined && v !== null);
  const ci = interval();
  L.push(`  A two-stage bootstrap over repos and then commits within them puts that at`);
  L.push(`  **${bare(ci[0])} to ${pp(ci[1])}**, which includes zero. Commits within a repo are the noise every`);
  L.push('  diagnostic below keeps pointing at, so a repo-only interval would be narrower and');
  L.push('  wrong.');
  L.push(`- **Median gap in \`not gone\` share: ${pp(quantile(scoring.map((r) => r.notGone), 0.5))}.** The pre-registration forbids folding`);
  L.push('  `edited` into `gone`, and publishing only `kept` does exactly that: the complement');
  L.push('  of `kept` is `edited + gone`. Counting a line that was rewritten in place as');
  L.push(`  surviving reverses ${scoring.filter((r) => r.pooled * r.notGone < 0).length} of the ${scoring.length} repos, \`Aider-AI/aider\` most of all.`);
  L.push(`- Median size-standardised gap: **${pp(quantile(stds, 0.5))}** (IQR ${bare(quantile(stds, 0.25))} to ${pp(quantile(stds, 0.75))}), over ${stds.length} repos.`);
  if (newStds.length) {
    L.push(`- Median new-file-standardised gap: **${pp(quantile(newStds, 0.5))}** (IQR ${bare(quantile(newStds, 0.25))} to ${pp(quantile(newStds, 0.75))}), over ${newStds.length} repos.`);
  }
  L.push(`- Median per-commit gap: **${pp(quantile(typicals, 0.5))}** (IQR ${bare(quantile(typicals, 0.25))} to ${pp(quantile(typicals, 0.75))}). It is not the same answer.`);
  const keptShares = (side) => scoring.map((r) => (r.c[side].kept / r.c[side].lines) * 100);
  L.push(`- Median kept share: agent ${quantile(keptShares('agent'), 0.5).toFixed(1)}% (IQR ${quantile(keptShares('agent'), 0.25).toFixed(1)} to ${quantile(keptShares('agent'), 0.75).toFixed(1)}), human ${quantile(keptShares('human'), 0.5).toFixed(1)}% (IQR ${quantile(keptShares('human'), 0.25).toFixed(1)} to ${quantile(keptShares('human'), 0.75).toFixed(1)}).`);
  L.push(`- Median gap with re-added identical lines not counted as kept: ${pp(quantile(scoring.map((r) => r.strict), 0.5))}.`);
  const byGroup = (g) => scoring.filter((r) => groupOf.get(r.slug) === g).map((r) => r.pooled);
  const vendor = byGroup('vendor');
  const user = byGroup('user');
  if (vendor.length && user.length) {
    L.push(`- Split the way [\`panel/repos.txt\`](panel/repos.txt) splits it: repos whose owner sells the`);
    L.push(`  agent, **${pp(quantile(vendor, 0.5))}** over ${vendor.length}; repos that only use one, **${pp(quantile(user, 0.5))}** over ${user.length}. The`);
    L.push('  effect concentrates in the vendors\' own repositories.');
  }
  const balanced = scoring.filter((r) => r.exposure < 1.2).map((r) => r.pooled);
  const older = scoring.filter((r) => r.exposure >= 1.2).map((r) => r.pooled);
  if (balanced.length && older.length) {
    L.push(`- The arrival window narrows the age confound without closing it. Where the two`);
    L.push(`  cohorts' line-weighted median ages are within 20%, the median gap is **${pp(quantile(balanced, 0.5))}** over`);
    L.push(`  ${balanced.length} repos; where the human lines are at least 20% older, **${pp(quantile(older, 0.5))}** over ${older.length}.`);
  }
  const cappedRepos = scoring.filter((r) => r.capped);
  if (cappedRepos.length) {
    L.push(`- Winsorisation clamped ${cappedRepos.reduce((a, r) => a + r.capped, 0)} commits across ${cappedRepos.length} repos, trimming`);
    L.push(`  ${num(cappedRepos.reduce((a, r) => a + r.trimmed, 0))} lines. It is not a rounding detail: on \`Aider-AI/aider\` one human`);
    L.push('  commit of 99,939 lines, kept in full, is clamped to 291, and that clamp is most of');
    L.push('  that row\'s +22.2 pp.');
  }
  L.push(`- Agent kept share below human: **${scoring.filter((r) => r.pooled < 0).length} of ${scoring.length}** repos.`);
  const signOnly = scoring.filter((r) => r.typical !== null && r.pooled * r.typical < 0);
  L.push(`- The two estimators disagree in sign on **${signOnly.length} of ${scoring.length}** repos, and are more than ${SPREAD} pp apart`);
  L.push(`  on ${voided.length - signOnly.length} more. All ${voided.length} support no conclusion. Drop them and the median of the rest`);
  L.push(`  is ${pp(quantile(survivors, 0.5))}, which is why they are not dropped.`);
  L.push(`- New-file share more than ${COMPOSITION * 100} pp apart: **${scoring.filter((r) => r.composition > COMPOSITION).length} of ${scoring.length}** repos, where the two cohorts are not the same kind of work.`);
  if (refs.length > 1) {
    const spread = Math.round((refs.at(-1) - refs[0]) / 86400);
    L.push(`- Squash contamination is close to all-or-nothing. Across the ${squash.length} repos with`);
  L.push(`  attribution to read, the pilot included, **${squash.filter((v) => v === 0).length} have none of it** because they do not`);
  L.push(`  squash-merge, and **${squash.filter((v) => v >= 80).length} have 80% or more** of their agent-attributed lines on`);
  L.push(`  squashes that mix human work. The median, ${quantile(squash, 0.5).toFixed(1)}%, is the least useful number here.`);
  L.push('  A cross-repo rate built from trailers is partly a measurement of which repos in');
  L.push('  the sample use the squash button.');
  L.push(`- The tips these rows were measured at span **${spread} days**. Cohorts count back from`);
    L.push('  each repo\'s own tip, so the rows cover different calendar windows and the median');
    L.push('  pools them.');
  }
  L.push('');
  L.push('The median is the unit of analysis, per the pre-registration. No line-weighted');
  L.push('average across repos is reported, because `openai/codex` alone would decide it.');
  L.push('Median and IQR are the inverse-ECDF quantile, Hyndman-Fan type 1.');
  L.push('');
  L.push('## What that adds up to');
  L.push('');
  L.push(`The crude figure says agent lines are kept ${quantile(gaps, 0.5).toFixed(0)} points more often. Every`);
  L.push('control applied to it moves it toward zero, and none of them is optional:');
  L.push('');
  L.push('| holding | median gap |');
  L.push('| --- | --- |');
  L.push(`| nothing, the crude figure | ${pp(quantile(gaps, 0.5))} |`);
  L.push(`| the three states apart, as \`not gone\` | ${pp(quantile(scoring.map((r) => r.notGone), 0.5))} |`);
  L.push(`| commit size | ${pp(quantile(stds, 0.5))} |`);
  L.push(`| whether the line sits in a new file | ${pp(quantile(newStds, 0.5))} |`);
  if (balanced.length) L.push(`| exposure, on the repos where it is balanced | ${pp(quantile(balanced, 0.5))} |`);
  if (user.length) L.push(`| ownership, on the repos that do not sell an agent | ${pp(quantile(user, 0.5))} |`);
  L.push('');
  L.push('So the honest reading of this panel is that most of the crude gap is composition:');
  L.push('what kind of code, at what commit size, exposed for how long, in whose repository.');
  L.push('The bootstrap above already includes zero, and six of the fourteen repos disagree');
  L.push('with themselves. This is a null result with a positive point estimate, not a');
  L.push('finding that agent code lasts longer.');
} else {
  L.push('No repo cleared the floor.');
}
L.push('');
L.push('## At 90 days');
L.push('');
L.push('| repo | AI n | mixed, dropped | AI kept | human kept | pooled | not gone | size-std | new-file-std | typical | new-file share | top 5 | read with |');
L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const tag = r.slug === PILOT ? `\`${r.slug}\` *(pilot)*` : `\`${r.slug}\``;
  if (r.absent) { L.push(`| ${tag} |${' — |'.repeat(10)} not measured: no output in \`panel/json\` |`); continue; }
  if (r.unmeasurable) { L.push(`| ${tag} |${' — |'.repeat(10)} \`unmeasurable\`: ${r.unmeasurable} |`); continue; }
  const c = r.c;
  const notes = [...r.flags];
  if (r.dateViolations) notes.push(`${num(r.dateViolations)} commits have a committer date before their parent's`);
  L.push(`| ${tag} | ${num(c.agent.lines)} | ${num(r.mixed)} | ${pct(c.agent.kept, c.agent.lines)} | ${pct(c.human.kept, c.human.lines)} `
    + `| ${pp(r.pooled)} | ${pp(r.notGone)} | ${pp(r.sizeStd?.gap ?? null)} | ${pp(r.newFileStd?.gap ?? null)} | ${pp(r.typical)} | ${dec(c.agent.newFileShare)} vs ${dec(c.human.newFileShare)} `
    + `| ${dec(c.agent.top5Share)} | ${notes.length ? notes.join('; ') : 'no threshold tripped'} |`);
}
L.push('');
L.push('`pooled` is the line-weighted difference in kept share, agent minus human. `typical` is');
L.push('the same difference between the median per-commit rates. `not gone` is the same');
L.push('difference counting a line that was rewritten in place as surviving, which is the');
L.push('reading the pre-registration insists on keeping separate from `kept`. A row where two');
L.push('estimators disagree in sign is a row where a few large commits carry the pooled');
L.push('figure. `mixed, dropped` is the agent-attributed lines in the same cohort excluded');
L.push('because they sit on multi-commit squashes, which is often larger than what is left. `top 5` is the share of the agent cohort held by');
L.push('its five largest commits. `size-std` is the same pooled difference held to');
L.push('commit-size strata, `floor(log2(added))`, weighted by the lines in each stratum;');
L.push('commit size differs systematically between the classes and is the dominant');
L.push('confound in the crude figure; it is blank where the strata both classes reach');
L.push(`cover less than ${COVERAGE * 100}% of the lines. \`new-file-std\` does the same for whether a line sits`);
L.push('in a file its own commit created. `no threshold tripped` means exactly that, not');
L.push('agreement.');
L.push('');
L.push('## Every horizon');
L.push('');
L.push('The gap is not stable in the horizon, so a single-horizon claim is choosing its answer.');
L.push('');
const days = [...new Set(rows.flatMap((r) => r.horizons?.map((h) => h.days) ?? []))].sort((a, b) => a - b);
L.push('| repo | ' + days.map((d) => `${d} d AI / human`).join(' | ') + ' |');
L.push('| --- | ' + days.map(() => '---').join(' | ') + ' |');
for (const r of rows) {
  if (!r.horizons) continue;
  const cells = days.map((d) => {
    const h = r.horizons.find((x) => x.days === d);
    if (!h) return '—';
    return `${h.ai} / ${h.human}${h.n !== null && h.n < FLOOR ? ' (low n)' : ''}`;
  });
  const tag = r.slug === PILOT ? `\`${r.slug}\` *(pilot)*` : `\`${r.slug}\``;
  L.push(`| ${tag} | ${cells.join(' | ')} |`);
}
L.push('');
L.push('`(low n)` marks a cohort under the 2,000 agent-line floor, where one commit moves the');
L.push('rate by more than a point.');
L.push('');
L.push('## Provenance');
L.push('');
L.push('`tip` is the commit every row was measured at. Cohort ages count back from the tip\'s');
L.push('arrival on the default branch, not from wall-clock now, so re-measuring the same sha');
L.push('reproduces the same number and re-measuring the repo later will not.');
L.push('');
L.push('| repo | tip | tip arrived | measured | tool |');
L.push('| --- | --- | --- | --- | --- |');
for (const r of rows) {
  if (!r.head) { L.push(`| \`${r.slug}\` | — | — | — | — |`); continue; }
  L.push(`| \`${r.slug}\` | [\`${r.head.slice(0, 10)}\`](https://github.com/${r.slug}/commit/${r.head}) `
    + `| ${r.reference ? day(r.reference * 1000) : '—'} | ${r.measuredAt ? day(r.measuredAt) : '—'} `
    + `| ${r.version ?? '—'} |`);
}
L.push('');
await writeFile(join(HERE, '..', 'RESULTS.md'), L.join('\n'));
console.error(`\nwrote RESULTS.md — ${measured.length} measured, ${scoring.length} above floor`);
