/* 按内容类型与日期拆分备份；清单最后提交，更新失败仍可读取上一版本。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./backup.js')); }
  else { root.TianDaoFolder = factory(root.TianDaoBackup); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (backup) {
  'use strict';
  var MANIFEST = '备份清单.json';
  var FORMAT = 'tiandao-folder';
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
    var documents = ['profile', 'tasks', 'preferences'].map(function (type) {
      var data = {};
      FIELDS[type].forEach(function (key) { if (state[key] !== undefined) { data[key] = clone(state[key]); } });
      return makeDocument(type, data);
    });
    var days = new Map();
    function day(date) {
      date = validDate(date) ? date : '未标日期';
      if (!days.has(date)) { days.set(date, makeDocument('day', { entries: [], notes: [], noteCompletions: [], trashEntries: [], notifications: [] }, date)); }
      return days.get(date).data;
    }
    var notes = new Map((state.notes || []).map(function (note) { return [note.id, note]; }));
    var regressions = new Map((state.noteCompletions || []).filter(function (item) { return item.hours < 0; })
      .map(function (item) { return [item.id, item]; }));
    (state.entries || []).forEach(function (entry) { day(entry.startDate || entry.date).entries.push(clone(entry)); });
    (state.notes || []).forEach(function (note) {
      var regression = regressions.get(note.id);
      // 旧版退步备注与扣减记录同行，部分导入也不能把它恢复成未完成备注。
      day(regression ? localDate(regression.completedAt) : note.date).notes.push(clone(note));
    });
    (state.noteCompletions || []).forEach(function (item) {
      var note = notes.get(item.id);
      // 正数完成记录与备注同行，选择部分日期时也不能把已完成备注变回未完成。
      var date = item.hours < 0 ? localDate(item.completedAt) : (note ? note.date : item.noteDate || localDate(item.completedAt));
      day(date).noteCompletions.push(clone(item));
    });
    (state.trashEntries || []).forEach(function (item) { day(item.entry.startDate || item.entry.date).trashEntries.push(clone(item)); });
    (state.notifications || []).forEach(function (item) { day(localDate(item.ts)).notifications.push(clone(item)); });
    Array.from(days.keys()).sort().forEach(function (date) {
      var doc = days.get(date);
      var refs = new Map();
      doc.data.entries.forEach(function (entry) {
        var skill = (state.skills || []).find(function (skill) { return normalized(skill.name) === normalized(entry.category); });
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
        if (doc.type === 'day') { result[key] = result[key].concat(clone(doc.data[key])); }
        else if (doc.data[key] !== undefined) { result[key] = clone(doc.data[key]); }
      });
    });
    if (current) {
      if (!types.has('profile')) { result.host = clone(current.host); result.focus = current.focus; }
      if (!types.has('tasks')) { result.points = clone(current.points); result.quests = Object.assign({}, clone(current.quests), { side: [] }); }
    }
    var refs = documents.flatMap(function (doc) { return doc.skillRefs || []; });
    refs.forEach(function (ref) {
      var selected = result.skills.find(function (skill) { return skill.id === ref.id || normalized(skill.name) === normalized(ref.name); });
      if (!selected && !types.has('profile')) {
        var existing = current && current.skills.find(function (skill) { return skill.id === ref.id || normalized(skill.name) === normalized(ref.name); });
        selected = existing ? clone(existing) : { id: ref.id, name: ref.name, hours: 0 };
        result.skills.push(selected);
      }
      if (selected) {
        result.noteCompletions.forEach(function (item) { if (item.skillId === ref.id) { item.skillId = selected.id; item.skillName = selected.name; } });
      }
    });
    return result;
  }
  function packageFiles(state, token, previous) {
    safePath(token);
    if (token.includes('/')) { throw new Error('备份版本名无效。'); }
    var files = new Map();
    var old = new Map((previous ? previous.records : []).map(function (record) { return [record.name, record]; }));
    var reused = 0;
    var manifest = { format: FORMAT, version: 1, savedAt: new Date().toISOString(), documents: [] };
    createDocuments(state).forEach(function (doc) {
      var name = documentPath(doc);
      var path = '版本/' + token + '/' + name;
      var text = JSON.stringify(doc, null, 2);
      var existing = old.get(name);
      if (existing && !existing.error && existing.raw === text) { path = existing.path; reused++; }
      else { files.set(path, text); }
      manifest.documents.push({ path: path, name: name, type: doc.type });
    });
    var changed = files.size;
    var unchanged = !!previous && changed === 0 && previous.records.length === manifest.documents.length;
    var raw = JSON.stringify(manifest, null, 2);
    // 每个版本保留清单，未变化文档可引用旧版本，仍能还原任一历史快照。
    files.set('版本/' + token + '/版本清单.json', raw);
    if (previous) { files.set('版本/' + token + '/上一版本清单.json', previous.raw); }
    files.set(MANIFEST, raw);
    return { manifest: manifest, files: files, changed: changed, reused: reused, unchanged: unchanged };
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
    return { fileAt: fileAt, readText: async function (path) { return (await (await fileAt(path)).getFile()).text(); } };
  }
  async function readManifest(directory) {
    var access = directoryAccess(directory, false);
    var raw = await access.readText(MANIFEST);
    return { raw: raw, manifest: parseManifest(raw), readText: access.readText, directory: directory, name: directory.name };
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
  async function readSource(readText, validate, header) {
    var raw;
    try { raw = header ? header.raw : await readText(MANIFEST); }
    catch (error) {
      if (error.name === 'NotFoundError' || error.message === '缺少文档：' + MANIFEST) { throw new Error('请选择包含「' + MANIFEST + '」的备份文件夹。'); }
      throw error;
    }
    var manifest = header ? header.manifest : parseManifest(raw);
    var records = await parallel(manifest.documents, 12, async function (descriptor) {
      try {
        var text = await readText(descriptor.path);
        var document = parseDocument(text, descriptor);
        if (validate) { validate(document); }
        return { ...descriptor, raw: text, document: document };
      } catch (error) { return { ...descriptor, error: error.message }; }
    });
    return { raw: raw, manifest: manifest, records: records, readText: readText };
  }
  async function readDirectory(directory, validate, header) {
    var result = await readSource(header ? header.readText : directoryAccess(directory, false).readText, validate, header);
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
  async function verifySnapshot(snapshot) {
    if (snapshot.records.some(function (item) { return item.error; })) { throw new Error('文件夹含缺失或无效文档，不能更新。'); }
    if (await snapshot.readText(MANIFEST) !== snapshot.raw) { throw new Error('文件夹在检查后已发生变化，请重新选择。'); }
    await parallel(snapshot.records, 12, async function (item) {
      if (await snapshot.readText(item.path) !== item.raw) { throw new Error('文件夹文档在检查后已发生变化：' + item.name); }
    });
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
  async function writeDirectory(directory, state, token, expected, isCurrent) {
    function checkSession() { if (isCurrent && !isCurrent()) { throw Object.assign(new Error('文件夹操作已取消。'), { name: 'AbortError' }); } }
    checkSession();
    if (expected && expected.records.some(function (item) { return item.error; })) { throw new Error('文件夹含缺失或无效文档，不能更新。'); }
    if (expected && await expected.readText(MANIFEST) !== expected.raw) { throw new Error('文件夹在检查后已发生变化，请重新选择。'); }
    var bundle = packageFiles(state, token, expected);
    if (bundle.unchanged) { await verifySnapshot(expected); checkSession(); return bundle; }
    var versions = await directory.getDirectoryHandle('版本', { create: true });
    var version = await uniqueDirectory(versions, token);
    if (version.name !== token) { bundle = packageFiles(state, version.name, expected); }
    var access = directoryAccess(directory, true);
    await parallel(Array.from(bundle.files).filter(function (item) { return item[0] !== MANIFEST; }), 6, async function (item) {
      var path = item[0], text = item[1];
      checkSession();
      var handle = await access.fileAt(path);
      await backup.writeFile(handle, text, '');
      if (await (await handle.getFile()).text() !== text) { throw new Error('文档写入校验失败：' + path); }
    });
    checkSession();
    // 最后原子替换清单；此前产生的未完成版本不会被导入流程读取。
    var manifest = await access.fileAt(MANIFEST);
    await backup.writeFile(manifest, bundle.files.get(MANIFEST), expected ? expected.raw : '', async function () {
      checkSession();
      if (expected) { await verifySnapshot(expected); }
      checkSession();
    });
    return bundle;
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
    assemble: assemble, packageFiles: packageFiles, readDirectory: readDirectory, readFiles: readFiles,
    verifySnapshot: verifySnapshot, uniqueDirectory: uniqueDirectory, writeDirectory: writeDirectory, zipFiles: zipFiles };
});
