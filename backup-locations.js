/* 目录句柄只保存在本机 IndexedDB，不进入系统备份；选择器始终由点击触发。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.TianDaoBackupLocations = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var KEYS = ['export-folder', 'import-folder', 'update-folder', 'export-file', 'import-file', 'update-file'];
  function create(getIndexedDB, onChange) {
    var handles = Object.create(null), selected = new Set();
    function valid(handle) { return handle && ['directory', 'file'].includes(handle.kind) && typeof handle.name === 'string'; }
    var database = new Promise(function (resolve) {
      try {
        var abandoned = false;
        var request = getIndexedDB().open('tiandao.backup-locations', 1);
        request.onupgradeneeded = function () { request.result.createObjectStore('handles'); };
        request.onerror = request.onblocked = function () { abandoned = true; resolve(null); };
        request.onsuccess = function () {
          var db = request.result;
          if (abandoned) { db.close(); return; }
          db.onversionchange = function () { db.close(); };
          resolve(db);
        };
      } catch (error) { resolve(null); }
    });
    var ready = database.then(function (db) {
      if (!db) { return; }
      return new Promise(function (resolve) {
        try {
          var transaction = db.transaction('handles', 'readonly');
          var store = transaction.objectStore('handles');
          KEYS.forEach(function (key) {
            var request = store.get(key);
            request.onsuccess = function () {
              // 页面刚打开时的新选择不能被尚未读完的旧位置覆盖。
              if (!selected.has(key) && valid(request.result)) { handles[key] = request.result; }
            };
          });
          transaction.oncomplete = transaction.onabort = transaction.onerror = function () { resolve(); };
        } catch (error) { resolve(); }
      });
    }).then(function () { if (onChange) { onChange(); } });
    function remember(key, handle) {
      if (!KEYS.includes(key) || !valid(handle)) { return Promise.resolve(false); }
      selected.add(key);
      handles[key] = handle;
      if (onChange) { onChange(); }
      return database.then(function (db) {
        if (!db) { return false; }
        return new Promise(function (resolve) {
          try {
            var transaction = db.transaction('handles', 'readwrite');
            transaction.objectStore('handles').put(handle, key);
            transaction.oncomplete = function () { resolve(true); };
            transaction.onabort = transaction.onerror = function () { resolve(false); };
          } catch (error) { resolve(false); }
        });
      });
    }
    function get(key) { return handles[key] || null; }
    function options(key, values) {
      var handle = get(key);
      if (!handle && key === 'import-folder') { handle = get('update-folder'); }
      if (!handle && key === 'update-folder') { handle = get('import-folder'); }
      var result = Object.assign({}, values, { id: 'tiandao-' + key });
      if (handle) { result.startIn = handle; }
      return result;
    }
    return { ready: ready, remember: remember, get: get, options: options };
  }
  return { create: create };
});
