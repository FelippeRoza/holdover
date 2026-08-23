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
const frac = (f) => (f === null || f === undefined ? '—' : (f * 100).toFixed(0) + '%');
const pp = (v) => (v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1));
const num = (n) => n.toLocaleString('en-US');

const rows = [];
for (const slug of slugs) {
  const file = join(JSONDIR, slug.replace('/', '__') + '.json.gz');
  let r;
  try { r = JSON.parse(gunzipSync(await readFile(file))); } catch { continue; }
  rows.push({ slug, ...summarise(r) });
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
  if (typical !== null && Math.sign(pooled) !== Math.sign(typical)) flags.push('estimators disagree in sign');
  else if (typical !== null && Math.abs(pooled - typical) > SPREAD) flags.push(`estimators ${Math.abs(pooled - typical).toFixed(0)} pp apart`);
  if (composition !== null && composition > COMPOSITION) flags.push(`new-file share ${frac(composition)} apart`);
  if (c.agent.top5Share !== null && c.agent.top5Share > 0.5) flags.push(`5 commits are ${frac(c.agent.top5Share)} of the cohort`);

  return {
    c, pooled, typical, composition, flags,
    mixed: r.all.mixed?.lines ?? 0,
    horizons: r.cohorts.map((h) => ({ days: h.days, ai: pct(h.agent.kept, h.agent.lines), human: pct(h.human.kept, h.human.lines), n: h.agent.lines })),
  };
}

const measured = rows.filter((r) => !r.unmeasurable && r.slug !== PILOT);
const scoring = measured.filter((r) => r.c.agent.lines >= FLOOR);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

const gaps = scoring.map((r) => r.pooled);
const L = [];
L.push('# Results');
L.push('');
L.push('Generated by `node panel/run.js` from the repo list in [`panel/repos.txt`](panel/repos.txt).');
L.push('Raw `--json` output for every repo, including the per-commit table, is in `panel/json/`.');
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
  L.push(`- ${measured.length} of ${rows.length - 1} repos measurable, ${scoring.length} above the pre-registered 2,000-line floor.`);
  L.push(`- Median pooled gap at 90 days: **${pp(median(gaps))} pp** (IQR ${pp(quantile(gaps, 0.25))} to ${pp(quantile(gaps, 0.75))}).`);
  L.push(`- Agent kept share below human: **${scoring.filter((r) => r.pooled < 0).length} of ${scoring.length}** repos.`);
  L.push(`- Estimators disagree in sign: **${scoring.filter((r) => r.typical !== null && Math.sign(r.pooled) !== Math.sign(r.typical)).length} of ${scoring.length}** repos. Those support no conclusion in either direction.`);
  L.push(`- New-file share more than ${frac(COMPOSITION)} apart: **${scoring.filter((r) => r.composition > COMPOSITION).length} of ${scoring.length}** repos, where the two cohorts are not the same kind of work.`);
  L.push('');
  L.push('The median is the unit of analysis, per the pre-registration. No line-weighted');
  L.push('average across repos is reported, because `openai/codex` alone would decide it.');
} else {
  L.push('No repo cleared the floor.');
}
L.push('');
L.push('## At 90 days');
L.push('');
L.push('| repo | AI n | AI kept | human kept | pooled | typical | new-file share | read with |');
L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const tag = r.slug === PILOT ? `\`${r.slug}\` *(pilot)*` : `\`${r.slug}\``;
  if (r.unmeasurable) { L.push(`| ${tag} | — | — | — | — | — | — | \`unmeasurable\`: ${r.unmeasurable} |`); continue; }
  const c = r.c;
  L.push(`| ${tag} | ${num(c.agent.lines)} | ${pct(c.agent.kept, c.agent.lines)} | ${pct(c.human.kept, c.human.lines)} `
    + `| ${pp(r.pooled)} pp | ${pp(r.typical)} pp | ${frac(c.agent.newFileShare)} vs ${frac(c.human.newFileShare)} `
    + `| ${r.flags.length ? r.flags.join('; ') : 'both estimators agree, composition close'} |`);
}
L.push('');
L.push('`pooled` is the line-weighted difference in kept share, agent minus human. `typical` is');
L.push('the same difference between the median per-commit rates. A row where they disagree in');
L.push('sign is a row where a few large commits carry the pooled figure.');
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
    return `${h.ai} / ${h.human}${h.n && h.n < FLOOR ? ' (low n)' : ''}`;
  });
  L.push(`| \`${r.slug}\` | ${cells.join(' | ')} |`);
}
L.push('');
L.push('`(low n)` marks a cohort under the 2,000 agent-line floor, where one commit moves the');
L.push('rate by more than a point.');
L.push('');
await writeFile(join(HERE, '..', 'RESULTS.md'), L.join('\n'));
console.error(`\nwrote RESULTS.md — ${measured.length} measured, ${scoring.length} above floor`);
