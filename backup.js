/* 备份合并与文件保护；同时供浏览器和 Node 回归测试使用。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.TianDaoBackup = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function stable(value, ignored) {
    if (Array.isArray(value)) { return value.map(function (item) { return stable(item, ignored); }); }
    if (!value || typeof value !== 'object') { return value; }
    return Object.keys(value).sort().reduce(function (result, key) {
      if ((ignored || []).indexOf(key) < 0) { result[key] = stable(value[key], ignored); }
      return result;
    }, {});
  }
  function equal(a, b, ignored) { return JSON.stringify(stable(a, ignored)) === JSON.stringify(stable(b, ignored)); }
  function normalizedName(value) { return String(value || '').trim().toLowerCase(); }
  function stamp(entry, end) {
    var date = (end ? entry.endDate : entry.startDate) || entry.date;
    return Date.parse(date + 'T00:00:00Z') / 60000 + Number(end ? entry.end : entry.start);
  }
  function entryContent(entry) {
    return [stamp(entry, false), stamp(entry, true), entry.category, entry.activity, entry.level || 'INFO'];
  }
  function intersects(a, b) { return stamp(a, false) < stamp(b, true) && stamp(b, false) < stamp(a, true); }
  function range(entry, start, end) {
    var result = clone(entry);
    var startDate = new Date(Math.round(start * 60000)).toISOString();
    var endDate = new Date(Math.round(end * 60000)).toISOString();
    result.date = result.startDate = startDate.slice(0, 10);
    result.endDate = endDate.slice(0, 10);
    result.start = (start * 60000 - Date.parse(result.startDate + 'T00:00:00Z')) / 60000;
    result.end = (end * 60000 - Date.parse(result.endDate + 'T00:00:00Z')) / 60000;
    result.id = entry.id + '-part-' + Math.round(start * 60000) + '-' + Math.round(end * 60000);
    return result;
  }
  function subtract(entry, blockers) {
    var parts = [entry];
    blockers.forEach(function (blocker) {
      parts = parts.reduce(function (result, part) {
        if (!intersects(part, blocker)) { return result.concat([part]); }
        if (stamp(part, false) < stamp(blocker, false)) { result.push(range(part, stamp(part, false), stamp(blocker, false))); }
        if (stamp(part, true) > stamp(blocker, true)) { result.push(range(part, stamp(blocker, true), stamp(part, true))); }
        return result;
      }, []);
    });
    return parts;
  }

  function planMerge(current, incoming, choices, defaults) {
    choices = choices || {};
    defaults = defaults || {};
    var result = clone(current);
    var conflicts = [];
    var added = 0;
    var duplicates = 0;
    var additions = { entries: 0, notes: 0, noteCompletions: 0, regressions: 0, skills: 0,
      achievements: 0, quests: 0, trashEntries: 0, notifications: 0 };
    var skillIds = Object.create(null);
    var noteIds = Object.create(null);
    var entryMetadata = new WeakMap();
    function metadata(entry) {
      var info = entryMetadata.get(entry);
      if (!info) {
        var content = entryContent(entry);
        info = { start: content[0], end: content[1], key: JSON.stringify(content) };
        entryMetadata.set(entry, info);
      }
      return info;
    }
    function conflict(id, title, local, imported, scope) {
      var choice = choices[id];
      if (choice !== 'current' && choice !== 'incoming') { choice = ''; }
      conflicts.push({ id: id, title: title, current: local, incoming: imported, choice: choice, scope: scope || '' });
      return choice;
    }
    function mergeField(target, key, imported, fallback, title) {
      var local = target[key];
      if (imported === undefined || equal(local, imported)) { return; }
      if (equal(local, fallback) || local === undefined || local === '') { target[key] = clone(imported); return; }
      if (equal(imported, fallback) || imported === '') { return; }
      if (conflict('field:' + title, title, local, imported) === 'incoming') { target[key] = clone(imported); }
    }
    result.host = result.host || {};
    Object.keys(incoming.host || {}).forEach(function (key) {
      var labels = { name: '宿主称号', boundAt: '绑定时间', weight: '体重', education: '修为', talent: '天赋', property: '财产', status: '状态' };
      mergeField(result.host, key, incoming.host[key], (defaults.host || {})[key], labels[key] || key);
    });
    // 点数是余额，不能相加，也不能把 0 当成缺失值。
    result.points = result.points || {};
    if (!equal(result.points, incoming.points)) {
      var emptyAccount = ['entries', 'notes', 'skills', 'achievements', 'noteCompletions', 'trashEntries'].every(function (key) { return !(current[key] || []).length; }) &&
        !((current.quests || {}).side || []).length && !(current.quests || {}).mainCompleted &&
        Object.keys(current.host || {}).every(function (key) { return !current.host[key] || current.host[key] === (defaults.host || {})[key]; }) &&
        Object.keys(current.points || {}).every(function (key) { return current.points[key] === 0; });
      if (emptyAccount || conflict('points', '点数余额（属性点 / 贡献点 / 成就点）', result.points, incoming.points) === 'incoming') {
        result.points = clone(incoming.points);
      }
    }
    result.quests = result.quests || {};
    function mainProgress(value) {
      return ['mainRevealed', 'mainCompleted', 'mainProgress', 'mainAccepted'].reduce(function (progress, key) {
        progress[key] = value[key] === undefined ? (key === 'mainAccepted' ? false : 0) : value[key];
        return progress;
      }, {});
    }
    var main = { progress: mainProgress(result.quests) };
    mergeField(main, 'progress', mainProgress(incoming.quests || {}), mainProgress({}), '主线任务进度');
    Object.assign(result.quests, main.progress);
    if (String((incoming.quests || {}).lastSeenAppVersion || '') > String(result.quests.lastSeenAppVersion || '')) {
      result.quests.lastSeenAppVersion = incoming.quests.lastSeenAppVersion;
    }

    function mergeList(local, imported, kind, title, equivalent, matching) {
      var list = [];
      var newIndices = new Set();
      var byId = new Map();
      var byContent = new Map();
      function contentKey(item) {
        if (!matching) { return ''; }
        if (kind === 'notes') { return JSON.stringify([item.date, item.createdAt, item.text]); }
        if (kind === 'noteCompletions') {
          return item.noteCreatedAt ? JSON.stringify([item.noteDate, item.noteCreatedAt, item.noteText]) : item.id;
        }
        return kind === 'skills' ? normalizedName(item.name) : JSON.stringify(stable(item, ['id']));
      }
      function addItem(item, index, localSource) {
        var key = contentKey(item);
        var found = item.id && byId.has(item.id) ? byId.get(item.id) : (matching && byContent.has(key) ? byContent.get(key) : -1);
        if (found < 0) {
          found = list.length;
          list.push(localSource ? item : clone(item));
          if (item.id) { byId.set(item.id, found); }
          if (matching) { byContent.set(key, found); }
          if (!localSource) { added++; newIndices.add(found); }
          return;
        }
        var existing = list[found];
        if (item.id) { byId.set(item.id, found); }
        if (kind === 'skills') { skillIds[item.id] = existing.id; }
        if (kind === 'notes') { noteIds[item.id] = existing.id; }
        if (equivalent(existing, item)) { duplicates++; return; }
        if (conflict((localSource ? 'local:' : '') + kind + ':' + (item.id || index), title + '：' + (item.name || item.title || item.date || ''), existing, item, localSource ? 'current' : '') === 'incoming') {
          if (matching && byContent.get(contentKey(existing)) === found) { byContent.delete(contentKey(existing)); }
          list[found] = Object.assign({}, clone(item), { id: existing.id || item.id });
          if (matching) { byContent.set(key, found); }
        }
      }
      (local || []).forEach(function (item, index) { addItem(item, index, true); });
      (imported || []).forEach(function (item, index) { addItem(item, index, false); });
      newIndices.forEach(function (index) {
        additions[kind === 'noteCompletions' && list[index].hours < 0 ? 'regressions' : kind]++;
      });
      return list;
    }
    function sameObject(a, b) { return equal(a, b, ['id']); }
    result.skills = mergeList(result.skills, incoming.skills, 'skills', '技能', sameObject, function (a, b) {
      return normalizedName(a.name) === normalizedName(b.name);
    });
    result.notes = mergeList(result.notes, incoming.notes, 'notes', '备注', sameObject, sameObject);
    var notesById = new Map();
    var notesByContent = new Map();
    result.notes.forEach(function (note) {
      notesById.set(note.id, note);
      notesByContent.set(JSON.stringify([note.date, note.createdAt, note.text]), note);
    });
    var skillsById = new Map();
    result.skills.forEach(function (skill) { if (!skillsById.has(skill.id)) { skillsById.set(skill.id, skill); } });
    function completionRecord(item) {
      var record = clone(item);
      record.id = noteIds[record.id] || record.id;
      // 已彻底删除的备注仍有完成记录；恢复不同 ID 的旧备份时重新关联，避免再次结算。
      if (!notesById.has(record.id) && record.noteCreatedAt) {
        var note = notesByContent.get(JSON.stringify([record.noteDate, record.noteCreatedAt, record.noteText]));
        if (note) { record.id = note.id; }
      }
      record.skillId = skillIds[record.skillId] || record.skillId;
      var skill = skillsById.get(record.skillId);
      if (skill) { record.skillName = skill.name; }
      return record;
    }
    function sameCompletion(a, b) { return equal(a, b, ['id', 'completedAt']); }
    result.noteCompletions = mergeList((current.noteCompletions || []).map(completionRecord), (incoming.noteCompletions || []).map(completionRecord),
      'noteCompletions', '备注完成记录', sameCompletion, sameCompletion);
    result.trashEntries = mergeList(result.trashEntries, incoming.trashEntries, 'trashEntries', '回收站日志', sameObject);
    // 重复完成同一支线也会产生同名成就，只有同一 ID 才视为同一成就。
    result.achievements = mergeList(result.achievements, incoming.achievements, 'achievements', '成就', sameObject);
    result.quests.side = mergeList(result.quests.side, (incoming.quests || {}).side, 'quests', '支线任务', sameObject);
    result.notifications = mergeList(result.notifications, incoming.notifications, 'notifications', '系统提示', sameObject, sameObject);
    var localEntries = result.entries || [];
    result.entries = [];
    var originalEntryIds = new Set(), originalEntryKeys = new Set();
    var entryKeys = new Set(), entryIds = new Map(), dayEntries = new Map(), longEntries = new Set();
    function days(info) {
      var start = Math.floor(info.start / 1440), end = Math.ceil(info.end / 1440) - 1;
      return Number.isFinite(start) && Number.isFinite(end) && end - start < 32 ? [start, end] : null;
    }
    function indexEntry(entry, order) {
      var info = metadata(entry); info.order = order;
      entryKeys.add(info.key);
      if (!entryIds.has(entry.id)) { entryIds.set(entry.id, new Set()); }
      entryIds.get(entry.id).add(entry);
      var span = days(info);
      if (!span) { longEntries.add(entry); return; }
      for (var day = span[0]; day <= span[1]; day++) {
        if (!dayEntries.has(day)) { dayEntries.set(day, new Set()); }
        dayEntries.get(day).add(entry);
      }
    }
    function rebuildEntryIndex() {
      entryKeys.clear(); entryIds.clear(); dayEntries.clear(); longEntries.clear();
      result.entries.forEach(indexEntry);
    }
    function addEntry(entry, index, localSource) {
      var info = metadata(entry);
      if (localSource) {
        if (entry.id) { originalEntryIds.add(entry.id); }
        originalEntryKeys.add(info.key);
      }
      var newOrigin = !localSource && !originalEntryIds.has(entry.id) && !originalEntryKeys.has(info.key) ?
        (entry.id ? 'id:' + entry.id : 'content:' + info.key) : undefined;
      function markNew(part) { if (newOrigin !== undefined) { metadata(part).newOrigin = newOrigin; } return part; }
      function copyEntry() {
        // 本地记录已随 current 整体复制；传入的记录只在确定保留时复制。
        if (localSource) { return entry; }
        var copy = clone(entry);
        entryMetadata.set(copy, { start: info.start, end: info.end, key: info.key, newOrigin: newOrigin });
        return copy;
      }
      if (entryKeys.has(info.key)) { duplicates++; return; }
      var span = days(info), matching = new Set(entryIds.get(entry.id));
      function findOverlap(candidate) {
        var other = metadata(candidate);
        if (other.start < info.end && info.start < other.end) { matching.add(candidate); }
      }
      if (!span) { result.entries.forEach(findOverlap); }
      else {
        longEntries.forEach(findOverlap);
        for (var day = span[0]; day <= span[1]; day++) {
          var bucket = dayEntries.get(day);
          if (bucket) { bucket.forEach(findOverlap); }
        }
      }
      if (!matching.size) {
        var copied = copyEntry(); indexEntry(copied, result.entries.length); result.entries.push(copied);
        if (!localSource) { added++; } return;
      }
      var clashes = Array.from(matching).sort(function (a, b) { return metadata(a).order - metadata(b).order; });
      var choice = conflict((localSource ? 'local:' : '') + 'entries:' + (entry.id || index), '时间记录冲突：' + (entry.startDate || entry.date), clashes, [entry], localSource ? 'current' : '');
      if (choice === 'incoming') {
        var retained = [];
        result.entries.forEach(function (candidate) {
          if (!matching.has(candidate)) { retained.push(candidate); return; }
          if (candidate.id === entry.id) { return; }
          var origin = metadata(candidate).newOrigin;
          subtract(candidate, [entry]).forEach(function (part) {
            if (origin !== undefined) { metadata(part).newOrigin = origin; }
            retained.push(part);
          });
        });
        retained.push(copyEntry());
        result.entries = retained;
        rebuildEntryIndex();
      } else if (choice === 'current' && !clashes.some(function (candidate) { return candidate.id === entry.id; })) {
        subtract(entry, clashes).forEach(function (part) { markNew(part); indexEntry(part, result.entries.length); result.entries.push(part); });
      }
    }
    localEntries.forEach(function (entry, index) { addEntry(entry, index, true); });
    (incoming.entries || []).forEach(function (entry, index) { addEntry(entry, index, false); });
    // 同一条日志因冲突拆成多段仍计一条；替换已有 ID 的日志属于修改。
    additions.entries = new Set(result.entries.map(function (entry) { return metadata(entry).newOrigin; })
      .filter(function (origin) { return origin !== undefined; })).size;
    ['hiddenSkills', 'hiddenAchievements'].forEach(function (key) {
      var ids = (result[key] || []).concat(incoming[key] || []).map(function (id) { return key === 'hiddenSkills' ? (skillIds[id] || id) : id; });
      result[key] = Array.from(new Set(ids));
    });
    ['focus', 'entryCategory'].forEach(function (key) { if (!result[key]) { result[key] = incoming[key] || ''; } });
    result.firstRun = false;
    additions.total = Object.keys(additions).reduce(function (total, key) { return total + (key === 'notifications' ? 0 : additions[key]); }, 0);
    return { state: result, conflicts: conflicts, unresolved: conflicts.filter(function (item) { return !item.choice; }).length,
      added: added, duplicates: duplicates, additions: additions };
  }

  function uniqueFilename(now, token) {
    var date = now || new Date();
    var stamp = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0') +
      '-' + String(date.getHours()).padStart(2, '0') + String(date.getMinutes()).padStart(2, '0') + String(date.getSeconds()).padStart(2, '0') +
      '-' + String(date.getMilliseconds()).padStart(3, '0');
    return 'tiandaochouqin-' + stamp + '-' + token + '.json';
  }

  function preserveDisplacedEntries(before, after, deletedAt) {
    var result = clone(after);
    result.trashEntries = result.trashEntries || [];
    var ids = new Set(result.trashEntries.map(function (item) { return item.id; }));
    (before.trashEntries || []).forEach(function (item) {
      if (!ids.has(item.id)) { result.trashEntries.push(clone(item)); ids.add(item.id); }
    });
    var exact = new Set(), byContent = new Map();
    function content(entry) { return JSON.stringify([entry.category, entry.activity, entry.level || 'INFO']); }
    (result.entries || []).forEach(function (entry) {
      exact.add(JSON.stringify(entryContent(entry)));
      var key = content(entry);
      if (!byContent.has(key)) { byContent.set(key, []); }
      byContent.get(key).push({ entry: entry, start: stamp(entry, false), end: stamp(entry, true) });
    });
    (before.entries || []).forEach(function (entry) {
      if (exact.has(JSON.stringify(entryContent(entry)))) { return; }
      var start = stamp(entry, false), end = stamp(entry, true);
      var retained = (byContent.get(content(entry)) || []).filter(function (item) { return item.start < end && start < item.end; })
        .map(function (item) { return item.entry; });
      subtract(entry, retained).forEach(function (part) {
        var id = 'imported-' + entry.id + '-' + Math.round(stamp(part, false) * 60000) + '-' + Math.round(stamp(part, true) * 60000) + '-' + deletedAt;
        if (!ids.has(id)) {
          result.trashEntries.push({ id: id, deletedAt: deletedAt, reason: 'imported', entry: clone(part) });
          ids.add(id);
        }
      });
    });
    return result;
  }
  async function writeNewFile(directory, filename, text) {
    var candidate = filename;
    var suffix = 0;
    while (true) {
      try { await directory.getFileHandle(candidate); }
      catch (error) {
        if (error.name !== 'NotFoundError') { throw error; }
        break;
      }
      candidate = filename.replace(/\.json$/, '-' + (++suffix) + '.json');
    }
    var handle = await directory.getFileHandle(candidate, { create: true });
    if ((await handle.getFile()).size) { throw new Error('目标文件已存在，请重新导出。'); }
    await writeFile(handle, text);
    return candidate;
  }
  async function writeFile(handle, text, expectedText, beforeCommit, resolveBeforeClose) {
    // 在打开写入流前和提交前复查，发现文件在预览后变化就中止。
    async function matchesExpected(currentHandle) {
      var file = await currentHandle.getFile();
      return expectedText === '' ? file.size === 0 : (await file.text()) === expectedText;
    }
    if (expectedText !== undefined && !await matchesExpected(handle)) {
      throw Object.assign(new Error('文件在检查后已发生变化，请重新选择并检查。'), { name: 'BackupFileChangedError' });
    }
    var writable = await handle.createWritable();
    try {
      await writable.write(text);
      if (beforeCommit) { await beforeCommit(); }
      var currentHandle = resolveBeforeClose ? await resolveBeforeClose() : handle;
      if (expectedText !== undefined && !await matchesExpected(currentHandle)) {
        throw Object.assign(new Error('文件在检查后已发生变化，更新已取消。'), { name: 'BackupFileChangedError' });
      }
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch (ignored) { /* stream may already be closed */ }
      throw error;
    }
  }
  return { planMerge: planMerge, preserveDisplacedEntries: preserveDisplacedEntries, equal: equal, uniqueFilename: uniqueFilename, writeNewFile: writeNewFile, writeFile: writeFile };
});
