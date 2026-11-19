'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const folder = require('../folder-backup.js');
const backup = require('../backup.js');
const { memoryDirectory } = require('./folder-fixture.js');

function data() {
  return { host: { name: '天道🌿' }, skills: [], hiddenSkills: [], focus: '', quests: { side: [] }, points: {},
    achievements: [], hiddenAchievements: [], ui: {}, viewDate: '2026-11-19', entryCategory: '', noticeSeenCount: 0,
    dataRevision: '1', firstRun: false, entries: [], notes: [{ id: 'n', date: '2026-11-19', text: '第一行\n第二行' }],
    noteCompletions: [], trashEntries: [], notifications: [] };
}
function hash(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
async function installBundle(root, bundle) {
  for (const [path, text] of bundle.files) {
    const parts = path.split('/'), file = parts.pop();
    let directory = root;
    for (const name of parts) { directory = await directory.getDirectoryHandle(name, { create: true }); }
    (await directory.getFileHandle(file, { create: true })).contents = text;
  }
}
function withCrypto(crypto) {
  const context = { crypto, TextEncoder, TianDaoBackup: backup };
  vm.runInNewContext(fs.readFileSync(require.resolve('../folder-backup.js'), 'utf8'), context);
  return context.TianDaoFolder;
}

test('async packages hash the exact UTF-8 document text for both active and historical manifests', async () => {
  const bundle = await folder.packageHashedFiles(data(), 'one');
  assert.deepEqual(JSON.parse(bundle.files.get(folder.manifestName)), bundle.manifest);
  assert.equal(bundle.files.get('版本/one/版本清单.json'), bundle.files.get(folder.manifestName));
  for (const item of bundle.manifest.documents) {
    assert.equal(item.sha256, hash(bundle.files.get(item.path)));
  }
  assert.ok(folder.packageFiles(data(), 'one').files instanceof Map, 'keep the original synchronous packaging API');
});

test('identical legacy backup upgrades just its manifests once, then writes nothing', async () => {
  const root = memoryDirectory(), state = data();
  const legacy = folder.packageFiles(state, 'legacy');
  await installBundle(root, legacy);
  const before = await folder.readDirectory(root);
  const upgraded = await folder.writeDirectory(root, state, 'upgrade', before);
  assert.equal(root.control.writes, 3);
  assert.equal(upgraded.changed, 0);
  assert.equal(upgraded.reused, before.records.length);
  assert.equal(upgraded.files.get('版本/upgrade/上一版本清单.json'), before.raw);
  for (const [index, item] of upgraded.manifest.documents.entries()) {
    assert.equal(item.path, before.records[index].path);
    assert.equal(item.sha256, hash(before.records[index].raw));
  }
  assert.ok((await folder.writeDirectory(root, state, 'next', await folder.readDirectory(root))).unchanged);
  assert.equal(root.control.writes, 3);
});

test('reviewed disk edits correct a stale or forged digest without copying the reviewed document', async () => {
  const root = memoryDirectory(), state = data();
  await folder.writeDirectory(root, state, 'old');
  const active = await root.getFileHandle(folder.manifestName);
  const manifest = JSON.parse(active.contents);
  const descriptor = manifest.documents.find(item => item.type === 'profile');
  const stale = descriptor.sha256;
  descriptor.verifiedSha256 = stale;
  active.contents = JSON.stringify(manifest, null, 2);
  const file = root.children.get('版本').children.get('old').children.get('属性.json');
  state.host.name = '外部编辑';
  file.contents = file.contents.replace('天道🌿', state.host.name);
  const reviewed = await folder.readDirectory(root);
  const written = await folder.writeDirectory(root, state, 'corrected', reviewed);
  const corrected = written.manifest.documents.find(item => item.type === 'profile');
  assert.equal(written.changed, 0);
  assert.equal(corrected.path, descriptor.path);
  assert.equal(corrected.sha256, hash(file.contents));
  assert.notEqual(corrected.sha256, stale);
});

test('only changed text needs hashing when verified digests accompany the reviewed records', async () => {
  const root = memoryDirectory(), state = data();
  await folder.writeDirectory(root, state, 'old');
  const snapshot = await folder.readDirectory(root);
  for (const record of snapshot.records) { record.verifiedSha256 = hash(record.raw); }
  let calls = 0;
  const counted = withCrypto({ subtle: { digest: (...args) => { calls++; return globalThis.crypto.subtle.digest(...args); } } });
  assert.ok((await counted.packageHashedFiles(state, 'same', snapshot)).unchanged);
  assert.equal(calls, 0);
  state.host.name += '!';
  const changed = await counted.packageHashedFiles(state, 'new', snapshot);
  assert.equal(changed.changed, 1);
  assert.equal(calls, 1);
  assert.equal(changed.manifest.documents[0].sha256, hash(changed.files.get(changed.manifest.documents[0].path)));
});

test('without WebCrypto the existing directory format keeps working without a migration', async () => {
  const legacy = withCrypto(undefined), root = memoryDirectory(), state = data();
  assert.equal(await legacy.sha256Text('test'), null);
  await legacy.writeDirectory(root, state, 'old');
  const before = await legacy.readDirectory(root);
  assert.ok(before.manifest.documents.every(item => !Object.hasOwn(item, 'sha256')));
  const writes = root.control.writes;
  assert.ok((await legacy.writeDirectory(root, state, 'same', before)).unchanged);
  assert.equal(root.control.writes, writes);
});

test('a rejecting SHA-256 provider falls back to comparing and writing the document text', async () => {
  const root = memoryDirectory(), state = data();
  await folder.writeDirectory(root, state, 'hashed');
  const failing = withCrypto({ subtle: { async digest() { throw new Error('Digest unavailable'); } } });
  const snapshot = await failing.readDirectory(root, null, null, state);
  assert.equal(snapshot.hashMatches, 0);
  assert.ok(snapshot.records.every(record => !record.error && !record.verifiedSha256));
  const writes = root.control.writes;
  assert.ok((await failing.writeDirectory(root, state, 'same', snapshot)).unchanged);
  assert.equal(root.control.writes, writes);
  state.host.name = '修改后';
  const updated = await failing.writeDirectory(root, state, 'changed', snapshot);
  assert.equal(updated.changed, 1);
  assert.ok(updated.manifest.documents.every(item => !Object.hasOwn(item, 'sha256')));
  const reopened = await folder.readDirectory(root);
  assert.equal(reopened.records[0].document.data.host.name, state.host.name);
});

test('a staged document deleted or edited during the final write leaves the old manifest active', async () => {
  for (const change of ['removed', 'edited']) {
    const root = memoryDirectory(), state = data();
    await folder.writeDirectory(root, state, 'old');
    const before = await folder.readDirectory(root);
    state.host.name = '修改后';
    root.control.onWrite = file => {
      if (file.name !== folder.manifestName) { return; }
      const files = root.children.get('版本').children.get('next').children;
      if (change === 'removed') { files.delete('属性.json'); }
      else { files.get('属性.json').contents += ' '; }
    };
    await assert.rejects(folder.writeDirectory(root, state, 'next', before), { name: 'FolderSnapshotChangedError' });
    assert.equal(root.children.get(folder.manifestName).contents, before.raw);
    assert.equal((await folder.readDirectory(root)).records[0].document.data.host.name, '天道🌿');
  }
});

test('a missing or replaced active manifest during final writing triggers a new review', async () => {
  for (const change of ['missing', 'replaced']) {
    const root = memoryDirectory(), state = data();
    await folder.writeDirectory(root, state, 'old');
    const before = await folder.readDirectory(root);
    state.host.name += '!';
    root.control.onWrite = async file => {
      if (file.name !== folder.manifestName) { return; }
      root.children.delete(file.name);
      if (change === 'replaced') { (await root.getFileHandle(file.name, { create: true })).contents = before.raw; }
    };
    await assert.rejects(folder.writeDirectory(root, state, 'changed', before), { name: 'FolderSnapshotChangedError' });
    assert.equal(root.children.get(folder.manifestName)?.contents, change === 'replaced' ? before.raw : undefined);
  }
});

test('preparing writes uses no filesystem access, fixes the reviewed content, and checks the disk on commit', async () => {
  const root = memoryDirectory(), state = data();
  await folder.writeDirectory(root, state, 'existing');
  const before = await folder.readDirectory(root);
  const reads = root.control.reads, writes = root.control.writes;
  const referencedDate = before.records.find(item => item.type === 'day').path;
  const tracked = new Proxy(root, { get(target, key) {
    assert.fail('preparation accessed the filesystem: ' + String(key));
  } });
  state.host.name = '预览时的名字';
  const summary = await folder.prepareDirectoryWrite(tracked, state, 'existing', before);
  assert.deepEqual([summary.changed, summary.reused, summary.unchanged], [1, 3, false]);
  const prepared = await folder.prepareDirectoryWrite(root, state, 'existing', before);
  assert.equal(root.control.reads, reads);
  assert.equal(root.control.writes, writes);
  await assert.rejects(prepared.commit(() => false), { name: 'AbortError' });
  assert.equal(root.control.reads, reads);
  assert.equal(root.control.writes, writes);

  state.host.name = '准备之后的名字';
  state.notes[0].text = '准备后才改的备注';
  const written = await prepared.commit();
  assert.equal(written.manifest.documents[0].path, '版本/existing-1/属性.json');
  assert.equal(written.manifest.documents.find(item => item.type === 'day').path, referencedDate);
  const saved = await folder.readDirectory(root);
  assert.equal(saved.records[0].document.data.host.name, '预览时的名字');
  assert.equal(saved.records.find(item => item.type === 'day').document.data.notes[0].text, data().notes[0].text);

  const next = await folder.prepareDirectoryWrite(root, state, 'next', saved);
  const profile = root.children.get('版本').children.get('existing-1').children.get('属性.json');
  profile.contents += ' ';
  await assert.rejects(next.commit(), { name: 'FolderSnapshotChangedError' });
  assert.equal(root.children.get(folder.manifestName).contents, saved.raw);
});
