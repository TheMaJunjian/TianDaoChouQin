/* 复盘检索与周期统计：日期采用与时间账本一致的日历分钟，不受夏令时影响。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.TianDaoHistory = factory(); }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  var DAY = 1440;
  function dateMinute(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) { return NaN; }
    var stamp = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp / 60000 : NaN;
  }
  function dateString(minutes) { return new Date(minutes * 60000).toISOString().slice(0, 10); }
  function completedDate(value) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) { return ''; }
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function bounds(entry) {
    return { start: dateMinute(entry.startDate || entry.date) + Number(entry.start),
      end: dateMinute(entry.endDate || entry.date) + Number(entry.end) };
  }
  function skillName(state, completion) {
    var skill = (state.skills || []).find(function (item) { return item.id === completion.skillId; });
    return skill ? skill.name : completion.skillName || '';
  }
  function period(anchor, mode) {
    var start = dateMinute(anchor);
    if (!Number.isFinite(start)) { throw new Error('请选择有效日期。'); }
    var date = new Date(start * 60000);
    if (mode === 'month') {
      start = dateMinute(anchor.slice(0, 7) + '-01');
      var end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 60000;
      var previous = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) / 60000;
      return { start: start, end: end, previousStart: previous };
    }
    start -= ((date.getUTCDay() + 6) % 7) * DAY;
    return { start: start, end: start + 7 * DAY, previousStart: start - 7 * DAY };
  }
  function summarize(state, start, end, skill) {
    var days = [];
    for (var day = start; day < end; day += DAY) { days.push({ date: dateString(day), logHours: 0, noteHours: 0 }); }
    (state.entries || []).forEach(function (entry) {
      if (skill !== null && (entry.category || '') !== skill) { return; }
      var range = bounds(entry);
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= start || range.start >= end) { return; }
      var first = Math.max(0, Math.floor((range.start - start) / DAY));
      var last = Math.min(days.length - 1, Math.ceil((range.end - start) / DAY) - 1);
      for (var index = first; index <= last; index++) {
        days[index].logHours += Math.max(0, Math.min(range.end, start + (index + 1) * DAY) - Math.max(range.start, start + index * DAY)) / 60;
      }
    });
    var counted = new Set();
    (state.noteCompletions || []).forEach(function (completion) {
      if (counted.has(completion.id)) { return; }
      counted.add(completion.id);
      if (skill !== null && skillName(state, completion) !== skill) { return; }
      var day = dateMinute(completedDate(completion.completedAt));
      var hours = Number(completion.hours);
      if (day >= start && day < end && Number.isFinite(hours) && hours > 0) { days[(day - start) / DAY].noteHours += hours; }
    });
    var result = { days: days, logHours: 0, noteHours: 0, activeDays: 0 };
    days.forEach(function (day) {
      day.totalHours = day.logHours + day.noteHours;
      result.logHours += day.logHours;
      result.noteHours += day.noteHours;
      if (day.totalHours > 0) { result.activeDays++; }
    });
    result.totalHours = result.logHours + result.noteHours;
    return result;
  }
  function trend(state, anchor, mode, skill) {
    var range = period(anchor, mode);
    var result = summarize(state, range.start, range.end, skill == null ? null : skill);
    result.startDate = dateString(range.start);
    result.endDate = dateString(range.end - DAY);
    result.previousHours = summarize(state, range.previousStart, range.start, skill == null ? null : skill).totalHours;
    result.changeHours = result.totalHours - result.previousHours;
    return result;
  }
  function search(state, filters) {
    filters = filters || {};
    var start = filters.startDate ? dateMinute(filters.startDate) : -Infinity;
    var end = filters.endDate ? dateMinute(filters.endDate) + DAY : Infinity;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) { throw new Error('请检查日期范围，开始日期不能晚于结束日期。'); }
    var tokens = String(filters.query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    var matches = [];
    var completions = new Map((state.noteCompletions || []).map(function (item) { return [item.id, item]; }));
    function accept(row, begin, finish) {
      if (finish <= start || begin >= end) { return; }
      if (filters.skill != null && row.skill !== filters.skill) { return; }
      var text = (row.text + ' ' + row.skill).toLowerCase();
      if (!tokens.every(function (token) { return text.includes(token); })) { return; }
      matches.push(row);
    }
    function entryRow(entry, trashId) {
      var range = bounds(entry);
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) { return; }
      accept({ id: entry.id, key: (trashId ? 'trash-entry:' + trashId : 'entry:' + entry.id), kind: 'entry', trash: !!trashId,
        date: entry.startDate || entry.date, endDate: entry.endDate || entry.date, start: entry.start, end: entry.end,
        text: entry.activity, skill: entry.category || '', hours: (range.end - range.start) / 60, sort: range.start,
        jumpDate: dateString(Math.floor(Math.max(range.start, start) / DAY) * DAY) }, range.start, range.end);
    }
    if (!filters.kind || filters.kind === 'all' || filters.kind === 'entry') {
      (state.entries || []).forEach(function (entry) { entryRow(entry); });
      if (filters.includeTrash) { (state.trashEntries || []).forEach(function (item) { entryRow(item.entry, item.id); }); }
    }
    if (!filters.kind || filters.kind === 'all' || filters.kind === 'note') {
      (state.notes || []).forEach(function (note) {
        if (note.deletedAt && !filters.includeTrash) { return; }
        var completion = completions.get(note.id);
        var day = dateMinute(note.date);
        if (!Number.isFinite(day)) { return; }
        accept({ id: note.id, key: 'note:' + note.id, kind: 'note', trash: !!note.deletedAt, date: note.date,
          text: note.text, skill: completion ? skillName(state, completion) : '', hours: completion ? completion.hours : 0,
          completed: !!completion, sort: day, jumpDate: note.date }, day, day + DAY);
      });
    }
    matches.sort(function (a, b) { return b.sort - a.sort || a.key.localeCompare(b.key); });
    var pageSize = 50;
    var page = Math.max(0, Math.min(Math.ceil(matches.length / pageSize) - 1, Math.floor(Number(filters.page) || 0)));
    return { total: matches.length, page: page, pages: Math.max(1, Math.ceil(matches.length / pageSize)), rows: matches.slice(page * pageSize, (page + 1) * pageSize) };
  }
  function skillNames(state) {
    var names = new Set((state.skills || []).map(function (item) { return item.name; }));
    (state.entries || []).forEach(function (item) { if (item.category) { names.add(item.category); } });
    (state.noteCompletions || []).forEach(function (item) { var name = skillName(state, item); if (name) { names.add(name); } });
    (state.trashEntries || []).forEach(function (item) { if (item.entry.category) { names.add(item.entry.category); } });
    return Array.from(names).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
  }
  return { trend: trend, search: search, skillNames: skillNames };
});
