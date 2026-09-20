import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toThenable, loadCredentials } from '../../lib/credentials.js';

test('toThenable keeps direct field access', () => {
  const t = toThenable({ token: 'T', n: 1 });
  assert.equal(t.token, 'T');
  assert.equal(t.n, 1);
});

test('toThenable supports .then chaining', async () => {
  const v = await toThenable({ token: 'T' });
  assert.equal(v.token, 'T');
});

test('toThenable supports awaiting directly', async () => {
  const v = await toThenable({ token: 'X' });
  assert.equal(v.token, 'X');
});

test('toThenable supports .catch and .finally', async () => {
  let finallyRan = false;
  const v = await toThenable({ token: 'Y' }).finally(() => { finallyRan = true; });
  assert.equal(v.token, 'Y');
  assert.equal(finallyRan, true);
});

test('loadCredentials stays synchronous and throws classified errors', () => {
  assert.equal(typeof loadCredentials, 'function');
  assert.throws(() => loadCredentials({ appDataDir: 'C:\\nope' }), (e) => Boolean(e.code));
});
