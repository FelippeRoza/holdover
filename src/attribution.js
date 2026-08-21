// Who wrote a commit.
//
// Every rule here is a string some tool writes about itself. Nothing is inferred
// from code style, and nothing is inferred from the subject line — the subject is
// where the false positives live. Matching `codex` anywhere in a message flags
// 4,829 of the 9,637 commits in `openai/codex`, because the repo is named codex.
// Anchored to a trailer line, the same word flags 360, all of them real.
//
// Two independent signals, unioned:
//
//   1. a trailer line naming an agent, matched on the EMAIL, never the name
//   2. the agent in the commit's own author field, which is how several tools work
//
// Signal 2 is not optional. Aider's two attribution modes are mutually exclusive
// by design, so across its own 13,138-commit history the trailer and the author
// suffix never co-occur: trailer-only detection sees 67 commits, author-only sees
// 3,661. Cursor, Windsurf, Jules, Devin, Replit, Lovable, v0 and Bolt all commit
// as themselves and write no agent trailer at all.
//
// Matching the name instead of the email does not work either. Sixteen distinct
// names pair with noreply@anthropic.com in a six-repo sample — `Claude`,
// `Claude Sonnet 5`, `Claude Opus 4.8 (1M context)`, and `goose`, which is a
// different tool using Anthropic's model. The email is the stable part.

/**
 * Vendor domains that only ever belong to a coding agent, so any address at the
 * domain counts. Kept separate from EXACT_EMAILS because these are safe to widen.
 */
const AGENT_DOMAINS = [
  'anthropic.com',      // Claude Code, and goose when it runs an Anthropic model
  'openai.com',         // Codex
  'cursor.com',         // Cursor
  'all-hands.dev', 'openhands.dev', // OpenHands (mid-migration between the two)
  'aider.chat', 'aider.dev',        // Aider (renamed domains)
  'opencode.ai',        // opencode
  'cognition.ai', 'devin.ai',       // Devin
  'factory.ai',         // Factory Droid
  'kiro.dev',           // Kiro
  'windsurf.ai',        // Windsurf Cascade
  'tabnine.com',        // Tabnine CLI
  'charm.land',         // Crush
  'continue.dev',       // Continue
  'ampcode.com',        // Amp
  'charlielabs.ai',     // Charlie
  'replit.com',         // Replit Agent
  'bolt.new',           // Bolt
  'lovable.dev',        // Lovable
  'v0.dev',             // v0
];

/**
 * Addresses whose domain is shared with humans, so the local part must match too.
 * google.com and bytedance.com have rather a lot of human employees.
 */
const EXACT_EMAILS = [
  'jules@google.com',
  'gemini-cli@google.com',
  'qwen-coder@alibabacloud.com',
  'traecli@bytedance.com',
];

/**
 * GitHub App identities, matched on the `+slug@users.noreply.github.com` suffix.
 * The numeric prefix is deliberately not matched: Copilot has appeared as both
 * 175728472+Copilot and 223556219+Copilot, and those are two different apps.
 */
const AGENT_GH_SLUGS = [
  'Copilot',
  'copilot-swe-agent[bot]',
  'chatgpt-codex-connector[bot]',
  'google-labs-jules[bot]', 'jules-fleet[bot]',
  'devin-ai-integration[bot]',
  'factory-droid[bot]',
  'opencode-agent[bot]',
  'charliecreates[bot]',
  'gpt-engineer-app[bot]',            // Lovable
  'amazon-q-developer[bot]',
  'qodo-code-review[bot]', 'qodo-merge[bot]',
  'coderabbitai[bot]',
  'gemini-code-assist[bot]',
];

/**
 * Author identities used by agents that commit as themselves. Matched against
 * "Name <email>", so a name-shaped rule and an email-shaped rule both fit here.
 */
const AGENT_AUTHORS = [
  / \(aider\) </i,                  // Aider's pre-v0.85 author rename
  /^Cursor Agent </i,
  /^Replit (AI )?Agent </i,
  /^Cascade </i,                    // Windsurf
  /^Google Labs Jules </i,
  /^devin-ai-integration </i,
  /^copilot-swe-agent </i,
  /^CharlieHelps </i,
  /^openhands </i,
  /^SWE-agent </i,                  // noemail@swe-agent.com
  /^Bolt( Agent)? </i,
  /^Lovable </i, /^lovable </,
  /^v0 </i,
];

/**
 * Machine commits that are not AI authorship. Excluded from BOTH the agent and
 * the human bucket: counting them as human would put thousands of lockfile bumps
 * into the baseline, and counting them as agent would be simply wrong.
 *
 * This is the bias `stillthere` carries by construction — its human bucket is
 * "everything no agent pattern matched", so every CI bot and every agent it
 * fails to recognise inflates the human side of its own comparison.
 */
const NOT_AUTHORSHIP = [
  // Any GitHub App identity that is not on the agent allowlist above. A hand-list
  // cannot keep up: graphiti's `zep-cla-assistant[bot]` was classified human, which
  // is exactly the contamination this tool criticises in others. Agents are matched
  // first, so an allowlisted agent bot never reaches here.
  /^[^<]*\[bot\] </i,
  /^web-flow </i,
  /^(dependabot|renovate|github-actions|pre-commit|allcontributors|imgbot|snyk-bot|mergify|codecov) </i,
];

/**
 * Placeholder identities from test fixtures and templates. The reserved TLDs are
 * matched as suffixes, so `test@opencode.test` counts, not only a bare `@test`.
 */
const PLACEHOLDER =
  /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|test|invalid|localhost|local)>?$/i;

const TRAILER_KEYS = 'co-authored-by|assisted-by';

/** A trailer line, anchored. Captures the address inside the angle brackets. */
const TRAILER_LINE = new RegExp(
  String.raw`^[ \t]*(?:${TRAILER_KEYS})[ \t]*:[^<\n]*<([^>\n]+)>[ \t]*$`,
  'gim',
);

/**
 * Structured markers that are not Co-authored-by at all. Replit alone accounts
 * for millions of commits and would be invisible to a trailer-only rule.
 */
const MARKER_LINES = [
  /^[ \t]*Replit-Commit-Author[ \t]*:[ \t]*(Agent|Assistant)[ \t]*$/im,
  /^[ \t]*Claude-Session[ \t]*:[ \t]*https?:\/\//im,
  /^[ \t]*Amp-Thread-ID[ \t]*:[ \t]*\S/im,
];

/**
 * `Assisted-by:` without an email. The Linux kernel mandates `Assisted-by:
 * AGENT:MODEL`, but curl has used the same trailer to credit humans since 2020
 * across 13,304 commits, so a bare name is not enough — require the AGENT:MODEL
 * shape, which a human credit does not have.
 */
const ASSISTED_BY_MODEL = /^[ \t]*assisted-by[ \t]*:[ \t]*[\w.+-]+:[\w.+-]/im;

function emailIsAgent(email) {
  const addr = email.trim().toLowerCase();
  if (PLACEHOLDER.test(addr)) return false;
  if (EXACT_EMAILS.includes(addr)) return true;
  const at = addr.lastIndexOf('@');
  if (at < 0) return false;
  const domain = addr.slice(at + 1);
  if (AGENT_DOMAINS.includes(domain)) return true;
  if (domain === 'users.noreply.github.com') {
    const local = addr.slice(0, at);
    const plus = local.indexOf('+');
    const slug = (plus < 0 ? local : local.slice(plus + 1));
    return AGENT_GH_SLUGS.some((s) => s.toLowerCase() === slug);
  }
  return false;
}

/**
 * @param {string} message  full commit message, subject and body
 * @param {string} author   "Name <email>"
 * @returns {'agent'|'human'|'excluded'}
 */
export function classify(message, author) {
  const ident = author || '';
  if (PLACEHOLDER.test(ident)) return 'excluded';

  // Agent identities are tested before the bot exclusion, because several agents
  // *are* GitHub Apps and would otherwise be swept up by the generic `[bot]` rule.
  if (AGENT_AUTHORS.some((re) => re.test(ident))) return 'agent';
  const authorEmail = ident.match(/<([^>]+)>/)?.[1];
  if (authorEmail && emailIsAgent(authorEmail)) return 'agent';

  // A bot author is not rescued by a trailer: CI bots routinely carry hoisted
  // co-authors from whatever they were merging.
  if (NOT_AUTHORSHIP.some((re) => re.test(ident))) return 'excluded';

  const text = message || '';
  TRAILER_LINE.lastIndex = 0;
  for (const m of text.matchAll(TRAILER_LINE)) {
    if (emailIsAgent(m[1])) return 'agent';
  }
  if (MARKER_LINES.some((re) => re.test(text))) return 'agent';
  if (ASSISTED_BY_MODEL.test(text)) return 'agent';

  return 'human';
}

/**
 * Does this commit look like a squash of more than one commit?
 *
 * This matters more than any other single thing in this file. GitHub credits
 * *every* commit author in a pull request as a co-author on the squash commit, so
 * one agent-trailered commit in a five-commit PR puts the agent trailer on a diff
 * that is mostly somebody else's work. The line counts are then wrong, not merely
 * coarse: on a fixture where an agent wrote 12 of 100 lines in a PR, trailer
 * attribution claims all 100.
 *
 * On getzep/graphiti, 0 of 129 agent-attributed commits have an agent in the
 * author field and 68 are multi-commit squashes carrying 93% of the agent lines.
 * Treating those as agent-authored is the difference between a headline and a
 * fabrication, so they are reported as `mixed` and left out of both rates.
 *
 * GitHub's squash body is distinctive: the PR number in the subject, one `* `
 * bullet per squashed commit, and a run of dashes before the trailers. Requiring
 * the PR-number subject as well as the bullets keeps an ordinary bulleted
 * changelog from being misread as a squash.
 */
export function isMultiCommitSquash(message) {
  const text = message || '';
  const subject = text.split('\n', 1)[0];
  if (!/\(#\d+\)\s*$/.test(subject)) return false;
  const bullets = (text.match(/^\* \S/gm) || []).length;
  return bullets >= 2 || /^-{5,}\s*$/m.test(text);
}

export const RULES = { AGENT_DOMAINS, EXACT_EMAILS, AGENT_GH_SLUGS };
