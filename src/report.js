// Output. Every rate is printed with the n it came from, because a rate without
// its n is the main way this kind of measurement misleads: only a small minority
// of agent commits are a year old, so the long horizons are thin by construction.
//
// Two estimators are always printed together. The pooled share answers "how much
// of what was written survived" and is dominated by the biggest commits; the
// per-commit median answers "what happens to a typical commit". On real repos they
// disagree by tens of points, and reporting only the flattering one is how this
// kind of tool goes wrong.

const pct = (num, den) => (den ? `${((num / den) * 100).toFixed(1)}%` : '—');
const pctOf = (frac) => (frac === null ? '—' : `${(frac * 100).toFixed(1)}%`);
const num = (n) => n.toLocaleString('en-US');

const THIN = 2000;        // the pre-registered floor for reporting a repo's rate
const CONCENTRATED = 0.5; // top-5 commits holding this much makes the pooled figure a few commits

export function human(result, name) {
  const L = [];
  L.push(name);

  if (result.unmeasurable) {
    L.push(`  unmeasurable — ${result.unmeasurable}`);
    if (result.commits) L.push(`  ${num(result.commits.total)} commits scanned.`);
    // The reason decides what the reader should take away, so say the right thing
    // rather than one generic line that fits only the no-attribution case.
    if (/no agent|squash/.test(result.unmeasurable)) {
      L.push('  This is not a keep rate of 0%: the tool cannot see agent work that was');
      L.push('  committed without attribution it can act on.');
    } else if (/retains almost nothing/.test(result.unmeasurable)) {
      L.push('  Neither class has anything left, so any difference between them would be');
      L.push('  0.0 pp by construction. That is an absence of data, not a finding of parity.');
    }
    return L.join('\n');
  }

  const { all, cohorts, commits } = result;
  L.push(`  AI-authored lines    ${num(all.agent.lines).padStart(9)}   (from ${num(commits.agent)} commits with agent attribution)`);
  L.push(`  human lines          ${num(all.human.lines).padStart(9)}   (from ${num(commits.human)} commits, the baseline)`);
  if (commits.mixed) {
    L.push(`  unattributable       ${num(all.mixed.lines).padStart(9)}   (${num(commits.mixed)} squashed PRs mixing agent and human work — excluded)`);
  }
  L.push('');

  const headline = cohorts.find((c) => c.days === 90) ?? cohorts[Math.floor(cohorts.length / 2)];
  for (const c of cohorts) {
    const label = `  at ${c.days} days`.padEnd(23);
    if (c === headline) {
      L.push(`${label}n = ${num(c.agent.lines)} AI lines / ${num(c.human.lines)} human lines`);
      L.push('                       ' + 'AI'.padStart(6) + '   human');
      for (const state of ['kept', 'edited', 'gone']) {
        L.push(`    ${state.padEnd(19)}${pct(c.agent[state], c.agent.lines).padStart(6)}  ${pct(c.human[state], c.human.lines).padStart(6)}`);
      }
      L.push(`    ${'kept, typical'.padEnd(19)}${pctOf(c.agent.keptMedian).padStart(6)}  ${pctOf(c.human.keptMedian).padStart(6)}`);
      if (c.agent.lines && c.human.lines) {
        const pooled = (c.agent.kept / c.agent.lines - c.human.kept / c.human.lines) * 100;
        const typical = (c.agent.keptMedian !== null && c.human.keptMedian !== null)
          ? (c.agent.keptMedian - c.human.keptMedian) * 100 : null;
        L.push('');
        L.push(`    gap, pooled        ${(pooled >= 0 ? '+' : '') + pooled.toFixed(1)} pp`);
        if (typical !== null) {
          L.push(`    gap, typical       ${(typical >= 0 ? '+' : '') + typical.toFixed(1)} pp`);
        }
        if (typical !== null && Math.sign(pooled) !== Math.sign(typical)) {
          L.push('    the two estimators disagree in sign — the pooled figure is a few large');
          L.push('    commits, not a property of the code. Do not quote either one alone.');
        }
        L.push(`    median line age    ${c.agent.medianAgeDays} d (AI)  vs ${c.human.medianAgeDays} d (human), line-weighted`);
        if (c.agent.newFileShare !== null && c.human.newFileShare !== null) {
          L.push(`    in new files       ${pctOf(c.agent.newFileShare).padStart(6)}  ${pctOf(c.human.newFileShare).padStart(6)}`);
          const spread = Math.abs(c.agent.newFileShare - c.human.newFileShare);
          if (spread > 0.15) {
            L.push('    the two cohorts are not the same kind of work: a line in a file its own');
            L.push('    commit created has nothing to be rewritten by. Most of a gap this size');
            L.push('    can be where the agent was pointed rather than how long its code lasts.');
          }
        }
        for (const [who, t] of [['AI', c.agent], ['human', c.human]]) {
          if (t.top5Share !== null && t.top5Share > CONCENTRATED) {
            L.push(`    concentrated: the 5 largest ${who} commits are ${pctOf(t.top5Share)} of that cohort`);
          }
        }
      }
      L.push('');
    } else {
      const thin = c.agent.lines > 0 && c.agent.lines < THIN;
      L.push(`${label}n = ${num(c.agent.lines)} lines    kept ${pct(c.agent.kept, c.agent.lines)}`
        + `   (human ${pct(c.human.kept, c.human.lines)})${thin ? '   (low n — indicative only)' : ''}`);
    }
  }

  L.push(footer(result));
  return L.join('\n');
}

function footer(result) {
  const w = result.warnings;
  const notes = [];
  notes.push('  What this measures: lines added by commits that disclose an agent, traced with');
  notes.push('  `git blame -C -w`. kept = still there, unchanged apart from whitespace.');
  notes.push('  edited = the spot was rewritten, not removed. gone = deleted, or the file is');
  notes.push('  gone. A gap here is a hypothesis, not a result — read the warnings below it.');
  notes.push('  Cohorts are dated by arrival on ' + result.branch + ', not by author date, and');
  notes.push('  every cohort is scored at HEAD, so lines within one differ in exposure.');
  notes.push('  Both sides are held to the same arrival window, starting at the first agent');
  notes.push('  commit. Check the median ages: if they are far apart, so is the exposure.');
  notes.push('  A deleted line is not a bad line. This is durability, not quality.');
  notes.push('');
  notes.push('  Undercounts by construction: agent work committed without attribution is');
  notes.push('  invisible, and every agent CLI can be told not to attribute. Treat the AI');
  notes.push('  line count as a floor, never as this repo\'s share of AI code.');
  if (result.commits?.mixed) {
    notes.push('  Squashed PRs that mix agent and human commits are excluded rather than');
    notes.push('  counted: GitHub puts the agent trailer on the whole diff and a clone cannot');
    notes.push('  say which lines were the agent\'s.');
  }
  if (!result.ignoreRevsHonoured) {
    notes.push('  No .git-blame-ignore-revs at HEAD: a mass-reformat commit, if this repo has');
    notes.push('  one, will read as an edit to every line it touched.');
  } else {
    notes.push(`  Honouring ${result.ignoreRevsFile}.`);
  }
  if (w.ignoredRevs) {
    notes.push(`  ${num(w.ignoredRevs)} revisions in .git-blame-ignore-revs are excluded from authorship`);
    notes.push(`  entirely, removing ${num(w.ignoredRevLines)} added lines. That file is committed by the`);
    notes.push('  repo, and nothing here checks that it only lists formatting commits.');
  }
  if (result.settings?.cap) {
    notes.push(`  Per-commit line counts clamped at ${num(result.settings.cap)} (p${(result.settings.winsor * 100).toFixed(0)} of all`);
    notes.push('  measured commits, one cap for both classes and every horizon).');
  }
  if (w.dateViolations) {
    notes.push(`  ${num(w.dateViolations)} commits on ${result.branch} have a committer date earlier than their`);
    notes.push('  parent\'s. Their arrival date is wrong and has been left uncorrected.');
  }
  if (w.filesSkipped) notes.push(`  ${num(w.filesSkipped)} files unreadable by blame and skipped.`);
  return notes.join('\n');
}

export function json(result, name) {
  return JSON.stringify({ repo: name, ...result }, null, 2);
}
