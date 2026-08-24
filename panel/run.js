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

const slugs = (await readFile(join(HERE, 'repos.txt'), 'utf8'))
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

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
  return (Number(r) > 0 ? '+' : '') + r;
};
const dec = (f) => (f === null || f === undefined ? '—' : (f * 100).toFixed(1) + '%');
const num = (n) => n.toLocaleString('en-US');

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

  return {
    c, pooled, typical, composition, flags,
    mixed: r.all?.mixed?.lines ?? 0,
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
L.push('## Summary');
L.push('');
if (gaps.length) {
  const eligible = slugs.filter((sl) => sl !== PILOT).length;
  const voided = scoring.filter((r) => r.typical !== null
    && (r.pooled * r.typical < 0 || Math.abs(r.pooled - r.typical) > SPREAD));
  const survivors = scoring.filter((r) => !voided.includes(r)).map((r) => r.pooled);
  const refs = rows.map((r) => r.reference).filter(Boolean).sort((a, b) => a - b);
  const typicals = scoring.map((r) => r.typical).filter((v) => v !== null);
  L.push(`- ${measured.length} of ${eligible} repos measurable, ${scoring.length} above the pre-registered 2,000-line floor.`);
  L.push(`- Median pooled gap at 90 days: **${pp(quantile(gaps, 0.5))} pp** (IQR ${pp(quantile(gaps, 0.25))} to ${pp(quantile(gaps, 0.75))}).`);
  L.push(`- Median per-commit gap: **${pp(quantile(typicals, 0.5))} pp** (IQR ${pp(quantile(typicals, 0.25))} to ${pp(quantile(typicals, 0.75))}). It is not the same answer.`);
  const keptShares = (side) => scoring.map((r) => (r.c[side].kept / r.c[side].lines) * 100);
  L.push(`- Median kept share: agent ${quantile(keptShares('agent'), 0.5).toFixed(1)}%, human ${quantile(keptShares('human'), 0.5).toFixed(1)}%.`);
  L.push(`- Agent kept share below human: **${scoring.filter((r) => r.pooled < 0).length} of ${scoring.length}** repos.`);
  L.push(`- Support no conclusion, the estimators disagreeing in sign or by more than ${SPREAD} pp: **${voided.length} of ${scoring.length}**. Drop them and the median of the rest is ${pp(quantile(survivors, 0.5))} pp, which is why they are not dropped.`);
  L.push(`- New-file share more than ${COMPOSITION * 100} pp apart: **${scoring.filter((r) => r.composition > COMPOSITION).length} of ${scoring.length}** repos, where the two cohorts are not the same kind of work.`);
  if (refs.length > 1) {
    const spread = Math.round((refs.at(-1) - refs[0]) / 86400);
    L.push(`- The tips these rows were measured at span **${spread} days**. Cohorts count back from`);
    L.push('  each repo\'s own tip, so the rows cover different calendar windows and the median');
    L.push('  pools them.');
  }
  L.push('');
  L.push('The median is the unit of analysis, per the pre-registration. No line-weighted');
  L.push('average across repos is reported, because `openai/codex` alone would decide it.');
  L.push('Median and IQR are the inverse-ECDF quantile, Hyndman-Fan type 1.');
} else {
  L.push('No repo cleared the floor.');
}
L.push('');
L.push('## At 90 days');
L.push('');
L.push('| repo | AI n | dropped as mixed | AI kept | human kept | pooled | typical | new-file share | top 5 | read with |');
L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const tag = r.slug === PILOT ? `\`${r.slug}\` *(pilot)*` : `\`${r.slug}\``;
  if (r.absent) { L.push(`| ${tag} |${' — |'.repeat(8)} not measured: no output in \`panel/json\` |`); continue; }
  if (r.unmeasurable) { L.push(`| ${tag} |${' — |'.repeat(8)} \`unmeasurable\`: ${r.unmeasurable} |`); continue; }
  const c = r.c;
  const notes = [...r.flags];
  if (r.dateViolations) notes.push(`${num(r.dateViolations)} commits have a committer date before their parent's`);
  L.push(`| ${tag} | ${num(c.agent.lines)} | ${num(r.mixed)} | ${pct(c.agent.kept, c.agent.lines)} | ${pct(c.human.kept, c.human.lines)} `
    + `| ${pp(r.pooled)} pp | ${pp(r.typical)} pp | ${dec(c.agent.newFileShare)} vs ${dec(c.human.newFileShare)} `
    + `| ${dec(c.agent.top5Share)} | ${notes.length ? notes.join('; ') : 'no threshold tripped'} |`);
}
L.push('');
L.push('`pooled` is the line-weighted difference in kept share, agent minus human. `typical` is');
L.push('the same difference between the median per-commit rates. A row where they disagree in');
L.push('sign is a row where a few large commits carry the pooled figure. `dropped as mixed` is');
L.push('the agent-attributed lines excluded because they sit on multi-commit squashes, which is');
L.push('often larger than the measured cohort. `top 5` is the share of the agent cohort held by');
L.push('its five largest commits. `no threshold tripped` means exactly that, not agreement.');
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
