'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Use a disposable browser profile: never read or change the user's site data.
const browserPath = [process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(candidate => candidate && fs.existsSync(candidate));
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
    if (!['index.html', 'app.js', 'backup.js', 'styles.css'].includes(file)) { response.writeHead(404).end(); return; }
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

    async function page(data = fixture()) {
      const { browserContextId } = await client.send('Target.createBrowserContext');
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
      await navigate(url + '/fixture');
      await run((key, value) => localStorage.setItem(key, JSON.stringify(value)), storageKey, data);
      await navigate(url + '/');
      return { run,
        leave: () => navigate(url + '/fixture'),
        load: () => navigate(url + '/'),
        state: () => run(key => JSON.parse(localStorage.getItem(key)), storageKey),
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
        close: () => client.send('Target.disposeBrowserContext', { browserContextId })
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
