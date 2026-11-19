/* 按内容类型与日期拆分备份；清单最后提交，更新失败仍可读取上一版本。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./backup.js')); }
  else { root.TianDaoFolder = factory(root.TianDaoBackup); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (backup) {
  'use strict';
  var MANIFEST = '备份清单.json';
  var FORMAT = 'tiandao-folder';
  var READ_CONCURRENCY = 32;
  var WRITE_CONCURRENCY = 12;
  var FIELDS = {
    profile: ['host', 'skills', 'hiddenSkills', 'focus'],
    tasks: ['quests', 'points', 'achievements', 'hiddenAchievements'],
    preferences: ['ui', 'viewDate', 'entryCategory', 'noticeSeenCount', 'dataRevision', 'firstRun'],
    day: ['entries', 'notes', 'noteCompletions', 'trashEntries', 'notifications']
  };
  var NAMES = { profile: '属性.json', tasks: '任务与成就.json', preferences: '界面设置.json' };
  async function parallel(items, limit, action) {
    var results = new Array(items.length), next = 0, failure;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async function () {
      while (!failure && next < items.length) {
        var index = next++;
        try { results[index] = await action(items[index], index); }
        catch (error) { failure = error; }
      }
    }));
    if (failure) { throw failure; }
    return results;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function normalized(value) { return String(value || '').trim().toLowerCase(); }
  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  }
  function localDate(value) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) { return '未标日期'; }
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function safePath(path) {
    if (typeof path !== 'string' || !path || path.split('/').some(function (part) {
      return !part || part === '.' || part === '..' || /[\\:*?"<>|\x00-\x1f]/.test(part) || /[. ]$/.test(part);
    })) { throw new Error('备份文档路径无效。'); }
    return path;
  }
  function makeDocument(type, data, date) {
    return { format: 'tiandao-document', version: 1, type: type, ...(date ? { date: date } : {}), data: data };
  }
  function documentPath(doc) { return doc.type === 'day' ? '日期/' + doc.date + '.json' : NAMES[doc.type]; }
  function createDocuments(state) {
    return groupDocuments(state).map(clone);
  }
  // 打包和哈希会立即序列化分组，只有对外返回的文档才需要独立副本。
  function groupDocuments(state) {
    var documents = ['profile', 'tasks', 'preferences'].map(function (type) {
      var data = {};
      FIELDS[type].forEach(function (key) { if (state[key] !== undefined) { data[key] = state[key]; } });
      return makeDocument(type, data);
    });
    var days = new Map();
    function day(date) {
      if (days.has(date)) { return days.get(date).data; }
      date = validDate(date) ? date : '未标日期';
      if (!days.has(date)) { days.set(date, makeDocument('day', { entries: [], notes: [], noteCompletions: [], trashEntries: [], notifications: [] }, date)); }
      return days.get(date).data;
    }
    var notes = new Map((state.notes || []).map(function (note) { return [note.id, note]; }));
    var regressions = new Map((state.noteCompletions || []).filter(function (item) { return item.hours < 0; })
      .map(function (item) { return [item.id, item]; }));
    (state.entries || []).forEach(function (entry) { day(entry.startDate || entry.date).entries.push(entry); });
    (state.notes || []).forEach(function (note) {
      var regression = regressions.get(note.id);
      // 旧版退步备注与扣减记录同行，部分导入也不能把它恢复成未完成备注。
      day(regression ? localDate(regression.completedAt) : note.date).notes.push(note);
    });
    (state.noteCompletions || []).forEach(function (item) {
      var note = notes.get(item.id);
      // 正数完成记录与备注同行，选择部分日期时也不能把已完成备注变回未完成。
      var date = item.hours < 0 ? localDate(item.completedAt) : (note ? note.date : item.noteDate || localDate(item.completedAt));
      day(date).noteCompletions.push(item);
    });
    (state.trashEntries || []).forEach(function (item) { day(item.entry.startDate || item.entry.date).trashEntries.push(item); });
    (state.notifications || []).forEach(function (item) { day(localDate(item.ts)).notifications.push(item); });
    var skillByName = new Map();
    (state.skills || []).forEach(function (skill) {
      var name = normalized(skill.name);
      if (!skillByName.has(name)) { skillByName.set(name, skill); }
    });
    Array.from(days.keys()).sort().forEach(function (date) {
      var doc = days.get(date);
      var refs = new Map();
      doc.data.entries.forEach(function (entry) {
        var skill = skillByName.get(normalized(entry.category));
        if (skill) { refs.set(skill.id, { id: skill.id, name: skill.name }); }
      });
      doc.data.noteCompletions.forEach(function (item) { refs.set(item.skillId, { id: item.skillId, name: item.skillName }); });
      doc.skillRefs = Array.from(refs.values());
      documents.push(doc);
    });
    return documents;
  }
  function parseDocument(text, descriptor) {
    var doc = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (!doc || doc.format !== 'tiandao-document' || doc.version !== 1 || !Object.hasOwn(FIELDS, doc.type) ||
        !doc.data || typeof doc.data !== 'object' || Array.isArray(doc.data) ||
        (doc.type === 'day' && !validDate(doc.date) && doc.date !== '未标日期') ||
        Object.keys(doc.data).some(function (key) { return !FIELDS[doc.type].includes(key); }) ||
        FIELDS[doc.type].some(function (key) { return !Object.hasOwn(doc.data, key); })) {
      throw new Error('文档格式或版本不受支持。');
    }
    if (doc.type === 'day' && (FIELDS.day.some(function (key) { return !Array.isArray(doc.data[key]); }) ||
        !Array.isArray(doc.skillRefs) || doc.skillRefs.some(function (ref) { return !ref || typeof ref.id !== 'string' || !ref.id || typeof ref.name !== 'string' || !ref.name.trim(); }))) {
      throw new Error('日期文档中的记录或技能引用无效。');
    }
    if (descriptor && (descriptor.type !== doc.type || descriptor.name !== documentPath(doc))) { throw new Error('文档与备份清单不匹配。'); }
    return doc;
  }
  function assemble(documents, defaults, current) {
    var result = clone(defaults);
    var types = new Set(documents.map(function (doc) { return doc.type; }));
    var singleton = new Set();
    documents.forEach(function (doc) {
      if (doc.type !== 'day' && singleton.has(doc.type)) { throw new Error('同类通用文档重复，请只选择一份。'); }
      singleton.add(doc.type);
      FIELDS[doc.type].forEach(function (key) {
        if (doc.type === 'day') {
          for (var record of clone(doc.data[key])) { result[key].push(record); }
        }
        else if (doc.data[key] !== undefined) { result[key] = clone(doc.data[key]); }
      });
    });
    if (current) {
      if (!types.has('profile')) { result.host = clone(current.host); result.focus = current.focus; }
      if (!types.has('tasks')) { result.points = clone(current.points); result.quests = Object.assign({}, clone(current.quests), { side: [] }); }
    }
    var refs = documents.flatMap(function (doc) { return doc.skillRefs || []; });
    if (!refs.length) { return result; }
    function skillIndex(skills) {
      var byId = new Map(), byName = new Map();
      function add(skill, position) {
        var name = normalized(skill.name);
        if (!byId.has(skill.id)) { byId.set(skill.id, position); }
        if (!byName.has(name)) { byName.set(name, position); }
      }
      skills.forEach(add);
      return { add: add, find: function (ref) {
        // 旧备份允许别名，ID 和名称分别匹配时保留原列表中靠前的一项。
        var position = Math.min(byId.get(ref.id) ?? Infinity, byName.get(normalized(ref.name)) ?? Infinity);
        return skills[position];
      } };
    }
    var selectedSkills = skillIndex(result.skills);
    var currentSkills = !types.has('profile') && current ? skillIndex(current.skills) : null;
    var remaps = [];
    refs.forEach(function (ref) {
      var selected = selectedSkills.find(ref);
      if (!selected && !types.has('profile')) {
        var existing = currentSkills && currentSkills.find(ref);
        selected = existing ? clone(existing) : { id: ref.id, name: ref.name, hours: 0 };
        selectedSkills.add(selected, result.skills.length);
        result.skills.push(selected);
      }
      if (selected) { remaps.push({ from: ref.id, skill: selected }); }
    });
    // 按引用顺序串起多次改名或换 ID，最后只遍历一遍完成记录。
    var finalSkill = new Map();
    for (var i = remaps.length - 1; i >= 0; i--) {
      var remap = remaps[i];
      finalSkill.set(remap.from, finalSkill.get(remap.skill.id) || remap.skill);
    }
    result.noteCompletions.forEach(function (item) {
      var skill = finalSkill.get(item.skillId);
      if (skill) { item.skillId = skill.id; item.skillName = skill.name; }
    });
    return result;
  }
  function packageDocuments(state, token, previous, onDocument) {
    safePath(token);
    if (token.includes('/')) { throw new Error('备份版本名无效。'); }
    var files = new Map();
    var old = new Map((previous ? previous.records : []).map(function (record) { return [record.name, record]; }));
    var reused = 0;
    var manifest = { format: FORMAT, version: 1, savedAt: new Date().toISOString(), documents: [] };
    groupDocuments(state).forEach(function (doc) {
      var name = documentPath(doc);
      var path = '版本/' + token + '/' + name;
      var text = JSON.stringify(doc, null, 2);
      var existing = old.get(name);
      var reuse = existing && !existing.error && existing.raw === text;
      if (reuse) { path = existing.path; reused++; }
      else { files.set(path, text); }
      var descriptor = { path: path, name: name, type: doc.type };
      manifest.documents.push(descriptor);
      if (onDocument) { onDocument(descriptor, text, reuse ? existing : null); }
    });
    var changed = files.size;
    var unchanged = !!previous && changed === 0 && previous.records.length === manifest.documents.length;
    return { manifest: manifest, files: files, changed: changed, reused: reused, unchanged: unchanged };
  }
  function addManifests(bundle, token, previous) {
    var files = bundle.files, raw = JSON.stringify(bundle.manifest, null, 2);
    // 每个版本保留清单，未变化文档可引用旧版本，仍能还原任一历史快照。
    files.set('版本/' + token + '/版本清单.json', raw);
    if (previous) { files.set('版本/' + token + '/上一版本清单.json', previous.raw); }
    files.set(MANIFEST, raw);
    return bundle;
  }
  function packageFiles(state, token, previous) {
    return addManifests(packageDocuments(state, token, previous), token, previous);
  }
  function canHashDocuments() {
    return !!(globalThis.crypto && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === 'function');
  }
  async function sha256Text(text) {
    if (!canHashDocuments()) { return null; }
    try {
      var bytes = new TextEncoder().encode(text);
      var digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      return Array.from(digest, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    } catch (ignored) { return null; } // 摘要不可用时，仍以正文读写和校验。
  }
  async function packageHashedFiles(state, token, previous) {
    if (!canHashDocuments()) { return packageFiles(state, token, previous); }
    var jobs = [];
    var bundle = packageDocuments(state, token, previous, function (descriptor, text, existing) {
      jobs.push({ descriptor: descriptor, text: text, existing: existing });
    });
    var oldHashes = new Map((previous ? previous.manifest.documents : []).map(function (doc) { return [doc.path, doc.sha256]; }));
    var digests = await parallel(jobs, READ_CONCURRENCY, function (job) {
      // 只复用与相同正文一起验证过的摘要，不能从未经核实的旧清单继承。
      var digest = job.existing && job.existing.verifiedSha256;
      return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : sha256Text(job.text);
    });
    if (digests.every(Boolean)) {
      jobs.forEach(function (job, index) {
        var digest = digests[index];
        job.descriptor.sha256 = digest;
        if (digest !== oldHashes.get(job.descriptor.path)) { bundle.unchanged = false; }
      });
    }
    return addManifests(bundle, token, previous);
  }
  function parseManifest(raw) {
    var value = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    if (!value || value.format !== FORMAT || value.version !== 1 || !Array.isArray(value.documents) || !value.documents.length) { throw new Error('不是有效的文件夹备份清单。'); }
    var names = new Set();
    value.documents.forEach(function (item) {
      if (!item || !Object.hasOwn(FIELDS, item.type)) { throw new Error('清单包含未知文档类型。'); }
      safePath(item.path); safePath(item.name);
      if (!/^版本\/[^/]+\//.test(item.path) || !item.path.endsWith('/' + item.name) || names.has(item.name)) { throw new Error('清单包含重复或无效路径。'); }
      names.add(item.name);
    });
    if (!Object.values(NAMES).every(function (name) { return names.has(name); })) { throw new Error('备份清单缺少通用文档。'); }
    return value;
  }
  function directoryAccess(directory, create) {
    var directories = new Map([['', Promise.resolve(directory)]]), files = new Map();
    function directoryAt(path) {
      if (!directories.has(path)) {
        var parts = path.split('/'), name = parts.pop();
        directories.set(path, directoryAt(parts.join('/')).then(function (parent) { return parent.getDirectoryHandle(name, { create: !!create }); }));
      }
      return directories.get(path);
    }
    function fileAt(path) {
      safePath(path);
      if (!files.has(path)) {
        var parts = path.split('/'), name = parts.pop();
        files.set(path, directoryAt(parts.join('/')).then(function (parent) { return parent.getFileHandle(name, { create: !!create }); }));
      }
      return files.get(path);
    }
    async function collectFileHandles(descriptors) {
      var groups = new Map();
      descriptors.forEach(function (item) {
        var path = safePath(item.path), split = path.lastIndexOf('/');
        var parent = path.slice(0, split);
        if (!groups.has(parent)) { groups.set(parent, new Set()); }
        groups.get(parent).add(path.slice(split + 1));
      });
      // 同一目录内的大批日期文档可一次枚举句柄，稀疏引用仍按清单路径直接读取。
      var groupsToList = Array.from(groups).filter(function (group) { return group[1].size >= 16; });
      await parallel(groupsToList, 8, async function (group) {
        var parent = group[0], names = group[1], remaining = names.size, budget = remaining * 2;
        try {
          var directory = await directoryAt(parent);
          for await (var [name, handle] of directory.entries()) {
            if (names.has(name) && handle.kind === 'file') {
              files.set(parent + '/' + name, Promise.resolve(handle));
              remaining--;
            }
            if (!remaining || --budget === 0) { break; }
          }
        } catch (ignored) { /* 未取得的句柄由 fileAt 逐项读取，错误归到相应文档。 */ }
      });
    }
    return { fileAt: fileAt, collectFileHandles: collectFileHandles,
      readText: async function (path) { return (await (await fileAt(path)).getFile()).text(); } };
  }
  async function readManifest(directory) {
    var access = directoryAccess(directory, false);
    var raw = await access.readText(MANIFEST);
    return { raw: raw, manifest: parseManifest(raw), readText: access.readText, collectFileHandles: access.collectFileHandles,
      directory: directory, name: directory.name };
  }
  async function probeManifest(directory) {
    try { return await readManifest(directory); }
    catch (error) { if (error.name === 'NotFoundError') { return null; } throw error; }
  }
  async function inspectDirectory(directory, knownRoots, knownParents) {
    var header = await probeManifest(directory);
    if (header) { return { kind: 'root', directory: directory, header: header }; }
    // resolve 只比较真正的目录关系，不按目录名称猜测，也不会把同级目录当成内部目录。
    for (var root of knownRoots || []) {
      if (!root || !root.resolve) { continue; }
      try {
        var relative = await root.resolve(directory);
        if (relative && relative.length) { return { kind: 'inside', directory: root }; }
      } catch (ignored) { /* 失效的旧句柄不影响新目录识别。 */ }
    }
    for (var parent of knownParents || []) {
      if (!parent || !parent.resolve) { continue; }
      try {
        var path = await parent.resolve(directory);
        if (path && path.length > 1) {
          var ancestor = await parent.getDirectoryHandle(path[0]);
          if (await probeManifest(ancestor)) { return { kind: 'inside', directory: ancestor }; }
        }
      } catch (ignored) { /* 只在已经授权的范围内寻找根目录。 */ }
    }
    var children = [], candidates = [], sampleFile;
    for await (var [name, child] of directory.entries()) {
      if (name === '版本清单.json' || name === '上一版本清单.json') { return { kind: 'internal' }; }
      if (child.kind === 'directory') { children.push(child); }
      else if (name === '属性.json' || /^\d{4}-\d{2}-\d{2}\.json$/.test(name)) { sampleFile = sampleFile || child; }
      if (children.length > 256) { throw new Error('此目录包含较多子目录，请直接选择天道酬勤文件夹。'); }
    }
    if (sampleFile) {
      try {
        var doc = JSON.parse(await (await sampleFile.getFile()).text());
        if (doc && doc.format === 'tiandao-document') { return { kind: 'internal' }; }
      } catch (ignored) { /* 普通目录中的同名文件不是识别依据。 */ }
    }
    var headers = await parallel(children, 8, async function (child) {
      try { return await probeManifest(child); } catch (ignored) { return null; }
    });
    headers.forEach(function (item) { if (item) { candidates.push(item); } });
    if (!candidates.length && directory.name === '版本') { return { kind: 'internal' }; }
    return { kind: 'parent', directory: directory, candidates: candidates };
  }
  function hasDocumentHash(descriptor) {
    return typeof descriptor.sha256 === 'string' && /^[a-f0-9]{64}$/.test(descriptor.sha256);
  }
  function readRecord(text, descriptor, validate) {
    var document = parseDocument(text, descriptor);
    if (validate) { validate(document); }
    return { path: descriptor.path, name: descriptor.name, type: descriptor.type, raw: text, document: document };
  }
  async function matchLocalDocuments(descriptors, currentState, validate) {
    var matches = new Map();
    if (!currentState || !canHashDocuments() || !descriptors.some(hasDocumentHash)) { return matches; }
    var local;
    try { local = new Map(groupDocuments(currentState).map(function (doc) { return [documentPath(doc), doc]; })); }
    catch (ignored) { return matches; } // 本地数据无法拆分时仍按原方式读取目录。
    await parallel(descriptors, READ_CONCURRENCY, async function (descriptor) {
      var doc = local.get(descriptor.name);
      if (!doc || doc.type !== descriptor.type || !hasDocumentHash(descriptor)) { return; }
      try {
        var text = JSON.stringify(doc, null, 2);
        var digest = await sha256Text(text);
        if (digest !== descriptor.sha256) { return; }
        // 清单只代表保存时的内容。快捷预览也须经过相同的结构和业务检查。
        var record = readRecord(text, descriptor, validate);
        record.verifiedSha256 = digest; // 对应 record.raw 的摘要；提交时仍须按路径核对磁盘原文。
        matches.set(descriptor.name, record);
      } catch (ignored) { /* 无法用本地文档预览时，检查实际文件。 */ }
    });
    return matches;
  }
  async function readSource(readText, validate, header, collectFileHandles, currentState) {
    var raw;
    try { raw = header ? header.raw : await readText(MANIFEST); }
    catch (error) {
      if (error.name === 'NotFoundError' || error.message === '缺少文档：' + MANIFEST) { throw new Error('请选择包含「' + MANIFEST + '」的备份文件夹。'); }
      throw error;
    }
    var manifest = header ? header.manifest : parseManifest(raw);
    var matches = await matchLocalDocuments(manifest.documents, currentState, validate);
    if (collectFileHandles) {
      await collectFileHandles(manifest.documents.filter(function (descriptor) { return !matches.has(descriptor.name); }));
    }
    var records = await parallel(manifest.documents, READ_CONCURRENCY, async function (descriptor) {
      if (matches.has(descriptor.name)) { return matches.get(descriptor.name); }
      try {
        var text = await readText(descriptor.path);
        var record = readRecord(text, descriptor, validate);
        if (currentState && hasDocumentHash(descriptor)) { record.verifiedSha256 = await sha256Text(text); }
        return record;
      } catch (error) { return { path: descriptor.path, name: descriptor.name, type: descriptor.type, error: error.message }; }
    });
    return { raw: raw, manifest: manifest, records: records, readText: readText, hashMatches: matches.size };
  }
  async function readDirectory(directory, validate, header, currentState) {
    var access = header || directoryAccess(directory, false);
    var result = await readSource(access.readText, validate, header, access.collectFileHandles, currentState);
    result.directory = directory;
    result.name = directory.name;
    return result;
  }
  async function readFiles(files, validate) {
    var texts = new Map();
    var name = '';
    Array.from(files).forEach(function (file) {
      var parts = (file.webkitRelativePath || file.name).split('/');
      if (parts.length > 1) { name = parts.shift(); }
      var path = parts.join('/');
      safePath(path);
      if (texts.has(path)) { throw new Error('文件夹包含重复路径。'); }
      texts.set(path, file);
    });
    var prefix = '';
    if (!texts.has(MANIFEST)) {
      var roots = Array.from(texts.keys()).filter(function (path) { return path.split('/').length === 2 && path.endsWith('/' + MANIFEST); });
      if (roots.length > 1) { throw new Error('此位置包含多个天道酬勤目录，请选择其中一个文件夹。'); }
      if (roots.length === 1) { prefix = roots[0].slice(0, -MANIFEST.length); name = prefix.slice(0, -1); }
    }
    var result = await readSource(async function (path) {
      path = prefix + path;
      if (!texts.has(path)) { throw new Error('缺少文档：' + path); }
      return texts.get(path).text();
    }, validate);
    result.name = name || '所选文件夹';
    return result;
  }
  function folderSnapshotChanged(message) {
    return Object.assign(new Error(message), { name: 'FolderSnapshotChangedError' });
  }
  async function verifyText(readText, path, expected, message) {
    var actual;
    try { actual = await readText(path); }
    catch (error) {
      if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') { throw folderSnapshotChanged(message); }
      throw error;
    }
    if (actual !== expected) { throw folderSnapshotChanged(message); }
  }
  async function verifyDocuments(snapshot) {
    // 重新按路径找文件，才能识别预览期间被同名文件或目录替换的句柄。
    var access = snapshot.directory ? directoryAccess(snapshot.directory, false) : snapshot;
    if (access.collectFileHandles) { await access.collectFileHandles(snapshot.records); }
    await parallel(snapshot.records, READ_CONCURRENCY, async function (item) {
      await verifyText(access.readText, item.path, item.raw, '文件夹文档在检查后已发生变化：' + item.name);
    });
  }
  async function verifyManifest(snapshot) {
    var access = snapshot.directory ? directoryAccess(snapshot.directory, false) : snapshot;
    await verifyText(access.readText, MANIFEST, snapshot.raw, '文件夹在检查后已发生变化，请重新选择。');
  }
  async function verifySnapshot(snapshot) {
    if (snapshot.records.some(function (item) { return item.error; })) { throw new Error('文件夹含缺失或无效文档，不能更新。'); }
    await verifyDocuments(snapshot);
    await verifyManifest(snapshot);
  }
  async function uniqueDirectory(parent, name) {
    safePath(name);
    if (name.includes('/')) { throw new Error('文件夹名称无效。'); }
    var candidate = name;
    var suffix = 0;
    while (true) {
      try { await parent.getDirectoryHandle(candidate); }
      catch (error) {
        if (error.name === 'NotFoundError') { break; }
        if (error.name !== 'TypeMismatchError') { throw error; }
      }
      candidate = name + '-' + (++suffix);
    }
    var directory = await parent.getDirectoryHandle(candidate, { create: true });
    for await (var entry of directory.keys()) { throw new Error('目标文件夹已存在内容，请重新导出。'); }
    return directory;
  }
  function checkWriteSession(isCurrent) {
    if (isCurrent && !isCurrent()) { throw Object.assign(new Error('文件夹操作已取消。'), { name: 'AbortError' }); }
  }
  async function prepareDirectoryWrite(directory, state, token, expected) {
    // 固定复核所需的原文；预览期间的页面改动不能改变这次提交所依据的数据。
    var reviewed = expected && { directory: directory, raw: expected.raw, manifest: expected.manifest,
      records: expected.records.map(function (item) {
        if (item.error) { throw new Error('文件夹含缺失或无效文档，不能更新。'); }
        return { name: item.name, path: item.path, raw: item.raw, verifiedSha256: item.verifiedSha256 };
      }) };
    var bundle = await packageHashedFiles(state, token, reviewed);
    return { changed: bundle.changed, reused: bundle.reused, unchanged: bundle.unchanged,
      commit: function (isCurrent) { return commitDirectoryWrite(directory, token, reviewed, bundle, isCurrent); } };
  }
  function relocateVersion(bundle, token, expected) {
    // 实际版本名可能重名，只改新正文的引用；沿用的旧版本路径和已审阅的正文保持原样。
    var files = new Map();
    var documents = bundle.manifest.documents.map(function (item) {
      if (!bundle.files.has(item.path)) { return item; }
      var path = '版本/' + token + '/' + item.name;
      files.set(path, bundle.files.get(item.path));
      return { ...item, path: path };
    });
    return addManifests({ ...bundle, files: files, manifest: { ...bundle.manifest, documents: documents } }, token, expected);
  }
  async function commitDirectoryWrite(directory, token, expected, bundle, isCurrent) {
    function checkSession() { checkWriteSession(isCurrent); }
    checkSession();
    if (bundle.unchanged) { await verifySnapshot(expected); checkSession(); return bundle; }
    if (expected) { await verifyManifest(expected); }
    checkSession();
    var versions = await directory.getDirectoryHandle('版本', { create: true });
    var version = await uniqueDirectory(versions, token);
    if (version.name !== token) { bundle = relocateVersion(bundle, version.name, expected); }
    var access = directoryAccess(version, true);
    var versionPrefix = '版本/' + version.name + '/';
    var staged = [];
    bundle.files.forEach(function (raw, path) {
      if (path !== MANIFEST) { staged.push({ path: path, name: path, raw: raw }); }
    });
    await parallel(staged, WRITE_CONCURRENCY, async function (item) {
      checkSession();
      var handle = await access.fileAt(item.path.slice(versionPrefix.length));
      await backup.writeFile(handle, item.raw, '');
    });
    checkSession();
    // 最后原子替换清单；此前产生的未完成版本不会被导入流程读取。
    try {
      var manifest = await directory.getFileHandle(MANIFEST, { create: !expected });
      async function currentManifestHandle() {
        var current = await directory.getFileHandle(MANIFEST);
        if (current !== manifest && (!manifest.isSameEntry || !await manifest.isSameEntry(current))) {
          throw folderSnapshotChanged('文件夹清单在检查后已被替换，请重新选择。');
        }
        return current;
      }
      await backup.writeFile(manifest, bundle.files.get(MANIFEST), expected ? expected.raw : '', async function () {
        checkSession();
        // 从根目录按路径复核已检查的旧文件及本次暂存的文件，再切换根清单。
        await verifyDocuments({ directory: directory, records: expected ? expected.records.concat(staged) : staged });
        checkSession();
      }, currentManifestHandle);
    } catch (error) {
      if (expected && ['BackupFileChangedError', 'NotFoundError', 'TypeMismatchError'].includes(error.name)) {
        throw folderSnapshotChanged('文件夹在检查后已发生变化，请重新选择。');
      }
      throw error;
    }
    return bundle;
  }
  async function writeDirectory(directory, state, token, expected, isCurrent) {
    checkWriteSession(isCurrent);
    var prepared = await prepareDirectoryWrite(directory, state, token, expected);
    return prepared.commit(isCurrent);
  }
  // 不支持直接写入文件夹时，下载无压缩 ZIP，解压后仍是同一种备份目录。
  function zipFiles(files, folderName) {
    var encoder = new TextEncoder();
    var chunks = [], central = [], offset = 0, centralSize = 0;
    function header(size) { var data = new Uint8Array(size); return { data: data, view: new DataView(data.buffer) }; }
    function crc32(bytes) {
      var crc = -1;
      for (var byte of bytes) { crc ^= byte; for (var bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } }
      return (crc ^ -1) >>> 0;
    }
    for (var [path, text] of files) {
      var name = encoder.encode(safePath(folderName + '/' + path)), bytes = encoder.encode(text), crc = crc32(bytes);
      var local = header(30), record = header(46);
      local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x800, true);
      local.view.setUint16(12, 33, true);
      local.view.setUint32(14, crc, true); local.view.setUint32(18, bytes.length, true); local.view.setUint32(22, bytes.length, true); local.view.setUint16(26, name.length, true);
      record.view.setUint32(0, 0x02014b50, true); record.view.setUint16(4, 20, true); record.view.setUint16(6, 20, true); record.view.setUint16(8, 0x800, true);
      record.view.setUint16(14, 33, true);
      record.view.setUint32(16, crc, true); record.view.setUint32(20, bytes.length, true); record.view.setUint32(24, bytes.length, true); record.view.setUint16(28, name.length, true); record.view.setUint32(42, offset, true);
      chunks.push(local.data, name, bytes); central.push(record.data, name);
      offset += 30 + name.length + bytes.length; centralSize += 46 + name.length;
    }
    if (files.size > 65535 || offset + centralSize > 0xffffffff) { throw new Error('备份过大，请使用支持直接写入文件夹的浏览器。'); }
    var end = header(22);
    end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, files.size, true); end.view.setUint16(10, files.size, true);
    end.view.setUint32(12, centralSize, true); end.view.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [end.data]), { type: 'application/zip' });
  }
  return { manifestName: MANIFEST, createDocuments: createDocuments, parseDocument: parseDocument, documentPath: documentPath,
    readManifest: readManifest, inspectDirectory: inspectDirectory,
    assemble: assemble, packageFiles: packageFiles, packageHashedFiles: packageHashedFiles, sha256Text: sha256Text,
    readDirectory: readDirectory, readFiles: readFiles,
    verifySnapshot: verifySnapshot, uniqueDirectory: uniqueDirectory, prepareDirectoryWrite: prepareDirectoryWrite,
    writeDirectory: writeDirectory, zipFiles: zipFiles };
});
