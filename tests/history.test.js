'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const history = require('../history.js');
const backupStatus = require('../backup-status.js');
const entry = (id, startDate, endDate, start, end, category = '阅读', activity = '阅读练习') =>
  ({ id, startDate, endDate, date: startDate, start, end, category, activity });

test('weekly trends split cross-day logs and retain credits from deleted notes exactly once', () => {
  const credit = { id: 'removed-note', skillId: 'read', skillName: '旧名称', hours: 2, completedAt: '2026-11-03T12:00:00' };
  const state = { skills: [{ id: 'read', name: '阅读' }],
    entries: [entry('boundary', '2026-11-01', '2026-11-02', 1380, 60), entry('later', '2026-11-09', '2026-11-09', 0, 120)],
    noteCompletions: [credit, credit], trashEntries: [{ entry: entry('trash', '2026-11-02', '2026-11-02', 0, 600) }] };
  const result = history.trend(state, '2026-11-06', 'week', '阅读');
  assert.equal(result.startDate, '2026-11-02');
  assert.equal(result.endDate, '2026-11-08');
  assert.equal(result.logHours, 1);
  assert.equal(result.noteHours, 2);
  assert.equal(result.totalHours, 3);
  assert.equal(result.previousHours, 1);
  assert.equal(result.activeDays, 2);
});

test('monthly trends respect leap days, adjacent months and skill filters', () => {
  const state = { entries: [entry('leap', '2024-02-29', '2024-03-01', 1380, 60),
    entry('other', '2024-02-02', '2024-02-02', 0, 180, '编程')] };
  const result = history.trend(state, '2024-02-10', 'month', '阅读');
  assert.equal(result.days.length, 29);
  assert.equal(result.days[28].totalHours, 1);
  assert.equal(result.totalHours, 1);
  assert.equal(history.trend(state, '2024-03-10', 'month', '阅读').totalHours, 1);
  assert.equal(history.trend(state, '2024-02-10', 'month', null).totalHours, 4);
});

test('search combines keywords, skill and intersecting date ranges without mutating records', () => {
  const state = { entries: [entry('cross', '2026-11-01', '2026-11-02', 1380, 60, '编程', 'Practice JavaScript'),
    entry('other', '2026-11-02', '2026-11-02', 60, 120, '阅读')] };
  const original = JSON.stringify(state);
  const result = history.search(state, { query: 'practice JAVASCRIPT', skill: '编程', startDate: '2026-11-02', endDate: '2026-11-02' });
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].id, 'cross');
  assert.equal(result.rows[0].jumpDate, '2026-11-02');
  assert.equal(JSON.stringify(state), original);
  assert.throws(() => history.search(state, { startDate: '2026-11-03', endDate: '2026-11-02' }), /日期/);
  assert.throws(() => history.search(state, { startDate: '2026-02-30' }), /日期/);
});

test('note search resolves credited skills, excludes trash by default and paginates', () => {
  const state = { skills: [{ id: 'read', name: '阅读' }],
    notes: Array.from({ length: 55 }, (_, id) => ({ id: String(id), date: '2026-11-02', text: '备注 ' + id, ...(id === 0 ? { deletedAt: '2026-11-03' } : {}) })),
    noteCompletions: [{ id: '1', skillId: 'read', skillName: '阅读', hours: 2 }] };
  assert.equal(history.search(state, { kind: 'note' }).total, 54);
  assert.equal(history.search(state, { kind: 'note' }).rows.length, 50);
  assert.equal(history.search(state, { page: 1 }).rows.length, 4);
  assert.equal(history.search(state, { includeTrash: true }).total, 55);
  assert.equal(history.search(state, { skill: '阅读' }).rows[0].id, '1');
  assert.equal(history.search(state, { skill: '' }).total, 53);
});

test('backup status ignores UI and notifications but detects business edits', () => {
  const first = { host: { name: '宿主', weight: '60' }, notes: [{ id: 'one', text: '原文' }], ui: { activeTab: 'entry' }, notifications: [] };
  const equivalent = { notifications: [{ text: '提示' }], notes: [{ text: '原文', id: 'one' }], host: { weight: '60', name: '宿主' }, ui: {} };
  assert.equal(backupStatus.fingerprint(first), backupStatus.fingerprint(equivalent));
  equivalent.notes[0].text = '新内容';
  assert.notEqual(backupStatus.fingerprint(first), backupStatus.fingerprint(equivalent));
  assert.equal(backupStatus.normalize({ lastSavedAt: 'invalid', pendingDownload: {} }).lastSavedAt, '');
  assert.equal(backupStatus.normalize({ pendingDownload: {} }).pendingDownload, null);
});
