#!/usr/bin/env bash
# Build fixture repos that exercise the cases which break this measurement.
# Every commit gets an explicit date so arrival cohorts are deterministic.
set -euo pipefail
ROOT="$1"
rm -rf "$ROOT"; mkdir -p "$ROOT"

AGENT='Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>'

new() { # new <name>
  R="$ROOT/$1"; mkdir -p "$R"; git init -q -b main "$R"
  git -C "$R" config user.name Human; git -C "$R" config user.email dev@corp.dev
  git -C "$R" config commit.gpgsign false
}
# at <repo> <iso-date> <line...>  — each extra argument is its own message line,
# so trailers land on their own line the way a real tool writes them
at() {
  local r="$1" d="$2"; shift 2
  local msg; msg=$(printf '%s\n' "$@")
  # Pinned to UTC so cohort boundaries do not move with the runner's timezone.
  GIT_AUTHOR_DATE="$d +0000" GIT_COMMITTER_DATE="$d +0000" \
    git -C "$r" commit -q -F - <<<"$msg"
}
lines() { local n="$1" p="$2"; : > "$p"; for i in $(seq 1 "$n"); do echo "$p line $i" >> "$p"; done; }

# ---------------------------------------------------------------- renames
new renames
R="$ROOT/renames"
lines 10 "$R/a.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "agent adds a.py" "" "$AGENT"
git -C "$R" mv a.py b.py; at "$R" 2025-02-01T00:00:00 "human renames a.py to b.py"
lines 6 "$R/other.py"; git -C "$R" add -A; at "$R" 2025-02-02T00:00:00 "human adds other.py"

# ------------------------------------------------------- bulk directory move
new bulkmove
R="$ROOT/bulkmove"
mkdir -p "$R/old"; for f in one two three; do lines 20 "$R/old/$f.py"; done
git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "agent adds old/" "" "$AGENT"
mkdir -p "$R/new"; git -C "$R" mv old/one.py old/two.py old/three.py new/
at "$R" 2025-03-01T00:00:00 "human moves old/ to new/"

# ------------------------------------------------------------- edited vs gone
new editedgone
R="$ROOT/editedgone"
lines 10 "$R/keep.py"; lines 10 "$R/edit.py"; lines 10 "$R/delete.py"
git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "agent adds three files" "" "$AGENT"
sed -i '' 's/edit.py line 3/edit.py line 3 REWRITTEN/' "$R/edit.py"   # 1 line edited
sed -i '' '/edit.py line 7/d' "$R/edit.py"                            # 1 line removed
rm "$R/delete.py"                                                     # 10 lines gone
git -C "$R" add -A; at "$R" 2025-02-01T00:00:00 "human edits and deletes"

# ------------------------------------------------------------- squash merge
new squash
R="$ROOT/squash"
lines 4 "$R/base.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "human base"
git -C "$R" checkout -q -b feature
lines 12 "$R/feat.py"; git -C "$R" add -A; at "$R" 2025-01-05T00:00:00 "agent writes feature" "" "$AGENT"
git -C "$R" checkout -q main
git -C "$R" merge -q --squash feature
# GitHub hoists co-author trailers from every commit in the PR into the squash
# commit, so the trailer survives the squash even though the branch commits do not.
at "$R" 2025-04-01T00:00:00 "feat: the whole PR (#1)" "" "$AGENT"

# ------------------------------------------------------------- rebase merge
new rebase
R="$ROOT/rebase"
lines 4 "$R/base.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "human base 1"
git -C "$R" checkout -q -b feature
lines 12 "$R/feat.py"; git -C "$R" add -A; at "$R" 2025-01-05T00:00:00 "agent writes feature" "" "$AGENT"
git -C "$R" checkout -q main
lines 4 "$R/other.py"; git -C "$R" add -A; at "$R" 2025-02-01T00:00:00 "human base 2"
git -C "$R" checkout -q feature
GIT_COMMITTER_DATE="2025-05-01T00:00:00 +0000" git -C "$R" rebase -q main >/dev/null
git -C "$R" checkout -q main; git -C "$R" merge -q --ff-only feature

# ------------------------------------------------------------- merge commit
new mergecommit
R="$ROOT/mergecommit"
lines 4 "$R/base.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "human base"
git -C "$R" checkout -q -b feature
lines 12 "$R/feat.py"; git -C "$R" add -A; at "$R" 2025-01-05T00:00:00 "agent writes feature" "" "$AGENT"
git -C "$R" checkout -q main
GIT_AUTHOR_DATE="2025-06-01T00:00:00 +0000" GIT_COMMITTER_DATE="2025-06-01T00:00:00 +0000" \
  git -C "$R" merge -q --no-ff feature -m "Merge pull request #1 from feature"

# --------------------------------------------------- reformat + ignore-revs
new reformat
R="$ROOT/reformat"
lines 20 "$R/wide.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "agent adds wide.py" "" "$AGENT"
sed -i '' 's/$/  /' "$R/wide.py"   # trailing whitespace on every line
git -C "$R" add -A; at "$R" 2025-02-01T00:00:00 "style: reformat everything"
git -C "$R" rev-parse HEAD > "$R/.git-blame-ignore-revs"
git -C "$R" add -A; at "$R" 2025-02-02T00:00:00 "add blame ignore list"

# ------------------------------------------------------------- no attribution
new notrailers
R="$ROOT/notrailers"
lines 8 "$R/x.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "human writes x.py"

# ---------------------------------------------------- bots and false positives
new noise
R="$ROOT/noise"
lines 10 "$R/real.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "agent adds real.py" "" "$AGENT"
lines 5 "$R/prose.py"; git -C "$R" add -A
at "$R" 2025-01-02T00:00:00 "drop the claude-specific codex workaround for gpt assistant"
lines 400 "$R/package-lock.json"; git -C "$R" add -A
GIT_AUTHOR_NAME='dependabot[bot]' GIT_AUTHOR_EMAIL='49699333+dependabot[bot]@users.noreply.github.com' \
  at "$R" 2025-01-03T00:00:00 "chore(deps): bump everything"
lines 6 "$R/human2.py"; git -C "$R" add -A
at "$R" 2025-01-04T00:00:00 "credit a person" "" "Co-Authored-By: Claude Dioudonnat <claude@dioudonnat.fr>"

# ------------------------------------------- squashed PR of mixed authorship
# The single most consequential case. GitHub credits every commit author in a PR
# as a co-author on the squash commit, so one agent-trailered commit out of many
# puts the agent trailer on a diff that is mostly somebody else's work. Trailer
# attribution claims all 100 lines here when the agent wrote 12.
new mixedsquash
R="$ROOT/mixedsquash"
lines 4 "$R/base.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "human base"
git -C "$R" checkout -q -b feature
lines 12 "$R/agent_part.py"; git -C "$R" add -A
at "$R" 2025-01-05T00:00:00 "agent writes 12 lines" "" "$AGENT"
lines 88 "$R/human_part.py"; git -C "$R" add -A
at "$R" 2025-01-06T00:00:00 "human writes 88 lines by hand"
git -C "$R" checkout -q main
git -C "$R" merge -q --squash feature >/dev/null
at "$R" 2025-04-01T00:00:00 "feat: the whole PR (#1)" "" \
  "* agent writes 12 lines" "" "* human writes 88 lines by hand" "" "---------" "" "$AGENT"

# ------------------------------------- single-commit squash: safe to attribute
new singlesquash
R="$ROOT/singlesquash"
lines 4 "$R/base.py"; git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "human base"
git -C "$R" checkout -q -b feature
lines 12 "$R/feat.py"; git -C "$R" add -A
at "$R" 2025-01-05T00:00:00 "agent writes feature" "" "$AGENT"
git -C "$R" checkout -q main
git -C "$R" merge -q --squash feature >/dev/null
at "$R" 2025-04-01T00:00:00 "agent writes feature (#1)" "" "$AGENT"

# ------------------------------------------- paths and content that break parsers
new awkward
R="$ROOT/awkward"
lines 4 "$R/café.py"                          # non-ASCII: core.quotePath breaks the join
mkdir -p "$R/pkg"; lines 4 "$R/pkg/deep.py"   # so a subdirectory run can be checked
printf 'l1\n-- a/evil.py\n++ b/evil.py\nl4\n' > "$R/doc.md"   # diff-shaped content
git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "agent adds awkward paths" "" "$AGENT"

# --------------------------------- deleted and re-added: present but reattributed
new readded
R="$ROOT/readded"
lines 10 "$R/x.py"; git -C "$R" add -A
at "$R" 2025-01-01T00:00:00 "agent adds x.py" "" "$AGENT"
rm "$R/x.py"; git -C "$R" add -A; at "$R" 2025-02-01T00:00:00 "human deletes x.py"
lines 10 "$R/x.py"; git -C "$R" add -A; at "$R" 2025-03-01T00:00:00 "human restores x.py"

# ------------------------------- whole tree replaced: nothing survives, either side
new replaced
R="$ROOT/replaced"
lines 20 "$R/old.py"; git -C "$R" add -A
at "$R" 2025-01-01T00:00:00 "agent writes the old tree" "" "$AGENT"
lines 10 "$R/alsoold.py"; git -C "$R" add -A; at "$R" 2025-01-02T00:00:00 "human writes more"
rm "$R/old.py" "$R/alsoold.py"; lines 30 "$R/brandnew.py"; git -C "$R" add -A
at "$R" 2025-06-01T00:00:00 "chore: replace the entire tree"

# ------------------------------------------------------------------ binary trap
new binary
R="$ROOT/binary"
lines 10 "$R/code.py"
printf '\x89PNG\r\n\x1a\n' > "$R/demo.png"; head -c 40000 /dev/urandom >> "$R/demo.png"
git -C "$R" add -A; at "$R" 2025-01-01T00:00:00 "agent adds code and a png" "" "$AGENT"

echo "fixtures built in $ROOT"
