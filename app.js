/* 天道酬勤 · 系统面板
 * 纯前端时间账本：宿主手动录入每个时间段，生成个人调试日志与一万小时进度。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'tiandao.entries.v1';
  var FOCUS_KEY = 'tiandao.focus.v1';
  var NAME_KEY = 'tiandao.host.v1';
  var GOAL_HOURS = 10000;
  var DAY_MINUTES = 1440;

  var state = {
    entries: load(STORAGE_KEY, []),
    focus: load(FOCUS_KEY, ''),
    host: load(NAME_KEY, '未命名修行者'),
    viewDate: todayStr()
  };

  var el = {};
  ['bootLine', 'hostName', 'todayFilled', 'todayMissing', 'totalHours', 'focusCategory',
   'focusLabel', 'focusPercent', 'focusFill', 'focusHint', 'entryForm', 'entryDate',
   'startTime', 'endTime', 'category', 'activity', 'level', 'formMsg', 'prevDay', 'nextDay',
   'viewDate', 'timeline', 'coverageFill', 'coverageHint', 'logDateLabel', 'logView',
   'copyLog', 'exportData', 'clearDay', 'catList'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /* ---------- 存储 ---------- */
  function load(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function saveKey(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      say('叮，存储模块异常，本次记录可能无法保存。');
    }
  }

  function saveEntries() { saveKey(STORAGE_KEY, state.entries); }
  function saveFocus() { saveKey(FOCUS_KEY, state.focus); }
  function saveHost() { saveKey(NAME_KEY, state.host); }

  /* ---------- 工具 ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function shiftDate(dateStr, days) {
    var p = dateStr.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function toMinutes(hhmm) {
    var p = hhmm.split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }

  function toClock(minutes) {
    return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
  }

  function hours(minutes) { return (minutes / 60).toFixed(1); }

  function byDate(dateStr) {
    return state.entries.filter(function (e) { return e.date === dateStr; })
      .sort(function (a, b) { return a.start - b.start; });
  }

  /* 合并重叠区间后统计已填时长，避免历史/导入数据重叠导致超过 24 小时。 */
  function filledMinutes(list) {
    var sorted = list.slice().sort(function (a, b) { return a.start - b.start; });
    var total = 0;
    var cursor = -1;
    sorted.forEach(function (e) {
      var start = Math.max(e.start, cursor);
      if (e.end > start) {
        total += e.end - start;
        cursor = e.end;
      }
    });
    return total;
  }

  function overlaps(list, start, end) {
    for (var i = 0; i < list.length; i++) {
      if (start < list[i].end && end > list[i].start) { return list[i]; }
    }
    return null;
  }

  function say(text) {
    el.formMsg.textContent = text;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 录入 ---------- */
  el.entryForm.addEventListener('submit', function (event) {
    event.preventDefault();

    var date = el.entryDate.value;
    var startRaw = el.startTime.value;
    var endRaw = el.endTime.value;
    var category = el.category.value.trim();
    var activity = el.activity.value.trim();

    if (!date || !startRaw || !endRaw || !category || !activity) {
      say('叮，输入不完整，检测功能丢失，需要宿主手动补全。');
      return;
    }

    var start = toMinutes(startRaw);
    // 结束时间填 00:00 视为当日 24:00（时间输入框无法表示 24:00）。
    var end = endRaw === '00:00' ? DAY_MINUTES : toMinutes(endRaw);

    if (end <= start) {
      say('叮，时间悖论警告：结束时间须晚于开始时间。跨夜请拆成两段记录。');
      return;
    }

    var dayList = byDate(date);
    var clash = overlaps(dayList, start, end);
    if (clash) {
      say('叮，时间线冲突：' + toClock(clash.start) + '-' + toClock(clash.end) +
        ' 已记录「' + clash.activity + '」，宿主无法分身。');
      return;
    }

    state.entries.push({
      id: String(Date.now()) + Math.random().toString(16).slice(2, 8),
      date: date,
      start: start,
      end: end,
      category: category,
      activity: activity,
      level: el.level.value
    });
    saveEntries();

    state.viewDate = date;
    el.viewDate.value = date;
    el.activity.value = '';
    el.startTime.value = end === DAY_MINUTES ? '' : toClock(end);
    el.endTime.value = '';

    say('叮，日志写入成功：' + toClock(start) + '-' + toClock(end) + ' ' + activity +
      '（+' + hours(end - start) + ' h）。');
    render();
  });

  /* ---------- 主修方向 ---------- */
  el.focusCategory.addEventListener('input', function () {
    state.focus = el.focusCategory.value.trim();
    saveFocus();
    renderFocus();
  });

  /* ---------- 宿主称号 ---------- */
  el.hostName.addEventListener('click', function () {
    renameHost();
  });

  function renameHost() {
    var name = window.prompt('叮，请宿主输入称号：', state.host);
    if (name === null) { return; }
    state.host = name.trim() || '未命名修行者';
    saveHost();
    el.hostName.textContent = state.host;
    say('叮，宿主称号已更新为「' + state.host + '」。');
  }

  /* ---------- 日期导航 ---------- */
  el.prevDay.addEventListener('click', function () { setViewDate(shiftDate(state.viewDate, -1)); });
  el.nextDay.addEventListener('click', function () { setViewDate(shiftDate(state.viewDate, 1)); });
  el.viewDate.addEventListener('change', function () {
    if (el.viewDate.value) { setViewDate(el.viewDate.value); }
  });

  function setViewDate(dateStr) {
    state.viewDate = dateStr;
    el.viewDate.value = dateStr;
    render();
  }

  /* ---------- 日志操作 ---------- */
  el.logView.addEventListener('click', function (event) {
    var id = event.target.getAttribute && event.target.getAttribute('data-del');
    if (!id) { return; }
    state.entries = state.entries.filter(function (e) { return e.id !== id; });
    saveEntries();
    say('叮，该段记录已从时间线抹除。');
    render();
  });

  el.copyLog.addEventListener('click', function () {
    var text = buildLogLines(state.viewDate).map(function (l) {
      return '[' + l.time + '] [' + l.level + '] ' + l.message;
    }).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        say('叮，日志已复制到剪贴板。');
      }, function () {
        say('叮，剪贴板权限缺失，需要宿主手动选中复制。');
      });
    } else {
      say('叮，剪贴板模块丢失，需要宿主手动选中复制。');
    }
  });

  el.exportData.addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state.entries, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'tiandao-chouqin-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    say('叮，修行数据已导出备份。');
  });

  el.clearDay.addEventListener('click', function () {
    if (!window.confirm('确认清空 ' + state.viewDate + ' 的全部记录？')) { return; }
    state.entries = state.entries.filter(function (e) { return e.date !== state.viewDate; });
    saveEntries();
    say('叮，当日时间线已重置。');
    render();
  });

  /* ---------- 日志生成 ---------- */
  function buildLogLines(dateStr) {
    var list = byDate(dateStr);
    var lines = [{
      time: '00:00:00',
      level: 'SYSTEM',
      message: '天道酬勤面板启动，载入 ' + dateStr + ' 时间线……',
      id: null
    }];

    if (!list.length) {
      lines.push({
        time: '00:00:00',
        level: 'ERROR',
        message: '检测功能丢失，当日无任何记录，需要宿主手动输入。',
        id: null
      });
      return lines;
    }

    var cursor = 0;
    list.forEach(function (e) {
      if (e.start > cursor) {
        lines.push({
          time: toClock(cursor) + ':00',
          level: 'WARN',
          message: '时间空洞 ' + toClock(cursor) + '-' + toClock(e.start) +
            '（' + hours(e.start - cursor) + ' h）：检测功能丢失，需要宿主手动输入。',
          id: null
        });
      }
      lines.push({
        time: toClock(e.start) + ':00',
        level: e.level,
        message: toClock(e.start) + '-' + toClock(e.end) + ' [' + e.category + '] ' +
          e.activity + '（' + hours(e.end - e.start) + ' h）',
        id: e.id
      });
      cursor = Math.max(cursor, e.end);
    });

    if (cursor < DAY_MINUTES) {
      lines.push({
        time: toClock(cursor) + ':00',
        level: 'WARN',
        message: '时间空洞 ' + toClock(cursor) + '-24:00（' + hours(DAY_MINUTES - cursor) +
          ' h）：检测功能丢失，需要宿主手动输入。',
        id: null
      });
    }

    var filled = filledMinutes(list);
    lines.push({
      time: '23:59:59',
      level: filled >= DAY_MINUTES ? 'SYSTEM' : 'WARN',
      message: filled >= DAY_MINUTES
        ? '叮，当日时间线已填满，日志归档完成，共 ' + list.length + ' 条记录。'
        : '当日日志尚未闭合，剩余 ' + hours(DAY_MINUTES - filled) + ' h 去向不明。',
      id: null
    });
    return lines;
  }

  /* ---------- 渲染 ---------- */
  function renderTimeline(list) {
    el.timeline.innerHTML = '';
    list.forEach(function (e) {
      var slot = document.createElement('div');
      slot.className = 'slot ' + e.level;
      slot.style.left = (e.start / DAY_MINUTES * 100) + '%';
      slot.style.width = ((e.end - e.start) / DAY_MINUTES * 100) + '%';
      slot.title = toClock(e.start) + '-' + toClock(e.end) + ' ' + e.category + ' · ' + e.activity;
      el.timeline.appendChild(slot);
    });
  }

  function renderLog(dateStr) {
    el.logDateLabel.textContent = dateStr;
    el.logView.innerHTML = buildLogLines(dateStr).map(function (l) {
      return '<div class="log-line"><span class="ts">[' + l.time + ']</span> ' +
        '<span class="lv-' + l.level + '">[' + l.level + ']</span> ' +
        '<span class="msg">' + escapeHtml(l.message) + '</span>' +
        (l.id ? ' <button class="del" data-del="' + l.id + '" title="删除该段">[x]</button>' : '') +
        '</div>';
    }).join('');
  }

  function normalize(name) { return String(name).trim().toLowerCase(); }

  function renderFocus() {
    var focus = state.focus;
    el.focusLabel.textContent = focus || '未设定';
    if (!focus) {
      el.focusFill.style.width = '0%';
      el.focusPercent.textContent = '0.000%';
      el.focusHint.textContent = '叮，未设定主修方向，无法计算大道进度。';
      return;
    }
    var key = normalize(focus);
    var minutes = state.entries.reduce(function (sum, e) {
      return normalize(e.category) === key ? sum + (e.end - e.start) : sum;
    }, 0);
    var h = minutes / 60;
    var percent = Math.min(h / GOAL_HOURS * 100, 100);
    el.focusFill.style.width = percent + '%';
    el.focusPercent.textContent = percent.toFixed(3) + '%';
    el.focusHint.textContent = '叮，「' + focus + '」已累计 ' + h.toFixed(1) +
      ' h，距一万小时之境还差 ' + Math.max(GOAL_HOURS - h, 0).toFixed(1) + ' h。';
  }

  function renderCategories() {
    var map = Object.create(null);
    state.entries.forEach(function (e) {
      var key = normalize(e.category);
      if (!map[key]) { map[key] = { name: e.category.trim(), minutes: 0 }; }
      map[key].minutes += e.end - e.start;
    });
    var rows = Object.keys(map).sort(function (a, b) { return map[b].minutes - map[a].minutes; });
    if (!rows.length) {
      el.catList.innerHTML = '<li><span>暂无数据</span><span>0.0 h</span></li>';
      return;
    }
    el.catList.innerHTML = rows.map(function (key) {
      return '<li><span>' + escapeHtml(map[key].name) + '</span><span>' +
        hours(map[key].minutes) + ' h</span></li>';
    }).join('');
  }

  function render() {
    var list = byDate(state.viewDate);
    var filled = filledMinutes(list);
    var todayList = byDate(todayStr());
    var todayFilled = filledMinutes(todayList);

    el.todayFilled.textContent = hours(todayFilled) + ' h';
    el.todayMissing.textContent = hours(Math.max(DAY_MINUTES - todayFilled, 0)) + ' h';
    el.totalHours.textContent = hours(filledMinutes(state.entries)) + ' h';

    var coverage = Math.min(filled / DAY_MINUTES * 100, 100);
    el.coverageFill.style.width = coverage + '%';
    el.coverageHint.textContent = state.viewDate + ' 时间线覆盖 ' + coverage.toFixed(1) + '%（' +
      hours(filled) + ' h / 24.0 h）' +
      (filled >= DAY_MINUTES ? ' · 叮，当日日志已闭合。' : ' · 检测功能丢失，剩余时段需要宿主手动输入。');

    renderTimeline(list);
    renderLog(state.viewDate);
    renderFocus();
    renderCategories();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    el.entryDate.value = todayStr();
    el.viewDate.value = state.viewDate;
    el.focusCategory.value = state.focus;
    el.hostName.textContent = state.host;

    var total = filledMinutes(state.entries) / 60;
    el.bootLine.textContent = state.entries.length
      ? '叮，欢迎回来，宿主。已载入 ' + state.entries.length + ' 条时间记录，累计修行 ' +
        total.toFixed(1) + ' h。检测模块仍未修复，需要宿主手动输入。'
      : '叮，系统绑定成功。检测模块丢失，需要宿主手动输入今日每一段时间。';

    render();
  }

  init();
})();
