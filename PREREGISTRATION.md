# Pre-registration: the holdover panel

Committed before any panel is run. Recorded here so the analysis cannot be
changed after seeing the numbers, and so the direction of the result cannot be
chosen after the fact.

Date: 2026-08-21. Tool version: `holdover` 0.1.0.

## The claim to be tested

For a repository containing disclosed agent-authored code, the share of
agent-authored lines still present on the default branch 90 days after they
arrived there differs from the share for human-authored lines in the same
repository over the same window.

Direction is not predicted. The result will be published whichever way it
lands, including if agent-authored lines are kept *less* often than human ones,
and including if the difference is not distinguishable from zero.

## Frame

- **Sampling frame.** 300 public GitHub repositories, selected by GitHub commit
  search for the attribution signals listed in `src/attribution.js`, restricted
  to repositories with a default branch, at least 200 commits, and a permissive
  or copyleft licence. The full slug list will be committed before any
  measurement is run, in `panel/frame.txt`.
- **Inclusion floor.** A repository enters the analysis only if it has at least
  **2,000 agent-authored lines** in the 90-day cohort. Below that a single
  commit moves the rate by more than a point.
- **Exclusions, decided in advance.** Repositories that are forks; repositories
  where the default branch has fewer than 20 human-authored commits, because
  there is no baseline to compare against; repositories that fail the
  partial-clone and shallow-clone checks; repositories the tool reports as
  `unmeasurable`, which covers a wholesale tree replacement, a partial or shallow
  clone, and a repository whose only agent attribution sits on multi-commit squash
  commits.
- **The pilot repository is excluded.** `getzep/graphiti` was used to build and
  debug the tool, so it cannot also be evidence. Its corrected result (-4.8 pp
  pooled, -98.2 pp per-commit, n = 2,786 agent lines, 67% of agent lines in
  newly created files against 26% for humans) supports no conclusion in either
  direction and is reported only as a worked example of what the corrections are
  worth.

## Method, fixed

- **Attribution.** The rules in `src/attribution.js` at the commit tagged
  `panel-v1`, which will be created when `panel/frame.txt` is. Trailer addresses
  and agent author identities, unioned. A vendor domain counts only with a
  tool-shaped local part: the first version of this file matched whole domains and
  so counted hand-written commits by people at OpenAI, Anthropic, Cursor, Charm,
  Continue and Aider as agent work. No change to that file after the frame is
  committed; if a rule has to change, the panel is re-run in full and both results
  are published.
- **Clock.** Arrival on the default branch: a commit on the first-parent trunk
  arrives at its own committer date, any other commit arrives when the oldest
  trunk commit having it as an ancestor arrived. Author date is not used.
- **Blame.** `git blame --incremental -C -w`, honouring `.git-blame-ignore-revs`
  when the repository commits one. Not `-C -C` or `-C -C -C`.
- **Outcome.** Three states: `kept`, `edited`, `gone`, as defined in
  `src/fate.js`. The headline is the 90-day `kept` share. `edited` will never be
  folded into `gone` in any published figure.
- **Squashed pull requests are not attributed.** A commit carrying agent
  attribution that is also a multi-commit squash covers a diff of mixed
  authorship, and a clone cannot say which lines were the agent's. Those commits
  are reported as `mixed` and excluded from both rates. This is not a minor
  filter: on the pilot repository it removes 87% of the apparent agent lines and
  reverses the sign of the gap.
- **Per-commit weight.** Per-commit added-line counts winsorised at the 99th
  percentile, using **one cap per repository computed from both classes pooled**,
  applied unchanged to every horizon. A per-class percentile is invalid here,
  because `ceil(0.99n) - 1 = n - 1` for any n < 100: agent cohorts are typically
  under 100 commits and human cohorts over, so a per-class cap clamps only the
  baseline. A per-cohort cap is also invalid, because it is not monotone in the
  horizon. The number of commits clamped and the volume trimmed will be reported.
- **Median and interquartile range** are the inverse-ECDF quantile, Hyndman-Fan
  type 1: the smallest order statistic whose empirical CDF reaches the quantile. It
  is not the default in R, NumPy or pandas, all of which use type 7, and on 14
  repositories type 7 gives a visibly narrower interval. Naming the convention is
  the point of fixing it here.
- **Two estimators, both published, neither alone.** The pooled line-weighted
  share within a repository, and the median per-commit rate. They answer different
  questions and on the pilot repository they differ by 93 points: -4.8 pp pooled
  against -98.2 pp per-commit, because the five largest agent commits are 80% of
  the cohort. A repository where the two estimators disagree in sign, or differ by
  more than 20 points, will be reported as supporting no conclusion in either
  direction.
- **Size standardisation.** The paired difference is also reported standardised on
  commit-size strata (`floor(log2(added))`), weighted by the lines in each stratum,
  with strata only one class reaches dropped. Commit size differs systematically
  between the classes and is the dominant confound in the pooled figure.
- **New-file standardisation.** And standardised on whether a line sits in a file
  its own commit created, which on the pilot repository is 67% of agent lines
  against 26% of human lines. `--json` exposes `keptInNewFiles` per commit so this
  can be recomputed without rerunning the tool. An external audit of an earlier version found that
  this single covariate moved the gap from +10.0 pp to +0.6 pp, with humans ahead
  inside the new-file stratum. Both the crude and the standardised estimate will be
  published; if they disagree, the standardised one is the result.
- **Unit of analysis is the repository.** Across repositories the report is the
  median and the interquartile range of the per-repository rate. No pooled
  line-weighted average across repositories will be published, because one
  bot-heavy repository would then determine the result.
- **All three horizons are published for every repository.** On `openai/codex` the
  gap runs -5.6 pp at 30 days, +1.5 pp at 90 and +3.1 pp at 180, crossing zero,
  while `Aider-AI/aider` holds +22.0, +22.2, +22.5 across the same three.
  Whether one horizon speaks for a repo is a property of the repo. See
  [RESULTS.md](RESULTS.md) for the current run. Reporting the 90-day figure alone would be choosing
  the answer. The 90-day figure remains the pre-registered headline; the other two
  are reported beside it in every table.
- **Reference point.** Cohorts are measured from the arrival date of the tip of
  the default branch at clone time, not from wall-clock now, so a rerun on the
  same commit reproduces the same number. The tip sha for every repository will
  be recorded.

## What will be reported regardless of outcome

- The per-repository table, all 300 rows, including repositories excluded by the
  floor and the reason, with the `mixed` (squashed, unattributable) line count
  alongside the attributed one.
- Median and IQR of the 90-day `kept` share, for agent and human, and the
  per-repository paired difference — pooled, per-commit, and size-standardised.
- The count of repositories where the two estimators disagree in sign.
- The count of repositories where the agent share is lower than the human share.
- The decomposition from the strictest definition to this one, so the
  contribution of each methodological choice to the headline is visible.
- The number of repositories that were unmeasurable, and why.
- For every repository, the new-file share of each cohort and the top-5-commit
  concentration, so a reader can see which rows are a handful of commits.
- The full per-commit table (`--json` `commitRows`) for every measured repository,
  so the analysis can be redone without rerunning the tool.
