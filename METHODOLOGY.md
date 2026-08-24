# Methodology

How the comparison is built, what each choice in it is worth, and what it still
cannot do. [README.md](README.md) is the tool; this is the argument for trusting
its output.

## The baseline is the point

A keep rate on its own is uninterpretable. 67% sounds bad until you find the humans
on the same repo are at 67% too. So every figure is printed next to the same figure
for non-agent commits in the same repository, over the same arrival window.

Getting that comparison honest is most of the work, and three things about it are
easy to get wrong.

**Age.** Agent commits are recent by definition; human commits go back to the
repo's first commit. Comparing "all human lines at least 90 days old" against
three-month-old agent lines compares ages, not authorship. Both sides are held to
the same arrival window, starting at the first agent commit, and the printed median
age is **line-weighted**. The commit-unweighted version made graphiti's cohorts
look 15 days apart when the lines were 150 days apart.

**Weighting.** Two estimators are always printed, because they answer different
questions and on real repos they disagree by tens of points. The pooled share is
"how much of what was written survived", and it is dominated by the largest
commits. The per-commit median is "what happens to a typical commit". On graphiti,
25 of 54 agent commits keep *zero* lines, small fixes that were entirely rewritten,
while five large commits holding 80% of the lines survive nearly intact. Pooled:
76.4%. Typical: 0%. Quoting either one alone is misleading, so the tool says so
out loud when they disagree in sign.

**Squashed pull requests.** GitHub credits every commit author in a PR as a
co-author on the squash commit, so one agent-trailered commit in a five-commit PR
puts the agent trailer on a diff that is mostly somebody else's. On a fixture where
an agent wrote 12 of 100 lines in a PR, trailer attribution claims all 100. On
graphiti, **zero** of 129 agent-attributed commits have an agent in the author
field, and 68 are multi-commit squashes carrying 87% of the apparent agent lines.
Those are reported as `unattributable` and excluded from both rates, because a
clone cannot recover which lines were the agent's. This one correction takes
graphiti from 45,279 agent lines at 92.1% to 3,259 at 75.9%, and flips the gap from
+15.0 pp to -1.1 pp.

**What kind of code it is.** A line in a file its own commit created has nothing to
be rewritten by. On graphiti 67% of agent lines are in new files against 26% of
human lines, and on three of four repos tested the asymmetry runs the same way. The
report prints both shares and says so when they diverge, because most of a gap can
be where the agent was pointed rather than how long its output lasts. The tool does
**not** stratify on this. See [Limitations](#limitations).

## Where the disagreeing numbers come from

Three published measurements of AI code survival report roughly 54%, 47% and 82%.
`holdover --decompose` walks from the strictest published definition to this one,
one change at a time, so each choice is a number:

```
$ npx holdover getzep/graphiti --decompose

  definition                                             AI n    kept   +edit   human n    kept  gap
  strictest published definition                       57,629   83.9%   96.7%   198,089   60.0%  +24.0
  + drop lockfiles, bundles and binaries               45,279   91.9%   96.2%   147,126   76.1%  +15.7
  + take CI bots out of the human baseline             45,279   91.9%   96.2%   146,508   76.0%  +15.8
  + follow content across files (-C)                   45,279   92.1%   96.3%   146,508   77.1%  +15.0
  + honour .git-blame-ignore-revs                      45,279   92.1%   96.3%   146,508   77.1%  +15.0
  + stop crediting the agent with whole squashed PRs    3,259   75.9%   81.4%   146,508   77.1%   -1.1
  + cohort by arrival on the default branch (90 days)    2,786   76.4%   82.0%   145,041   76.9%   -0.4
  + hold both sides to the same arrival window          2,786   76.4%   82.0%    15,938   83.8%   -7.3
  + winsorise per-commit volume at p99                  2,786   76.4%   82.0%    13,452   81.2%   -4.8
```

Read down the `AI n` column. Squash attribution is the single largest effect in the
table, and it is the one no published tool corrects for: it takes the cohort from
45,279 lines to 3,259 and flips the sign of the gap from +15.0 to -1.1. If you take
one thing from this project, it is that a headline "AI code survival rate" computed
from `Co-authored-by` trailers on a squash-merging repo is mostly measuring human
pull requests.

Age matching is the next largest, worth 6.9 points, and lockfiles and binaries are
worth 8 points on the agent side. `-C` is worth almost nothing here once
whitespace-insensitive blame is already on, which was not obvious in advance.

Three warnings about reading this table:

**It is sequential.** Each row is worth what it is worth *in that position*. A
choice already implied by an earlier row reads as 0.0 even when removing it from the
finished measurement would move the number a lot. Do not quote a row as an
attribution of variance.

**Step 0 is a strawman.** It is the harshest defensible reading of the published
definitions, assembled from three papers, not a re-run of anyone's pipeline. The
ladder also ends at this tool by construction, so it cannot show a choice that goes
the other way.

**The two biggest levers are not in it at all.** The unit of analysis, pooled lines
versus per-commit median, is worth more on graphiti than every row combined
(-4.8 pp against -98.2 pp), and it is not a definition of survival but of what you
are averaging over. The same goes for the new-file split. Both are in the default
report instead.

## How it works

Five passes, all `git`:

1. **Classify.** `git log` with author identity and full message, matched against
   the rules in [`src/attribution.js`](src/attribution.js).
2. **Date.** Arrival on the default branch. A commit on the first-parent trunk
   arrives at its own committer date; any other commit arrives when the oldest
   trunk commit having it as an ancestor arrived, which is when the merge that
   brought it in landed.
3. **Count.** One `git log -U0 -M --patch` stream gives the line ranges each
   commit added, in that commit's own coordinate space.
4. **Blame.** `git blame --incremental -C` over every text file at HEAD, in
   parallel across cores, honouring `.git-blame-ignore-revs` when the repo commits
   one.
5. **Trace.** For lines blame no longer credits to their author, one `git diff -U0`
   per commit decides `edited` from `gone`.

### Why those flags

Every choice below was measured rather than assumed, on `pallets/flask` (5,556
commits) and `django/django` (34,884 commits).

- **`-C`, not `-M -C`.** `-C` implies `-M`. Path renames are followed with no flags
  at all; what `-M` adds is movement of a block within one file.
- **Not `-C -C` or `-C -C -C`.** They change a further 0.35% and 0.29% of lines on
  flask, 0.57% and 0.84% on django, and the last one costs 23x. Good for a forensic
  question about one file, a bad default for a repo.
- **`.git-blame-ignore-revs` is worth more than every `-C` level combined.**
  Honouring django's committed file moves 16.87% of sampled lines off the wrong
  commit; one 2022 Black run owns 16.3% of them. git does not read the file unless
  asked, and says nothing when it is present and ignored.
- **`--incremental`, not `--line-porcelain`.** All three formats carry the same
  information, but parsing is single-threaded, so on a large repo the format *is*
  the bottleneck: 14-way parallel blame over `openai/codex` ran only 3.2x faster
  than serial because Node was parsing 23 million lines of output. On one real
  file: line-porcelain 177,829 bytes, porcelain 46,962, incremental 21,267.
  `--porcelain` is not usable, because it omits `filename` for later groups from
  the same commit and so silently loses the original path when one commit's lines
  survive under two names.
- **Arrival, not author date.** The author date is set by whoever ran `git commit`,
  survives rebase and cherry-pick, and can be any value at all. Committer date
  alone is not enough either: validated against 13,655 server-side push timestamps
  from GitHub's activity API on an 18,143-commit repo, a commit's own committer
  date is within a minute of the truth 75.3% of the time and up to 27.3 days early.
  The first-parent rule above is within a minute 99.28% of the time.
- **Dates are never repaired.** When a trunk commit's date goes backwards, that is
  reported and left alone. Clamping to a running maximum spreads a future date over
  the whole tail, clamping to a minimum spreads a backdate over the whole head, and
  isotonic regression averages two liars into a third wrong answer.

### Who counts as an agent

Two signals, unioned: a trailer line whose **email** names an agent, and an agent
in the commit's own **author** field. The full list is
[`src/attribution.js`](src/attribution.js), which is meant to be read.

Matching the display name does not work. Sixteen distinct names pair with
`noreply@anthropic.com` across a six-repo sample: `Claude`, `Claude Sonnet 5`,
`Claude Opus 4.8 (1M context)`, and `goose`, which is a different tool running an
Anthropic model. Matching a keyword anywhere in the message is far worse: `codex`
flags 4,829 of the 9,637 commits in `openai/codex`, because the repo is named
codex. Anchored to a trailer line, the same word flags 360, all real.

The author field is not optional. Aider's two attribution modes are mutually
exclusive by design, so across its own 13,138-commit history the trailer and the
author suffix never co-occur: trailer-only detection sees 67 commits, author-only
sees 3,661. Cursor, Windsurf, Jules, Devin, Replit, Lovable, v0 and Bolt all commit
as themselves and write no agent trailer. Replit writes `Replit-Commit-Author:
Agent` instead. Crush defaults to `Assisted-by:`, the Linux kernel convention,
which curl has also used to credit *humans* since 2020, across 13,304 commits, so
`Assisted-by:` only counts when its value has the `AGENT:MODEL` shape.

## Limitations

Stated plainly, because most of them cannot be fixed.

- **Every number is a floor on agent involvement, and the multiplier to the truth
  is unknown.** Trailer-and-identity detection has measured recall between 0% and
  92% depending purely on which tool a repo uses. Four holes: agent-written code a
  human commits with no attribution, which is probably the largest and is invisible
  to any git-level signal; one config line (`attribution.commit: ""`,
  `--no-attribute-co-authored-by`, `includeCoAuthoredBy: false`) silences a repo
  permanently and silently; PR-body-only attribution never enters git at all; and
  Aider's default flipped mid-2025, splitting its own history in half.
- **The attribution signal is self-asserted and forgeable.** It is text in a commit
  message with no integrity guarantee, and the tools' own documentation shows how
  to set it to an arbitrary value. Over 480 public commits carry a Claude trailer
  with an author date before Claude Code existed. Do not use this to audit anyone.
- **It does not control for what kind of code each side writes, and that is
  probably fatal to any cross-class comparison.** Agents and humans are not given
  the same work. On graphiti, 67% of agent lines are in files the same commit
  created, against 26% for humans, and an external audit that standardised on that
  one covariate moved an earlier version of the gap from +10.0 pp to +0.6 pp, with
  humans *ahead* inside the new-file stratum. The report prints both shares and
  warns when they diverge, but it does not stratify. `--json` emits a `commitRows`
  table so you can stratify, cluster or reweight yourself. Treat a cross-class gap
  as a hypothesis, not a result.
- **`-C` penalises commits that move code.** The denominator counts every line a
  commit introduced into a file, including a block it moved in from elsewhere;
  blame with `-C` credits those lines to whoever originally wrote them. So a commit
  that reorganises code scores artificially low, in the conservative direction for
  agents. Fixing it needs block-level copy detection on the counting side, which
  git's `-M` does not do.
- **`.git-blame-ignore-revs` is a gaming surface.** Every revision listed there is
  dropped from authorship entirely, numerator and denominator. The file is
  committed by the repo owner, and nothing checks that it holds only formatting
  commits. Listing an agent's worst commit and a human's best moves the gap
  arbitrarily. The tool reports how many revisions and how many lines the file
  removes, which is a disclosure, not a defence.
- **The agent cohort is usually a handful of commits by a couple of people.** On
  graphiti, five commits are 80% of the agent cohort and two maintainers are 99% of
  it, and those same two supply half the human baseline. That is a within-person
  design presented as a between-group one. No interval is reported; a
  commit-clustered one on its 54 measured commits would likely include zero.
- **Measurable repos are not a random sample.** Leaving attribution on is a
  per-invocation choice made by the person deciding whether the work is worth
  attributing, and the repos with the most agent history are the agent vendors'
  own. Agent commit share across the twenty repos in [RESULTS.md](RESULTS.md) has a
  median of 5% and a range from 0.1% to 89%.
- **Squashed PRs are dropped, not measured, and that can empty a repo.** A
  multi-commit squash carrying agent attribution is reported as `unattributable`.
  On a repo that squash-merges everything, this can leave nothing to measure, and
  the tool will say so rather than produce a number. Detection is heuristic:
  GitHub's squash signature is `(#N)` in the subject plus one `* ` bullet per
  squashed commit, so a repo that rewrites squash messages will slip through and
  be over-credited, and an unusual hand-written message could be dropped
  needlessly.
- **Single-commit squashes are still counted, and are not always safe.** A
  one-commit PR squash carries one author's work, so the trailer applies to the
  whole diff. But GitHub's "Update branch" and rebase-then-squash flows can produce
  a single-commit squash containing merge resolution written by someone else.
- **The two estimators can disagree in sign, and then the repo says nothing.**
  That is not a bug being disclosed; it is the most common outcome on repos with
  few, large agent commits, which is most of them. A repo where they disagree
  supports no conclusion, and the pre-registration commits to reporting it that
  way.
- **Winsorisation is unavoidably a modelling choice.** Clamping a commit's line
  count scales its kept/edited/gone split proportionally, which assumes the
  clamped part behaves like the counted part. It does not have to.
- **Winsorising moves the number.** Clamping per-commit volume at p99 changes
  graphiti's 90-day human baseline from 83.8% to 81.2% on its own. It is the right thing to
  do and it is not free. `--winsor 1` disables it. The cap is one number per repo,
  computed from both classes pooled and applied to every horizon. An earlier
  per-class p99 was a no-op below 100 commits and so only ever clamped the
  baseline, and an earlier per-cohort cap made reported totals go *up* as cohorts
  shrank.
- **Age matching narrows the baseline, sometimes a lot.** Holding both sides to the
  same arrival window cut graphiti's human cohort from 145,041 lines to 15,938.
  That is the correct comparison and a much smaller n, and it does not fully fix
  exposure: graphiti's line-weighted median ages are still 191 and 341 days.
- **Every cohort is scored at HEAD, not at the horizon.** "At 90 days" means "had
  at least 90 days to change", so a line that arrived 91 days ago and one that
  arrived 800 days ago are both in the 90-day cohort with nine times the difference
  in exposure. A proper survival analysis would censor at the horizon; this does
  not.
- **A repo whose default branch was force-pushed or filter-branched has no
  trustworthy clock**, and nothing in a clone can detect that.
- **Direct pushes to the default branch are dated by when the author committed
  locally, not when they pushed.** On the validation repo that is 0.31% of commits,
  worst case about 23 hours. Only GitHub's activity API closes it, and this tool
  does not call it.
- **Partial and shallow clones are refused**, not degraded. On a `blob:none` clone
  a single `git log --numstat` over 5,460 commits took 77 seconds because every
  diff is a network round trip.
- **Performance is bounded by lines at HEAD, not commits.** graphiti (951 commits,
  147k lines) takes 4.8 seconds. `openai/codex` (9,638 commits, 1.77M lines across
  6,451 files) takes 228 seconds, of which 157 is blame. That is git-bound, not
  fixable in this tool.
- **This is one repo at a time.** Across repos the unit of analysis must be the
  repo, median and IQR, never a pooled line-weighted average, or one bot-heavy
  repo decides the answer. See [PREREGISTRATION.md](PREREGISTRATION.md).
