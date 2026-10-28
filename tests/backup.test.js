'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const backup = require('../backup.js');

function state(overrides) {
  return Object.assign({ entries: [], notes: [], noteCompletions: [], trashEntries: [], host: { name: '未绑定', weight: '' }, skills: [], achievements: [],
    points: { attribute: 0, contribution: 0, achievement: 0 }, quests: { side: [] }, notifications: [],
    hiddenSkills: [], hiddenAchievements: [], ui: { activeTab: 'entry' } }, overrides);
}
function entry(id, start, end, activity = id, startDate = '2026-10-24', endDate = startDate) {
  return { id, date: startDate, startDate, endDate, start, end, category: '', activity, level: 'INFO' };
}
function resolved(a, b, choice) {
  const choices = {};
  let plan;
  for (let i = 0; i < 20; i++) {
    plan = backup.planMerge(a, b, choices, state());
    if (!plan.unresolved) { return plan; }
    plan.conflicts.forEach(item => { choices[item.id] = choice; });
  }
  throw new Error('Conflicts did not converge');
}
function noOverlaps(entries) {
  const times = entries.map(e => [Date.parse(e.startDate + 'T00:00:00Z') / 60000 + e.start,
    Date.parse(e.endDate + 'T00:00:00Z') / 60000 + e.end]).sort((a, b) => a[0] - b[0]);
  times.forEach((span, index) => { if (index) { assert.ok(times[index - 1][1] <= span[0]); } });
}

test('disjoint backups preserve both sides, deduplicate repeated imports, and do not mutate inputs', () => {
  const local = state({ entries: [entry('a', 60, 120)], skills: [{ id: 's', name: '阅读', hours: 10 }] });
  const incoming = state({ entries: [entry('b', 120, 180)], notes: [{ id: 'n', date: '2026-10-24', createdAt: '2026-10-24T00:00:00Z', text: '备注' }] });
  const before = JSON.stringify([local, incoming]);
  const plan = backup.planMerge(local, incoming, {}, state());
  assert.equal(plan.unresolved, 0);
  assert.equal(plan.state.entries.length, 2);
  assert.equal(plan.state.notes.length, 1);
  assert.equal(plan.state.skills.length, 1);
  assert.equal(JSON.stringify([local, incoming]), before);
  const repeated = backup.planMerge(plan.state, incoming, {}, state());
  assert.equal(repeated.unresolved, 0);
  assert.deepEqual(repeated.state, plan.state);
});

test('semantic duplicate entries and notes with different IDs do not accumulate', () => {
  const a = state({ entries: [entry('a', 1, 2, 'same')], notes: [{ id: 'n1', text: 'same', date: '2026-10-24', createdAt: '2026-10-24T00:00:00Z' }] });
  const b = state({ entries: [Object.assign(entry('b', 1, 2, 'same'), { createdAt: 'later' })], notes: [{ id: 'n2', createdAt: '2026-10-24T00:00:00Z', date: '2026-10-24', text: 'same' }] });
  const plan = backup.planMerge(a, b, {}, state());
  assert.equal(plan.duplicates, 2);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.state.entries.length, 1);
  assert.equal(plan.state.notes.length, 1);
});

test('overlap resolution clips either side, preserving all non-overlapping time', () => {
  const a = state({ entries: [entry('a', 60, 240)] });
  const b = state({ entries: [entry('b', 120, 180)] });
  const plan = resolved(a, b, 'incoming');
  assert.deepEqual(plan.state.entries.map(e => [e.start, e.end]).sort((a, b) => a[0] - b[0]), [[60, 120], [120, 180], [180, 240]]);
  assert.equal(new Set(plan.state.entries.map(e => e.id)).size, 3);
  noOverlaps(plan.state.entries);
  const keep = resolved(b, a, 'current');
  assert.equal(keep.state.entries.length, 3);
  noOverlaps(keep.state.entries);
});

test('cross-day and fractional-second overlaps retain exact endpoints', () => {
  const a = state({ entries: [entry('a', 1430.5, 30.25, 'overnight', '2026-10-24', '2026-10-25')] });
  const b = state({ entries: [entry('b', 0, 15, 'new', '2026-10-25')] });
  const merged = resolved(a, b, 'incoming').state;
  noOverlaps(merged.entries);
  assert.equal(merged.entries.length, 3);
  assert.equal(merged.entries.find(e => e.startDate === '2026-10-24').start, 1430.5);
  assert.ok(merged.entries.some(e => e.start === 15 && e.end === 30.25));
});

test('same ID edits, skills, host fields, balances and quest progress require explicit choices', () => {
  const a = state({ entries: [entry('same', 60, 90, 'old')], host: { name: 'A', weight: '60' }, skills: [{ id: 'sa', name: '阅读', hours: 10 }],
    points: { attribute: 5, contribution: 2, achievement: 1 }, quests: { side: [], mainCompleted: 1, mainRevealed: 1 } });
  const b = state({ entries: [entry('same', 120, 150, 'new')], host: { name: 'B', weight: '61' }, skills: [{ id: 'sb', name: '阅读', hours: 20 }],
    hiddenSkills: ['sb'], quests: { side: [], mainCompleted: 2, mainRevealed: 2 } });
  assert.equal(backup.planMerge(a, b, {}, state()).unresolved, 6);
  const kept = resolved(a, b, 'current').state;
  assert.equal(kept.points.attribute, 5);
  assert.equal(kept.entries[0].activity, 'old');
  assert.equal(kept.skills.length, 1);
  assert.deepEqual(kept.hiddenSkills, ['sa']);
  const adopted = resolved(a, b, 'incoming').state;
  assert.equal(adopted.points.attribute, 0);
  assert.equal(adopted.host.name, 'B');
  assert.equal(adopted.skills[0].hours, 20);
  assert.equal(adopted.entries.length, 1);
  assert.equal(adopted.entries[0].start, 120);
});

test('repeated quest achievements remain separate, same ID note edits conflict', () => {
  const a = state({ achievements: [{ id: 'a', name: '每日任务', points: 1 }], notes: [{ id: 'n', text: 'old' }] });
  const b = state({ achievements: [{ id: 'b', name: '每日任务', points: 1 }], notes: [{ id: 'n', text: 'new' }] });
  const plan = resolved(a, b, 'incoming');
  assert.equal(plan.state.achievements.length, 2);
  assert.equal(plan.state.notes[0].text, 'new');
});

test('overlaps within an incoming file are also reviewed', () => {
  const plan = backup.planMerge(state(), state({ entries: [entry('a', 60, 120), entry('b', 90, 150)] }), {}, state());
  assert.equal(plan.unresolved, 1);
  noOverlaps(resolved(state(), state({ entries: [entry('a', 60, 120), entry('b', 90, 150)] }), 'incoming').state.entries);
});

test('conflicts already inside the current or target backup cannot bypass review', () => {
  const invalid = state({ entries: [entry('a', 60, 120), entry('b', 90, 150)], notes: [{ id: 'n', text: 'first' }, { id: 'n', text: 'second' }] });
  const plan = backup.planMerge(invalid, state(), {}, state());
  assert.equal(plan.unresolved, 2);
  assert.ok(plan.conflicts.every(conflict => conflict.scope === 'current'));
  const clean = resolved(invalid, state(), 'incoming');
  assert.equal(clean.state.notes.length, 1);
  noOverlaps(clean.state.entries);
});

test('a fresh account can adopt the first backup balance without a spurious conflict', () => {
  const plan = backup.planMerge(state(), state({ points: { attribute: 5, contribution: 3, achievement: 2 } }), {}, state());
  assert.equal(plan.unresolved, 0);
  assert.equal(plan.state.points.attribute, 5);
});

test('completed notes survive repeated backup merges without awarding hours twice', () => {
  const completion = { id: 'n', skillId: 's', skillName: '阅读', hours: 2.5, completedAt: '2026-10-28T01:00:00Z',
    noteText: '读书', noteDate: '2026-10-27', noteCreatedAt: '2026-10-27T01:00:00Z' };
  const a = state({ skills: [{ id: 's', name: '阅读', hours: 10 }], noteCompletions: [completion] });
  const b = state({ skills: [{ id: 's', name: '阅读', hours: 10 }], noteCompletions: [Object.assign({}, completion, { completedAt: '2026-10-28T02:00:00Z' })] });
  const plan = backup.planMerge(a, b, {}, state());
  assert.equal(plan.unresolved, 0);
  assert.equal(plan.state.noteCompletions.length, 1);
  assert.equal(plan.state.noteCompletions[0].hours, 2.5);
  assert.equal(backup.planMerge(plan.state, b, {}, state()).state.noteCompletions.length, 1);
});

test('semantic note and skill deduplication remaps completion references', () => {
  const note = { id: 'local-note', text: '练习', date: '2026-10-27', createdAt: '2026-10-27T01:00:00Z' };
  const a = state({ skills: [{ id: 'local-skill', name: '绘画', hours: 0 }], notes: [note] });
  const b = state({ skills: [{ id: 'remote-skill', name: '绘画', hours: 0 }], notes: [Object.assign({}, note, { id: 'remote-note' })],
    noteCompletions: [{ id: 'remote-note', skillId: 'remote-skill', skillName: '绘画', hours: 1.25, completedAt: '2026-10-28T01:00:00Z' }] });
  const plan = backup.planMerge(a, b, {}, state());
  assert.equal(plan.unresolved, 0);
  assert.equal(plan.state.notes.length, 1);
  assert.equal(plan.state.noteCompletions[0].id, 'local-note');
  assert.equal(plan.state.noteCompletions[0].skillId, 'local-skill');
});

test('conflicting completion hours require a choice and retain a single credit record', () => {
  const completion = { id: 'n', skillId: 's', skillName: '阅读', hours: 1, completedAt: '2026-10-28T01:00:00Z' };
  const a = state({ noteCompletions: [completion] });
  const b = state({ noteCompletions: [Object.assign({}, completion, { hours: 3 })] });
  assert.equal(backup.planMerge(a, b, {}, state()).unresolved, 1);
  const plan = resolved(a, b, 'incoming');
  assert.equal(plan.state.noteCompletions.length, 1);
  assert.equal(plan.state.noteCompletions[0].hours, 3);
});

test('reimported notes with new IDs reconnect credits retained after permanent deletion', () => {
  const note = { id: 'imported-note', date: '2026-10-27', createdAt: '2026-10-27T01:00:00Z', text: '阅读' };
  const credit = { id: 'deleted-note', skillId: 's', skillName: '阅读', hours: 2, completedAt: '2026-10-28T01:00:00Z',
    noteDate: note.date, noteCreatedAt: note.createdAt, noteText: note.text };
  const a = state({ skills: [{ id: 's', name: '阅读', hours: 0 }], noteCompletions: [credit] });
  // Older backups can contain the note alone or both the note and its completion.
  for (const completions of [[], [Object.assign({}, credit, { id: note.id })]]) {
    const b = state({ skills: a.skills, notes: [note], noteCompletions: completions });
    const plan = backup.planMerge(a, b, {}, state());
    assert.equal(plan.unresolved, 0);
    assert.equal(plan.state.notes.length, 1);
    assert.equal(plan.state.noteCompletions.length, 1);
    assert.equal(plan.state.noteCompletions[0].id, plan.state.notes[0].id);
    assert.equal(plan.state.noteCompletions[0].hours, 2);
    assert.equal(backup.planMerge(plan.state, b, {}, state()).state.noteCompletions.length, 1);
  }
});

test('note trash conflicts are reviewable and both backup recycle bins are retained', () => {
  const note = { id: 'n', text: '阅读', date: '2026-10-27', createdAt: '2026-10-27T01:00:00Z' };
  const trash = { id: 'trash-log', deletedAt: '2026-10-28T01:00:00Z', entry: entry('e', 60, 120) };
  const a = state({ notes: [note] });
  const b = state({ notes: [Object.assign({}, note, { deletedAt: '2026-10-28T01:00:00Z' })], trashEntries: [trash] });
  assert.equal(backup.planMerge(a, b, {}, state()).unresolved, 1);
  const plan = resolved(a, b, 'incoming');
  assert.ok(plan.state.notes[0].deletedAt);
  assert.equal(plan.state.trashEntries.length, 1);
  assert.equal(backup.planMerge(plan.state, b, {}, state()).state.trashEntries.length, 1);
});

test('import replacement archives only the displaced part of an original log', () => {
  const old = entry('old', 60, 240, '旧日志');
  const before = state({ entries: [old] });
  const after = state({ entries: [entry('left', 60, 120, '旧日志'), entry('new', 120, 180, '新日志'), entry('right', 180, 240, '旧日志')] });
  const result = backup.preserveDisplacedEntries(before, after, '2026-10-28T01:00:00Z');
  assert.equal(result.trashEntries.length, 1);
  assert.equal(result.trashEntries[0].entry.activity, '旧日志');
  assert.equal(result.trashEntries[0].entry.start, 120);
  assert.equal(result.trashEntries[0].entry.end, 180);
  assert.equal(result.trashEntries[0].reason, 'imported');
  assert.equal(before.trashEntries.length, 0);
  assert.equal(after.trashEntries.length, 0);
});

test('full replacement retains prior recycle-bin logs and archives removed active logs', () => {
  const before = state({ entries: [entry('old', 60, 120)], trashEntries: [{ id: 'previous-trash', deletedAt: '2026-10-27T00:00:00Z', entry: entry('older', 30, 60) }] });
  const result = backup.preserveDisplacedEntries(before, state(), '2026-10-28T01:00:00Z');
  assert.equal(result.entries.length, 0);
  assert.equal(result.trashEntries.length, 2);
  const repeated = backup.preserveDisplacedEntries(result, result, '2026-10-28T02:00:00Z');
  assert.equal(repeated.trashEntries.length, 2);
});

test('unchanged and ID-deduplicated logs do not create spurious recycle-bin versions', () => {
  const before = state({ entries: [entry('old', 60, 120, '同一记录')] });
  const after = state({ entries: [entry('new-id', 60, 120, '同一记录')] });
  assert.equal(backup.preserveDisplacedEntries(before, after, '2026-10-28T01:00:00Z').trashEntries.length, 0);
});

function fileHandle(initial) {
  let contents = initial;
  let aborted = false;
  let pending;
  return {
    get contents() { return contents; },
    set contents(value) { contents = value; },
    get aborted() { return aborted; },
    async getFile() { return { size: contents.length, text: async () => contents }; },
    async createWritable() { return { write: async text => { pending = text; }, close: async () => { contents = pending; }, abort: async () => { aborted = true; } }; }
  };
}

test('new export renames around existing files and never writes their contents', async () => {
  const files = new Map([['backup.json', fileHandle('old')], ['backup-1.json', fileHandle('other')]]);
  const directory = { async getFileHandle(name, options) {
    if (!files.has(name)) {
      if (!options?.create) { throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); }
      files.set(name, fileHandle(''));
    }
    return files.get(name);
  } };
  assert.equal(await backup.writeNewFile(directory, 'backup.json', 'new'), 'backup-2.json');
  assert.equal(files.get('backup.json').contents, 'old');
  assert.equal(files.get('backup-1.json').contents, 'other');
  assert.equal(files.get('backup-2.json').contents, 'new');
});

test('updates verify file contents before opening and before committing the write', async () => {
  const file = fileHandle('old');
  await backup.writeFile(file, 'new', 'old');
  assert.equal(file.contents, 'new');
  await assert.rejects(backup.writeFile(file, 'bad', 'old'), /变化/);
  assert.equal(file.contents, 'new');
  const racing = fileHandle('old');
  const open = racing.createWritable;
  racing.createWritable = async () => {
    const stream = await open();
    const write = stream.write;
    stream.write = async text => { await write(text); racing.contents = 'external change'; };
    return stream;
  };
  await assert.rejects(backup.writeFile(racing, 'bad', 'old'), /变化/);
  assert.equal(racing.contents, 'external change');
  assert.equal(racing.aborted, true);
});

test('permission errors do not turn into file creation attempts', async () => {
  let attempts = 0;
  await assert.rejects(backup.writeNewFile({ getFileHandle: async () => {
    attempts++;
    throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  } }, 'backup.json', 'new'), /denied/);
  assert.equal(attempts, 1);
});

test('export names differ even for the same millisecond', () => {
  const date = new Date(2026, 9, 27, 12, 34, 56, 789);
  assert.notEqual(backup.uniqueFilename(date, 'first'), backup.uniqueFilename(date, 'second'));
  assert.match(backup.uniqueFilename(date, 'first'), /^tiandaochouqin-2026-10-27-123456-789-first.json$/);
});

const samplePaths = ['tiandaochouqin-2026-09-30.json', 'tiandaochouqin-2026-10-26.json'].map(name => path.join(__dirname, '..', 'data', name));
test('provided September and October backups merge in either order without losing records', { skip: !samplePaths.every(file => fs.existsSync(file)) }, () => {
  const [old, recent] = samplePaths.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const [a, b] of [[old, recent], [recent, old]]) {
    const plan = resolved(a, b, 'current');
    assert.equal(plan.state.entries.length, 598);
    assert.equal(plan.state.notes.length, 18);
    assert.equal(plan.state.skills.length, 2);
    assert.equal(plan.state.achievements.length, 3);
    assert.equal(plan.state.quests.side.length, 5);
    noOverlaps(plan.state.entries);
    const repeated = resolved(plan.state, b, 'current');
    assert.equal(repeated.state.entries.length, 598);
    assert.equal(repeated.state.notes.length, 18);
  }
});
