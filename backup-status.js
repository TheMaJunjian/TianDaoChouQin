(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.TianDaoBackupStatus = factory(); }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function canonical(value) {
    if (Array.isArray(value)) { return value.map(canonical); }
    if (!value || typeof value !== 'object') { return value; }
    return Object.keys(value).sort().reduce(function (result, key) { result[key] = canonical(value[key]); return result; }, {});
  }
  // 仅用于识别备份后是否有业务改动，不用于安全校验。提示和界面草稿不触发提醒。
  function fingerprint(state) {
    var text = JSON.stringify(canonical(['entries', 'notes', 'noteCompletions', 'trashEntries', 'host', 'skills', 'achievements',
      'focus', 'points', 'quests', 'hiddenSkills', 'hiddenAchievements'].map(function (key) { return state[key]; })));
    var first = 2166136261;
    var second = 5381;
    for (var i = 0; i < text.length; i++) {
      first = Math.imul(first ^ text.charCodeAt(i), 16777619);
      second = Math.imul(second, 33) ^ text.charCodeAt(i);
    }
    return text.length + ':' + (first >>> 0).toString(16) + ':' + (second >>> 0).toString(16);
  }
  function normalize(value) {
    value = value && typeof value === 'object' ? value : {};
    return {
      enabled: value.enabled !== false,
      lastSavedAt: typeof value.lastSavedAt === 'string' && Number.isFinite(Date.parse(value.lastSavedAt)) ? value.lastSavedAt : '',
      lastSavedFingerprint: typeof value.lastSavedFingerprint === 'string' ? value.lastSavedFingerprint : '',
      lastSavedName: typeof value.lastSavedName === 'string' ? value.lastSavedName : '',
      dismissedFingerprint: typeof value.dismissedFingerprint === 'string' ? value.dismissedFingerprint : '',
      pendingDownload: value.pendingDownload && typeof value.pendingDownload.fingerprint === 'string' &&
        typeof value.pendingDownload.name === 'string' && Number.isFinite(Date.parse(value.pendingDownload.startedAt)) ? value.pendingDownload : null
    };
  }
  return { fingerprint: fingerprint, normalize: normalize };
});
