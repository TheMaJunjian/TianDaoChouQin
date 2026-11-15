'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const folder = require('../folder-backup.js');
const backup = require('../backup.js');
const { memoryDirectory } = require('./folder-fixture.js');
function state(overrides = {}) {
  return Object.assign({ host: { name: '宿主' }, skills: [{ id: 'read', name: '阅读', hours: 20 }], hiddenSkills: [], focus: '阅读',
    quests: { side: [], mainCompleted: 0 }, points: { attribute: 2, achievement: 3, contribution: 4 }, achievements: [], hiddenAchievements: [],
    ui: { activeTab: 'entry' }, viewDate: '2026-11-15', entryCategory: '', noticeSeenCount: 0, dataRevision: 'rev', firstRun: false,
    entries: [], notes: [], noteCompletions: [], trashEntries: [], notifications: [] }, overrides);
}
function defaults() { return state({ host: { name: '未绑定' }, skills: [], points: { attribute: 0, achievement: 0, contribution: 0 }, focus: '' }); }
function sample() {
  return state({ entries: [{ id: 'cross', date: '2026-11-12', startDate: '2026-11-12', endDate: '2026-11-13', start: 1380, end: 60, category: '阅读', activity: '跨日阅读' }],
    notes: [{ id: 'note', date: '2026-11-12', createdAt: '2026-11-12T12:00:00Z', text: '练习' }],
    noteCompletions: [{ id: 'note', skillId: 'read', skillName: '阅读', hours: 2, completedAt: '2026-11-14T12:00:00' },
      { id: 'loss', skillId: 'read', skillName: '阅读', hours: -1, completedAt: '2026-11-15T12:00:00' }],
    notifications: [{ id: 'notice', ts: new Date('2026-11-15T12:00:00').getTime(), text: '完成' }] });
}
test('folder documents round-trip all state and keep note completion with its original date', () => {
  const input = sample();
  const docs = folder.createDocuments(input);
  assert.deepEqual(docs.map(folder.documentPath), ['属性.json', '任务与成就.json', '界面设置.json', '日期/2026-11-12.json', '日期/2026-11-15.json']);
  const restored = folder.assemble(docs.map(doc => folder.parseDocument(JSON.stringify(doc))), defaults());
  assert.deepEqual(restored, input);
  const day = docs.find(doc => doc.date === '2026-11-12');
  assert.equal(day.data.entries[0].endDate, '2026-11-13');
  assert.equal(day.data.noteCompletions[0].id, day.data.notes[0].id);
});
test('partial dates retain current profile and rewards and remap skill references without adding baseline hours', () => {
  const docs = folder.createDocuments(sample()).filter(doc => doc.date === '2026-11-12');
  const current = state({ host: { name: '现有宿主' }, skills: [{ id: 'local', name: '阅读', hours: 100 }], points: { attribute: 99 } });
  const partial = folder.assemble(docs, defaults(), current);
  assert.deepEqual(partial.host, current.host);
  assert.deepEqual(partial.points, current.points);
  assert.equal(partial.skills[0].hours, 100);
  assert.equal(partial.noteCompletions[0].skillId, 'local');
  assert.equal(partial.noteCompletions.length, 1);
  assert.equal(backup.planMerge(current, partial, {}, defaults()).unresolved, 0);
  assert.equal(folder.assemble(docs, defaults()).skills[0].hours, 0);
});
test('partial date imports keep legacy regression notes with their deductions', () => {
  const input = state({
    notes: [{ id: 'legacy-loss', date: '2026-11-12', createdAt: '2026-11-12T12:00:00Z', text: '旧退步' }],
    noteCompletions: [{ id: 'legacy-loss', skillId: 'read', skillName: '阅读', hours: -2, completedAt: '2026-11-15T12:00:00' }]
  });
  const days = folder.createDocuments(input).filter(doc => doc.type === 'day');
  assert.equal(days.length, 1, 'a partial import must not revive a regression as an unfinished note');
  assert.equal(days[0].date, '2026-11-15', 'regressions are archived by submission date');
  const restored = folder.assemble(days, defaults());
  assert.deepEqual(restored.notes, input.notes);
  assert.deepEqual(restored.noteCompletions, input.noteCompletions);
});
test('folder update commits a new version and retains old version and unrelated files', async () => {
  const root = memoryDirectory();
  const directory = await folder.uniqueDirectory(root, 'backup');
  const unrelated = await directory.getFileHandle('说明.txt', { create: true }); unrelated.contents = 'keep';
  await folder.writeDirectory(directory, sample(), 'one');
  const original = await folder.readDirectory(directory);
  const next = sample(); next.host.name = '新宿主';
  await folder.writeDirectory(directory, next, 'two', original);
  const updated = await folder.readDirectory(directory);
  assert.equal(folder.assemble(updated.records.map(record => record.document), defaults()).host.name, '新宿主');
  assert.equal(unrelated.contents, 'keep');
  assert.equal(await original.readText(original.records[0].path), original.records[0].raw);
  assert.notEqual(original.raw, updated.raw);
  assert.equal((await folder.uniqueDirectory(root, 'backup')).name, 'backup-1');
});
test('disk failures and cancelled updates leave the active manifest and old backup intact', async () => {
  const root = memoryDirectory();
  await folder.writeDirectory(root, sample(), 'old');
  const before = await folder.readDirectory(root);
  root.control.failAt = root.control.writes + 2;
  await assert.rejects(folder.writeDirectory(root, state(), 'failed', before), /disk full/);
  assert.equal((await folder.readDirectory(root)).raw, before.raw);
  root.control.failAt = 0;
  let active = true;
  root.control.onWrite = () => { active = false; };
  await assert.rejects(folder.writeDirectory(root, state(), 'cancelled', before, () => active), { name: 'AbortError' });
  assert.equal((await folder.readDirectory(root)).raw, before.raw);
});
test('external edits before or during update cannot be overwritten by a stale review', async () => {
  for (const during of [false, true]) {
    const root = memoryDirectory();
    await folder.writeDirectory(root, sample(), 'old');
    const before = await folder.readDirectory(root);
    const manifest = await root.getFileHandle(folder.manifestName);
    if (during) { root.control.onWrite = () => { manifest.contents = before.raw + ' '; }; }
    else { manifest.contents += ' '; }
    await assert.rejects(folder.writeDirectory(root, state(), 'new', before), /变化/);
    assert.equal(manifest.contents, before.raw + ' ');
  }
});
test('folder file selection reads only the active version and reports corrupt documents individually', async () => {
  const bundle = folder.packageFiles(sample(), 'one');
  const paths = Array.from(bundle.files, ([path, text]) => ({ webkitRelativePath: 'backup/' + path, text: async () => text }));
  paths.push({ webkitRelativePath: 'backup/版本/old/broken.json', text: async () => 'invalid old version' });
  const loaded = await folder.readFiles(paths);
  assert.equal(loaded.records.length, 5);
  assert.equal(loaded.records.some(record => record.error), false);
  paths.find(file => file.webkitRelativePath.endsWith('属性.json')).text = async () => '{broken';
  const damaged = await folder.readFiles(paths);
  assert.equal(damaged.records.filter(record => record.error).length, 1);
  assert.equal(damaged.records.filter(record => record.document).length, 4);
});
test('cancellation or old document changes during the final manifest write abort the staged commit', async () => {
  for (const cancel of [true, false]) {
    const root = memoryDirectory();
    await folder.writeDirectory(root, sample(), 'old');
    const before = await folder.readDirectory(root);
    const oldVersion = await (await root.getDirectoryHandle('版本')).getDirectoryHandle('old');
    const profile = await oldVersion.getFileHandle('属性.json');
    let active = true;
    root.control.onWrite = file => {
      if (file.name !== folder.manifestName) { return; }
      if (cancel) { active = false; } else { profile.contents += ' '; }
    };
    await assert.rejects(folder.writeDirectory(root, state(), 'new', before, () => active), cancel ? { name: 'AbortError' } : /变化/);
    assert.equal((await folder.readDirectory(root)).raw, before.raw);
  }
});
test('invalid paths, unknown document fields and duplicate documents are rejected', async () => {
  const bundle = folder.packageFiles(sample(), 'one');
  const manifest = JSON.parse(bundle.files.get(folder.manifestName));
  manifest.documents[0].path = '../outside.json';
  bundle.files.set(folder.manifestName, JSON.stringify(manifest));
  await assert.rejects(folder.readFiles(Array.from(bundle.files, ([name, text]) => ({ name, text: async () => text }))), /路径/);
  const doc = folder.createDocuments(sample())[3]; doc.data.points = { attribute: 99 };
  assert.throws(() => folder.parseDocument(JSON.stringify(doc)), /格式/);
  const profile = folder.createDocuments(sample())[0];
  assert.throws(() => folder.assemble([profile, profile], defaults()), /重复/);
});
test('ZIP fallback contains UTF-8 filenames and the exact manifest and documents', async () => {
  const bundle = folder.packageFiles(sample(), 'one');
  const bytes = Buffer.from(await folder.zipFiles(bundle.files, '备份').arrayBuffer());
  let offset = 0; const actual = new Map();
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 6), 0x800);
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    actual.set(name, bytes.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size).toString('utf8'));
    offset += 30 + nameSize + size;
  }
  assert.deepEqual(actual, new Map(Array.from(bundle.files, ([path, text]) => ['备份/' + path, text])));
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), bundle.files.size);
});
test('folder recognition distinguishes roots, parents, siblings and authorized internal paths', async () => {
  const parent = memoryDirectory('保存位置');
  const first = await parent.getDirectoryHandle('任意名称', { create: true });
  await folder.writeDirectory(first, sample(), 'initial');
  assert.equal((await folder.inspectDirectory(first)).kind, 'root');
  const detectedParent = await folder.inspectDirectory(parent);
  assert.deepEqual(detectedParent.candidates.map(item => item.name), ['任意名称']);
  const version = await (await first.getDirectoryHandle('版本')).getDirectoryHandle('initial');
  const dates = await version.getDirectoryHandle('日期');
  assert.equal((await folder.inspectDirectory(dates, [first])).directory, first);
  assert.equal((await folder.inspectDirectory(dates, [], [parent])).directory, first);
  assert.equal((await folder.inspectDirectory(dates)).kind, 'internal');
  assert.equal((await folder.inspectDirectory(version)).kind, 'internal');
  const sibling = await parent.getDirectoryHandle('同级其他目录', { create: true });
  assert.equal((await folder.inspectDirectory(sibling, [first], [parent])).kind, 'parent');
  await folder.writeDirectory(sibling, state(), 'another');
  assert.equal((await folder.inspectDirectory(sibling, [first])).directory, sibling);
  assert.equal((await folder.inspectDirectory(parent)).candidates.length, 2);
  const fromParent = await folder.readFiles(Array.from(folder.packageFiles(sample(), 'one').files, ([path, text]) =>
    ({ webkitRelativePath: '保存位置/任意名称/' + path, text: async () => text })));
  assert.equal(fromParent.name, '任意名称');
  assert.equal(fromParent.records.length, 5);
});
test('incremental updates only write changed documents and retain manifests for complete history', async () => {
  const root = memoryDirectory();
  const data = state({ notes: Array.from({ length: 300 }, (_, i) => ({ id: 'note-' + i, text: '记录',
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10) })) });
  await folder.writeDirectory(root, data, 'initial');
  const before = await folder.readDirectory(root);
  root.control.reads = 0;
  const inspected = await folder.inspectDirectory(root);
  assert.equal(inspected.kind, 'root');
  assert.equal(root.control.reads, 1, 'path validation reads only the manifest, not 303 documents');
  data.notes[42].text = '修改一条';
  const writes = root.control.writes;
  const written = await folder.writeDirectory(root, data, 'changed', before);
  assert.equal(written.changed, 1);
  assert.equal(written.reused, 302);
  assert.equal(root.control.writes - writes, 4, 'one document, two historical manifests and the current manifest');
  const after = await folder.readDirectory(root);
  const reused = after.records.find(record => record.name === '属性.json');
  assert.equal(reused.path, before.records.find(record => record.name === '属性.json').path);
  const version = await (await root.getDirectoryHandle('版本')).getDirectoryHandle('changed');
  assert.equal(await (await (await version.getFileHandle('上一版本清单.json')).getFile()).text(), before.raw);
  assert.equal(await (await (await version.getFileHandle('版本清单.json')).getFile()).text(), after.raw);
  assert.deepEqual(folder.assemble(after.records.map(record => record.document), defaults()), data);
  const unchangedWrites = root.control.writes;
  assert.equal((await folder.writeDirectory(root, data, 'unchanged', after)).unchanged, true);
  assert.equal(root.control.writes, unchangedWrites);
  assert.equal((await root.getDirectoryHandle('版本')).children.size, 2);
});
