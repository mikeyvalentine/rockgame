// node tools/loader-test.mjs
import assert from 'node:assert/strict';
import { createLoadQueue } from '../src/loader/loadQueue.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };

await test('runs tasks in order and collects results by id', async () => {
  const order = [];
  const queue = createLoadQueue([
    { id: 'a', run: () => { order.push('a'); return 1; } },
    { id: 'b', run: () => { order.push('b'); return 2; } },
  ]);
  const results = await queue.run();
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(results.a, 1);
  assert.equal(results.b, 2);
});

await test('a later task can read an earlier task’s result', async () => {
  const queue = createLoadQueue([
    { id: 'first', run: () => 'hello' },
    { id: 'second', run: (_report, results) => `${results.first} world` },
  ]);
  const results = await queue.run();
  assert.equal(results.second, 'hello world');
});

await test('progress is monotonic and ends at exactly 1', async () => {
  const seen = [];
  const queue = createLoadQueue([
    { id: 'light', weight: 1, run: (report) => { report(0.5); } },
    { id: 'heavy', weight: 9, run: (report) => { report(0.25); report(0.75); } },
  ], { onProgress: ({ progress }) => seen.push(progress) });

  await queue.run();

  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1] - 1e-9, `progress went backwards: ${seen[i - 1]} -> ${seen[i]}`);
  }
  assert.equal(seen.at(-1), 1);
});

await test('weights decide how much of the bar each task owns', async () => {
  let afterFirst = null;
  const queue = createLoadQueue([
    { id: 'light', weight: 1, run: () => {} },
    { id: 'heavy', weight: 9, run: () => { /* progress is read before this finishes */ } },
  ], {
    onProgress: ({ progress, id }) => { if (id === 'heavy' && afterFirst == null) afterFirst = progress; },
  });
  await queue.run();
  assert.ok(Math.abs(afterFirst - 0.1) < 1e-9, `expected 0.1 after the light task, got ${afterFirst}`);
});

await test('a failing task is recorded but does not stall the queue', async () => {
  const queue = createLoadQueue([
    { id: 'bad', run: () => { throw new Error('nope'); } },
    { id: 'good', run: () => 'ran anyway' },
  ]);
  const results = await queue.run();
  assert.equal(results.good, 'ran anyway');
  assert.equal(results.errors.length, 1);
  assert.equal(results.errors[0].taskId, 'bad');
  assert.equal(queue.progress, 1, 'a failure must still complete the bar');
});

await test('minMs holds the splash open on a warm cache', async () => {
  const started = Date.now();
  await createLoadQueue([{ id: 'instant', run: () => {} }], { minMs: 120 }).run();
  assert.ok(Date.now() - started >= 110, 'returned too early');
});

await test('out-of-range sub-progress is clamped', async () => {
  const seen = [];
  await createLoadQueue(
    [{ id: 'a', run: (report) => { report(5); report(-2); report(NaN); } }],
    { onProgress: ({ progress }) => seen.push(progress) },
  ).run();
  assert.ok(seen.every((p) => p >= 0 && p <= 1), `out of range: ${seen}`);
});

console.log(`loader: ${passed} passed`);
