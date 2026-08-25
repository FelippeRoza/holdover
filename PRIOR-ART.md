# Prior art

The other tools that measure line survival, what each does differently, and where
the widely quoted figures come from.

| | retroactive? | repos you don't own? | needs installing first? | human baseline? | three states? | excludes mixed squashes? | ground-truth attribution? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **holdover** | yes | yes | no | yes | yes | yes | **no** |
| [`git-ai`](https://github.com/git-ai-project/git-ai) | no | no | yes, agents must checkpoint as they write | no | yes | n/a | **yes** |
| `survival.py` in [`Everyone-Needs-A-Copilot/claude-copilot`](https://github.com/Everyone-Needs-A-Copilot/claude-copilot) | yes | yes | no | no | no | no | no |
| [`keeprate`](https://www.npmjs.com/package/keeprate) | no | no | yes, needs Claude Code session logs | no | no | n/a | yes |
| [`stillthere`](https://www.npmjs.com/package/stillthere) | yes | yes | no | yes | no | no | no |
| [`git-of-theseus`](https://github.com/erikbern/git-of-theseus) | yes | yes | no | n/a | no | n/a | n/a |

The squash column is the one that matters most and it is the newest. Every tool here
that reads agent authorship out of trailers, except this one, credits an agent with
the whole of a squashed pull request whenever any commit in it carried one. On the
repo used to build this tool that was 87% of the apparent agent lines, and
correcting it reversed the sign of the result.

The last column is the one this tool loses. `git-ai` and `keeprate` read what the
agent itself recorded; everything here rests on a trailer any user can switch off
or forge, with measured recall between 0% and 92% depending on which tool a repo
uses. That is a worse foundation than ground truth, and it is the price of working
on a repo you merely cloned.

`git-ai` says in its own README that it does not use "AI or heuristics to 'detect'
AI code", because the agents report which lines they wrote. That gives it
ground-truth attribution, and means it can never measure history that predates its
install. Its own hooks do sync the notes on push and fetch, so a repo you cloned is
readable when the notes came with it.

`survival.py` defines survival as `surviving / authored` using
`git blame --line-porcelain` with no `-M`, no `-C` and no `-w`, and counts every
line of a since-deleted file as dead. Its docstring is candid about the
consequence: a moved line reads as a changed line. The figure of 47.4% that
circulates is not a published result. It appears once in that file, in a comment,
describing a run its own author rejected because 596 of 797 files were
framework-installed and replaced wholesale.

`keeprate` matches agent-written lines from Claude Code session logs against the
working tree by normalised string equality, with no time window at all. Its own
reported run has a session age of 18 minutes.

`stillthere` is the closest thing to this tool and reaches the same shape of
conclusion, with a per-agent table and a human column. It runs
`git blame --line-porcelain -w` with no `-M`, no `-C` and no ignore-revs, passes
`--no-renames` to the counting side so that a file move is deliberately scored as a
full rewrite, has no arrival dating and only a crude opt-in `--since` filter rather
than a horizon, credits the whole of a squashed PR
to the agent, and classifies as human every commit its agent patterns did not
match, which puts Windsurf, Replit, Aider's author-rename mode and every
un-attributed agent commit into the baseline it compares against. Its Codex pattern
matches the `openai-codex[bot]` trailer but not the `Co-authored-by: Codex
<noreply@openai.com>` the CLI writes by default.

Its README states that "research across 153M lines found ~40% of AI-written code is
rewritten or deleted within two weeks". GitClear is the source of the 153M-line
figure, from its 2024 report. Its own number on that exact two-week definition is
3.3% for 2020 in that report, and 3.1% for 2020 rising to 5.7% for 2024 in the 2025
report, which covers 211M lines. GitClear also has no per-line AI attribution at
all. It compares time periods.

The academic lineage predates all of this. `git-of-theseus` and `hercules` have
measured line survival by cohort year since long before AI, with no notion of
agent authorship. The line-level survival framing here, including the
Kaplan-Meier setup, is
[Rahman & Shihab, arXiv:2601.16809](https://arxiv.org/abs/2601.16809), which
reports agent-authored lines modified 53.9% of the time against 69.3% for
human-authored, across 201 repositories, a 15.4 pp gap at the line level, and no
significant difference at the file level (77.7% vs 81.9%, p = 0.052). That paper
defines death as *any* modification, which is exactly the choice this tool splits
in two.
