/* 天道酬勤 · 系统面板
 * 纯前端外挂面板：标签页容器 + 时间账本 + 任务系统 + 提示系统。
 * 所有数据仅保存在本机浏览器 localStorage，宿主可随时导入 / 导出。
 */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var APP_VERSION = '0.2'; // 开发者固件版本：本次更新即「主线任务」背后的真实版本迭代
  var STORAGE_KEY = 'tiandao.state.v2';
  var LEGACY_ENTRIES_KEY = 'tiandao.entries.v1';
  var LEGACY_FOCUS_KEY = 'tiandao.focus.v1';
  var LEGACY_NAME_KEY = 'tiandao.host.v1';
  var GOAL_HOURS = 10000;
  var DAY_MINUTES = 1440;
  var TOAST_DEDUPE_MS = 4000;

  var SKILL_LEVELS = [
    { key: 'aware', label: '了解', minHours: 0, locked: false },
    { key: 'beginner', label: '入门', minHours: 20, locked: false },
    { key: 'familiar', label: '熟悉', minHours: 300, locked: false },
    { key: 'proficient', label: '掌握', minHours: 1000, locked: false },
    { key: 'mastery', label: '精通', minHours: 5000, locked: false },
    { key: 'grandmaster', label: '宗师', minHours: 10000, locked: true },
    { key: 'perfection', label: '圆满', minHours: 30000, locked: true },
    { key: 'supernatural', label: '神通', minHours: 100000, locked: true }
  ];

  var MAIN_QUEST_CLUES = [
    '向幕后黑手提供两万五千亿资金',
    '注册成为「公论」与会者，并获得五十万贡献点',
    '帮助「公论」推广，使注册用户达到八十亿'
  ];

  /* ---------- 默认状态 ---------- */
  function defaultState() {
    return {
      entries: [],
      focus: '',
      host: {
        name: '未命名修行者',
        weight: '',
        education: '',
        talent: '',
        property: '',
        status: ''
      },
      skills: [],
      achievements: [],
      points: { attribute: 0, contribution: 0, achievement: 0 },
      quests: {
        mainRevealed: 0,   // 已解锁的主线线索数
        mainCompleted: 0,  // 已提交完成的主线线索数
        mainAccepted: false, // 当前线索是否已「接受」
        lastSeenAppVersion: '0.0',
        side: []
      },
      notifications: [],
      noticeSeenCount: 0,
      viewDate: todayStr(),
      firstRun: true
    };
  }

  var state = loadState();

  var el = {};
  [
    'toastStack', 'userVersion', 'pAch', 'pContrib', 'pAttr', 'tabbar',
    'questBadge', 'noticeBadge',
    'hostName', 'todayFilled', 'todayMissing', 'totalHours', 'focusCategory',
    'focusLabel', 'focusPercent', 'focusFill', 'focusHint',
    'attrWeight', 'attrEdu', 'attrTalent', 'attrProperty', 'attrStatus',
    'polishPercent', 'polishFill', 'polishHint',
    'skillForm', 'skillName', 'skillMode', 'skillLevelWrap', 'skillLevel',
    'skillHoursWrap', 'skillHours', 'skillList',
    'achForm', 'achName', 'achPoints', 'achDesc', 'achList',
    'entryForm', 'entryDate', 'startTime', 'endTime', 'category', 'activity',
    'level', 'prevDay', 'nextDay', 'viewDate', 'timeline', 'coverageFill',
    'coverageHint', 'logDateLabel', 'logView', 'copyLog', 'exportData',
    'importBtn', 'importFile', 'resetAll', 'clearDay', 'catList',
    'mainQuestBody', 'sideQuestForm', 'sideTitle', 'sideDesc', 'sideRewardAttr',
    'sideRewardContrib', 'sideQuestList', 'noticeView', 'clearNotices',
    'eggMask', 'eggCount', 'eggPause', 'eggBoost'
  ].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /* ---------- 存储 ---------- */
  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        return mergeDefaults(parsed);
      }
    } catch (e) { /* fall through to legacy / default */ }

    // 兼容旧版本（v1）数据，做一次性迁移
    var fresh = defaultState();
    try {
      var legacyEntries = window.localStorage.getItem(LEGACY_ENTRIES_KEY);
      var legacyFocus = window.localStorage.getItem(LEGACY_FOCUS_KEY);
      var legacyHost = window.localStorage.getItem(LEGACY_NAME_KEY);
      if (legacyEntries) { fresh.entries = JSON.parse(legacyEntries); }
      if (legacyFocus) { fresh.focus = JSON.parse(legacyFocus); }
      if (legacyHost) { fresh.host.name = JSON.parse(legacyHost); }
    } catch (e) { /* ignore malformed legacy data */ }
    return fresh;
  }

  function mergeDefaults(parsed) {
    var base = defaultState();
    if (!parsed || typeof parsed !== 'object') { return base; }
    var merged = base;

    function safe(fn) { try { fn(); } catch (e) { /* keep default for this field only */ } }

    safe(function () { merged.entries = Array.isArray(parsed.entries) ? parsed.entries : base.entries; });
    safe(function () { merged.focus = typeof parsed.focus === 'string' ? parsed.focus : base.focus; });
    safe(function () { merged.host = Object.assign({}, base.host, (parsed.host && typeof parsed.host === 'object') ? parsed.host : {}); });
    safe(function () { merged.skills = Array.isArray(parsed.skills) ? parsed.skills : base.skills; });
    safe(function () { merged.achievements = Array.isArray(parsed.achievements) ? parsed.achievements : base.achievements; });
    safe(function () { merged.points = Object.assign({}, base.points, (parsed.points && typeof parsed.points === 'object') ? parsed.points : {}); });
    safe(function () {
      merged.quests = Object.assign({}, base.quests, (parsed.quests && typeof parsed.quests === 'object') ? parsed.quests : {});
      merged.quests.side = Array.isArray(merged.quests.side) ? merged.quests.side : [];
    });
    safe(function () { merged.notifications = Array.isArray(parsed.notifications) ? parsed.notifications : []; });
    safe(function () { merged.noticeSeenCount = typeof parsed.noticeSeenCount === 'number' ? parsed.noticeSeenCount : 0; });
    safe(function () { merged.viewDate = typeof parsed.viewDate === 'string' ? parsed.viewDate : todayStr(); });
    merged.firstRun = false;
    return merged;
  }

  var saveTimer = null;
  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderTamperSignature();
    } catch (e) {
      toast('叮，存储模块异常，本次记录可能无法持久化保存。', { level: 'ERROR' });
    }
  }

  /* 简单校验签名：用于检测宿主是否绕过面板直接改写 localStorage 数值。 */
  function computeSignature() {
    var sideRewardSum = state.quests.side.reduce(function (sum, q) {
      return sum + (q.status === 'done' ? q.rewardAttr + q.rewardContrib : 0);
    }, 0);
    var achPointSum = state.achievements.reduce(function (sum, a) { return sum + a.points; }, 0);
    var skillHourSum = state.skills.reduce(function (sum, s) { return sum + s.hours; }, 0);
    var payload = [
      state.points.attribute, state.points.contribution, state.points.achievement,
      state.quests.mainCompleted, state.quests.mainRevealed,
      sideRewardSum, achPointSum, skillHourSum
    ].join('|');
    var hash = 0;
    for (var i = 0; i < payload.length; i++) {
      hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
    }
    return String(hash);
  }

  function renderTamperSignature() {
    try {
      window.localStorage.setItem(STORAGE_KEY + '.sig', computeSignature());
    } catch (e) { /* ignore */ }
  }

  function checkTamperOnBoot() {
    try {
      var savedSig = window.localStorage.getItem(STORAGE_KEY + '.sig');
      if (savedSig !== null && savedSig !== computeSignature()) {
        openEgg();
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- 工具 ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function pad3(n) { var s = String(n); while (s.length < 3) { s = '0' + s; } return s; }

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

  function rawMinutes(list) {
    return list.reduce(function (sum, e) { return sum + (e.end - e.start); }, 0);
  }

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

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normalize(name) { return String(name).trim().toLowerCase(); }

  function uid() { return String(Date.now()) + Math.random().toString(16).slice(2, 8); }

  /* ---------- 提示系统：弹出 toast + 写入「提示」标签页日志 ---------- */
  var lastToastKey = '';
  var lastToastAt = 0;

  function toast(text, opts) {
    opts = opts || {};
    var now = Date.now();
    var key = text;
    var dupe = key === lastToastKey && (now - lastToastAt) < TOAST_DEDUPE_MS;
    lastToastKey = key;
    lastToastAt = now;

    if (!dupe) {
      var card = document.createElement('div');
      card.className = 'toast' + (opts.level ? ' toast-' + opts.level : '');
      card.textContent = text;
      el.toastStack.appendChild(card);
      window.setTimeout(function () { card.classList.add('show'); }, 10);
      window.setTimeout(function () {
        card.classList.remove('show');
        window.setTimeout(function () { card.remove(); }, 400);
      }, 4200);
    }

    // 记录到提示标签页：即便短时间重复触发也只在日志里追加一次「(x n)」计数，避免刷屏。
    var last = state.notifications[state.notifications.length - 1];
    if (last && last.text === text && (now - last.ts) < TOAST_DEDUPE_MS) {
      last.count = (last.count || 1) + 1;
      last.ts = now;
    } else {
      state.notifications.push({ id: uid(), text: text, ts: now, count: 1 });
      if (state.notifications.length > 300) { state.notifications.shift(); }
    }
    persist();
    renderNotifications();
  }

  /* ---------- 属性点强化：始终锁定，仅作为「未来可期」的占位 ---------- */
  document.querySelectorAll('.attr-plus').forEach(function (btn) {
    btn.addEventListener('click', function () {
      toast('叮，系统等级不足，当前功能缺失。请完成主线任务以解锁属性强化模块。', { level: 'WARN' });
    });
  });

  /* ---------- 标签页切换 ---------- */
  el.tabbar.addEventListener('click', function (event) {
    var btn = event.target.closest('.tab-btn');
    if (!btn) { return; }
    setActiveTab(btn.getAttribute('data-tab'));
  });

  function setActiveTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-tab-panel') === tab);
    });
    if (tab === 'quest') { onOpenQuestTab(); }
    if (tab === 'notice') {
      state.noticeSeenCount = state.notifications.length;
      persist();
      updateNoticeBadge();
    }
  }

  /* ---------- 宿主称号 ---------- */
  el.hostName.addEventListener('click', function () {
    var name = window.prompt('叮，请宿主输入称号：', state.host.name);
    if (name === null) { return; }
    state.host.name = name.trim() || '未命名修行者';
    persist();
    el.hostName.textContent = state.host.name;
    toast('叮，宿主称号已更新为「' + state.host.name + '」。系统已绑定。');
    renderPolish();
  });

  /* ---------- 主修方向 ---------- */
  el.focusCategory.addEventListener('input', function () {
    state.focus = el.focusCategory.value.trim();
    persist();
    renderFocus();
  });

  /* ---------- 基础属性 ---------- */
  function bindAttrField(inputEl, field, label) {
    inputEl.addEventListener('change', function () {
      var value = inputEl.value.trim();
      state.host[field] = value;
      persist();
      if (value) {
        toast('叮，检测到宿主' + label + '数据录入：【' + value + '】，属性面板已更新。');
      }
      renderPolish();
    });
  }
  bindAttrField(el.attrWeight, 'weight', '体重');
  bindAttrField(el.attrEdu, 'education', '学历');
  bindAttrField(el.attrTalent, 'talent', '天赋');
  bindAttrField(el.attrProperty, 'property', '财产');
  bindAttrField(el.attrStatus, 'status', '状态');

  /* ---------- 技能 ---------- */
  function fillSkillLevelSelect() {
    el.skillLevel.innerHTML = SKILL_LEVELS.filter(function (l) { return !l.locked; }).map(function (l) {
      return '<option value="' + l.key + '">' + l.label + '（约 ' + l.minHours + '+ 小时）</option>';
    }).join('');
  }
  fillSkillLevelSelect();

  el.skillMode.addEventListener('change', function () {
    var byLevel = el.skillMode.value === 'level';
    el.skillLevelWrap.classList.toggle('hidden', !byLevel);
    el.skillHoursWrap.classList.toggle('hidden', byLevel);
  });

  function levelForHours(h) {
    var current = SKILL_LEVELS[0];
    for (var i = 0; i < SKILL_LEVELS.length; i++) {
      if (h >= SKILL_LEVELS[i].minHours) { current = SKILL_LEVELS[i]; }
    }
    return current;
  }

  el.skillForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = el.skillName.value.trim();
    if (!name) { return; }

    var hoursValue;
    if (el.skillMode.value === 'level') {
      var levelKey = el.skillLevel.value;
      var levelDef = SKILL_LEVELS.filter(function (l) { return l.key === levelKey; })[0];
      hoursValue = levelDef ? levelDef.minHours : 0;
    } else {
      hoursValue = Math.max(0, Number(el.skillHours.value) || 0);
    }

    var existing = state.skills.filter(function (s) { return normalize(s.name) === normalize(name); })[0];
    if (existing) {
      existing.hours = hoursValue;
    } else {
      state.skills.push({ id: uid(), name: name, hours: hoursValue });
    }
    persist();

    var lv = levelForHours(hoursValue);
    toast('叮，检测到宿主技能【' + name + '】，当前等级：' + lv.label +
      '（累计 ' + hoursValue + ' 小时）。');

    el.skillForm.reset();
    fillSkillLevelSelect();
    el.skillLevelWrap.classList.remove('hidden');
    el.skillHoursWrap.classList.add('hidden');
    renderSkills();
    renderPolish();
  });

  el.skillList.addEventListener('click', function (event) {
    var id = event.target.getAttribute && event.target.getAttribute('data-del-skill');
    if (!id) { return; }
    var skill = state.skills.filter(function (s) { return s.id === id; })[0];
    state.skills = state.skills.filter(function (s) { return s.id !== id; });
    persist();
    if (skill) { toast('叮，技能【' + skill.name + '】记录已从面板抹除。'); }
    renderSkills();
    renderPolish();
  });

  function renderSkills() {
    if (!state.skills.length) {
      el.skillList.innerHTML = '<li class="empty">暂无技能记录，快去投入时间修炼一门手艺吧。</li>';
      return;
    }
    el.skillList.innerHTML = state.skills.slice().sort(function (a, b) { return b.hours - a.hours; }).map(function (s) {
      var lv = levelForHours(s.hours);
      var next = SKILL_LEVELS[SKILL_LEVELS.indexOf(lv) + 1];
      var progressText = next
        ? (next.locked
          ? '（检测到更高等级「' + next.label + '」，功能缺失，需完成主线任务解锁）'
          : '（距「' + next.label + '」还差 ' + Math.max(next.minHours - s.hours, 0) + ' 小时）')
        : '';
      return '<li class="skill-item' + (lv.locked ? ' locked' : '') + '">' +
        '<div class="skill-head"><span class="skill-name">' + escapeHtml(s.name) + '</span>' +
        '<span class="skill-lv">' + lv.label + '</span></div>' +
        '<div class="skill-meta">累计 ' + s.hours + ' 小时 ' + progressText + '</div>' +
        '<button type="button" class="del" data-del-skill="' + s.id + '" title="删除">[x]</button>' +
        '</li>';
    }).join('');
  }

  /* ---------- 成就 ---------- */
  el.achForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = el.achName.value.trim();
    if (!name) { return; }
    var points = Math.max(1, Math.min(999, Number(el.achPoints.value) || 1));
    var desc = el.achDesc.value.trim();
    state.achievements.push({ id: uid(), name: name, points: points, desc: desc });
    state.points.achievement += points;
    persist();
    toast('叮，检测到宿主达成成就【' + name + '】，获得成就点 +' + points + '。');
    el.achForm.reset();
    el.achPoints.value = 10;
    renderAchievements();
    renderPoints();
    renderPolish();
  });

  el.achList.addEventListener('click', function (event) {
    var id = event.target.getAttribute && event.target.getAttribute('data-del-ach');
    if (!id) { return; }
    state.achievements = state.achievements.filter(function (a) { return a.id !== id; });
    persist();
    renderAchievements();
  });

  function renderAchievements() {
    if (!state.achievements.length) {
      el.achList.innerHTML = '<li class="empty">暂无成就，宿主的传说尚待书写。</li>';
      return;
    }
    el.achList.innerHTML = state.achievements.slice().reverse().map(function (a) {
      return '<li class="ach-item"><span class="ach-name">🏆 ' + escapeHtml(a.name) +
        '</span><span class="ach-pt">+' + a.points + '</span>' +
        (a.desc ? '<div class="ach-desc">' + escapeHtml(a.desc) + '</div>' : '') +
        '<button type="button" class="del" data-del-ach="' + a.id + '" title="删除">[x]</button></li>';
    }).join('');
  }

  /* ---------- 录入时间段 ---------- */
  el.entryForm.addEventListener('submit', function (event) {
    event.preventDefault();

    var date = el.entryDate.value;
    var startRaw = el.startTime.value;
    var endRaw = el.endTime.value;
    var category = el.category.value.trim();
    var activity = el.activity.value.trim();

    if (!date || !startRaw || !endRaw || !category || !activity) {
      toast('叮，输入不完整，检测功能丢失，需要宿主手动补全。', { level: 'WARN' });
      return;
    }

    var start = toMinutes(startRaw);
    var end = toMinutes(endRaw) || DAY_MINUTES;

    if (end <= start) {
      toast('叮，时间悖论警告：结束时间须晚于开始时间。跨夜请拆成两段记录。', { level: 'ERROR' });
      return;
    }

    var dayList = byDate(date);
    var clash = overlaps(dayList, start, end);
    if (clash) {
      toast('叮，时间线冲突：' + toClock(clash.start) + '-' + toClock(clash.end) +
        ' 已记录「' + clash.activity + '」，宿主无法分身。', { level: 'ERROR' });
      return;
    }

    state.entries.push({
      id: uid(),
      date: date,
      start: start,
      end: end,
      category: category,
      activity: activity,
      level: el.level.value
    });
    persist();

    state.viewDate = date;
    el.viewDate.value = date;
    el.activity.value = '';
    el.startTime.value = end === DAY_MINUTES ? '' : toClock(end);
    el.endTime.value = '';

    toast('叮，日志写入成功：' + toClock(start) + '-' + toClock(end) + ' ' + activity +
      '（+' + hours(end - start) + ' h）。');
    render();
  });

  /* ---------- 日期导航 ---------- */
  el.prevDay.addEventListener('click', function () { setViewDate(shiftDate(state.viewDate, -1)); });
  el.nextDay.addEventListener('click', function () { setViewDate(shiftDate(state.viewDate, 1)); });
  el.viewDate.addEventListener('change', function () {
    if (el.viewDate.value) { setViewDate(el.viewDate.value); }
  });

  function setViewDate(dateStr) {
    state.viewDate = dateStr;
    el.viewDate.value = dateStr;
    persist();
    render();
  }

  /* ---------- 日志操作 ---------- */
  el.logView.addEventListener('click', function (event) {
    var id = event.target.getAttribute && event.target.getAttribute('data-del');
    if (!id) { return; }
    state.entries = state.entries.filter(function (e) { return e.id !== id; });
    persist();
    toast('叮，该段记录已从时间线抹除。');
    render();
  });

  el.copyLog.addEventListener('click', function () {
    var text = buildLogLines(state.viewDate).map(function (l) {
      return '[' + l.time + '] [' + l.level + '] ' + l.message;
    }).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('叮，日志已复制到剪贴板。');
      }, function () {
        toast('叮，剪贴板权限缺失，需要宿主手动选中复制。', { level: 'WARN' });
      });
    } else {
      toast('叮，剪贴板模块丢失，需要宿主手动选中复制。', { level: 'WARN' });
    }
  });

  el.clearDay.addEventListener('click', function () {
    if (!window.confirm('确认清空 ' + state.viewDate + ' 的全部记录？')) { return; }
    state.entries = state.entries.filter(function (e) { return e.date !== state.viewDate; });
    persist();
    toast('叮，当日时间线已重置。');
    render();
  });

  /* ---------- 数据导入 / 导出 ---------- */
  el.exportData.addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'tiandao-chouqin-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('叮，修行数据已导出备份。');
  });

  el.importBtn.addEventListener('click', function () { el.importFile.click(); });
  el.importFile.addEventListener('change', function () {
    var file = el.importFile.files && el.importFile.files[0];
    if (!file) { return; }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        state = mergeDefaults(parsed);
        persist();
        toast('叮，宿主数据导入成功，面板已重新同步。');
        fullRender();
      } catch (e) {
        toast('叮，导入文件格式异常，数据未变更。', { level: 'ERROR' });
      }
    };
    reader.readAsText(file);
    el.importFile.value = '';
  });

  el.resetAll.addEventListener('click', function () {
    if (!window.confirm('确认重置全部本地数据？此操作不可撤销，请先导出备份。')) { return; }
    state = defaultState();
    persist();
    toast('叮，系统已恢复出厂设置。检测模块丢失，一切需要宿主重新手动输入。');
    fullRender();
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

  /* ---------- 渲染：时间轴 / 日志 / 统计 ---------- */
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

  /* ---------- 面板华丽度 ---------- */
  function renderPolish() {
    var checks = [
      state.host.name && state.host.name !== '未命名修行者',
      !!state.host.weight,
      !!state.host.education,
      !!state.host.talent,
      !!state.host.property,
      !!state.host.status,
      state.skills.length > 0,
      state.achievements.length > 0
    ];
    var filled = checks.filter(Boolean).length;
    var percent = Math.round(filled / checks.length * 100);
    el.polishPercent.textContent = percent + '%';
    el.polishFill.style.width = percent + '%';

    var tier = percent >= 100 ? 4 : percent >= 75 ? 3 : percent >= 50 ? 2 : percent >= 25 ? 1 : 0;
    document.body.className = document.body.className.replace(/\bpolish-\d\b/g, '').trim();
    document.body.classList.add('polish-' + tier);

    var hints = [
      '叮，面板仍是最朴素的调试界面，快去补全属性。',
      '叮，检测到属性数据流入，面板开始泛起微光。',
      '叮，属性完整度过半，系统外壳纹路逐渐显现。',
      '叮，属性接近完整，面板特效即将全部激活。',
      '叮，属性已全部录入！完整版特效面板已激活——此刻，你才是真正的天选宿主。'
    ];
    el.polishHint.textContent = hints[tier];
  }

  /* ---------- 积分展示 ---------- */
  function renderPoints() {
    el.pAch.textContent = state.points.achievement;
    el.pContrib.textContent = state.points.contribution;
    el.pAttr.textContent = state.points.attribute;
  }

  /* ---------- 版本号 ---------- */
  function userVersionText() {
    return state.quests.mainCompleted > 0
      ? '0.1' + pad3(state.quests.mainCompleted)
      : '0.1';
  }
  function renderVersion() {
    el.userVersion.textContent = userVersionText();
  }

  /* ---------- 任务系统 ---------- */
  function onOpenQuestTab() {
    if (state.quests.mainRevealed === 0) {
      state.quests.mainRevealed = 1;
      persist();
      toast('叮，获得主线任务：解锁系统面板全部功能，当前进度 0/' + MAIN_QUEST_CLUES.length + '。');
    } else if (state.quests.lastSeenAppVersion !== APP_VERSION &&
      state.quests.mainRevealed < MAIN_QUEST_CLUES.length &&
      state.quests.mainCompleted >= state.quests.mainRevealed) {
      state.quests.mainRevealed += 1;
      state.quests.mainAccepted = false;
      state.quests.lastSeenAppVersion = APP_VERSION;
      persist();
      toast('叮，检测到系统固件更新（' + previousVersionTag() + ' → ' + APP_VERSION +
        '），解锁主线任务线索 ' + state.quests.mainRevealed + '：' +
        MAIN_QUEST_CLUES[state.quests.mainRevealed - 1]);
    }
    renderMainQuest();
    renderSideQuests();
    updateQuestBadge();
  }

  function previousVersionTag() {
    var parts = APP_VERSION.split('.');
    var minor = Number(parts[1] || 0);
    return parts[0] + '.' + Math.max(minor - 1, 0);
  }

  function currentClueIndex() { return state.quests.mainCompleted; } // 0-based，指向下一条待完成线索

  function renderMainQuest() {
    var total = MAIN_QUEST_CLUES.length;
    var completed = state.quests.mainCompleted;
    var revealed = state.quests.mainRevealed;

    if (revealed === 0) {
      el.mainQuestBody.innerHTML = '<p class="hint">叮，主线任务尚未加载，请稍候……</p>';
      return;
    }

    var html = '<div class="quest-progress">解锁系统面板全部功能 · 进度 ' + completed + '/' + total + '</div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + (completed / total * 100) + '%"></div></div>';

    if (completed >= total) {
      html += '<p class="hint">叮，当前已发布的主线任务线索已全部完成，固件版本 ' + userVersionText() +
        '。等待开发者发布下一次系统更新（当前固件 ' + APP_VERSION + '）。</p>';
    } else if (completed < revealed) {
      var clue = MAIN_QUEST_CLUES[completed];
      html += '<div class="quest-card">' +
        '<div class="quest-title">线索 ' + (completed + 1) + '：' + escapeHtml(clue) + '</div>' +
        '<div class="quest-actions">' +
        '<button type="button" class="btn ghost" id="questGuide">查看指引</button>' +
        (state.quests.mainAccepted
          ? '<button type="button" class="btn" id="questSubmit">提交任务</button>'
          : '<button type="button" class="btn" id="questAccept">接受任务</button>') +
        '</div></div>';
    } else {
      html += '<p class="hint">叮，本条线索已提交，等待固件更新解锁下一条线索。可尝试重新进入本标签页检查更新。</p>';
    }
    el.mainQuestBody.innerHTML = html;

    var guideBtn = document.getElementById('questGuide');
    if (guideBtn) {
      guideBtn.addEventListener('click', function () {
        toast('叮，任务指引：完成后点击「提交任务」，系统将自动核算固件版本，奖励属性点 +5。');
      });
    }
    var acceptBtn = document.getElementById('questAccept');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', function () {
        state.quests.mainAccepted = true;
        persist();
        toast('叮，已接受主线任务线索 ' + (completed + 1) + '，祝宿主武运昌隆。');
        renderMainQuest();
      });
    }
    var submitBtn = document.getElementById('questSubmit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () { submitMainQuest(); });
    }
  }

  function submitMainQuest() {
    state.quests.mainCompleted += 1;
    state.quests.mainAccepted = false;
    state.points.attribute += 5;
    persist();
    renderPoints();
    renderVersion();
    toast('叮，系统正在升级……');
    window.setTimeout(function () {
      toast('叮，系统升级完成。');
      window.setTimeout(function () {
        toast('叮，系统已经升级到第 ' + userVersionText() + ' 版，获得属性点 +5。');
        renderMainQuest();
        updateQuestBadge();
      }, 700);
    }, 700);
  }

  el.sideQuestForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var title = el.sideTitle.value.trim();
    if (!title) { return; }
    var desc = el.sideDesc.value.trim();
    var rewardAttr = Math.max(0, Math.min(20, Number(el.sideRewardAttr.value) || 0));
    var rewardContrib = Math.max(0, Math.min(20, Number(el.sideRewardContrib.value) || 0));
    state.quests.side.push({
      id: uid(), title: title, desc: desc,
      rewardAttr: rewardAttr, rewardContrib: rewardContrib,
      status: 'open'
    });
    persist();
    toast('叮，宿主已发布支线任务【' + title + '】。');
    el.sideQuestForm.reset();
    el.sideRewardAttr.value = 1;
    el.sideRewardContrib.value = 1;
    renderSideQuests();
    updateQuestBadge();
  });

  el.sideQuestList.addEventListener('click', function (event) {
    var target = event.target;
    var id = target.getAttribute && (
      target.getAttribute('data-accept') || target.getAttribute('data-submit') || target.getAttribute('data-del-quest')
    );
    if (!id) { return; }
    var quest = state.quests.side.filter(function (q) { return q.id === id; })[0];
    if (!quest) { return; }

    if (target.hasAttribute('data-accept')) {
      quest.status = 'accepted';
      persist();
      toast('叮，已接受支线任务【' + quest.title + '】。');
    } else if (target.hasAttribute('data-submit')) {
      quest.status = 'done';
      state.points.attribute += quest.rewardAttr;
      state.points.contribution += quest.rewardContrib;
      persist();
      toast('叮，支线任务【' + quest.title + '】已完成，获得属性点 +' + quest.rewardAttr +
        '，贡献点 +' + quest.rewardContrib + '。');
      renderPoints();
    } else if (target.hasAttribute('data-del-quest')) {
      state.quests.side = state.quests.side.filter(function (q) { return q.id !== id; });
      persist();
    }
    renderSideQuests();
    updateQuestBadge();
  });

  function renderSideQuests() {
    if (!state.quests.side.length) {
      el.sideQuestList.innerHTML = '<li class="empty">暂无支线任务，快给自己安排一个吧。</li>';
      return;
    }
    el.sideQuestList.innerHTML = state.quests.side.slice().reverse().map(function (q) {
      var statusLabel = { open: '未接受', accepted: '进行中', done: '已完成' }[q.status];
      var actions = '';
      if (q.status === 'open') {
        actions = '<button type="button" class="btn ghost" data-accept="' + q.id + '">接受任务</button>';
      } else if (q.status === 'accepted') {
        actions = '<button type="button" class="btn" data-submit="' + q.id + '">提交任务</button>';
      }
      actions += '<button type="button" class="del" data-del-quest="' + q.id + '" title="删除">[x]</button>';
      return '<li class="quest-item quest-' + q.status + '">' +
        '<div class="quest-title">' + escapeHtml(q.title) + ' <span class="quest-status">[' + statusLabel + ']</span></div>' +
        (q.desc ? '<div class="quest-desc">' + escapeHtml(q.desc) + '</div>' : '') +
        '<div class="quest-reward">奖励：属性点 +' + q.rewardAttr + ' ／ 贡献点 +' + q.rewardContrib + '</div>' +
        '<div class="quest-actions">' + actions + '</div></li>';
    }).join('');
  }

  function updateQuestBadge() {
    var pendingMain = (state.quests.mainRevealed > state.quests.mainCompleted) ? 1 : 0;
    var pendingSide = state.quests.side.filter(function (q) { return q.status !== 'done'; }).length;
    var total = pendingMain + pendingSide;
    el.questBadge.textContent = total > 0 ? total : '';
  }

  /* ---------- 提示标签页 ---------- */
  function renderNotifications() {
    var list = state.notifications.slice().reverse();
    if (!list.length) {
      el.noticeView.innerHTML = '<div class="log-line"><span class="msg">暂无提示记录。</span></div>';
    } else {
      el.noticeView.innerHTML = list.map(function (n) {
        var d = new Date(n.ts);
        var time = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        return '<div class="log-line"><span class="ts">[' + time + ']</span> <span class="msg">' +
          escapeHtml(n.text) + '</span>' + (n.count > 1 ? ' <span class="hint">(×' + n.count + ')</span>' : '') +
          '</div>';
      }).join('');
    }
    updateNoticeBadge();
  }

  function updateNoticeBadge() {
    var unread = Math.max(state.notifications.length - state.noticeSeenCount, 0);
    el.noticeBadge.textContent = unread > 0 ? unread : '';
  }

  el.clearNotices.addEventListener('click', function () {
    state.notifications = [];
    state.noticeSeenCount = 0;
    persist();
    renderNotifications();
  });

  /* ---------- 异常检测彩蛋 ---------- */
  var eggTimer = null;
  var eggValue = 100;

  function openEgg() {
    eggValue = 100;
    el.eggCount.textContent = eggValue;
    el.eggMask.classList.remove('hidden');
    startEggTimer();
  }

  function startEggTimer() {
    stopEggTimer();
    eggTimer = window.setInterval(function () {
      eggValue -= 1;
      el.eggCount.textContent = eggValue;
      el.eggCount.classList.toggle('negative', eggValue < 0);
    }, 1000);
  }

  function stopEggTimer() {
    if (eggTimer) { window.clearInterval(eggTimer); eggTimer = null; }
  }

  el.eggPause.addEventListener('click', function () {
    stopEggTimer();
  });

  el.eggBoost.addEventListener('click', function () {
    // 根据当前倒计时值 v，加速 (v+1) 秒，使其瞬间越过 0 来到 -1，随后继续正常递减。
    eggValue = eggValue - (eggValue + 1);
    el.eggCount.textContent = eggValue;
    el.eggCount.classList.add('negative');
    if (!eggTimer) { startEggTimer(); }
  });

  /* ---------- 汇总渲染 ---------- */
  function render() {
    var list = byDate(state.viewDate);
    var filled = filledMinutes(list);
    var todayList = byDate(todayStr());
    var todayFilled = filledMinutes(todayList);

    el.todayFilled.textContent = hours(todayFilled) + ' h';
    el.todayMissing.textContent = hours(Math.max(DAY_MINUTES - todayFilled, 0)) + ' h';
    el.totalHours.textContent = hours(rawMinutes(state.entries)) + ' h';

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

  function fullRender() {
    el.entryDate.value = todayStr();
    el.viewDate.value = state.viewDate;
    el.focusCategory.value = state.focus;
    el.hostName.textContent = state.host.name;
    el.attrWeight.value = state.host.weight;
    el.attrEdu.value = state.host.education;
    el.attrTalent.value = state.host.talent;
    el.attrProperty.value = state.host.property;
    el.attrStatus.value = state.host.status;

    render();
    renderSkills();
    renderAchievements();
    renderPolish();
    renderPoints();
    renderVersion();
    renderMainQuest();
    renderSideQuests();
    updateQuestBadge();
    renderNotifications();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    fillSkillLevelSelect();
    setActiveTab('attr');
    fullRender();
    checkTamperOnBoot();

    if (state.firstRun && !state.notifications.length) {
      state.firstRun = false;
      persist();
      toast('叮，恭喜您获得天道酬勤系统面板！');
      window.setTimeout(function () {
        toast('叮，请宿主点击「宿主」处输入称号以完成系统绑定。');
      }, 1600);
    } else {
      state.firstRun = false;
      persist();
      var total = rawMinutes(state.entries) / 60;
      if (state.entries.length) {
        toast('叮，欢迎回来，宿主。已载入 ' + state.entries.length + ' 条时间记录，累计修行 ' +
          total.toFixed(1) + ' h。');
      }
    }
  }

  init();
})();
