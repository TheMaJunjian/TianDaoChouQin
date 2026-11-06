/* 小型界面快照独立写入，完整业务快照仍由应用负责提交。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.TianDaoStorage = factory(); }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function create(accessStorage, key) {
    function readUi(revision) {
      var storage = accessStorage();
      for (var suffix of ['.ui', '.ui.backup']) {
        try {
          var value = JSON.parse(storage.getItem(key + suffix));
          if (value && value.version === 1 && value.dataRevision === revision && value.ui && typeof value.ui === 'object' && !Array.isArray(value.ui)) { return value; }
        } catch (error) { /* 尝试独立的界面副本。 */ }
      }
      return null;
    }
    function writeUi(value) {
      var storage = accessStorage();
      var serialized = JSON.stringify(value);
      if (storage.getItem(key + '.ui') !== serialized) { storage.setItem(key + '.ui', serialized); }
      try {
        if (storage.getItem(key + '.ui.backup') !== serialized) { storage.setItem(key + '.ui.backup', serialized); }
      } catch (error) { return false; }
      return true;
    }
    return { readUi: readUi, writeUi: writeUi };
  }
  return { create: create };
});
