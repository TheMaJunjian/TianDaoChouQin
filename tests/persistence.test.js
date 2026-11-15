'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { memoryDirectory } = require('./folder-fixture.js');

// Use a disposable browser profile: never read or change the user's site data.
const browserPath = [process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(candidate => candidate && fs.existsSync(candidate));
if (process.env.REQUIRE_BROWSER_TESTS === '1' && !browserPath) {
  throw new Error('Browser tests are required. Install Chrome/Edge/Chromium or set BROWSER_PATH.');
}
const root = path.resolve(__dirname, '..');
const storageKey = 'tiandao.state.v2';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await check()) { return; } } catch { /* navigation replaces the JS context */ }
    await pause(50);
  }
  throw new Error('Browser condition did not become true');
}

async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') { errors.push(message.params.exceptionDetails); }
    const request = pending.get(message.id);
    if (!request) { return; }
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) { request.reject(new Error(message.error.message)); }
    else { request.resolve(message.result); }
  });
  return { errors, close: () => socket.close(), send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  } };
}

function fixture(overrides = {}) {
  return Object.assign({ entries: [], host: { name: '测试宿主' },
    skills: [{ id: 'reading', name: '阅读', hours: 20 }, { id: 'coding', name: '编程', hours: 30 }],
    focus: '阅读', points: {}, quests: { side: [] }, notifications: [],
    notes: ['one', 'two', 'three'].map(id => ({ id, text: '备注 ' + id,
      date: '2026-11-06', createdAt: '2026-11-06T08:00:00.000Z' })) }, overrides);
}

test('browser persistence and refresh recovery', { skip: !browserPath, timeout: 90000 }, async t => {
  const server = http.createServer((request, response) => {
    const file = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (file === 'fixture') { response.end('<!doctype html><title>Fixture</title>'); return; }
    if (!['index.html', 'app.js', 'backup.js', 'folder-backup.js', 'backup-locations.js', 'storage.js', 'backup-status.js', 'history.js', 'dialogs.js', 'styles.css'].includes(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' :
      file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
    response.end(fs.readFileSync(path.join(root, file)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tiandao-persistence-'));
  const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let client;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 15000);
      browser.once('error', error => { clearTimeout(timer); reject(error); });
      browser.stderr.on('data', chunk => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    client = await connect(endpoint);

    async function page(data = fixture(), sharedContext) {
      const { browserContextId } = sharedContext ? { browserContextId: sharedContext } : await client.send('Target.createBrowserContext');
      const { targetId } = await client.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
      const send = (method, params) => client.send(method, params, sessionId);
      await send('Page.enable');
      await send('Runtime.enable');
      async function run(fn, ...args) {
        const result = await send('Runtime.evaluate', { expression: '(' + fn.toString() + ')(' + args.map(arg => JSON.stringify(arg)).join(',') + ')', returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) { throw new Error(JSON.stringify(result.exceptionDetails)); }
        return result.result.value;
      }
      async function navigate(target) {
        await send('Page.navigate', { url: target });
        await until(() => run(expected => location.href === expected && document.readyState === 'complete', target));
      }
      if (!sharedContext) {
        await navigate(url + '/fixture');
        await run((key, value) => localStorage.setItem(key, JSON.stringify(value)), storageKey, data);
      }
      await navigate(url + '/');
      return { run, send,
        newTab: () => page(null, browserContextId),
        async key(key, modifiers = 0) {
          const windowsVirtualKeyCode = { Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13 }[key];
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, modifiers });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, modifiers });
        },
        failWrites: (key = storageKey) => run(key => {
          const original = Storage.prototype.setItem;
          window.restoreStorageWrites = () => { Storage.prototype.setItem = original; };
          Storage.prototype.setItem = function (name, value) {
            if (name === key) { throw new DOMException('Test quota', 'QuotaExceededError'); }
            return original.call(this, name, value);
          };
        }, key),
        restoreWrites: () => run(() => window.restoreStorageWrites()),
        leave: () => navigate(url + '/fixture'),
        load: () => navigate(url + '/'),
        state: () => run(key => {
          const saved = JSON.parse(localStorage.getItem(key));
          const ui = JSON.parse(localStorage.getItem(key + '.ui'));
          if (ui && ui.dataRevision === saved.dataRevision) { Object.assign(saved, { ui: ui.ui, viewDate: ui.viewDate, entryCategory: ui.entryCategory }); }
          return saved;
        }, storageKey),
        click: selector => run(value => document.querySelector(value).click(), selector),
        set: (id, value, type = 'input') => run((id, value, type) => {
          const element = document.getElementById(id); element.value = value;
          element.dispatchEvent(new Event(type, { bubbles: true }));
        }, id, value, type),
        value: id => run(id => document.getElementById(id).value, id),
        visible: id => run(id => !document.getElementById(id).classList.contains('hidden'), id),
        submit: id => run(id => document.getElementById(id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })), id),
        async reload() {
          const before = await run(() => performance.timeOrigin);
          await send('Page.reload', { ignoreCache: true });
          await until(() => run(before => performance.timeOrigin !== before && document.readyState === 'complete', before));
        },
        close: () => sharedContext ? client.send('Target.closeTarget', { targetId }) : client.send('Target.disposeBrowserContext', { browserContextId })
      };
    }

    await t.test('remembers the last chosen note skill across cancel, completion and reload', async () => {
      const p = await page();
      await p.click('[data-tab="timeline"]');
      await p.click('[data-note-complete="one"]');
      assert.equal(await p.value('noteCompleteSkill'), 'reading');
      await p.set('noteCompleteSkill', 'coding', 'change');
      await p.click('#noteCompleteCancel');
      await p.reload();
      await p.click('[data-note-complete="two"]');
      assert.equal(await p.value('noteCompleteSkill'), 'coding');
      await p.set('noteCompleteHours', '1.5');
      await p.submit('noteCompleteForm');
      await p.reload();
      await p.click('[data-note-complete="three"]');
      assert.equal(await p.value('noteCompleteSkill'), 'coding');
      assert.equal(await p.value('noteCompleteHours'), '');
      const saved = await p.state();
      assert.equal(saved.noteCompletions.length, 1);
      assert.equal(saved.noteCompletions[0].hours, 1.5);
      assert.equal(saved.noteCompletions[0].skillId, 'coding');
      await p.close();
    });

    await t.test('missing remembered skills fall back to focus, first skill, or empty safely', async () => {
      for (const [overrides, expected] of [
        [{}, 'reading'], [{ focus: '' }, 'coding'], [{ skills: [] }, '']
      ]) {
        const p = await page(fixture(Object.assign({ ui: { noteCompleteSkillId: 'deleted' } }, overrides)));
        await p.click('[data-note-complete="one"]');
        assert.equal(await p.value('noteCompleteSkill'), expected);
        await p.close();
      }
    });

    await t.test('note editing and completion drafts recover without committing or crediting', async () => {
      const p = await page();
      await p.click('[data-tab="timeline"]');
      await p.click('[data-note-edit="one"]');
      await p.set('noteEditInput', '尚未保存\n第二行');
      await p.reload();
      assert.equal(await p.visible('noteEditModal'), true);
      assert.equal(await p.value('noteEditInput'), '尚未保存\n第二行');
      assert.equal((await p.state()).notes[0].text, '备注 one');
      await p.submit('noteEditForm');
      await p.reload();
      assert.equal(await p.visible('noteEditModal'), false);
      assert.equal((await p.state()).notes.find(note => note.id === 'one').text, '尚未保存\n第二行');
      await p.click('[data-note-complete="one"]');
      await p.set('noteCompleteSkill', 'coding', 'change');
      await p.set('noteCompleteHours', '2.25');
      await p.reload();
      assert.equal(await p.visible('noteCompleteModal'), true);
      assert.equal(await p.value('noteCompleteHours'), '2.25');
      assert.equal((await p.state()).noteCompletions.length, 0);
      await p.click('#noteCompleteCancel');
      await p.reload();
      assert.equal(await p.visible('noteCompleteModal'), false);
      await p.close();
    });

    await t.test('deleted and already completed notes cannot be revived by stale drafts', async () => {
      const data = fixture();
      data.notes[0].deletedAt = '2026-11-06T09:00:00Z';
      data.noteCompletions = [{ id: 'two', skillId: 'coding', skillName: '编程', hours: 2, completedAt: '2026-11-06T09:00:00Z' }];
      data.ui = { noteEditDraft: { id: 'one', originalText: '备注 one', text: '旧草稿' },
        noteCompleteDraft: { id: 'two', skillId: 'reading', hours: '99' } };
      const p = await page(data);
      assert.equal(await p.visible('noteEditModal'), false);
      assert.equal(await p.visible('noteCompleteModal'), false);
      assert.equal((await p.state()).noteCompletions.length, 1);
      await p.close();
    });

    await t.test('completed and recycled notes retain their content and credited hours', async () => {
      const p = await page();
      await p.click('[data-tab="timeline"]');
      await p.click('[data-note-complete="one"]');
      await p.set('noteCompleteHours', '1.25');
      await p.submit('noteCompleteForm');
      await p.set('noteFilter', 'completed', 'change');
      await p.click('[data-note-del="one"]');
      await p.set('noteFilter', 'trash', 'change');
      await p.reload();
      assert.equal((await p.state()).noteCompletions[0].hours, 1.25);
      assert.equal(await p.run(() => document.getElementById('noteView').textContent.includes('备注 one')), true);
      await p.click('[data-note-restore="one"]');
      await p.reload();
      await p.set('noteFilter', 'completed', 'change');
      assert.equal(await p.run(() => document.querySelector('[data-note-complete="one"]').disabled), true);
      assert.equal((await p.state()).noteCompletions.length, 1);
      await p.close();
    });

    await t.test('backup recovery includes note drafts and the remembered completion skill', async () => {
      const p = await page();
      await p.click('[data-tab="timeline"]');
      await p.click('[data-note-complete="one"]');
      await p.set('noteCompleteSkill', 'coding', 'change');
      await p.set('noteCompleteHours', '0.75');
      await p.leave();
      await p.run(key => localStorage.setItem(key, '{invalid'), storageKey);
      await p.load();
      assert.equal(await p.visible('noteCompleteModal'), true);
      assert.equal(await p.value('noteCompleteSkill'), 'coding');
      assert.equal(await p.value('noteCompleteHours'), '0.75');
      assert.equal((await p.state()).notes.length, 3);
      assert.equal((await p.state()).noteCompletions.length, 0);
      await p.close();
    });

    await t.test('form drafts, note composition and collapses survive immediate refresh', async () => {
      const p = await page();
      await p.set('skillName', '书法');
      await p.set('skillMode', 'hours', 'change');
      await p.set('skillHours', '12.5');
      await p.click('#skillListToggle');
      await p.click('[data-tab="quest"]');
      await p.set('sideTitle', '每天练字');
      await p.set('sideDesc', '临帖\n练习');
      await p.set('sideRewardAttr', '-2');
      await p.set('sideRewardAchievement', '3');
      await p.click('[data-tab="entry"]');
      await p.set('activity', '未提交的备注');
      await p.set('level', 'WARN', 'change');
      await p.reload();
      for (const [id, value] of Object.entries({ skillName: '书法', skillMode: 'hours', skillHours: '12.5',
        sideTitle: '每天练字', sideDesc: '临帖\n练习', sideRewardAttr: '-2', sideRewardAchievement: '3', activity: '未提交的备注', level: 'WARN' })) {
        assert.equal(await p.value(id), value, id);
      }
      assert.equal(await p.visible('skillHoursWrap'), true);
      assert.equal((await p.state()).ui.skillListCollapsed, true);
      assert.equal((await p.state()).ui.activeTab, 'entry');
      await p.click('#noteSubmit');
      await p.submit('skillForm');
      await p.submit('sideQuestForm');
      await p.reload();
      assert.equal(await p.value('activity'), '');
      assert.equal(await p.value('skillName'), '');
      assert.equal(await p.value('sideTitle'), '');
      assert.equal((await p.state()).notes.length, 4);
      assert.equal((await p.state()).quests.side.length, 1);
      await p.close();
    });

    await t.test('name and task-progress drafts resume without submitting rewards', async () => {
      const p = await page(fixture({ quests: { side: [{ id: 'quest', title: '练习', desc: '', status: 'accepted', rewardAttr: 1, rewardAchievement: 2 }] } }));
      await p.click('#hostName');
      await p.set('nameInput', '待确认称号');
      await p.reload();
      assert.equal(await p.value('nameInput'), '待确认称号');
      assert.equal(await p.visible('nameModal'), true);
      assert.equal((await p.state()).host.name, '测试宿主');
      await p.click('#nameCancel');
      await p.click('[data-tab="quest"]');
      await p.click('[data-submit="quest"]');
      await p.run(() => { document.getElementById('taskProgress').value = '43'; document.getElementById('taskProgressCursor').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); });
      await p.reload();
      assert.equal(await p.visible('taskSubmitModal'), true);
      assert.equal(await p.value('taskProgress'), '44');
      assert.equal((await p.state()).points.attribute, 0);
      await p.click('#taskSubmitConfirm');
      await p.reload();
      assert.equal((await p.state()).quests.side[0].progress, 44);
      assert.equal(await p.visible('taskSubmitModal'), false);
      await p.close();
    });

    await t.test('note filters retain separate scroll positions after refresh and tab changes', async () => {
      const data = fixture();
      data.notes = Array.from({ length: 60 }, (_, index) => ({ id: 'scroll-' + index, text: '滚动备注 ' + index,
        date: '2026-11-06', createdAt: '2026-11-06T08:00:00Z', ...(index >= 30 ? { deletedAt: '2026-11-06T09:00:00Z' } : {}) }));
      const p = await page(data);
      await p.click('[data-tab="timeline"]');
      await p.run(() => { const view = document.getElementById('noteView'); view.scrollTop = 260; view.dispatchEvent(new Event('scroll')); });
      await p.set('noteFilter', 'trash', 'change');
      await p.run(() => { const view = document.getElementById('noteView'); view.scrollTop = 130; view.dispatchEvent(new Event('scroll')); });
      await p.reload();
      assert.equal(await p.value('noteFilter'), 'trash');
      assert.equal(await p.run(() => document.getElementById('noteView').scrollTop), 130);
      await p.set('noteFilter', 'pending', 'change');
      assert.equal(await p.run(() => document.getElementById('noteView').scrollTop), 260);
      await p.click('[data-tab="attr"]');
      await p.reload();
      await p.click('[data-tab="timeline"]');
      assert.equal(await p.run(() => document.getElementById('noteView').scrollTop), 260);
      await p.close();
    });

    await t.test('editing an existing log preserves its identity after reload', async () => {
      const entry = { id: 'original', date: '2026-11-06', startDate: '2026-11-06', endDate: '2026-11-06',
        start: 480, end: 540, category: '阅读', activity: '原日志', level: 'INFO' };
      const p = await page(fixture({ entries: [entry], ui: { activeTab: 'entry', entryDraft: {
        startDate: entry.date, startTime: '08:00:00', endDate: entry.date, endTime: '09:00:00',
        category: '阅读', activity: '修改后的日志', level: 'INFO', startSecond: null, endSecond: null, editingEntryId: entry.id } } }));
      await p.reload();
      assert.equal((await p.state()).ui.entryDraft.startSecond, null);
      await p.submit('entryForm');
      assert.equal(await p.visible('confirmModal'), false);
      await p.reload();
      const saved = await p.state();
      assert.equal(saved.entries.length, 1);
      assert.equal(saved.entries[0].id, 'original');
      assert.equal(saved.entries[0].activity, '修改后的日志');
      assert.equal(saved.trashEntries.length, 1);
      await p.close();
    });

    await t.test('editing text, duration, time and skill recalculates hours without counting archived logs', async () => {
      const entry = { id: 'original', date: '2026-11-06', start: 480, end: 540, category: '阅读', activity: '原日志', level: 'INFO' };
      const p = await page(fixture({ entries: [entry], viewDate: entry.date }));
      for (const [index, change] of [
        { fields: {}, reading: '21.0', coding: '30.0' },
        { fields: { endTime: '10:00:00' }, reading: '22.0', coding: '30.0' },
        { fields: { startTime: '12:00:00', endTime: '13:00:00' }, reading: '21.0', coding: '30.0' },
        { fields: { category: '编程' }, reading: '20.0', coding: '31.0' }
      ].entries()) {
        await p.click('[data-tab="timeline"]');
        await p.click('[data-entry-id="original"]');
        await p.click('#detailFillBlank');
        await p.set('activity', '修改 ' + index);
        for (const [field, value] of Object.entries(change.fields)) { await p.set(field, value); }
        await p.reload();
        await p.submit('entryForm');
        await p.reload();
        assert.equal((await p.state()).entries.length, 1);
        for (const [name, expected] of [['阅读', change.reading], ['编程', change.coding]]) {
          assert.match(await p.run(name => Array.from(document.querySelectorAll('.skill-item'))
            .find(item => item.querySelector('.skill-name').textContent === name).textContent, name), new RegExp('累计 ' + expected + ' 小时'));
        }
      }
      await p.close();
    });

    await t.test('regression records negative hours once, lowers skill level, and survives refresh and repeated import', async () => {
      const entry = { id: 'practice', date: '2026-11-06', start: 480, end: 540, category: '阅读', activity: '阅读', level: 'INFO' };
      const p = await page(fixture({ entries: [entry], skills: [{ id: 'reading', name: '阅读', hours: 300 }] }));
      await p.click('[data-tab="entry"]');
      await p.set('category', '阅读', 'change');
      await p.set('activity', '修正多记的时间');
      const before = await p.state();
      assert.equal(await p.run(() => document.querySelectorAll('#entryActions button').length), 2);
      assert.equal(await p.run(() => document.querySelectorAll('#regressionForm > label').length), 2);
      assert.equal(await p.run(() => document.querySelectorAll('#regressionForm > button').length), 1);
      await p.set('regressionSkill', 'reading', 'change');
      await p.set('regressionHours', '2.5');
      await p.click('#regressionSubmit');
      await p.click('#regressionSubmit');
      await p.reload();
      const saved = await p.state();
      assert.deepEqual(saved.entries, before.entries);
      assert.equal(saved.noteCompletions.length, 1);
      assert.equal(saved.noteCompletions[0].hours, -2.5);
      assert.deepEqual(saved.notes, before.notes);
      assert.equal(saved.ui.regressionDraft, null);
      assert.equal(await p.value('regressionHours'), '');
      assert.equal(await p.value('activity'), '修正多记的时间');
      assert.match(await p.run(() => document.getElementById('skillList').textContent), /了解.*累计 298.5 小时/);
      assert.equal(await p.run(() => document.getElementById('focusPercent').textContent), '2.985%');
      await p.click('[data-tab="timeline"]');
      assert.match(await p.run(() => document.getElementById('regressionView').textContent), /阅读 · -2.5 小时/);
      assert.doesNotMatch(await p.run(() => document.getElementById('noteView').textContent), /退步|-2.5/);
      for (let index = 0; index < 2; index++) {
        await p.click('[data-tab="entry"]');
        await p.set('backupFormat', 'file', 'change');
        await p.click('#importBtn');
        await p.set('importJsonInput', JSON.stringify(saved));
        await p.click('#detailUploadImport');
        assert.equal(await p.run(() => document.getElementById('detailUploadImport').disabled), false);
        await p.click('#detailUploadImport');
        assert.equal(await p.visible('detailModal'), false);
        assert.equal((await p.state()).noteCompletions.length, 1);
      }
      assert.match(await p.run(() => document.getElementById('skillList').textContent), /累计 298.5 小时/);
      await p.close();
    });

    await t.test('regression drafts recover, invalid hours do not save, and failed saves can retry safely', async () => {
      const p = await page();
      await p.click('[data-tab="entry"]');
      await p.set('regressionSkill', 'reading', 'change');
      await p.set('regressionHours', '-1.25');
      const draftId = (await p.state()).ui.regressionDraft.id;
      await p.reload();
      assert.equal(await p.visible('noteCompleteModal'), false);
      assert.equal(await p.value('regressionHours'), '-1.25');
      assert.equal((await p.state()).ui.regressionDraft.id, draftId);
      for (const value of ['', '0', 'abc', 'Infinity', '-50000.1', '50000.1']) {
        await p.set('regressionHours', value);
        await p.submit('regressionForm');
        assert.equal((await p.state()).noteCompletions.length, 0);
      }
      await p.set('regressionHours', '21.25');
      const retryId = (await p.state()).ui.regressionDraft.id;
      await p.failWrites();
      await p.submit('regressionForm');
      assert.equal((await p.state()).notes.length, 3);
      assert.equal((await p.state()).noteCompletions.length, 0);
      assert.equal(await p.value('regressionHours'), '21.25');
      await p.restoreWrites();
      await p.submit('regressionForm');
      await p.reload();
      const saved = await p.state();
      assert.equal(saved.noteCompletions.length, 1);
      assert.equal(saved.noteCompletions[0].hours, -21.25);
      assert.equal(saved.noteCompletions[0].id, retryId);
      assert.equal(await p.run(() => document.getElementById('focusFill').style.width), '0%');
      assert.equal(await p.run(() => document.getElementById('focusPercent').textContent), '0.000%');
      assert.equal(await p.value('regressionHours'), '');
      await p.set('regressionHours', '-2');
      await p.set('regressionHours', '');
      await p.reload();
      assert.equal(await p.value('regressionHours'), '');
      assert.equal((await p.state()).noteCompletions.length, 1);
      await p.click('[data-tab="timeline"]');
      await p.set('noteFilter', 'pending', 'change');
      await p.click('[data-note-complete="one"]');
      assert.equal(await p.run(() => document.getElementById('noteCompleteTitle').textContent), '完成备注');
      await p.set('noteCompleteHours', '-1');
      await p.submit('noteCompleteForm');
      assert.equal((await p.state()).noteCompletions.length, 1, 'normal note completion still requires positive hours');
      await p.close();
    });

    await t.test('legacy regression notes and drafts appear only in the separate regression sections', async () => {
      const oldNote = { id: 'old-loss', date: '2026-11-06', createdAt: '2026-11-06T08:00:00Z', text: '旧版退步说明' };
      const oldLoss = { id: oldNote.id, skillId: 'reading', skillName: '阅读', hours: -2,
        completedAt: oldNote.createdAt, noteText: oldNote.text, noteDate: oldNote.date, noteCreatedAt: oldNote.createdAt };
      const p = await page(fixture({ notes: [oldNote], noteCompletions: [oldLoss], viewDate: oldNote.date,
        ui: { noteCompleteDraft: { id: 'legacy-draft', mode: 'regression', text: '旧草稿', skillId: 'coding', hours: '-0.5' } } }));
      assert.equal(await p.visible('noteCompleteModal'), false);
      assert.equal(await p.value('regressionHours'), '-0.5');
      assert.equal(await p.value('regressionSkill'), 'coding');
      await p.click('[data-tab="timeline"]');
      for (const filter of ['pending', 'completed', 'trash']) {
        await p.set('noteFilter', filter, 'change');
        assert.doesNotMatch(await p.run(() => document.getElementById('noteView').textContent), /旧版退步说明/);
      }
      assert.equal(await p.run(() => document.getElementById('regressionCountLabel').textContent), '1 条');
      assert.match(await p.run(() => document.getElementById('regressionView').textContent), /阅读 · -2 小时/);
      await p.click('[data-tab="review"]');
      await p.set('reviewKind', 'regression', 'change');
      assert.equal(await p.run(() => document.querySelectorAll('#reviewResults .review-result').length), 1);
      assert.equal(await p.run(() => document.querySelectorAll('#reviewResults [data-review-key]').length), 0);
      await p.reload();
      assert.equal(await p.value('reviewKind'), 'regression');
      await p.click('[data-tab="entry"]');
      await p.submit('regressionForm');
      assert.equal((await p.state()).noteCompletions.length, 2);
      assert.equal((await p.state()).noteCompletions[1].id, 'legacy-draft');
      await p.close();
    });

    await t.test('failed primary writes retain note input and backup-only failure retains saved notes', async () => {
      for (const failedKey of [storageKey, storageKey + '.backup']) {
        const p = await page();
        await p.click('[data-tab="entry"]');
        await p.set('activity', '存储失败验证');
        await p.run(key => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (name, value) {
            if (name === key) { throw new DOMException('Test quota', 'QuotaExceededError'); }
            return original.call(this, name, value);
          };
        }, failedKey);
        await p.click('#noteSubmit');
        assert.equal(await p.value('activity'), failedKey === storageKey ? '存储失败验证' : '');
        await p.reload();
        assert.equal((await p.state()).notes.length, failedKey === storageKey ? 3 : 4);
        await p.close();
      }
    });
    await t.test('failed log, skill and quest saves retain input and can be retried once', async () => {
      for (const item of [
        { form: 'entryForm', field: 'activity', text: '日志重试', key: 'entries', success: '已记录：', fields: { startDate: '2026-11-06', startTime: '08:00:00', endDate: '2026-11-06', endTime: '09:00:00' } },
        { form: 'skillForm', field: 'skillName', text: '技能重试', key: 'skills', success: '已录入技能', fields: {} },
        { form: 'sideQuestForm', field: 'sideTitle', text: '支线重试', key: 'quests', success: '已发布支线任务', fields: {} }
      ]) {
        const p = await page();
        await p.set(item.field, item.text);
        for (const [id, value] of Object.entries(item.fields)) { await p.set(id, value); }
        const before = await p.state();
        await p.failWrites();
        await p.submit(item.form);
        assert.equal(await p.value(item.field), item.text);
        assert.deepEqual((await p.state())[item.key], before[item.key]);
        assert.equal(await p.run(text => document.getElementById('noticeView').textContent.includes(text), item.success), false);
        await p.restoreWrites();
        await p.click('[data-tab="entry"]');
        assert.deepEqual((await p.state())[item.key], before[item.key], 'later saves cannot commit the failed operation');
        await p.submit(item.form);
        assert.equal(await p.value(item.field), '');
        const saved = await p.state();
        assert.equal(item.key === 'quests' ? saved.quests.side.length : saved[item.key].length, item.key === 'skills' ? 3 : 1);
        await p.close();
      }
    });

    await t.test('failed task completion keeps the dialog and credits rewards only on successful retry', async () => {
      for (const kind of ['main', 'side']) {
        const data = fixture({ quests: { mainAccepted: true, side: [{ id: 'retry', title: '重试任务', status: 'accepted', rewardAttr: 3, rewardAchievement: 2 }] } });
        const p = await page(data);
        await p.click('[data-tab="quest"]');
        await p.click(kind === 'main' ? '#questSubmit' : '[data-submit="retry"]');
        await p.failWrites();
        await p.click('#taskSubmitConfirm');
        assert.equal(await p.visible('taskSubmitModal'), true);
        assert.equal((await p.state()).points.attribute, 0);
        await p.restoreWrites();
        await p.click('#taskSubmitConfirm');
        assert.equal(await p.visible('taskSubmitModal'), false);
        await p.reload();
        const saved = await p.state();
        assert.equal(saved.points.attribute, kind === 'main' ? 5 : 3);
        assert.equal(saved.achievements.length, kind === 'main' ? 0 : 1);
        assert.equal(kind === 'main' ? saved.quests.mainCompleted : saved.quests.side[0].completionCount, 1);
        await p.close();
      }
    });

    await t.test('failed log edits preserve the original and archive it only after successful retry', async () => {
      const entry = { id: 'original', date: '2026-11-06', start: 480, end: 540, category: '阅读', activity: '原日志', level: 'INFO' };
      const p = await page(fixture({ entries: [entry], ui: { activeTab: 'entry', entryDraft: {
        startDate: entry.date, startTime: '08:00:00', endDate: entry.date, endTime: '09:00:00', category: '阅读', activity: '修改', level: 'INFO', editingEntryId: entry.id } } }));
      await p.failWrites();
      await p.submit('entryForm');
      assert.equal(await p.value('activity'), '修改');
      await p.restoreWrites();
      await p.click('[data-tab="entry"]');
      assert.equal((await p.state()).entries[0].activity, '原日志');
      assert.equal((await p.state()).trashEntries.length, 0);
      await p.submit('entryForm');
      const saved = await p.state();
      assert.equal(saved.entries.length, 1);
      assert.equal(saved.entries[0].id, 'original');
      assert.equal(saved.entries[0].activity, '修改');
      assert.equal(saved.trashEntries.length, 1);
      await p.close();
    });
    await t.test('dialogs trap keyboard focus, close on Escape, and restore the opener', async () => {
      const p = await page();
      await p.run(() => document.getElementById('hostName').focus());
      await p.click('#hostName');
      await p.run(() => document.getElementById('nameConfirm').focus());
      await p.key('Tab');
      assert.equal(await p.run(() => document.activeElement.id), 'nameInput');
      await p.key('Tab', 8);
      assert.equal(await p.run(() => document.activeElement.id), 'nameConfirm');
      assert.equal(await p.run(() => document.querySelector('main').inert), true);
      await p.key('Escape');
      assert.equal(await p.visible('nameModal'), false);
      assert.equal(await p.run(() => document.activeElement.id), 'hostName');
      assert.equal(await p.run(() => document.querySelector('main').inert), false);
      await p.close();
    });

    await t.test('nested confirmations return focus to the underlying note editor', async () => {
      const p = await page();
      await p.click('[data-tab="timeline"]');
      await p.click('[data-note-edit="one"]');
      await p.set('noteEditInput', '本页草稿');
      await p.run(key => {
        const saved = JSON.parse(localStorage.getItem(key));
        saved.notes.find(note => note.id === 'one').text = '其他页面修改';
        localStorage.setItem(key, JSON.stringify(saved));
      }, storageKey);
      await p.submit('noteEditForm');
      assert.equal(await p.visible('confirmModal'), true);
      await p.key('Escape');
      assert.equal(await p.visible('confirmModal'), false);
      assert.equal(await p.visible('noteEditModal'), true);
      assert.equal(await p.run(() => document.getElementById('noteEditModal').contains(document.activeElement)), true);
      assert.equal(await p.value('noteEditInput'), '本页草稿');
      await p.key('Escape');
      assert.equal(await p.visible('noteEditModal'), false);
      await p.close();
    });
    await t.test('typing with 3000 logs writes only small UI snapshots and survives reload', async t => {
      const data = fixture();
      data.entries = Array.from({ length: 3000 }, (_, index) => {
        const date = new Date(Date.UTC(2018, 0, index + 1)).toISOString().slice(0, 10);
        return { id: 'perf-' + index, date, start: 480, end: 540, category: '阅读', activity: '历史日志 ' + index, level: 'INFO' };
      });
      const p = await page(data);
      const result = await p.run(key => {
        const initial = localStorage.getItem(key);
        const original = Storage.prototype.setItem;
        const writes = [];
        Storage.prototype.setItem = function (name, value) { writes.push({ name, bytes: value.length * 2 }); return original.call(this, name, value); };
        const started = performance.now();
        for (let index = 1; index <= 100; index++) {
          const field = document.getElementById('activity');
          field.value = '草'.repeat(index);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        Storage.prototype.setItem = original;
        return { milliseconds: performance.now() - started, fullBytes: initial.length * 2,
          primaryWrites: writes.filter(write => write.name === key || write.name === key + '.backup').length,
          uiBytes: writes.reduce((sum, write) => sum + write.bytes, 0), unchanged: initial === localStorage.getItem(key) };
      }, storageKey);
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.primaryWrites, 0);
      assert.equal(result.unchanged, true);
      assert.ok(result.uiBytes < result.fullBytes * 10, '100 edits must not rewrite the history 100 times');
      await p.reload();
      assert.equal(await p.value('activity'), '草'.repeat(100));
      assert.equal((await p.state()).entries.length, 3000);
      await p.close();
    });

    await t.test('reset does not resurrect drafts from an older data revision', async () => {
      const p = await page();
      await p.set('activity', '旧草稿');
      const oldUi = await p.run(key => localStorage.getItem(key + '.ui'), storageKey);
      await p.click('[data-tab="entry"]');
      await p.click('#resetAll');
      await p.click('#confirmAccept');
      await p.leave();
      await p.run((key, oldUi) => { localStorage.setItem(key + '.ui', oldUi); localStorage.setItem(key + '.ui.backup', oldUi); }, storageKey, oldUi);
      await p.load();
      assert.equal(await p.value('activity'), '');
      assert.equal((await p.state()).notes.length, 0);
      await p.close();
    });
    async function folderSetup(p) {
      await p.run(source => {
        window.makeTestDirectory = (0, eval)('(' + source + ')');
        window.folderRoot = window.makeTestDirectory('备份测试');
        window.showDirectoryPicker = async () => window.folderRoot;
      }, memoryDirectory.toString());
    }

    await t.test('folder is the default and export, import and update locations survive reload independently', async () => {
      const p = await page();
      assert.equal(await p.value('backupFormat'), 'folder');
      assert.equal(await p.run(() => document.getElementById('exportData').textContent), '导出文件夹');
      const data = await p.state();
      await p.run(async data => {
        const root = await navigator.storage.getDirectory();
        window.exportParent = await root.getDirectoryHandle('导出位置', { create: true });
        window.importDirectory = await root.getDirectoryHandle('另一个导入目录', { create: true });
        await TianDaoFolder.writeDirectory(window.importDirectory, data, 'source');
        window.showDirectoryPicker = async () => window.exportParent;
      }, data);
      await p.click('[data-tab="entry"]');
      await p.click('#backupRemindExport');
      await until(() => p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey));
      const exportedName = await p.run(key => JSON.parse(localStorage.getItem(key + '.backup-status')).lastSavedName.slice(0, -1), storageKey);
      assert.equal(exportedName, '天道酬勤');
      await p.run(() => { window.showDirectoryPicker = async options => {
        window.firstImportStart = options.startIn?.name;
        return window.importDirectory;
      }; });
      await p.click('#importBtn');
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      assert.equal(await p.run(() => window.firstImportStart), exportedName);
      await p.click('#detailClose');
      await p.set('backupFormat', 'file', 'change');
      assert.equal(await p.run(() => document.getElementById('exportData').textContent), '导出文件');
      assert.equal(await p.visible('updateFolder'), false);
      assert.equal(await p.visible('folderPathControl'), false);
      assert.equal(await p.visible('folderImportPathControl'), false);
      await p.reload();
      assert.equal(await p.value('backupFormat'), 'folder');
      await until(() => p.run(() => document.getElementById('folderImportLocation').textContent === '导入位置：另一个导入目录'));
      await p.run(() => {
        window.locationCalls = [];
        window.showDirectoryPicker = async options => {
          window.locationCalls.push({ id: options.id, name: options.startIn?.name, mode: options.mode, kind: options.startIn?.kind });
          throw new DOMException('Cancelled', 'AbortError');
        };
      });
      await p.click('#exportData');
      await until(async () => !await p.visible('detailModal'));
      await p.click('#importBtn');
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      assert.match(await p.run(() => document.getElementById('detailBody').textContent), /另一个导入目录/);
      assert.deepEqual((await p.state()).notes, data.notes, 'opening the remembered folder only offers document selection');
      await p.click('#detailClose');
      assert.deepEqual(await p.run(() => window.locationCalls), [
        { id: 'tiandao-export-folder', name: '导出位置', mode: 'readwrite', kind: 'directory' }
      ]);
      await p.click('#updateFolder');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查文件夹更新'));
      assert.equal(await p.run(() => window.locationCalls.length), 1, 'updates reuse the persisted directory without a picker');
      await p.click('#detailFolderAction');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(async () => {
        const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle('导出位置');
        const versions = await (await parent.getDirectoryHandle('天道酬勤')).getDirectoryHandle('版本');
        let count = 0; for await (const name of versions.keys()) { count++; } return count;
      }), 2);
      await p.click('#changeFolderPath');
      await until(async () => !await p.visible('detailModal'));
      assert.deepEqual(await p.run(() => window.locationCalls.at(-1)),
        { id: 'tiandao-update-folder', name: exportedName, mode: 'readwrite', kind: 'directory' });
      assert.equal(await p.run(() => document.getElementById('folderUpdateLocation').textContent), '更新位置：' + exportedName);
      assert.equal((await p.state()).entries.length, data.entries.length, 'remembering or cancelling does not import');
      await p.close();
    });

    await t.test('changing the import path opens documents first, preserves cancelled paths and survives reload', async () => {
      const p = await page();
      const original = await p.state();
      await p.run(async data => {
        const root = await navigator.storage.getDirectory();
        window.firstImport = await root.getDirectoryHandle('原导入目录', { create: true });
        window.nextImport = await root.getDirectoryHandle('新导入目录', { create: true });
        window.invalidImport = await root.getDirectoryHandle('无效导入目录', { create: true });
        await TianDaoFolder.writeDirectory(window.firstImport, data, 'source');
        data.notes = [{ id: 'new-folder-note', text: '从新目录选择的备注', date: '2026-11-16', createdAt: '2026-11-16T08:00:00Z' }];
        await TianDaoFolder.writeDirectory(window.nextImport, data, 'source');
        window.showDirectoryPicker = async () => window.firstImport;
      }, original);
      await p.click('[data-tab="entry"]'); await p.click('#importBtn');
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      await p.click('#detailClose');
      await p.run(() => { window.showDirectoryPicker = async () => { throw new DOMException('Cancelled', 'AbortError'); }; });
      await p.click('#changeImportFolderPath');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => document.getElementById('folderImportLocation').textContent), '导入位置：原导入目录');
      await p.run(() => { window.showDirectoryPicker = async () => window.invalidImport; });
      await p.click('#changeImportFolderPath');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => document.getElementById('folderImportLocation').textContent), '导入位置：原导入目录');
      await p.run(() => { window.showDirectoryPicker = async options => { window.importPickerMode = options.mode; return window.nextImport; }; });
      await p.click('#changeImportFolderPath');
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      assert.equal(await p.run(() => window.importPickerMode), 'read');
      assert.equal(await p.run(() => document.getElementById('folderImportLocation').textContent), '导入位置：新导入目录');
      assert.deepEqual((await p.state()).notes, original.notes);
      await p.click('[data-folder-select="none"]');
      await p.run(() => Array.from(document.querySelectorAll('.folder-document')).find(item => item.textContent.includes('2026-11-16')).querySelector('input').click());
      await p.click('#detailFolderAction');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查导入数据'));
      assert.deepEqual((await p.state()).notes, original.notes);
      await p.click('#detailUploadImport');
      assert.equal((await p.state()).notes.filter(note => note.id === 'new-folder-note').length, 1);
      await p.reload();
      await until(() => p.run(() => document.getElementById('folderImportLocation').textContent === '导入位置：新导入目录'));
      await p.click('[data-tab="entry"]');
      await p.run(() => {
        window.pickerCalls = 0;
        window.showDirectoryPicker = async () => { window.pickerCalls++; throw new Error('Unexpected picker'); };
      });
      await p.click('#importBtn');
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      assert.equal(await p.run(() => window.pickerCalls), 0);
      assert.match(await p.run(() => document.getElementById('detailBody').textContent), /新导入目录/);
      assert.equal((await p.state()).notes.filter(note => note.id === 'new-folder-note').length, 1);
      await p.close();
    });

    await t.test('remembered folder imports request only read permission and never write or reopen a picker', async () => {
      const p = await page(); await folderSetup(p);
      const original = await p.state();
      await p.run(async data => { await TianDaoFolder.writeDirectory(window.folderRoot, data, 'source'); }, original);
      await p.click('[data-tab="entry"]'); await p.click('#importBtn');
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      await p.click('#detailClose');
      await p.run(() => {
        window.permission = 'prompt'; window.permissionReply = 'denied'; window.permissionRequests = 0; window.pickerCalls = 0;
        window.folderRoot.control.writes = 0;
        window.folderRoot.queryPermission = async options => { window.queryMode = options.mode; return window.permission; };
        window.folderRoot.requestPermission = async options => { window.permissionRequests++; window.requestMode = options.mode; return window.permissionReply; };
        window.showDirectoryPicker = async () => { window.pickerCalls++; throw new Error('Unexpected picker'); };
      });
      await p.click('#importBtn');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => window.permissionRequests), 1);
      assert.deepEqual(await p.run(() => [window.queryMode, window.requestMode]), ['read', 'read']);
      assert.deepEqual((await p.state()).notes, original.notes);
      await p.run(() => { window.permissionReply = 'granted'; });
      await p.click('#importBtn');
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      assert.equal(await p.run(() => window.permissionRequests), 2);
      assert.deepEqual((await p.state()).notes, original.notes);
      await p.click('#detailClose');
      await p.run(() => {
        window.permission = 'granted';
        window.folderRoot.getFileHandle = async () => { throw new DOMException('Missing directory', 'NotFoundError'); };
      });
      await p.click('#importBtn');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => window.pickerCalls), 0);
      assert.equal(await p.run(() => window.folderRoot.control.writes), 0);
      assert.equal(await p.run(() => document.getElementById('folderImportLocation').textContent), '导入位置：备份测试');
      await p.close();
    });

    await t.test('first update selects a folder and changing the path persists without writing either backup', async () => {
      const p = await page();
      await p.run(async data => {
        const root = await navigator.storage.getDirectory();
        window.firstFolder = await root.getDirectoryHandle('原更新目录', { create: true });
        window.nextFolder = await root.getDirectoryHandle('新更新目录', { create: true });
        window.emptyFolder = await root.getDirectoryHandle('无效目录', { create: true });
        await TianDaoFolder.writeDirectory(window.firstFolder, data, 'original');
        await TianDaoFolder.writeDirectory(window.nextFolder, data, 'original');
        window.beforeChange = { first: (await TianDaoFolder.readDirectory(window.firstFolder)).raw,
          next: (await TianDaoFolder.readDirectory(window.nextFolder)).raw };
        window.pickerCalls = 0;
        window.showDirectoryPicker = async () => { window.pickerCalls++; return window.firstFolder; };
      }, await p.state());
      await p.click('[data-tab="entry"]'); await p.click('#updateFolder');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查文件夹更新'));
      assert.equal(await p.run(() => window.pickerCalls), 1);
      await p.click('#detailClose');
      await p.run(() => { window.showDirectoryPicker = async () => window.nextFolder; });
      await p.click('#changeFolderPath');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => document.getElementById('folderUpdateLocation').textContent), '更新位置：新更新目录');
      assert.equal(await p.run(async () => (await TianDaoFolder.readDirectory(window.firstFolder)).raw === window.beforeChange.first &&
        (await TianDaoFolder.readDirectory(window.nextFolder)).raw === window.beforeChange.next), true);
      await p.run(() => { window.showDirectoryPicker = async () => window.emptyFolder; });
      await p.click('#changeFolderPath');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => document.getElementById('folderUpdateLocation').textContent), '更新位置：新更新目录');
      await p.reload();
      await until(() => p.run(() => document.getElementById('folderUpdateLocation').textContent === '更新位置：新更新目录'));
      await p.run(() => {
        window.pickerCalls = 0;
        window.showDirectoryPicker = async () => { window.pickerCalls++; throw new Error('Unexpected picker'); };
      });
      await p.click('#updateFolder');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查文件夹更新'));
      assert.match(await p.run(() => document.getElementById('detailBody').textContent), /新更新目录/);
      await p.click('#detailFolderAction');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => window.pickerCalls), 0);
      await p.close();
    });

    await t.test('remembered update paths request expired permission without opening a picker or writing on denial', async () => {
      const p = await page(); await folderSetup(p);
      await p.click('[data-tab="entry"]'); await p.click('#exportData');
      await until(() => p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey));
      await p.run(async () => {
        window.targetFolder = Array.from(window.folderRoot.children.values())[0];
        window.beforePermission = (await TianDaoFolder.readDirectory(window.targetFolder)).raw;
        window.permission = 'prompt'; window.permissionReply = 'denied'; window.permissionRequests = 0; window.pickerCalls = 0;
        window.targetFolder.queryPermission = async options => { window.permissionMode = options.mode; return window.permission; };
        window.targetFolder.requestPermission = async () => { window.permissionRequests++; return window.permissionReply; };
        window.showDirectoryPicker = async () => { window.pickerCalls++; throw new Error('Unexpected picker'); };
      });
      await p.click('#updateFolder');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => window.permissionRequests), 1);
      assert.equal(await p.run(() => window.permissionMode), 'readwrite');
      assert.equal(await p.run(async () => (await TianDaoFolder.readDirectory(window.targetFolder)).raw === window.beforePermission), true);
      await p.run(() => { window.permissionReply = 'granted'; });
      await p.click('#updateFolder');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查文件夹更新'));
      await p.click('#detailFolderAction');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => window.permissionRequests), 2);
      assert.equal(await p.run(() => window.pickerCalls), 0);
      await p.run(() => {
        window.permission = 'granted';
        window.targetFolder.getFileHandle = async () => { throw new DOMException('Missing directory', 'NotFoundError'); };
      });
      await p.click('#updateFolder');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(() => window.permissionRequests), 2);
      assert.equal(await p.run(() => window.pickerCalls), 0, 'missing remembered folders never silently open a picker');
      assert.equal(await p.run(() => document.getElementById('folderUpdateLocation').textContent), '更新位置：天道酬勤');
      await p.close();
    });

    await t.test('folder export uses a stable name and adds a suffix without overwriting an existing backup', async () => {
      const p = await page(); await folderSetup(p);
      await p.click('[data-tab="entry"]'); await p.click('#exportData');
      await until(() => p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey));
      await p.run(async () => { window.originalManifest = (await TianDaoFolder.readDirectory(window.folderRoot.children.get('天道酬勤'))).raw; });
      await p.click('#exportData');
      await until(() => p.run(key => JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedName === '天道酬勤-1/', storageKey));
      assert.deepEqual(await p.run(() => Array.from(window.folderRoot.children.keys())), ['天道酬勤', '天道酬勤-1']);
      assert.equal(await p.run(async () => (await TianDaoFolder.readDirectory(window.folderRoot.children.get('天道酬勤'))).raw === window.originalManifest), true);
      assert.equal(await p.run(() => document.getElementById('folderUpdateLocation').textContent), '更新位置：天道酬勤-1');
      await p.close();
    });

    await t.test('single-file locations are remembered separately and native file import still reviews before applying', async () => {
      const p = await page();
      const data = await p.state();
      await p.set('backupFormat', 'file', 'change');
      await p.run(async data => {
        const root = await navigator.storage.getDirectory();
        window.fileExportParent = await root.getDirectoryHandle('单文件导出位置', { create: true });
        window.importHandle = await root.getFileHandle('完整备份.json', { create: true });
        data.host.name = '尚未确认的导入';
        const writer = await window.importHandle.createWritable();
        await writer.write(JSON.stringify(data)); await writer.close();
        window.showDirectoryPicker = async () => window.fileExportParent;
        window.showOpenFilePicker = async () => [window.importHandle];
      }, data);
      await p.click('[data-tab="entry"]'); await p.click('#exportData'); await p.click('#detailDownloadBackup');
      await until(() => p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey));
      await p.click('#detailClose');
      await p.click('#importBtn'); await p.click('#detailChooseImport');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查导入数据'));
      assert.equal((await p.state()).host.name, data.host.name);
      await p.click('#detailClose'); await p.reload();
      await p.set('backupFormat', 'file', 'change');
      await until(() => p.run(() => document.getElementById('backupLocationHint').textContent.includes('完整备份.json')));
      await p.run(() => {
        window.locationCalls = [];
        window.showDirectoryPicker = window.showOpenFilePicker = async options => {
          window.locationCalls.push({ id: options.id, name: options.startIn?.name });
          throw new DOMException('Cancelled', 'AbortError');
        };
      });
      await p.click('#exportData'); await p.click('#detailDownloadBackup');
      await until(() => p.run(() => window.locationCalls.length === 1));
      await p.click('#detailClose'); await p.click('#importBtn'); await p.click('#detailChooseImport');
      await until(() => p.run(() => window.locationCalls.length === 2));
      assert.deepEqual(await p.run(() => window.locationCalls), [
        { id: 'tiandao-export-file', name: '单文件导出位置' }, { id: 'tiandao-import-file', name: '完整备份.json' }
      ]);
      await p.close();
    });

    await t.test('unavailable location storage does not block pickers or alter backup data', async () => {
      const p = await page();
      const result = await p.run(async () => {
        const memory = TianDaoBackupLocations.create(() => { throw new DOMException('Denied', 'SecurityError'); });
        await memory.ready;
        const handle = { name: '本次选择', kind: 'directory' };
        const saved = await memory.remember('export-folder', handle);
        return { saved, options: memory.options('export-folder', { mode: 'readwrite' }),
          importOptions: memory.options('import-folder', { mode: 'read' }) };
      });
      assert.equal(result.saved, false);
      assert.deepEqual(result.options, { mode: 'readwrite', id: 'tiandao-export-folder', startIn: { name: '本次选择', kind: 'directory' } });
      assert.deepEqual(result.importOptions, { mode: 'read', id: 'tiandao-import-folder' });
      await p.close();
    });

    await t.test('folder export and update preserve data and offer conflict choices before writing', async () => {
      const p = await page();
      await folderSetup(p);
      await p.click('[data-tab="entry"]');
      await p.click('#exportData');
      await until(() => p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey));
      assert.equal(await p.visible('detailModal'), false);
      const initial = await p.run(async () => {
        window.folderRoot = Array.from(window.folderRoot.children.values())[0];
        const snapshot = await TianDaoFolder.readDirectory(window.folderRoot);
        return snapshot.records.map(item => ({ name: item.name, error: item.error }));
      });
      assert.ok(initial.some(item => item.name === '属性.json'));
      assert.ok(initial.some(item => item.name === '日期/2026-11-06.json'));
      assert.ok(initial.every(item => !item.error));
      await p.click('#hostName');
      await p.set('nameInput', '更新文件夹的宿主');
      await p.click('#nameConfirm');
      await p.click('#updateFolder');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查文件夹更新'));
      assert.equal(await p.run(() => document.getElementById('detailFolderAction').disabled), true);
      await p.click('[data-folder-choice="incoming"]');
      assert.equal(await p.run(() => document.getElementById('detailFolderAction').disabled), false);
      await p.click('#detailFolderAction');
      await until(async () => !await p.visible('detailModal'));
      const updated = await p.run(async () => {
        const snapshot = await TianDaoFolder.readDirectory(window.folderRoot);
        return { host: snapshot.records.find(item => item.document.type === 'profile').document.data.host.name,
          versions: (await window.folderRoot.getDirectoryHandle('版本')).children.size };
      });
      assert.equal(updated.host, '更新文件夹的宿主');
      assert.equal(updated.versions, 2);
      await p.close();
    });

    await t.test('selected folder dates import without changing unselected attributes, points or skill baselines', async () => {
      const p = await page();
      await folderSetup(p);
      const before = await p.state();
      const incoming = structuredClone(before);
      incoming.host.name = '不应导入的宿主'; incoming.points.attribute = 99; incoming.skills[0].hours = 999;
      incoming.notes = []; incoming.noteCompletions = []; incoming.notifications = [];
      incoming.entries = ['2026-11-13', '2026-11-14'].map((date, index) => ({ id: 'folder-' + index, date, startDate: date, endDate: date,
        start: 60, end: 120, category: '阅读', activity: '按日期导入', level: 'INFO' }));
      await p.run(async incoming => { await TianDaoFolder.writeDirectory(window.folderRoot, incoming, 'source'); }, incoming);
      for (let attempt = 0; attempt < 2; attempt++) {
        await p.click('[data-tab="entry"]'); await p.click('#importBtn');
        await until(() => p.run(() => !!document.querySelector('[data-folder-select="none"]')));
        await p.click('[data-folder-select="none"]');
        assert.equal(await p.run(() => document.getElementById('detailFolderAction').disabled), true);
        await p.run(() => Array.from(document.querySelectorAll('.folder-document')).find(item => item.textContent.includes('2026-11-14')).querySelector('input').click());
        await p.click('#detailFolderAction');
        await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查导入数据'));
        assert.equal(await p.run(() => !!document.querySelector('input[name="backupImportMode"][value="replace"]')), false);
        await p.click('#detailUploadImport');
        assert.equal(await p.visible('detailModal'), false);
      }
      const saved = await p.state();
      assert.equal(saved.entries.length, 1);
      assert.equal(saved.entries[0].date, '2026-11-14');
      assert.deepEqual(saved.host, before.host); assert.deepEqual(saved.points, before.points); assert.deepEqual(saved.skills, before.skills);
      assert.deepEqual(saved.notes, before.notes);
      await p.click('#importBtn');
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      await p.click('#detailFolderAction');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查导入数据'));
      await p.click('input[name="backupImportMode"][value="replace"]');
      await p.click('#detailUploadImport');
      assert.equal((await p.state()).host.name, incoming.host.name);
      assert.equal((await p.state()).entries.length, 2);
      await p.close();
    });

    await t.test('folder failures never claim success and damaged documents remain excluded from partial import', async () => {
      const p = await page(); await folderSetup(p);
      await p.run(() => { window.folderRoot.control.failAt = 2; });
      await p.click('[data-tab="entry"]'); await p.click('#exportData');
      await until(async () => !await p.visible('detailModal'));
      assert.equal(await p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey), false);
      await p.run(async data => {
        window.folderRoot = window.makeTestDirectory('损坏备份');
        await TianDaoFolder.writeDirectory(window.folderRoot, data, 'source');
        const version = await (await window.folderRoot.getDirectoryHandle('版本')).getDirectoryHandle('source');
        (await version.getFileHandle('属性.json')).contents = '{broken';
      }, await p.state());
      await p.click('#importBtn');
      await until(() => p.run(() => !!document.querySelector('.folder-document.invalid')));
      assert.equal(await p.run(() => document.querySelector('.folder-document.invalid input').disabled), true);
      await p.click('#detailFolderAction');
      await until(() => p.run(() => document.getElementById('detailTitle').textContent === '检查导入数据'));
      assert.equal(await p.run(() => !!document.querySelector('input[value="replace"]')), false);
      await p.click('#detailFolderBack');
      assert.equal(await p.run(() => !!document.querySelector('.folder-document.invalid')), true);
      await p.close();
    });

    await t.test('folder ZIP export and directory file input work without directory picker support', async () => {
      const p = await page();
      await p.run(() => {
        window.showDirectoryPicker = undefined;
        HTMLAnchorElement.prototype.click = function () { window.folderDownloadName = this.download; };
      });
      await p.click('[data-tab="entry"]'); await p.click('#exportData');
      await until(() => p.run(() => !!window.folderDownloadName));
      assert.equal(await p.run(() => window.folderDownloadName), '天道酬勤.zip');
      assert.equal(await p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey), false);
      await p.run(() => { document.getElementById('importFolderFiles').click = function () {}; });
      await p.click('#importBtn');
      await p.run(data => {
        const bundle = TianDaoFolder.packageFiles(data, 'source');
        const transfer = new DataTransfer();
        for (const [path, text] of bundle.files) {
          const file = new File([text], path.split('/').at(-1), { type: 'application/json' });
          Object.defineProperty(file, 'webkitRelativePath', { value: '备份/' + path });
          transfer.items.add(file);
        }
        const input = document.getElementById('importFolderFiles'); input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, await p.state());
      await until(() => p.run(() => !!document.querySelector('[data-folder-document]')));
      assert.equal(await p.run(() => document.querySelectorAll('.folder-document.invalid').length), 0);
      await p.close();
    });

    await t.test('file backups track success, business changes, and persistent reminder preferences', async () => {
      const p = await page();
      await p.set('backupFormat', 'file', 'change');
      await p.run(() => {
        window.showDirectoryPicker = async () => ({ getFileHandle: async (name, options) => {
          if (!options) { throw new DOMException('Missing', 'NotFoundError'); }
          return { getFile: async () => ({ size: 0 }), createWritable: async () => ({
            write: async value => { window.testBackupFile = value; }, close: async () => {}, abort: async () => {} }) };
        } });
      });
      await p.click('[data-tab="entry"]');
      await p.click('#exportData');
      await p.click('#detailDownloadBackup');
      await until(() => p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey));
      await p.click('#detailClose');
      assert.equal(await p.run(() => document.getElementById('backupStatus').textContent), '当前业务数据已备份到文件');
      await p.set('activity', '备份后的新备注');
      assert.equal(await p.visible('backupReminder'), false, 'drafts do not change the backup status');
      await p.click('#noteSubmit');
      assert.equal(await p.run(() => document.getElementById('backupStatus').textContent), '上次备份后有新改动');
      assert.equal(await p.visible('backupReminder'), true);
      await p.click('#backupReminders');
      await p.reload();
      assert.equal(await p.visible('backupReminder'), false);
      assert.equal(await p.run(() => document.getElementById('backupReminders').checked), false);
      await p.close();
    });

    await t.test('cancelled writes and unconfirmed downloads never claim a successful backup', async () => {
      const p = await page();
      await p.set('backupFormat', 'file', 'change');
      await p.click('[data-tab="entry"]');
      await p.run(() => { window.showDirectoryPicker = async () => { throw new DOMException('Cancelled', 'AbortError'); }; });
      await p.click('#exportData');
      await p.click('#detailDownloadBackup');
      assert.equal(await p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey), false);
      await p.run(() => { window.showDirectoryPicker = undefined; HTMLAnchorElement.prototype.click = function () {}; });
      await p.click('#detailDownloadBackup');
      await until(() => p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.pendingDownload, storageKey));
      assert.equal(await p.run(key => !!JSON.parse(localStorage.getItem(key + '.backup-status'))?.lastSavedAt, storageKey), false);
      await p.click('#detailClose');
      await p.set('activity', '导出预览之后又有修改');
      await p.click('#noteSubmit');
      await p.reload();
      assert.equal(await p.visible('backupDownloadPending'), true);
      await p.click('#backupConfirmDownloaded');
      assert.equal(await p.visible('backupDownloadPending'), false);
      assert.equal(await p.run(() => document.getElementById('backupStatus').textContent), '上次备份后有新改动');
      await p.close();
    });
    await t.test('review searches across dates, restores filters and navigates to the matched day', async () => {
      const p = await page(fixture({ entries: [
        { id: 'cross', date: '2026-11-01', startDate: '2026-11-01', endDate: '2026-11-02', start: 1380, end: 60, category: '编程', activity: '跨日 JavaScript 练习', level: 'INFO' }
      ] }));
      await p.click('[data-tab="review"]');
      await p.set('reviewAnchor', '2026-11-06', 'change');
      await p.set('reviewStart', '2026-11-02', 'change');
      await p.set('reviewEnd', '2026-11-02', 'change');
      await p.set('reviewSkill', 'name:编程', 'change');
      await p.set('reviewQuery', 'javascript 练习');
      await until(() => p.run(() => document.getElementById('reviewCount').textContent.includes('找到 1 条')));
      assert.equal(await p.run(() => document.getElementById('reviewChart').children.length), 7);
      assert.equal(await p.run(() => document.getElementById('reviewSummary').textContent.includes('1.00 h')), true);
      await p.reload();
      assert.equal(await p.value('reviewQuery'), 'javascript 练习');
      assert.equal(await p.value('reviewSkill'), 'name:编程');
      assert.equal((await p.state()).ui.activeTab, 'review');
      await p.click('[data-review-key="entry:cross"]');
      assert.equal((await p.state()).viewDate, '2026-11-02');
      assert.equal((await p.state()).ui.activeTab, 'timeline');
      await p.close();
    });

    await t.test('review paginates notes, escapes their text and fits mobile screens', async () => {
      const data = fixture({ notes: Array.from({ length: 55 }, (_, id) => ({ id: 'result-' + id,
        date: '2026-11-02', createdAt: '2026-11-02T08:00:00Z', text: '<img src=x onerror=alert(1)> 备注 ' + id })) });
      const p = await page(data);
      await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await p.click('[data-tab="review"]');
      await p.set('reviewPeriod', 'month', 'change');
      await p.set('reviewAnchor', '2024-02-15', 'change');
      assert.equal(await p.run(() => document.getElementById('reviewChart').children.length), 29);
      assert.equal(await p.run(() => document.querySelectorAll('.review-result').length), 50);
      assert.equal(await p.run(() => document.querySelectorAll('#reviewResults img').length), 0);
      assert.equal(await p.run(() => document.documentElement.scrollWidth <= innerWidth), true);
      await p.click('#reviewNext');
      assert.equal(await p.run(() => document.querySelectorAll('.review-result').length), 5);
      await p.set('reviewStart', '2026-11-03', 'change');
      await p.set('reviewEnd', '2026-11-02', 'change');
      assert.equal(await p.run(() => document.getElementById('reviewCount').textContent.includes('开始日期不能晚于结束日期')), true);
      await p.click('#reviewClear');
      assert.equal(await p.run(() => document.querySelectorAll('.review-result').length), 50);
      await p.close();
    });
    await t.test('independent UI snapshots and business commits synchronize across real tabs', async () => {
      const p = await page();
      const other = await p.newTab();
      await p.click('[data-tab="entry"]');
      await p.set('activity', '跨标签页草稿');
      await until(async () => await other.value('activity') === '跨标签页草稿');
      await other.click('#noteSubmit');
      await until(async () => await p.value('activity') === '');
      assert.equal((await p.state()).notes.filter(note => note.text === '跨标签页草稿').length, 1);
      await other.close();
      await p.reload();
      assert.equal(await p.value('activity'), '');
      assert.equal((await p.state()).notes.length, 4);
      await p.close();
    });

    await t.test('successful commits invalidate stale drafts even when UI writes fail', async () => {
      const p = await page();
      await p.set('skillName', '保存后清除草稿');
      await p.failWrites(storageKey + '.ui');
      await p.submit('skillForm');
      await p.reload();
      assert.equal(await p.value('skillName'), '');
      assert.equal((await p.state()).skills.filter(skill => skill.name === '保存后清除草稿').length, 1);
      await p.close();
    });
    await t.test('clipboard fallback remains usable inside the focused export dialog', async () => {
      const p = await page();
      await p.set('backupFormat', 'file', 'change');
      await p.run(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        document.execCommand = command => {
          if (command !== 'copy') { return false; }
          window.copiedExport = document.activeElement.value;
          return document.getElementById('detailModal').contains(document.activeElement);
        };
      });
      await p.click('[data-tab="entry"]');
      await p.click('#exportData');
      await p.click('#detailCopyBackup');
      assert.equal(await p.run(() => JSON.parse(window.copiedExport).notes.length), 3);
      assert.equal(await p.visible('detailModal'), true);
      await p.close();
    });
    assert.deepEqual(client.errors, [], 'no uncaught application errors');
  } finally {
    if (client) { client.close(); }
    if (browser.pid && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, 'exit');
      browser.kill();
      await exited;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
