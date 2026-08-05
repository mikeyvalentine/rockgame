// node tools/store-test.mjs
import assert from 'node:assert/strict';
import { createStore } from '../src/lib/store.js';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

test('set merges and returns the new state', () => {
  const store = createStore({ a: 1 });
  const next = store.set({ b: 2 });
  assert.deepEqual(next, { a: 1, b: 2 });
  assert.equal(store.get('a'), 1);
});

test('set accepts a function of the current state', () => {
  const store = createStore({ n: 1 });
  store.set((state) => ({ n: state.n + 1 }));
  assert.equal(store.get('n'), 2);
});

test('subscribers only fire on an actual change', () => {
  const store = createStore({ a: 1 });
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  store.set({ a: 1 });
  assert.equal(calls, 0, 'writing the same value must not notify');
  store.set({ a: 2 });
  assert.equal(calls, 1);
});

test('key-filtered subscribers ignore unrelated keys', () => {
  const store = createStore({ a: 1, b: 1 });
  let calls = 0;
  store.subscribe(['b'], () => { calls += 1; });
  store.set({ a: 9 });
  assert.equal(calls, 0);
  store.set({ b: 9 });
  assert.equal(calls, 1);
});

test('a subscriber sees the new state, and the previous one', () => {
  const store = createStore({ a: 1 });
  let seen = null;
  store.subscribe((state, prev, changed) => { seen = { state, prev, changed }; });
  store.set({ a: 2 });
  assert.equal(seen.state.a, 2);
  assert.equal(seen.prev.a, 1);
  assert.deepEqual(seen.changed, ['a']);
});

test('unsubscribe stops delivery', () => {
  const store = createStore({ a: 1 });
  let calls = 0;
  const off = store.subscribe(() => { calls += 1; });
  store.set({ a: 2 });
  off();
  store.set({ a: 3 });
  assert.equal(calls, 1);
});

test('unsubscribing during a notification does not skip a sibling', () => {
  const store = createStore({ a: 1 });
  const seen = [];
  const off = store.subscribe(() => { seen.push('first'); off(); });
  store.subscribe(() => { seen.push('second'); });
  store.set({ a: 2 });
  assert.deepEqual(seen, ['first', 'second']);
});

console.log(`store: ${passed} passed`);
