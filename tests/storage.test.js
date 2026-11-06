'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../storage.js');

test('UI snapshots restore only against the matching data revision', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const store = create(() => storage, 'test');
  const snapshot = { version: 1, dataRevision: 'first', ui: { entryDraft: { activity: 'draft' } } };
  store.writeUi(snapshot);
  assert.deepEqual(store.readUi('first'), snapshot);
  assert.equal(store.readUi('after-reset-or-import'), null);
  values.set('test.ui', '{broken');
  assert.deepEqual(store.readUi('first'), snapshot, 'recover a damaged UI snapshot from its matching copy');
});

test('a failed UI backup keeps the primary draft and never touches business storage', () => {
  const values = new Map([['test', 'business']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => {
    if (key.endsWith('.backup')) { throw new Error('quota'); }
    values.set(key, value);
  } };
  const store = create(() => storage, 'test');
  assert.equal(store.writeUi({ version: 1, dataRevision: 'v1', ui: {} }), false);
  assert.ok(store.readUi('v1'));
  assert.equal(values.get('test'), 'business');
});
