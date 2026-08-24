# holdover

[![CI](https://github.com/FelippeRoza/holdover/actions/workflows/ci.yml/badge.svg)](https://github.com/FelippeRoza/holdover/actions/workflows/ci.yml)

How much of what a coding agent wrote is still in your repo, and how that compares
to the humans working on the same repo, plus the checks that tell you when the
comparison is not worth making.

Reads git history. Nothing to install in the repo being measured, no hooks, no
daemon, no prior instrumentation, and it works on repos you do not own.

```bash
npx holdover                 # this repo
npx holdover getzep/graphiti # any public one
```

Node 20+ and git. No dependencies.

## Most of the "AI-written" code in these measurements is human

GitHub's squash merge copies every co-author trailer onto the squashed commit. One
agent commit inside a five-commit pull request therefore puts an agent trailer on a
diff that is mostly somebody else's, and every git-history tool that reads trailers
credits the agent with all of it.

On the repo this tool was built against, that was **87% of the apparent agent
lines**. `--decompose` walks from the strictest published definition to this one,
one choice at a time, so each is a number:

```
$ npx holdover getzep/graphiti --decompose

  definition                                             AI n    kept   +edit   human n    kept  gap
  strictest published definition                       57,629   83.9%   95.2%   198,089   60.0%  +24.0
  + drop lockfiles, bundles and binaries               45,279   91.9%   94.8%   147,126   76.1%  +15.7
  + take CI bots out of the human baseline             45,279   91.9%   94.8%   146,508   76.0%  +15.8
  + follow content across files (-C)                   45,279   92.1%   95.0%   146,508   77.1%  +15.0
  + honour .git-blame-ignore-revs                      45,279   92.1%   95.0%   146,508   77.1%  +15.0
  + stop crediting the agent with whole squashed PRs    3,259   75.9%   79.4%   146,508   77.1%   -1.1
  + cohort by arrival on the default branch (90 days)    2,786   76.4%   79.9%   145,041   76.9%   -0.4
  + hold both sides to the same arrival window          2,786   76.4%   79.9%    15,938   83.8%   -7.3
  + winsorise per-commit volume at p99                  2,786   76.4%   79.9%    13,452   81.2%   -4.8
```

Read down the `AI n` column. The squash row takes the cohort from 45,279 lines to
3,259 and flips the sign of the gap. It is the largest effect in the table and no
other tool in [PRIOR-ART.md](PRIOR-ART.md) corrects for it. A headline "AI code
survival rate" computed from `Co-authored-by` trailers on a squash-merging repo is
mostly measuring human pull requests.

The ladder is sequential and step 0 is a strawman assembled from three papers, not a
re-run of anyone's pipeline. [METHODOLOGY.md](METHODOLOGY.md) says what that does and
does not license you to conclude.

## The default report

```
$ npx holdover getzep/graphiti

getzep/graphiti
  AI-authored lines        3,259   (from 61 commits with agent attribution)
  human lines             60,447   (from 659 commits, the baseline)
  unattributable          21,823   (68 squashed PRs mixing agent and human work — excluded)

  at 30 days           n = 2,970 lines    kept 75.7%   (human 81.3%)
  at 90 days           n = 2,786 AI lines / 13,452 human lines
                           AI   human
    kept                76.4%   81.2%
    edited               3.5%    7.5%
    gone                20.1%   11.3%
    kept, typical        0.0%   98.2%

    gap, pooled        -4.8 pp
    gap, typical       -98.2 pp
    median line age    191.3 d (AI)  vs 340.8 d (human), line-weighted
    in new files        67.0%   26.1%
    the two cohorts are not the same kind of work: a line in a file its own
    commit created has nothing to be rewritten by. Most of a gap this size
    can be where the agent was pointed rather than how long its code lasts.
    concentrated: the 5 largest AI commits are 80.0% of that cohort

  at 180 days          n = 1,925 lines    kept 69.1%   (human 79.3%)   (low n — indicative only)
```

That output is the point, and the warnings under it are not decoration. The
interesting version of this tool is not the one that prints a big number; it is the
one that tells you the big number was an artifact.

graphiti is the repo the tool was built against, so it is a worked example rather
than evidence, and -4.8 pp is not a finding: the per-commit estimator says -98.2,
the agent cohort is 67% new-file lines against the humans' 26%, and five commits are
80% of it. The honest report here is *no conclusion in either direction*. That
figure moved four times during development, every time because a bug was fixed or a
confound was controlled; [METHODOLOGY.md](METHODOLOGY.md) has the steps.

> The npm package `keeprate`, and the package `stillthere`, are unrelated
> projects by other authors that measure something similar. Both are described
> in [PRIOR-ART.md](PRIOR-ART.md) with what they do differently.

## What it measures

Lines added by commits that disclose an agent, traced to the current tip of the
default branch, in three states:

| state | meaning |
| --- | --- |
| `kept` | the line is still there, unchanged apart from whitespace. Either `git blame` still credits it to the commit that wrote it, following content moved between files and ignoring the revisions the repo asks blame to ignore, or the diff from that commit to HEAD does not touch it at all |
| `edited` | the line is no longer credited to its author, but the diff from that commit to HEAD *replaced* it rather than removing it. The contribution to that spot survives in changed form |
| `gone` | the file is not at HEAD under any name, or the hunk covering the line only deletes |

Collapsing `edited` into `gone` means a one-character rename scores the same as
deleting the file. On graphiti, 76.4% of attributable agent lines are unchanged and
a further 3.5% were edited in place, so 20.1% are actually gone. A two-state
measurement reports that as "24% did not survive." It is not, however, the largest
source of disagreement between the published numbers; that turns out to be squash
attribution. See [the decomposition](METHODOLOGY.md#where-the-disagreeing-numbers-come-from).

## What it does not measure

- **Quality.** A deleted line is not a bad line. Prototypes get deleted because
  they were finished, not because they were wrong.
- **How much of your code is AI-written.** It measures *disclosed* agent work.
  Everything below is undercounted, sometimes by an order of magnitude.
- **Anything about a repo with no agent attribution.** That prints
  `unmeasurable`, not 0%.

## Five repos, five different answers

Measured with the shipped defaults at the 90-day horizon, at the tips recorded in
[RESULTS.md](RESULTS.md#provenance). This is the whole case for reporting the
diagnostics rather than the number. All twenty repos are in
[RESULTS.md](RESULTS.md), where the median pooled gap is +6.6 pp with an
interquartile range of +0.4 to +14.9, and 7 of the 14 repos above the line floor
support no conclusion because their two estimators disagree.

| repo | AI n | AI kept | human kept | pooled | typical | new-file share | read with |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Aider-AI/aider` | 48,474 | 66.6% | 44.4% | **+22.2 pp** | +19.7 pp | 6% vs 11% | nothing tripped, and stable at every horizon. The cleanest result here |
| `browser-use/browser-use` | 14,238 | 20.5% | 41.6% | **-21.1 pp** | -13.4 pp | 48% vs 37% | nothing tripped either, and it runs the other way |
| `openai/codex` | 11,592 | 59.6% | 57.6% | +2.0 pp | -1.2 pp | 25% vs 32% | estimators disagree in sign, and the gap changes sign twice across the horizons |
| `getzep/graphiti` | 2,786 | 76.4% | 81.2% | -4.8 pp | -98.2 pp | 67% vs 26% | estimators 93 pp apart, 5 commits are 80% of the cohort, so no conclusion |
| `OpenHands/OpenHands` | — | — | — | — | — | — | `unmeasurable`: the tree was replaced wholesale, so both classes retain nothing |

Read the *level* as well as the gap: 66.6%, 20.5%, 59.6%, 76.4%. A headline "AI code
survives N% of the time" describes a repo, not agents. The two cleanest rows here
point in opposite directions by more than 20 points each.

**The gap is not stable in the horizon.** On codex it runs -5.3 pp at 30 days,
+2.0 pp at 90 and -6.8 pp at 180. Aider's barely moves, 22.0 to 22.5. Whether a
single-horizon claim holds is a property of the repo, not of the horizon, and you
cannot tell which you have without printing all three.

An earlier version of this tool reported `+0.0 pp` for OpenHands, from 0 of 427,394
agent lines and 0 of 301,298 human lines. That is the failure mode this project
exists to catch: a number that looks like parity and is actually an absence of data.

## Measuring this repo

`npx holdover` in a clone of holdover prints `unmeasurable`. Every line here was
written by an agent and disclosed, there are no human commits to compare against,
and the newest agent lines have not had 30 days on the branch yet. A tool whose
argument is that an absence of data should not be printed as a number cannot make
an exception for itself.

## Usage

```
holdover                     measure the repo in the current directory
holdover <path>              measure a local repo
holdover <owner/repo>        clone a public GitHub repo and measure it

--horizons 30,90,180         days since arrival on the default branch
--json                       machine-readable output, including a per-commit table
--decompose                  show what each definitional choice is worth
--winsor 0.99                clamp per-commit line counts at this percentile
--branch <ref>               measure a ref other than the detected default
--quiet                      no progress output
```

Exit codes: `0` measured, `3` unmeasurable, `1` not a repo, `2` bad arguments.

`--json` includes `commitRows`: one row per measured commit with its class, arrival
timestamp, lines added, lines added in files that commit created, and its
kept/edited/gone/reattributed split. Everything the report prints is derivable from
that table, which is the point. The two estimators should not have to be taken on
trust.

## Reading further

The tool is one thing and the argument for trusting it is another, so they are
separate documents.

- [RESULTS.md](RESULTS.md). Twenty repos measured with the shipped defaults, every
  horizon, and the tip sha each row is pinned to.
- [METHODOLOGY.md](METHODOLOGY.md). Why the baseline is constructed the way it is,
  what each definitional choice is worth in points, the five passes and the flags
  they use, and the limitations. Most of them cannot be fixed and are stated anyway.
- [PRIOR-ART.md](PRIOR-ART.md). The other tools that measure this, what each one
  does differently, and where the widely quoted numbers come from.
- [PREREGISTRATION.md](PREREGISTRATION.md). The 300-repo panel, its frame and its
  analysis, committed before any of it is run.

## Licence

MIT.
