import test from 'node:test';
import assert from 'node:assert/strict';
import { photoOrderKey, readPhotoOrder, writePhotoOrder, clearPhotoOrder } from '../src/photo-order.js';

test('photo order recovery is scoped to the backend, inspector, skid, revision, and run', () => {
  const args = ['https://example.supabase.co', 'inspector', 'skid', 4, 'run'];
  const key = photoOrderKey(...args);
  assert.ok(key);
  for (let index = 0; index < args.length; index++) {
    const other = [...args]; other[index] = index === 3 ? 5 : index === 0 ? 'https://other.supabase.co' : 'other';
    assert.notEqual(photoOrderKey(...other), key);
  }
  assert.equal(photoOrderKey('invalid', 'user', 'skid', 4, 'run'), null);
  assert.notEqual(photoOrderKey(...args.slice(0, 4), 'inspection:record'), photoOrderKey(...args.slice(0, 4), 'test-run:record'));
});

test('photo order drafts retain only a complete unique permutation and leave invalid cache data untouched', () => {
  const previous = globalThis.localStorage;
  const stored = new Map();
  globalThis.localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  try {
    const order = { v: 1, expectedIds: ['a', 'b', 'c'], orderedIds: ['c', 'a', 'b'] };
    assert.equal(writePhotoOrder('key', order), '');
    assert.deepEqual(readPhotoOrder('key'), { order, error: '' });
    for (const orderedIds of [['a', 'a', 'c'], ['a', 'b'], ['a', 'b', 'foreign']]) {
      const raw = JSON.stringify({ ...order, orderedIds }); stored.set('invalid', raw);
      assert.match(readPhotoOrder('invalid').error, /could not be read/);
      assert.equal(stored.get('invalid'), raw);
    }
    assert.equal(clearPhotoOrder('key'), '');
    assert.deepEqual(readPhotoOrder('key'), { order: null, error: '' });
    globalThis.localStorage.setItem = () => { throw new Error('Quota'); };
    assert.match(writePhotoOrder('key', order), /could not be cached locally/);
    assert.equal(writePhotoOrder(null, order).includes('could not be cached'), true);
  } finally {
    if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous;
  }
});
