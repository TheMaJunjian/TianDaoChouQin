'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const folder = require('../folder-backup.js');
const { memoryDirectory } = require('./folder-fixture.js');

function state(days = 2) {
  return { host: { name: '宿主' }, skills: [], hiddenSkills: [], focus: '', quests: { side: [] }, points: {},
    achievements: [], hiddenAchievements: [], ui: {}, viewDate: '', entryCategory: '', noticeSeenCount: 0,
    dataRevision: 'rev', firstRun: false, entries: [], noteCompletions: [], trashEntries: [], notifications: [],
    notes: Array.from({ length: days }, (_, i) => ({ id: 'n' + i, text: '记录', date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10) })) };
}
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');

async function seed(root, data) {
  const bundle = folder.packageFiles(data, 'one');
  for (const item of bundle.manifest.documents) { item.sha256 = hash(bundle.files.get(item.path)); }
  bundle.files.set(folder.manifestName, JSON.stringify(bundle.manifest));
  for (const [path, text] of bundle.files) {
    let directory = root;
    const parts = path.split('/');
    const name = parts.pop();
    for (const part of parts) { directory = await directory.getDirectoryHandle(part, { create: true }); }
    (await directory.getFileHandle(name, { create: true })).contents = text;
  }
  return bundle;
}

test('hash previews open just the manifest or the few documents that differ from this page', async () => {
  const root = memoryDirectory(), data = state(300);
  const bundle = await seed(root, data);
  const version = root.children.get('版本').children.get('one');
  const dates = version.children.get('日期');
  let lookups = 0, listings = 0;
  for (const directory of [version, dates]) {
    const original = directory.getFileHandle;
    directory.getFileHandle = (...args) => { lookups++; return original(...args); };
    directory.entries = async function* () { listings++; yield* directory.children; };
  }
  const same = await folder.readDirectory(root, null, null, data);
  assert.equal(same.records.length, 303);
  assert.equal(same.hashMatches, 303);
  assert.equal(root.control.reads, 1);
  assert.equal(lookups, 0);
  assert.ok(same.records.every(item => item.raw === bundle.files.get(item.path) && item.verifiedSha256 === hash(item.raw)));
  const oldNote = data.notes[42];
  data.notes = data.notes.filter(note => note !== oldNote);
  data.host.name = '当前宿主';
  root.control.reads = 0;
  const changed = await folder.readDirectory(root, null, null, data);
  assert.equal(changed.hashMatches, 301);
  assert.equal(root.control.reads, 3, 'root manifest, changed profile and folder-only date');
  assert.equal(lookups, 2);
  assert.equal(listings, 0, 'hash hits never trigger a bulk directory scan');
  assert.deepEqual(changed.records.map(item => item.document), same.records.map(item => item.document));
  assert.equal(changed.records[0].verifiedSha256, hash(changed.records[0].raw));
});

test('legacy, unusable or untrusted descriptor fields never replace a disk read or document validation', async () => {
  const root = memoryDirectory(), data = state();
  const { manifest } = await seed(root, data);
  const file = root.children.get(folder.manifestName);
  const [profile, tasks, preferences, firstDay, lastDay] = manifest.documents;
  delete profile.sha256;
  tasks.sha256 = 'malformed';
  preferences.sha256 = '0'.repeat(64);
  firstDay.type = 'profile';
  for (const item of manifest.documents) { item.verifiedSha256 = 'forged'; }
  file.contents = JSON.stringify(manifest);
  const checked = await folder.readDirectory(root, null, null, data);
  assert.equal(root.control.reads, 5);
  assert.match(checked.records.find(item => item.name === firstDay.name).error, /清单不匹配/);
  assert.ok(checked.records.every(item => item.verifiedSha256 !== 'forged'));
  assert.equal(checked.records.find(item => item.name === lastDay.name).verifiedSha256, lastDay.sha256);

  const invalidLocal = { ...data };
  delete invalidLocal.host;
  profile.sha256 = hash(JSON.stringify(folder.createDocuments(invalidLocal)[0], null, 2));
  file.contents = JSON.stringify(manifest);
  const fallback = await folder.readDirectory(root, null, null, invalidLocal);
  assert.deepEqual(fallback.records[0].document.data.host, data.host, 'invalid local candidates fall back to actual valid documents');
});

test('confirming a fully matched preview reuses its computed hashes and verifies every file on disk', async t => {
  const root = memoryDirectory(), data = state(30);
  const { manifest } = await seed(root, data);
  const digest = t.mock.method(globalThis.crypto.subtle, 'digest');
  const checked = await folder.readDirectory(root, null, null, data);
  assert.equal(digest.mock.callCount(), manifest.documents.length);
  root.control.reads = 0;
  assert.ok((await folder.writeDirectory(root, data, 'unchanged', checked)).unchanged);
  assert.equal(digest.mock.callCount(), manifest.documents.length, 'commit does not compute the same digests again');
  assert.equal(root.control.reads, manifest.documents.length + 1, 'all documents and the root manifest are still verified');
});

test('without Web Crypto a hashed backup is read in full', async t => {
  const root = memoryDirectory(), data = state();
  const { manifest } = await seed(root, data);
  t.mock.getter(globalThis, 'crypto', () => undefined);
  const checked = await folder.readDirectory(root, null, null, data);
  assert.equal(root.control.reads, manifest.documents.length + 1);
  assert.equal(checked.hashMatches, 0);
  assert.ok(checked.records.every(record => !record.error && !record.verifiedSha256));
});

test('final verification reopens replaced or missing paths and full reviews use the actual edited bytes', async () => {
  for (const fast of [true, false]) {
    const root = memoryDirectory(), data = state();
    await seed(root, data);
    const version = root.children.get('版本').children.get('one');
    const name = '属性.json', before = version.children.get(name).contents;
    const preview = await folder.readDirectory(root, null, null, fast ? data : undefined);
    version.children.delete(name);
    await assert.rejects(folder.verifySnapshot(preview), { name: 'FolderSnapshotChangedError' });
    const replacement = await version.getFileHandle(name, { create: true });
    replacement.contents = before.replace('宿主', '主人');
    await assert.rejects(folder.writeDirectory(root, data, 'unchanged', preview), { name: 'FolderSnapshotChangedError' });
    assert.equal(root.control.writes, 0);
    assert.equal((await folder.readDirectory(root)).records[0].document.data.host.name, '主人');
    replacement.contents = before;
    const manifestText = root.children.get(folder.manifestName).contents;
    root.children.delete(folder.manifestName);
    await assert.rejects(folder.verifySnapshot(preview), { name: 'FolderSnapshotChangedError' });
    (await root.getFileHandle(folder.manifestName, { create: true })).contents = manifestText + ' ';
    await assert.rejects(folder.verifySnapshot(preview), { name: 'FolderSnapshotChangedError' });
  }
});
