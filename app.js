/* 天道酬勤 · 系统面板
 * 纯前端外挂面板：标签页容器 + 时间账本 + 任务系统 + 提示系统。
 * 所有数据仅保存在本机浏览器 localStorage，宿主可随时导入 / 导出。
 */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var APP_VERSION = '0.2'; // 开发者系统等级：本次更新即「主线任务」背后的真实版本迭代
  var STORAGE_KEY = 'tiandao.state.v2';
  var LEGACY_ENTRIES_KEY = 'tiandao.entries.v1';
  var LEGACY_FOCUS_KEY = 'tiandao.focus.v1';
  var LEGACY_NAME_KEY = 'tiandao.host.v1';
  var GOAL_HOURS = 10000;
  var DAY_MINUTES = 1440;

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

  /* 主线任务指引：由开发者自定义，与上面的线索一一对应；留空则提示「暂无提示」。 */
  var MAIN_QUEST_GUIDES = [
    '',
    '',
    ''
  ];

  /* 点击空白区域时的兜底提示：按点击位置所属的纵向区域给出不同内容。 */
  var ZONE_HINTS = [
    { max: 0.2, text: '系统面板顶部：此处显示宿主的系统等级与三种点数，全部由任务与成就结算而来。' },
    { max: 0.5, text: '面板主体区域：系统检测功能已丢失，一切数据需要宿主亲自复写。' },
    { max: 0.8, text: '面板下半区：宿主的每一次复写都会即时结算，不需要切换标签页刷新。' },
    { max: 1.01, text: '系统提醒：数据仅保存在本机浏览器，清除浏览器数据将导致修行记录丢失。' }
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
      hiddenSkills: [],
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
  var skillListCollapsed = false;
  var hiddenSkillListCollapsed = false;
  var achievementListCollapsed = false;

  var el = {};
  [
    'toastStack', 'userVersion', 'pAch', 'pContrib', 'pAttr', 'tabbar',
    'polishFloat', 'polishFloatLabel', 'polishFloatFill', 'polishFloatPercent', 'polishBlock',
    'attrSkillSummary', 'attrAchSummary', 'skillListToggle', 'achListToggle', 'skillCard', 'achCard',
    'hostName', 'todayFilled', 'todayMissing', 'totalHours', 'skillCount', 'focusCategory',
    'nameModal', 'nameInput', 'nameConfirm', 'nameCancel',
    'detailModal', 'detailTitle', 'detailBody', 'detailClose',
    'focusLabel', 'focusPercent', 'focusFill', 'focusHint',
    'attrWeight', 'attrEdu', 'attrTalent', 'attrProperty', 'attrStatus',
    'polishPercent', 'polishFill',
    'skillForm', 'skillName', 'skillMode', 'skillLevelWrap', 'skillLevel',
    'skillHoursWrap', 'skillHours', 'skillList', 'hiddenSkillsBlock', 'hiddenSkillList', 'hiddenSkillToggle',
    'achList',
    'entryForm', 'entryDate', 'startTime', 'endTime', 'category', 'activity',
    'level', 'prevDay', 'nextDay', 'viewDate', 'timeline', 'coverageFill',
    'coverageHint', 'logDateLabel', 'logView', 'copyLog', 'exportData',
    'importBtn', 'importFile', 'resetAll', 'clearDay', 'catList',
    'mainQuestBody', 'sideQuestForm', 'sideTitle', 'sideDesc', 'sideRewardAttr',
    'sideRewardContrib', 'sideQuestList', 'noticeView', 'clearNotices',
    'eggMask', 'eggCount', 'eggClose', 'eggPause', 'eggBoost'
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
    safe(function () { merged.hiddenSkills = Array.isArray(parsed.hiddenSkills) ? parsed.hiddenSkills : base.hiddenSkills; });
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
  var sigTimer = null;
  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('存储模块异常，本次记录可能无法持久化保存。', { level: 'ERROR' });
      return;
    }
    // 签名计算涉及多次数组遍历，防抖到空闲时统一计算一次，避免频繁操作（如逐字输入）时反复重算。
    if (sigTimer) { window.clearTimeout(sigTimer); }
    sigTimer = window.setTimeout(renderTamperSignature, 300);
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

  /* 当日进行中的时间不算「空洞」：结算上限取当前时刻。 */
  function nowMinutes() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function dayLimit(dateStr) {
    return dateStr === todayStr() ? Math.min(nowMinutes(), DAY_MINUTES) : DAY_MINUTES;
  }

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

  /* 仅统计截止时刻之前已被复写的分钟数：未到来的时间不计入闭合判断。 */
  function filledMinutesUpTo(list, limit) {
    var clipped = list.filter(function (e) { return e.start < limit; }).map(function (e) {
      return { start: e.start, end: Math.min(e.end, limit) };
    });
    return filledMinutes(clipped);
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

  /* ---------- 提示系统：弹出 toast + 写入「提示」标签页日志 ----------
   * 提示改为「点击触发」，因此不再做任何去重与间隔限制：
   * 宿主点击几次，就提示几次。
   */
  function toast(text, opts) {
    opts = opts || {};
    text = String(text).indexOf('叮，') === 0 ? String(text) : '叮，' + text;

    var card = document.createElement('div');
    card.className = 'toast' + (opts.level ? ' toast-' + opts.level.toLowerCase() : '');
    card.textContent = text;
    el.toastStack.appendChild(card);
    // 弹窗从屏幕中央出现，一路上移到可视区域顶部悬停，最后虚化消失（动画由 CSS 负责）。
    card.addEventListener('animationend', function () { card.remove(); });
    window.setTimeout(function () { card.remove(); }, 5200);

    state.notifications.push({ id: uid(), text: text, ts: Date.now(), count: 1 });
    if (state.notifications.length > 300) { state.notifications.shift(); }
    persist();
    renderNotifications();
  }

  /* ---------- 点击空白区域弹出对应区域的提示 ---------- */
  function isInteractive(node) {
    return !!(node.closest && node.closest('input, select, textarea, button, a, label, .modal-box, .egg-box, .toast'));
  }

  function zoneHintFor(clientY) {
    var ratio = window.innerHeight ? clientY / window.innerHeight : 0.5;
    for (var i = 0; i < ZONE_HINTS.length; i++) {
      if (ratio <= ZONE_HINTS[i].max) { return ZONE_HINTS[i].text; }
    }
    return ZONE_HINTS[ZONE_HINTS.length - 1].text;
  }

  function setupClickHints() {
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || target.nodeType !== 1 || isInteractive(target)) { return; }
      var holder = target.closest('[data-hint]');
      toast(holder ? holder.getAttribute('data-hint') : zoneHintFor(event.clientY));
    });
  }

  /* ---------- 属性点强化：始终锁定，仅作为「未来可期」的占位 ---------- */
  var PLUS_HINTS = {
    name: '称号强化需要消耗属性点，当前系统等级不足，该功能缺失。',
    skill: '技能强化需要消耗成就点，当前系统等级不足，该功能缺失。',
    ach: '成就由支线任务结算产生，成就点强化功能当前缺失。'
  };

  document.addEventListener('click', function (event) {
    var btn = event.target.closest && event.target.closest('.attr-plus');
    if (!btn) { return; }
    var key = btn.getAttribute('data-attr-plus') || '';
    if (key === 'skill' || key === 'ach' || btn.hasAttribute('data-skill-plus')) {
      toast(PLUS_HINTS[key] || PLUS_HINTS.skill, { level: 'WARN' });
      return;
    }
    toast(PLUS_HINTS[key] || '系统等级不足，当前功能缺失。请完成主线任务以解锁属性强化模块。', { level: 'WARN' });
  });

  /* 没有属性点 / 成就点时，连置灰的 [+] 都不显示。 */
  function renderPlusVisibility() {
    var hasAttr = state.points.attribute > 0;
    var hasAch = state.points.achievement > 0;
    document.querySelectorAll('.attr-plus').forEach(function (btn) {
      var key = btn.getAttribute('data-attr-plus');
      var show = (key === 'skill' || key === 'ach') ? hasAch : hasAttr;
      btn.classList.toggle('hidden', !show);
    });
    document.querySelectorAll('[data-skill-plus]').forEach(function (btn) {
      btn.classList.toggle('hidden', !hasAch);
    });
  }

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
    updatePolishFloat();
    if (tab === 'quest') { onOpenQuestTab(); }
    if (tab === 'notice') {
      state.noticeSeenCount = state.notifications.length;
      persist();
      updateNoticeBadge();
    }
  }

  /* ---------- 宿主称号：自定义弹窗，替代原生 prompt ---------- */
  function openNameModal() {
    el.nameInput.value = state.host.name === '未命名修行者' ? '' : state.host.name;
    el.nameModal.classList.remove('hidden');
    window.setTimeout(function () { el.nameInput.focus(); }, 30);
  }

  function closeNameModal() { el.nameModal.classList.add('hidden'); }

  function confirmName() {
    var name = el.nameInput.value.trim() || '未命名修行者';
    state.host.name = name;
    persist();
    closeNameModal();
    toast('宿主称号已更新为「' + state.host.name + '」。系统已绑定。');
    refreshAll();
  }

  el.hostName.addEventListener('click', openNameModal);
  el.nameConfirm.addEventListener('click', confirmName);
  el.nameCancel.addEventListener('click', closeNameModal);
  el.nameInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); confirmName(); }
    if (event.key === 'Escape') { closeNameModal(); }
  });
  el.nameModal.addEventListener('click', function (event) {
    if (event.target === el.nameModal) { closeNameModal(); }
  });

  /* ---------- 主修方向：从已有技能中选择，进度即该技能的进度 ---------- */
  el.focusCategory.addEventListener('change', function () {
    state.focus = el.focusCategory.value;
    persist();
    if (state.focus) {
      toast('主修方向已锁定为技能【' + state.focus + '】，一万小时进度将跟随该技能同步。');
    }
    refreshAll();
  });

  function renderFocusOptions() {
    var names = state.skills.map(function (s2) { return s2.name; });
    if (!names.length) {
      el.focusCategory.innerHTML = '<option value="">暂无技能，请先复写技能</option>';
      el.focusCategory.value = '';
      return;
    }
    var options = ['<option value="">未设定</option>'].concat(names.map(function (n) {
      return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>';
    }));
    el.focusCategory.innerHTML = options.join('');
    var matched = names.filter(function (n) { return normalize(n) === normalize(state.focus); })[0];
    if (!matched && state.focus) {
      // 主修方向必须是已有技能，否则进度会从零开始：清掉失效的旧值。
      state.focus = '';
      persist();
    }
    el.focusCategory.value = matched || '';
  }

  /* ---------- 复写表单中的「技能」下拉：与技能数据联动 ---------- */
  function renderCategoryOptions() {
    var prev = el.category.value;
    if (!state.skills.length) {
      el.category.innerHTML = '<option value="">暂无技能，请先在「复写技能」中添加</option>';
      return;
    }
    el.category.innerHTML = state.skills.map(function (s2) {
      var lv = levelForHours(effectiveHours(s2));
      return '<option value="' + escapeHtml(s2.name) + '">' + escapeHtml(s2.name) + ' · ' + lv.label + '</option>';
    }).join('');
    var keep = state.skills.filter(function (s2) { return s2.name === prev; })[0];
    el.category.value = keep ? prev : state.skills[0].name;
  }

  /* ---------- 基础属性 ---------- */
  function bindAttrField(inputEl, field, label) {
    // input：每输入一个字符都立刻刷新完整度；change：完成输入后才给出提示，避免刷屏。
    inputEl.addEventListener('input', function () {
      state.host[field] = inputEl.value.trim();
      persist();
      renderPolish();
    });
    inputEl.addEventListener('change', function () {
      var value = inputEl.value.trim();
      state.host[field] = value;
      persist();
      if (value) {
        toast('检测到宿主' + label + '数据复写：【' + value + '】，属性面板已更新。');
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
  var MAX_UNLOCKED_LEVEL = SKILL_LEVELS.filter(function (l) { return !l.locked; }).slice(-1)[0];
  var FIRST_LOCKED_LEVEL = SKILL_LEVELS.filter(function (l) { return l.locked; })[0];

  function fillSkillLevelSelect() {
    // 锁定等级同样展示（开放可见），但不可被选中：选中后会被系统还原并给出提示。
    el.skillLevel.innerHTML = SKILL_LEVELS.map(function (l) {
      return '<option value="' + l.key + '"' + (l.locked ? ' class="level-locked"' : '') + '>' +
        l.label + '（约 ' + l.minHours + '+ 小时）</option>';
    }).join('');
    el.skillLevel.value = SKILL_LEVELS[0].key;
    lastSkillLevel = el.skillLevel.value;
  }
  var lastSkillLevel = SKILL_LEVELS[0].key;
  fillSkillLevelSelect();

  el.skillLevel.addEventListener('change', function () {
    var picked = SKILL_LEVELS.filter(function (l) { return l.key === el.skillLevel.value; })[0];
    if (picked && picked.locked) {
      el.skillLevel.value = lastSkillLevel;
      toast('宿主技能超过当前系统等级限制，「' + picked.label + '」暂不可复写。', { level: 'WARN' });
      return;
    }
    lastSkillLevel = el.skillLevel.value;
  });

  el.skillMode.addEventListener('change', function () {
    var byLevel = el.skillMode.value === 'level';
    el.skillLevelWrap.classList.toggle('hidden', !byLevel);
    el.skillHoursWrap.classList.toggle('hidden', byLevel);
  });

  /* 受系统等级限制：无论累计多少小时，展示等级都不会越过最高的未锁定等级。 */
  function levelForHours(h) {
    var current = SKILL_LEVELS[0];
    for (var i = 0; i < SKILL_LEVELS.length; i++) {
      if (!SKILL_LEVELS[i].locked && h >= SKILL_LEVELS[i].minHours) { current = SKILL_LEVELS[i]; }
    }
    return current;
  }

  function exceedsSystemLimit(h) {
    return !!FIRST_LOCKED_LEVEL && h >= FIRST_LOCKED_LEVEL.minHours;
  }

  /* 技能实际小时 = 手动复写的基准小时 + 复写时间段中归属该技能的时长。 */
  function entryHoursFor(name) {
    var key = normalize(name);
    var minutes = state.entries.reduce(function (sum, e) {
      return normalize(e.category) === key ? sum + (e.end - e.start) : sum;
    }, 0);
    return minutes / 60;
  }

  function effectiveHours(skill) {
    return (Number(skill.hours) || 0) + entryHoursFor(skill.name);
  }

  function skillByName(name) {
    return state.skills.filter(function (s2) { return normalize(s2.name) === normalize(name); })[0];
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

    var existing = skillByName(name);
    if (existing) {
      existing.hours = hoursValue;
    } else {
      state.skills.push({ id: uid(), name: name, hours: hoursValue });
    }
    persist();

    var total = effectiveHours(skillByName(name));
    var lv = levelForHours(total);
    toast('检测到宿主技能【' + name + '】，当前等级：' + lv.label +
      '（累计 ' + total.toFixed(1) + ' 小时）。');

    el.skillForm.reset();
    fillSkillLevelSelect();
    el.skillLevelWrap.classList.remove('hidden');
    el.skillHoursWrap.classList.add('hidden');
    refreshAll();
  });

  el.skillList.addEventListener('click', function (event) {
    var target = event.target;
    if (!target.getAttribute) { return; }

    var cappedId = target.getAttribute('data-capped-skill');
    if (cappedId) {
      var capped = state.skills.filter(function (s2) { return s2.id === cappedId; })[0];
      if (capped) {
        toast('技能【' + capped.name + '】累计已突破 ' + FIRST_LOCKED_LEVEL.minHours +
          ' 小时，本应进入下一等级「' + FIRST_LOCKED_LEVEL.label +
          '」，但受当前系统等级限制，该功能缺失。', { level: 'WARN' });
      }
      return;
    }

    var hideId = target.getAttribute('data-hide-skill');
    if (hideId) {
      var hiddenIndex = state.hiddenSkills.indexOf(hideId);
      if (hiddenIndex >= 0) {
        state.hiddenSkills.splice(hiddenIndex, 1);
      } else {
        state.hiddenSkills.push(hideId);
      }
      persist();
      refreshAll();
      return;
    }

    var id = target.getAttribute('data-del-skill');
    if (!id) { return; }
    var skill = state.skills.filter(function (s2) { return s2.id === id; })[0];
    if (!skill || !window.confirm('确认删除技能【' + skill.name + '】？删除后将同时移除该技能的累计记录。')) { return; }
    state.skills = state.skills.filter(function (s2) { return s2.id !== id; });
    state.hiddenSkills = state.hiddenSkills.filter(function (hiddenId) { return hiddenId !== id; });
    if (skill && normalize(skill.name) === normalize(state.focus)) { state.focus = ''; }
    persist();
    if (skill) { toast('技能【' + skill.name + '】记录已从面板抹除。'); }
    refreshAll();
  });

  el.hiddenSkillList.addEventListener('click', function (event) {
    var target = event.target;
    var showId = target.getAttribute && target.getAttribute('data-show-skill');
    if (!showId) { return; }
    state.hiddenSkills = state.hiddenSkills.filter(function (hiddenId) { return hiddenId !== showId; });
    persist();
    refreshAll();
  });

  el.hiddenSkillToggle.addEventListener('click', function () {
    hiddenSkillListCollapsed = !hiddenSkillListCollapsed;
    renderHiddenSkillToggle();
  });

  el.skillListToggle.addEventListener('click', function () {
    skillListCollapsed = !skillListCollapsed;
    renderSkillListToggle();
  });

  el.achListToggle.addEventListener('click', function () {
    achievementListCollapsed = !achievementListCollapsed;
    renderAchievementListToggle();
  });

  el.attrSkillSummary.addEventListener('click', function () {
    var skills = visibleSkills();
    openDetailModal('技能列表', skills.length
      ? skills.map(function (s2) {
        return '<div class="detail-row"><span>' + escapeHtml(s2.name) + '</span><b>' +
          escapeHtml(levelForHours(effectiveHours(s2)).label) + '</b></div>';
      }).join('')
      : '<p class="hint">暂无可见技能。</p>');
  });

  el.attrAchSummary.addEventListener('click', function () {
    openDetailModal('成就列表', state.achievements.length
      ? state.achievements.map(function (a2) {
        return '<div class="detail-row"><span>' + escapeHtml(a2.name) +
          (a2.desc ? '<small>' + escapeHtml(a2.desc) + '</small>' : '') +
          '</span><b>+' + a2.points + '</b></div>';
      }).join('')
      : '<p class="hint">暂无成就。</p>');
  });

  function openDetailModal(title, body) {
    el.detailTitle.textContent = title;
    el.detailBody.innerHTML = body;
    el.detailModal.classList.remove('hidden');
  }

  function closeDetailModal() { el.detailModal.classList.add('hidden'); }

  el.detailClose.addEventListener('click', closeDetailModal);
  el.detailModal.addEventListener('click', function (event) {
    if (event.target === el.detailModal) { closeDetailModal(); }
  });

  function sortedSkills() {
    return state.skills.slice().sort(function (a2, b2) {
      return effectiveHours(b2) - effectiveHours(a2);
    });
  }

  function visibleSkills() {
    return sortedSkills().filter(function (s2) {
      return state.hiddenSkills.indexOf(s2.id) < 0;
    });
  }

  function renderSkills() {
    var skills = visibleSkills();
    if (!skills.length) {
      el.skillList.innerHTML = '<li class="empty">暂无可见技能记录。</li>';
      return;
    }
    el.skillList.innerHTML = skills.map(function (s2) {
      var h = effectiveHours(s2);
      var lv = levelForHours(h);
      var next = SKILL_LEVELS[SKILL_LEVELS.indexOf(lv) + 1];
      var capped = exceedsSystemLimit(h);
      // 受系统等级限制时不直接铺开文字，改为点击 [!] 后弹出提示窗。
      var progressText = capped
        ? ''
        : (next ? '距「' + next.label + '」还差 ' + Math.max(next.minHours - h, 0).toFixed(1) + ' 小时' : '');
      return '<li class="skill-item' + (capped ? ' capped' : '') + '">' +
        '<div class="skill-head">' +
        '<span class="skill-name">' + escapeHtml(s2.name) + '</span>' +
        '<span class="skill-actions">' +
        (capped ? '<button type="button" class="del warn" data-capped-skill="' + s2.id + '" title="系统提示">[!]</button>' : '') +
        '<button type="button" class="skill-action" data-hide-skill="' + s2.id + '" title="隐藏技能项">隐藏</button>' +
        '<button type="button" class="del" data-del-skill="' + s2.id + '" title="删除技能">删除</button>' +
        '</span>' +
        '<span class="skill-lv">' + lv.label + '</span>' +
        '<button type="button" class="attr-plus" data-skill-plus="' + s2.id + '" aria-label="强化技能">+</button>' +
        '</div>' +
        '<div class="skill-meta">累计 ' + h.toFixed(1) + ' 小时' +
        (progressText ? ' · ' + progressText : '') + '</div>' +
        '</li>';
    }).join('');
  }

  function renderHiddenSkills() {
    var skills = sortedSkills().filter(function (s2) {
      return state.hiddenSkills.indexOf(s2.id) >= 0;
    });
    el.hiddenSkillsBlock.classList.toggle('hidden', !skills.length);
    if (!skills.length) { return; }
    el.hiddenSkillList.innerHTML = skills.map(function (s2) {
      var h = effectiveHours(s2);
      return '<li class="skill-item hidden-skill-item">' +
        '<div class="skill-head"><span class="skill-name">' + escapeHtml(s2.name) + '</span>' +
        '<span class="skill-lv">' + levelForHours(h).label + '</span>' +
        '<button type="button" class="skill-action" data-show-skill="' + s2.id + '">显示</button></div>' +
        '<div class="skill-meta">累计 ' + h.toFixed(1) + ' 小时</div>' +
        '</li>';
    }).join('');
    renderHiddenSkillToggle();
  }

  function renderHiddenSkillToggle() {
    el.hiddenSkillList.classList.toggle('hidden', hiddenSkillListCollapsed);
    el.hiddenSkillToggle.textContent = hiddenSkillListCollapsed ? '展开' : '折叠';
    el.hiddenSkillToggle.setAttribute('aria-expanded', String(!hiddenSkillListCollapsed));
    el.hiddenSkillToggle.setAttribute('aria-label', hiddenSkillListCollapsed ? '展开隐藏技能' : '折叠隐藏技能');
    el.hiddenSkillToggle.title = hiddenSkillListCollapsed ? '展开隐藏技能' : '折叠隐藏技能';
  }

  function renderSkillListToggle() {
    el.skillList.classList.toggle('hidden', skillListCollapsed);
    el.skillListToggle.setAttribute('aria-expanded', String(!skillListCollapsed));
    el.skillListToggle.textContent = skillListCollapsed ? '展开' : '折叠';
    el.skillListToggle.setAttribute('aria-label', skillListCollapsed ? '展开技能项' : '折叠技能');
    el.skillListToggle.title = skillListCollapsed ? '展开技能项' : '折叠技能';
  }

  function renderAchievementListToggle() {
    el.achList.classList.toggle('hidden', achievementListCollapsed);
    el.achListToggle.textContent = achievementListCollapsed ? '展开' : '折叠';
    el.achListToggle.setAttribute('aria-expanded', String(!achievementListCollapsed));
    el.achListToggle.setAttribute('aria-label', achievementListCollapsed ? '展开成就' : '折叠成就');
    el.achListToggle.title = achievementListCollapsed ? '展开成就' : '折叠成就';
  }

  /* ---------- 成就：只展示，不提供编辑区（支线任务完成即成就） ---------- */
  function renderAchievements() {
    if (!state.achievements.length) {
      el.achList.innerHTML = '<li class="empty">暂无成就，完成一条支线任务即可刻下第一枚成就。</li>';
      renderAchievementListToggle();
      return;
    }
    el.achList.innerHTML = state.achievements.slice().map(function (a2) {
      return '<li class="ach-item">' +
        '<div class="ach-head"><span class="ach-name">🏆 ' + escapeHtml(a2.name) + '</span>' +
        (a2.desc ? '<span class="ach-desc">' + escapeHtml(a2.desc) + '</span>' : '') +
        '<span class="ach-pt">+' + a2.points + '</span></div>' +
        '</li>';
    }).join('');
    renderAchievementListToggle();
  }

  /* ---------- 复写时间段 ---------- */
  el.entryForm.addEventListener('submit', function (event) {
    event.preventDefault();

    var date = el.entryDate.value;
    var startRaw = el.startTime.value;
    var endRaw = el.endTime.value;
    var category = el.category.value.trim();
    var activity = el.activity.value.trim();

    if (!state.skills.length) {
      toast('尚未复写任何技能，无法归类本段时间。请先在「复写技能」中添加技能。', { level: 'WARN' });
      return;
    }

    if (!date || !startRaw || !endRaw || !category || !activity) {
      toast('输入不完整，请补全日期、时间、技能和活动内容。', { level: 'WARN' });
      return;
    }

    var start = toMinutes(startRaw);
    var end = toMinutes(endRaw) || DAY_MINUTES;

    if (end <= start) {
      toast('时间悖论警告：结束时间须晚于开始时间。跨夜请拆成两段记录。', { level: 'ERROR' });
      return;
    }

    var dayList = byDate(date);
    var clash = overlaps(dayList, start, end);
    if (clash) {
      toast('时间线冲突：' + toClock(clash.start) + '-' + toClock(clash.end) +
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

    toast('日志写入成功：' + toClock(start) + '-' + toClock(end) + ' ' + activity +
      '（+' + hours(end - start) + ' h）。');

    var skill = skillByName(category);
    if (skill) {
      var lv = levelForHours(effectiveHours(skill));
      toast('技能【' + skill.name + '】已同步本段复写，当前等级：' + lv.label +
        '（累计 ' + effectiveHours(skill).toFixed(1) + ' 小时）。');
    }
    // 数据更新后立即刷新全部面板，无需切换标签页。
    refreshAll();
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
    refreshAll();
  }

  /* ---------- 日志操作 ---------- */
  el.logView.addEventListener('click', function (event) {
    var id = event.target.getAttribute && event.target.getAttribute('data-del');
    if (!id) { return; }
    state.entries = state.entries.filter(function (e) { return e.id !== id; });
    persist();
    toast('该段记录已从时间线抹除。');
    refreshAll();
  });

  el.copyLog.addEventListener('click', function () {
    var text = buildLogLines(state.viewDate).map(function (l) {
      return '[' + l.time + '] [' + l.level + '] ' + l.message;
    }).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('日志已复制到剪贴板。');
      }, function () {
        toast('无法访问剪贴板，请手动选择日志内容复制。', { level: 'WARN' });
      });
    } else {
      toast('当前环境不支持剪贴板，请手动选择日志内容复制。', { level: 'WARN' });
    }
  });

  el.clearDay.addEventListener('click', function () {
    if (!window.confirm('确认清空 ' + state.viewDate + ' 的全部记录？')) { return; }
    state.entries = state.entries.filter(function (e) { return e.date !== state.viewDate; });
    persist();
    toast('当日时间线已重置。');
    refreshAll();
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
    toast('修行数据已导出备份。');
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
        toast('宿主数据导入成功，面板已重新同步。');
        fullRender();
      } catch (e) {
        toast('导入文件格式异常，数据未变更。', { level: 'ERROR' });
      }
    };
    reader.readAsText(file);
    el.importFile.value = '';
  });

  el.resetAll.addEventListener('click', function () {
    if (!window.confirm('确认重置全部本地数据？此操作不可撤销，请先导出备份。')) { return; }
    state = defaultState();
    persist();
    toast('系统已恢复初始状态，所有数据需要重新输入。');
    fullRender();
  });

  /* ---------- 日志生成 ---------- */
  function buildLogLines(dateStr) {
    var list = byDate(dateStr);
    var limit = dayLimit(dateStr);
    var isToday = dateStr === todayStr();
    var lines = [{
      time: '00:00:00',
      level: 'SYSTEM',
      message: '天道酬勤面板启动，载入 ' + dateStr + ' 时间线……',
      id: null
    }];

    if (!list.length) {
      lines.push({
        time: '00:00:00',
        level: limit > 0 ? 'ERROR' : 'SYSTEM',
        message: limit > 0
          ? '检测功能丢失，当日无任何记录，需要宿主手动输入。'
          : '新的一天刚刚开始，尚无需要复写的时间。',
        id: null
      });
      return lines;
    }

    var cursor = 0;
    list.forEach(function (e) {
      var gapEnd = Math.min(e.start, limit);
      if (gapEnd > cursor) {
        lines.push({
          time: toClock(cursor) + ':00',
          level: 'WARN',
          message: '时间空洞 ' + toClock(cursor) + '-' + toClock(gapEnd) +
            '（' + hours(gapEnd - cursor) + ' h）：检测功能丢失，需要宿主手动输入。',
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

    if (cursor < limit) {
      lines.push({
        time: toClock(cursor) + ':00',
        level: 'WARN',
        message: '时间空洞 ' + toClock(cursor) + '-' + toClock(limit) + '（' + hours(limit - cursor) +
          ' h）：检测功能丢失，需要宿主手动输入。',
        id: null
      });
    }

    var filled = filledMinutesUpTo(list, limit);
    var closed = filled >= limit;
    lines.push({
      time: isToday ? toClock(limit) + ':00' : '23:59:59',
      level: closed ? 'SYSTEM' : 'WARN',
      message: closed
        ? (isToday
          ? '截至 ' + toClock(limit) + '，当日时间线已闭合，共 ' + list.length + ' 条记录。'
          : '当日时间线已填满，日志归档完成，共 ' + list.length + ' 条记录。')
        : '当日日志尚未闭合，截至 ' + toClock(limit) + ' 仍有 ' + hours(limit - filled) + ' h 去向不明。',
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
    renderFocusOptions();
    var focus = state.focus;
    var skill = focus ? skillByName(focus) : null;
    el.focusLabel.textContent = skill ? skill.name : '未设定';
    if (!skill) {
      el.focusFill.style.width = '0%';
      el.focusPercent.textContent = '0.000%';
      el.focusHint.textContent = state.skills.length
        ? '未设定主修方向，请从已有技能中选择一项，进度将直接沿用该技能的累计小时。'
        : '尚无技能可供选择，请先复写技能，再指定主修方向。';
      return;
    }
    // 主修方向即技能：进度直接沿用该技能已累计的小时，不会从零开始。
    var h = effectiveHours(skill);
    var percent = Math.min(h / GOAL_HOURS * 100, 100);
    el.focusFill.style.width = percent + '%';
    el.focusPercent.textContent = percent.toFixed(3) + '%';
    el.focusHint.textContent = '技能「' + skill.name + '」当前等级 ' + levelForHours(h).label +
      '，已累计 ' + h.toFixed(1) + ' h，距一万小时之境还差 ' +
      Math.max(GOAL_HOURS - h, 0).toFixed(1) + ' h。';
  }

  function renderCategories() {
    renderCategoryOptions();
    if (!state.skills.length && !state.entries.length) {
      el.catList.innerHTML = '<li><span>暂无数据</span><span>0.0 h</span></li>';
      return;
    }
    var map = Object.create(null);
    state.skills.forEach(function (s2) {
      map[normalize(s2.name)] = { name: s2.name, hours: effectiveHours(s2), known: true };
    });
    state.entries.forEach(function (e) {
      var key = normalize(e.category);
      if (!map[key]) { map[key] = { name: String(e.category).trim(), hours: 0, known: false }; }
      if (!map[key].known) { map[key].hours += (e.end - e.start) / 60; }
    });
    var rows = Object.keys(map).sort(function (x, y) { return map[y].hours - map[x].hours; });
    el.catList.innerHTML = rows.map(function (key) {
      var row = map[key];
      var suffix = row.known ? ' · ' + levelForHours(row.hours).label : '';
      return '<li><span>' + escapeHtml(row.name) + escapeHtml(suffix) + '</span><span>' +
        row.hours.toFixed(1) + ' h</span></li>';
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
    polishPercentValue = percent;
    el.polishPercent.textContent = percent + '%';
    el.polishFill.style.width = percent + '%';
    renderProgressFloat(percent);
    renderAttrSummaries();
    renderPlusVisibility();

    var tier = percent >= 100 ? 4 : percent >= 75 ? 3 : percent >= 50 ? 2 : percent >= 25 ? 1 : 0;
    document.body.className = document.body.className.replace(/\bpolish-\d\b/g, '').trim();
    document.body.classList.add('polish-' + tier);

    var hints = [
      '面板仍是最朴素的调试界面，快去补全属性。',
      '检测到属性数据流入，面板开始泛起微光。',
      '属性完整度过半，系统外壳纹路逐渐显现。',
      '属性接近完整，面板特效即将全部激活。',
      '属性已全部复写！完整版特效面板已激活——此刻，你才是真正的天选宿主。'
    ];
    // 静态提示文字已移除：完整度跨过新的档位时才以弹窗形式提示一次。
    if (lastPolishTier !== null && tier !== lastPolishTier) { toast(hints[tier]); }
    lastPolishTier = tier;
    updatePolishFloat();
  }

  var lastPolishTier = null;
  var polishPercentValue = 0;

  function renderAttrSummaries() {
    // 技能不展示「几项」，具体技能由下方的技能列表逐条呈现。
    var skills = visibleSkills();
    el.attrSkillSummary.textContent = skills.length
      ? skills.map(function (s2) { return s2.name; }).join('、')
      : '暂无';
    el.skillListToggle.title = skills.length
      ? '技能名称按等级从高到低排列，点击展开或折叠技能项'
      : '暂无技能';
    el.attrAchSummary.textContent = state.achievements.length
      ? state.achievements.length + ' 项 · 成就点 ' + state.points.achievement
      : '暂无';
  }

  /* ---------- 手机端：面板完整度进度条吸附显示 ---------- */
  function isNarrowScreen() {
    return window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  }

  function updatePolishFloat() {
    var attrActive = document.querySelector('.tab-panel[data-tab-panel="attr"]');
    var visiblePanel = attrActive && attrActive.classList.contains('active');
    if (polishPercentValue >= 100) {
      renderTaskFloat();
      el.polishFloat.classList.remove('at-top');
      el.polishFloat.classList.add('at-bottom');
      el.polishFloat.classList.remove('hidden');
      return;
    }
    if (!visiblePanel) {
      el.polishFloat.classList.remove('at-top');
      el.polishFloat.classList.add('at-bottom');
      el.polishFloat.classList.remove('hidden');
      return;
    }
    var rect = el.polishBlock.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      el.polishFloat.classList.remove('at-bottom');
      el.polishFloat.classList.add('at-top');
      el.polishFloat.classList.remove('hidden');
      return;
    }
    var inView = rect.bottom > 0 && rect.top < window.innerHeight;
    if (inView) {
      el.polishFloat.classList.add('hidden');
      return;
    }
    // 不在可视区域时，按相对位置吸附在顶部或底部。
    var atTop = rect.bottom <= 0;
    el.polishFloat.classList.toggle('at-top', atTop);
    el.polishFloat.classList.toggle('at-bottom', !atTop);
    el.polishFloat.classList.remove('hidden');
  }

  function renderProgressFloat(percent) {
    el.polishFloatLabel.textContent = '面板完整度';
    el.polishFloatPercent.textContent = percent + '%';
    el.polishFloatFill.style.width = percent + '%';
  }

  function renderTaskFloat() {
    var mainTotal = MAIN_QUEST_CLUES.length;
    var mainCompleted = Math.min(state.quests.mainCompleted, mainTotal);
    var sideTasks = state.quests.side;
    var sideDone = sideTasks.filter(function (q) { return q.status === 'done'; }).length;
    var useSide = mainCompleted >= mainTotal && sideTasks.length > 0;
    var completed = useSide ? sideDone : mainCompleted;
    var total = useSide ? sideTasks.length : mainTotal;
    var label = useSide ? '支线任务' : '主线任务';
    var percent = total ? Math.min(completed / total * 100, 100) : 0;
    el.polishFloatLabel.textContent = label;
    el.polishFloatPercent.textContent = completed + '/' + total;
    el.polishFloatFill.style.width = percent + '%';
  }

  window.addEventListener('scroll', updatePolishFloat, { passive: true });
  window.addEventListener('resize', updatePolishFloat);

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
      toast('获得主线任务：解锁系统面板全部功能，当前进度 0/TREE（' + MAIN_QUEST_CLUES.length + '）。');
    } else if (state.quests.lastSeenAppVersion !== APP_VERSION &&
      state.quests.mainRevealed < MAIN_QUEST_CLUES.length &&
      state.quests.mainCompleted >= state.quests.mainRevealed) {
      state.quests.mainRevealed += 1;
      state.quests.mainAccepted = false;
      state.quests.lastSeenAppVersion = APP_VERSION;
      persist();
      toast('检测到系统更新（' + previousVersionTag() + ' → ' + APP_VERSION +
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
      el.mainQuestBody.innerHTML = '<p class="hint">主线任务尚未加载，请稍候……</p>';
      return;
    }

    var html = '<div class="quest-progress">解锁系统面板全部功能 · 进度 ' + completed + '/TREE（' + total + '）</div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + (completed / total * 100) + '%"></div></div>';

    if (completed >= total) {
      html += '<p class="hint">当前已发布的主线任务线索已全部完成，系统等级 ' + userVersionText() +
        '。等待开发者发布下一次系统更新（当前系统等级 ' + APP_VERSION + '）。</p>';
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
      html += '<p class="hint">本条线索已提交，等待系统更新解锁下一条线索。可尝试重新进入本标签页检查更新。</p>';
    }
    el.mainQuestBody.innerHTML = html;

    var guideBtn = document.getElementById('questGuide');
    if (guideBtn) {
      guideBtn.addEventListener('click', function () {
        // 指引内容由开发者在 MAIN_QUEST_GUIDES 中自定义，留空即提示暂无提示。
        var guide = (MAIN_QUEST_GUIDES[completed] || '').trim();
        toast(guide ? '任务指引：' + guide : '暂无提示。');
      });
    }
    var acceptBtn = document.getElementById('questAccept');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', function () {
        state.quests.mainAccepted = true;
        persist();
        toast('已接受主线任务线索 ' + (completed + 1) + '，祝宿主武运昌隆。');
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
    updatePolishFloat();
    renderMainQuest();
    updateQuestBadge();
    toast('系统正在升级……');
    window.setTimeout(function () {
      toast('系统升级完成。');
      window.setTimeout(function () {
        toast('系统已经升级到第 ' + userVersionText() + ' 版，获得属性点 +5。');
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
    toast('宿主已发布支线任务【' + title + '】。');
    el.sideQuestForm.reset();
    el.sideRewardAttr.value = 1;
    el.sideRewardContrib.value = 1;
    // 发布后立即刷新「已发布支线任务」，不需要切换标签页。
    refreshAll();
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
      toast('已接受支线任务【' + quest.title + '】。');
    } else if (target.hasAttribute('data-submit')) {
      quest.status = 'done';
      state.points.attribute += quest.rewardAttr;
      state.points.contribution += quest.rewardContrib;
      // 支线任务完成即成就：直接结算为一枚成就与对应成就点。
      var achPoints = Math.max(1, quest.rewardAttr + quest.rewardContrib);
      state.achievements.push({
        id: uid(),
        name: quest.title,
        points: achPoints,
        desc: quest.desc || '完成支线任务结算',
        questId: quest.id
      });
      state.points.achievement += achPoints;
      persist();
      toast('支线任务【' + quest.title + '】已完成，获得属性点 +' + quest.rewardAttr +
        '，贡献点 +' + quest.rewardContrib + '。');
      toast('该支线任务已记入成就簿【' + quest.title + '】，获得成就点 +' + achPoints + '。');
    } else if (target.hasAttribute('data-del-quest')) {
      state.quests.side = state.quests.side.filter(function (q) { return q.id !== id; });
      persist();
    }
    refreshAll();
  });

  function renderSideQuests() {
    if (!state.quests.side.length) {
      el.sideQuestList.innerHTML = '<li class="empty">暂无支线任务，快给自己安排一个吧。</li>';
      return;
    }
    el.sideQuestList.innerHTML = state.quests.side.slice().map(function (q) {
      var statusLabel = { open: '未接受', accepted: '进行中', done: '已完成' }[q.status];
      var actions = '';
      if (q.status === 'open') {
        actions = '<button type="button" class="btn ghost" data-accept="' + q.id + '">接受任务</button>';
      } else if (q.status === 'accepted') {
        actions = '<button type="button" class="btn" data-submit="' + q.id + '">提交任务</button>';
      }
      actions += '<button type="button" class="btn ghost danger" data-del-quest="' + q.id + '">删除任务</button>';
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
    if (pendingMain + pendingSide > 0) { flashTab('quest'); }
  }

  /* ---------- 提示标签页 ---------- */
  function renderNotifications() {
    var list = state.notifications.slice();
    if (!list.length) {
      el.noticeView.innerHTML = '<div class="log-line"><span class="msg">暂无提示记录。</span></div>';
    } else {
      el.noticeView.innerHTML = list.map(function (n) {
        var d = new Date(n.ts);
        var dateTime = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
          pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        return '<div class="log-line"><span class="ts">[' + dateTime + ']</span> <span class="msg">' +
          escapeHtml(n.text) + '</span>' + (n.count > 1 ? ' <span class="hint">(×' + n.count + ')</span>' : '') +
          '</div>';
      }).join('');
      el.noticeView.scrollTop = el.noticeView.scrollHeight;
    }
    updateNoticeBadge();
  }

  function updateNoticeBadge() {
    var unread = Math.max(state.notifications.length - state.noticeSeenCount, 0);
    if (unread > 0) { flashTab('notice'); }
  }

  /* 不使用红点与数字角标：仅让对应标签高亮 1 秒作为提醒。 */
  var flashTimers = {};
  function flashTab(tab) {
    var btn = document.querySelector('.tab-btn[data-tab="' + tab + '"]');
    if (!btn || btn.classList.contains('active')) { return; }
    btn.classList.add('flash');
    if (flashTimers[tab]) { window.clearTimeout(flashTimers[tab]); }
    flashTimers[tab] = window.setTimeout(function () {
      btn.classList.remove('flash');
      flashTimers[tab] = null;
    }, 1000);
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

  el.eggClose.addEventListener('click', function () {
    stopEggTimer();
    el.eggMask.classList.add('hidden');
  });

  el.eggPause.addEventListener('click', function () {
    stopEggTimer();
  });

  el.eggBoost.addEventListener('click', function () {
    // 加速 (当前值 + 1) 秒：无论当前是 6 还是 60，都会瞬间越过 0 来到 -1，随后继续正常递减。
    // （这里刻意用 eggValue - (eggValue + 1) 而不是直接写 -1，是为了保留“加速 N 秒”的叙事逻辑。）
    eggValue = eggValue - (eggValue + 1); // 恒等于 -1，属于设计彩蛋而非笔误
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

    var todayLimit = dayLimit(todayStr());
    var todayFilledNow = filledMinutesUpTo(todayList, todayLimit);
    el.todayFilled.textContent = hours(todayFilled) + ' h';
    // 今日缺失只统计「已经过去却没有复写」的时间。
    el.todayMissing.textContent = hours(Math.max(todayLimit - todayFilledNow, 0)) + ' h';
    el.totalHours.textContent = hours(rawMinutes(state.entries)) + ' h';
    el.skillCount.textContent = state.skills.length;

    var limit = dayLimit(state.viewDate);
    var filledNow = filledMinutesUpTo(list, limit);
    var coverage = Math.min(filled / DAY_MINUTES * 100, 100);
    el.coverageFill.style.width = coverage + '%';
    el.coverageHint.textContent = state.viewDate + ' 时间线覆盖 ' + coverage.toFixed(1) + '%（' +
      hours(filled) + ' h / 24.0 h）' +
      (filledNow >= limit
        ? ' · 截至 ' + toClock(limit) + ' 的日志已闭合。'
        : ' · 检测功能丢失，截至 ' + toClock(limit) + ' 仍有 ' + hours(limit - filledNow) +
          ' h 需要宿主手动输入。');

    renderTimeline(list);
    renderLog(state.viewDate);
    renderFocus();
    renderCategories();
  }

  /* 任何数据变更后统一调用：所有面板即时刷新，不依赖切换标签页。 */
  function refreshAll() {
    el.hostName.textContent = state.host.name;
    render();
    renderSkills();
    renderHiddenSkills();
    renderSkillListToggle();
    renderAchievements();
    renderPolish();
    renderPoints();
    renderVersion();
    renderMainQuest();
    renderSideQuests();
    updateQuestBadge();
  }

  function fullRender() {
    el.entryDate.value = todayStr();
    el.viewDate.value = state.viewDate;
    el.attrWeight.value = state.host.weight;
    el.attrEdu.value = state.host.education;
    el.attrTalent.value = state.host.talent;
    el.attrProperty.value = state.host.property;
    el.attrStatus.value = state.host.status;

    refreshAll();
    renderNotifications();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    fillSkillLevelSelect();
    setActiveTab('attr');
    fullRender();
    setupClickHints();
    updatePolishFloat();
    checkTamperOnBoot();

    if (state.firstRun && !state.notifications.length) {
      state.firstRun = false;
      persist();
      toast('恭喜您获得天道酬勤系统面板！');
      window.setTimeout(function () {
        toast('请宿主点击基础属性中的「宿主」称号以完成系统绑定。');
      }, 1600);
    } else {
      state.firstRun = false;
      persist();
      var total = rawMinutes(state.entries) / 60;
      if (state.entries.length) {
        toast('欢迎回来，宿主。已载入 ' + state.entries.length + ' 条时间记录，累计修行 ' +
          total.toFixed(1) + ' h。');
      }
    }
  }

  init();
})();
