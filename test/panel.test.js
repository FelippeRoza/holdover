import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winsorise, sharedCap } from '../src/measure.js';

// panel/run.js is a script, so the pieces worth testing are the ones it shares
// with the tool. These are the invariants the published table rests on.

test('the shared cap is one number for both classes', () => {
  const agent = Array.from({ length: 5 }, (_, i) => ({ added: (i + 1) * 10 }));
  const human = Array.from({ length: 200 }, (_, i) => ({ added: i + 1 }));
  const cap = sharedCap([...agent, ...human], 0.99);
  assert.equal(cap, sharedCap([...human, ...agent], 0.99), 'order must not matter');
  assert.ok(cap > 1);
});

test('winsorising is idempotent, so applying the cap twice is safe', () => {
  const rows = [{ added: 900, kept: 500, edited: 200, gone: 200, reattributed: 0 }];
  const once = winsorise(rows, 100).rows;
  const twice = winsorise(once, 100).rows;
  assert.deepEqual(twice, once);
});
