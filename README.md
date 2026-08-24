# holdover

How much of what a coding agent wrote is still in your repo, and how that compares
to the humans working on the same repo, plus the checks that tell you when the
comparison is not worth making.

Reads git history. Nothing to install in the repo being measured, no hooks, no
daemon, no prior instrumentation, and it works on repos you do not own.

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
    edited               5.6%   10.5%
    gone                18.0%    8.3%
    kept, typical        0.0%   98.2%

    gap, pooled        -4.8 pp
    gap, typical       -98.2 pp
    median line age    191.3 d (AI)  vs 340.8 d (human), line-weighted
    in new files        67.0%   26.1%
    the two cohorts are not the same kind of work: a line in a file its own
    commit created has nothing to be rewritten by. Most of a gap this size
    can be where the agent was pointed rather than how long its code lasts.
    concentrated: the 5 largest AI commits are 80.0% of that cohort

  at 180 days          n = 1,925 lines    kept 69.1%   (human 79.3%)   (low n)
```

That output is the point, and the warnings under it are not decoration. The
interesting version of this tool is not the one that prints a big number; it is the
one that tells you the big number was an artifact.

This repo is where the tool was built, so it is the worked example rather than
evidence. Its measured figure moved four times during development, every time
because a bug was fixed or a confound was controlled:

| measured gap | after fixing |
| --- | --- |
| +32.7 pp | nothing, the first working version |
| +13.6 pp | age matching: the human baseline was years of older code |
| +0.7 pp | a shared winsorisation cap (a per-class p99 is a no-op below 100 commits, so it only ever clamped the baseline) and excluding mixed-authorship squashes (87% of the "agent" lines were human pull requests carrying a hoisted trailer) |
| **-4.8 pp** | counting a re-added identical line as kept rather than edited, and making blame whitespace-insensitive on both sides |

Those are the steps in the order they were found, not an attribution of variance.
The corrections interact, and the last two were applied together. Two of them came
from adversarial review of the finished tool rather than from testing it.

And even -4.8 pp is not a finding: the per-commit estimator says -98.2, the agent
cohort is 67% new-file lines against the humans' 26%, and five commits are 80% of
it. The honest report on graphiti is *no conclusion in either direction*. If your
repo prints warnings like these, it is telling you the same thing.

```bash
npx holdover
```

Node 20+ and git. No dependencies.

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
a further 5.6% were edited in place, so 18.0% are actually gone. A two-state
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

## Four repos, four different answers

Measured with the shipped defaults at the 90-day horizon, at the tips recorded in
[RESULTS.md](RESULTS.md#provenance). This is the whole case for
reporting the diagnostics rather than the number. Twenty repos measured the same way
are in [RESULTS.md](RESULTS.md), where the median gap is +3.0 pp with an interquartile
range from -5.1 to +10.7, and the two estimators disagree in sign on 6 of the 14 repos
that clear the line floor:

| repo | AI n | AI kept | human kept | pooled | typical | new-file share | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `openai/codex` | 1,186,546 | 56.3% | 53.0% | +3.2 pp | +20.7 pp | 34% vs 28% | both estimators agree, composition close, but see the horizon note below |
| `aaif-goose/goose` | 66,090 | 55.3% | 44.6% | **+10.7 pp** | +20.4 pp | 58% vs 48% | both estimators agree, composition close, and the cleanest result here |
| `getzep/graphiti` | 2,786 | 76.4% | 81.2% | -4.8 pp | -98.2 pp | 67% vs 26% | estimators 93 points apart, 5 commits are 80% of the cohort, so no conclusion |
| `OpenHands/OpenHands` | — | — | — | — | — | — | `unmeasurable`: the tree was replaced wholesale, so both classes retain nothing |

Read the *level* as well as the gap: 56.3%, 55.3%, 76.4%. A headline "AI code survives
N% of the time" describes a repo, not agents.

**The gap is not stable in the horizon.** On codex it goes +6.4 pp at 30 days,
+3.2 pp at 90, and **-5.8 pp at 180** (AI 43.2% against humans' 49.0%, on 478,344
lines, not a thin-n artifact). Whatever advantage is there erodes and reverses over
longer windows. Any single-horizon claim is choosing its answer.

An earlier version of this tool reported `+0.0 pp` for OpenHands, from 0 of 427,394
agent lines and 0 of 301,298 human lines. That is the failure mode this project
exists to catch: a number that looks like parity and is actually an absence of data.

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
