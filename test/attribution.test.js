import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/attribution.js';

const HUMAN = 'Ada Lovelace <ada@corp.dev>';
const agent = (msg, author = HUMAN) => classify(msg, author);

test('trailers real tools write are agent', () => {
  // Every string here was observed in a public commit, not invented.
  const cases = [
    'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
    'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>',
    'Co-authored-by: goose <noreply@anthropic.com>',
    'Co-authored-by: Codex <noreply@openai.com>',
    'Co-authored-by: Codex <199175422+chatgpt-codex-connector[bot]@users.noreply.github.com>',
    'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
    'Co-authored-by: Cursor <cursoragent@cursor.com>',
    'Co-authored-by: openhands <openhands@all-hands.dev>',
    'Co-authored-by: aider (gpt-5.4) <aider@aider.chat>',
    'Co-Authored-By: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>',
    'Co-authored-by: google-labs-jules[bot] <161369871+google-labs-jules[bot]@users.noreply.github.com>',
    'Co-authored-by: Droid <droid@factory.ai>',
    'Co-Authored-By: Kiro <noreply@kiro.dev>',
    'Co-Authored-By: opencode <noreply@opencode.ai>',
    'Co-Authored-By: Tabnine CLI <noreply@tabnine.com>',
    'Co-Authored-By: Crush <crush@charm.land>',
    'Co-Authored-By: Continue <noreply@continue.dev>',
    'Co-authored-by: Amp <amp@ampcode.com>',
    'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
    'Co-authored-by: TRAE CLI <traecli@bytedance.com>',
    'Co-authored-by: Windsurf Cascade <cascade@windsurf.ai>',
  ];
  for (const trailer of cases) {
    assert.equal(agent(`fix: a thing\n\n${trailer}\n`), 'agent', trailer);
  }
});

test('markers that are not Co-authored-by', () => {
  assert.equal(agent('checkpoint\n\nReplit-Commit-Author: Agent\n'), 'agent');
  assert.equal(agent('Assistant checkpoint: x\n\nReplit-Commit-Author: Assistant\n'), 'agent');
  assert.equal(agent('work\n\nClaude-Session: https://claude.ai/code/session_01F5QQ\n'), 'agent');
  assert.equal(agent('work\n\nAmp-Thread-ID: https://ampcode.com/threads/T-1\n'), 'agent');
  // The kernel's convention: Assisted-by: AGENT:MODEL
  assert.equal(agent('pwm: fix a thing\n\nAssisted-by: Codex:gpt-5.6-sol\n'), 'agent');
});

test('agents that commit as themselves need no trailer', () => {
  const authors = [
    'Paul Gauthier (aider) <paul@aider.chat>',
    'Cursor Agent <cursoragent@cursor.com>',
    'Replit Agent <agent@replit.com>',
    'Replit AI Agent <no-reply@replit.com>',
    'Cascade <cascade@windsurf.ai>',
    'Google Labs Jules <jules@google.com>',
    'devin-ai-integration <devin@cognition.ai>',
    'copilot-swe-agent <copilot@github.com>',
    'CharlieHelps <charlie@charlielabs.ai>',
    'openhands <openhands@all-hands.dev>',
    'v0 <noreply@v0.dev>',
    'Lovable <noreply@lovable.dev>',
    'Bolt <noreply@bolt.new>',
    'copilot-swe-agent[bot] <198982749+copilot-swe-agent[bot]@users.noreply.github.com>',
  ];
  for (const a of authors) {
    assert.equal(classify('plain subject, no trailers', a), 'agent', a);
  }
});

test('the subject line is never evidence', () => {
  // These are real subjects from repos named after the tools. Matching a keyword
  // anywhere in the message flags half of openai/codex.
  const subjects = [
    'OpenHands: Default onboarding LLM to OpenAI GPT-5.5 (#1103)',
    '[codex] Render streaming assistant deltas (#753)',
    'fix(frontend): Handle assistant messages at the top (#8766)',
    'Expand ANTHROPIC_MODELS list with recent Claude model names',
    'drop the claude-specific codex workaround for the gpt assistant',
    'pwm: rzg2l-gpt: Drop unused rzg2l_gpt_chip parameter',
    'doc: cmd: gpt: Reinstate gpt setenv',
  ];
  for (const s of subjects) assert.equal(agent(s), 'human', s);
});

test('humans who happen to be called Claude are human', () => {
  // A real 2019 commit, five years before Claude Code existed.
  assert.equal(
    agent('feat: a thing\n\nCo-Authored-By: Claude Dioudonnat <claude@dioudonnat.fr>\n'),
    'human',
  );
  assert.equal(classify('fix a bug', 'Claude Paroz <claude@2xlibre.net>'), 'human');
});

test('Assisted-by crediting a human is not an agent', () => {
  // curl has used this trailer for humans since 2020, across 13,304 commits.
  const msg = 'CODE_REVIEW.md: how to do code reviews\n\n'
    + 'Assisted-by: Daniel Gustafsson\nAssisted-by: Rich Salz\n';
  assert.equal(agent(msg), 'human');
});

test('CI bots are neither agent nor human', () => {
  const bots = [
    'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
    'renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>',
    'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>',
    'web-flow <noreply@github.com>',
  ];
  for (const b of bots) assert.equal(classify('chore: bump', b), 'excluded', b);
});

test('placeholder identities are excluded', () => {
  assert.equal(agent('x\n\nCo-authored-by: Debug Agent <debug@example.com>\n'), 'human');
  assert.equal(classify('x', 'Test <test@opencode.test>'), 'excluded');
});

test('a trailer not in the last paragraph still counts', () => {
  // git's own trailer parser only reads the final paragraph, so three of six real
  // message shapes are invisible to it. This matcher is line-anchored instead.
  const msg = 'fix: thing\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n\n'
    + 'Some trailing prose that git treats as the last paragraph.\n';
  assert.equal(agent(msg), 'agent');
  const glued = 'fix: thing\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n';
  assert.equal(agent(glued), 'agent');
  const bulleted = 'feat: squashed (#12)\n\n* one\n* two\n\n---------\n'
    + 'Co-authored-by: Codex <noreply@openai.com>\n';
  assert.equal(agent(bulleted), 'agent');
});

test('a vendor employee is not an agent', () => {
  // A whole-domain rule counted every hand-written commit by anyone at these
  // companies as agent work, which is the error this tool exists to correct.
  for (const who of [
    'Jane Doe <jane@openai.com>',
    'Boris <boris@anthropic.com>',
    'Michael <michael@cursor.com>',
    'Paul <paul@aider.chat>',
    'Christian <christian@charm.land>',
    'Amjad <amjad@replit.com>',
  ]) {
    assert.equal(classify('fix: adjust the retry backoff', who), 'human', who);
  }
});

test('a tool-shaped address at a vendor domain is an agent', () => {
  for (const addr of [
    'noreply@anthropic.com', 'noreply@openai.com', 'cursoragent@cursor.com',
    'cascade@windsurf.ai', 'agent@replit.com', 'openhands@all-hands.dev',
  ]) {
    assert.equal(classify(`feat: x\n\nCo-authored-by: Tool <${addr}>`, 'A <a@corp.dev>'),
      'agent', addr);
  }
});

test('a tool name that is also a given name does not match', () => {
  // The local-part rule is what keeps vendor employees out of the agent bucket,
  // so any token in it that is also a first name puts them back.
  for (const addr of [
    'claude@anthropic.com', 'claude.dubois@anthropic.com', 'charlie@openai.com',
    'jules@openai.com', 'ai@openai.com',
  ]) {
    assert.equal(classify('fix: adjust the retry backoff', `Someone <${addr}>`), 'human', addr);
  }
  // Jules at google.com is a full-address rule, not a local-part one.
  assert.equal(
    classify('feat: x\n\nCo-authored-by: Jules <jules@google.com>', 'A <a@corp.dev>'), 'agent');
});
