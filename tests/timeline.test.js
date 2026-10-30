'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Exercise the application's handlers without starting the unrelated panels.
function timeline() {
  const element = () => {
    const classes = new Set();
    const captures = new Set();
    return { style: {}, attributes: {}, listeners: {}, children: [],
      set innerHTML(value) { this.children = []; },
      appendChild(item) { this.children.push(item); item.parent = this; },
      querySelector(selector) { return this.children.find(item => item.className === selector.slice(1)) || null; },
      replaceWith(item) {
        const index = this.parent.children.indexOf(this);
        this.parent.children[index] = item;
        item.parent = this.parent;
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      setPointerCapture(id) { captures.add(id); },
      hasPointerCapture(id) { return captures.has(id); },
      releasePointerCapture(id) { captures.delete(id); },
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, enabled) { if (enabled) { classes.add(name); } else { classes.delete(name); } },
        contains(name) { return classes.has(name); }
      } };
  };
  const track = element();
  const markers = [];
  const context = vm.createContext({
    DAY_MINUTES: 1440,
    timelineZoom: { start: 0, end: 1440, anchor: null },
    timelineCursors: { start: { ratio: 0, rangeRatio: 0, snap: null }, end: { ratio: 1, rangeRatio: 1, snap: null } },
    state: { ui: { timelineZoom: { start: 0, end: 1440 } }, notes: [], viewDate: '2026-10-30' },
    entries: [],
    el: {
      timelineNoteMarkers: { getBoundingClientRect: () => ({ left: 100, right: 1100, width: 1000 }),
        querySelectorAll: () => markers },
      timeline: track, timelineAxis: {}, timelineStartCursor: element(), timelineEndCursor: element()
    },
    document: { createElement: element },
    pad: value => String(value).padStart(2, '0'),
    dateTimeStamp: () => 0,
    timelineBlankSegments: () => [],
    setTimelineNotePriority: () => {},
    prioritizeTimelineCursorNote: () => {},
    persist: () => {}
  });
  const names = ['toClock', 'timelineZoomRange', 'normalizeTimelineCursors', 'timelineCursorMinutes', 'timelineNotePosition',
    'notesByDate', 'noteMinutes', 'timelineSnapPoints', 'timelineSnapKind', 'syncTimelineCursorSnapStyles',
    'renderTimelineNoteLines', 'updateTimelineNoteMarkerPositions', 'updateTimelineZoomLabel', 'renderTimeline', 'syncCollapseState',
    'setTimelineZoom', 'timelineZoomFromCursors', 'moveTimelineCursor', 'bindTimelineCursor', 'resetTimelineZoom'];
  names.forEach(name => {
    const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  }'));
    assert.ok(match, 'application function exists: ' + name);
    vm.runInContext(match[0], context);
  });
  context.byDate = () => context.entries;
  function drag(name, ratios) {
    const dragState = {
      offset: 0, lastX: 100 + context.timelineCursors[name].ratio * 1000,
      snap: null, released: null
    };
    ratios.forEach(ratio => context.moveTimelineCursor(name, { clientX: 100 + ratio * 1000 }, dragState));
    return dragState;
  }
  function addMarker(minutes) {
    const marker = element();
    marker.setAttribute('data-note-second', minutes * 60);
    markers.push(marker);
    return marker;
  }
  function addNote(minutes) {
    context.state.notes.push({ date: context.state.viewDate,
      createdAt: context.state.viewDate + 'T' + context.toClock(minutes), text: '备注' });
    return addMarker(minutes);
  }
  return { context, drag, addNote };
}

function assertScale(context) {
  const gap = context.timelineCursors.end.rangeRatio - context.timelineCursors.start.rangeRatio;
  assert.ok(gap >= 1 / 24 - 1e-9, 'the zoom controls retain at least one hour');
  assert.ok(context.timelineCursors.start.ratio <= context.timelineCursors.end.ratio + 1e-9,
    'the displayed sliders never cross');
  assert.ok(context.timelineCursors.start.ratio >= -1e-9);
  assert.ok(context.timelineCursors.end.ratio <= 1 + 1e-9);
  assert.ok(Math.abs(context.timelineZoom.end - context.timelineZoom.start - gap * 1440) < 1e-7,
    'the zoom control values determine the visible time span');
  assert.ok(context.timelineZoom.start >= -1e-7);
  assert.ok(context.timelineZoom.end <= 1440 + 1e-7);
  assert.ok(Math.abs(context.timelineZoom.start - context.timelineCursors.start.rangeRatio * 1440) < 1e-7);
  assert.ok(Math.abs(context.timelineZoom.end - context.timelineCursors.end.rangeRatio * 1440) < 1e-7);
  ['start', 'end'].forEach(name => {
    const item = context.timelineCursors[name];
    if (item.snap !== null) {
      assert.ok(Math.abs(context.timelineCursorMinutes(name) -
        (context.timelineZoom.start + item.ratio * context.timelineZoomRange())) < 1e-7,
      'snapped sliders align with the current displayed time scale');
    } else {
      assert.equal(item.ratio, item.rangeRatio, 'free sliders keep the full-day position mapping');
    }
  });
}

test('left slider at noon and right slider at the far right show noon through midnight', () => {
  const { context, drag } = timeline();
  drag('start', [0.5]);
  assert.equal(context.timelineZoom.start, 720);
  assert.equal(context.timelineZoom.end, 1440);
  assert.ok(context.el.timelineAxis.innerHTML.startsWith('<span>12:00:00</span>'));
  assert.ok(context.el.timelineAxis.innerHTML.endsWith('<span>24:00:00</span>'));
  assertScale(context);
});

test('moving either slider keeps the other endpoint and slider unchanged', () => {
  const { context, drag } = timeline();
  for (const ratio of [0.25, 0.5, 0.75]) {
    drag('start', [ratio]);
    assert.equal(context.timelineZoom.start, ratio * 1440);
    assert.equal(context.timelineZoom.end, 1440);
    assert.equal(context.timelineCursors.end.ratio, 1);
    assertScale(context);
  }
  drag('start', [0.25]);
  for (const ratio of [0.75, 0.5, 1]) {
    drag('end', [ratio]);
    assert.equal(context.timelineZoom.start, 360);
    assert.equal(context.timelineCursors.start.ratio, 0.25);
    assert.equal(context.timelineZoom.end, ratio * 1440);
    assertScale(context);
  }
});

test('bringing sliders closer enlarges the rendered time blocks', () => {
  const { context, drag } = timeline();
  const entries = [{ id: 'one-hour', start: 1260, end: 1320, level: 'INFO', category: '', activity: '阅读' }];
  context.byDate = () => entries;
  context.renderTimeline(entries);
  const originalWidth = parseFloat(context.el.timeline.children[0].style.width);
  drag('start', [0.5]);
  assert.equal(parseFloat(context.el.timeline.children[0].style.width), originalWidth * 2);
  drag('start', [0.75]);
  assert.equal(parseFloat(context.el.timeline.children[0].style.width), originalWidth * 4);
  assertScale(context);
});

test('zoom depends on slider distance rather than pointer event frequency', () => {
  const single = timeline();
  const many = timeline();
  single.drag('start', [0.5]);
  many.drag('start', Array.from({ length: 100 }, (_, i) => (i + 1) / 200));
  assert.equal(many.context.timelineZoom.end, single.context.timelineZoom.end);
  many.drag('end', [0.75]);
  assert.equal(many.context.timelineZoom.start, 720);
  assert.equal(many.context.timelineZoom.end, 1080);
  assert.equal(many.context.timelineZoomRange(), 360);
  assertScale(many.context);
});

test('right slider and dragging back out use the same scale', () => {
  const { context, drag } = timeline();
  drag('end', [0.5]);
  assert.equal(context.timelineZoom.start, 0);
  assert.equal(context.timelineZoom.end, 720);
  assertScale(context);
  drag('end', [0.75, 1]);
  assert.equal(context.timelineZoom.start, 0);
  assert.equal(context.timelineZoom.end, 1440);
  assertScale(context);
});

test('neither slider can cross the other, even outside the ruler', () => {
  for (const name of ['start', 'end']) {
    const { context, drag } = timeline();
    drag(name, name === 'start' ? [0.8, 1, 1.5] : [0.2, 0, -0.5]);
    assertScale(context);
    assert.ok(Math.abs(context.timelineZoomRange() - 60) < 1e-7);
    drag(name, name === 'start' ? [0.5, 0] : [0.5, 1]);
    assert.equal(context.timelineZoomRange(), 1440);
    assertScale(context);
  }
});

test('snapping selects a note without changing the zoom and can be released', () => {
  const { context, addNote } = timeline();
  const marker = addNote(360);
  const dragState = { offset: 0, lastX: 100, snap: null, released: null };
  context.moveTimelineCursor('start', { clientX: 350 }, dragState);
  assert.equal(context.timelineCursors.start.snap, 360);
  assert.equal(context.timelineZoom.start, 0);
  assert.equal(context.timelineZoom.end, 1440);
  assert.equal(marker.style.left, '25%');
  assert.ok(context.el.timelineStartCursor.classList.contains('note-linked'));
  assert.ok(marker.classList.contains('is-linked'));
  assertScale(context);
  context.moveTimelineCursor('start', { clientX: 355 }, dragState);
  assert.equal(context.timelineCursors.start.snap, 360);
  assertScale(context);
  context.moveTimelineCursor('start', { clientX: 380 }, dragState);
  assert.equal(context.timelineCursors.start.snap, null);
  assert.ok(!marker.classList.contains('is-linked'));
  assertScale(context);
});

test('two snapped sliders remain aligned without changing the zoom span', () => {
  const { context, addNote } = timeline();
  const firstMarker = addNote(360);
  const secondMarker = addNote(720);
  const first = { offset: 0, lastX: 100, snap: null, released: null };
  context.moveTimelineCursor('start', { clientX: 350 }, first);
  const ratio = 720 / 1440;
  const second = { offset: 0, lastX: 1100, snap: null, released: null };
  context.moveTimelineCursor('end', { clientX: 100 + ratio * 1000 }, second);
  assert.equal(context.timelineCursors.start.snap, 360);
  assert.equal(context.timelineCursors.end.snap, 720);
  assert.equal(context.timelineZoom.start, 0);
  assert.equal(context.timelineZoom.end, 1440);
  assert.ok(firstMarker.classList.contains('is-linked'));
  assert.ok(secondMarker.classList.contains('is-linked'));
  assertScale(context);
});

test('left slider snaps at the displayed note line after zooming', () => {
  const { context, drag, addNote } = timeline();
  drag('start', [0.25]);
  const marker = addNote(720);
  context.renderTimeline([]);
  const line = context.el.timeline.querySelector('.timeline-note-lines').children[0];
  const before = JSON.stringify(context.timelineZoom);
  const axis = context.el.timelineAxis.innerHTML;
  // In the visible 06:00–24:00 range, the noon note is one third across.
  drag('start', [1 / 3]);
  assert.equal(context.timelineCursors.start.snap, 720);
  assert.equal(JSON.stringify(context.timelineZoom), before, 'snapping must not change the visible range');
  assert.equal(context.el.timelineAxis.innerHTML, axis, 'the axis labels stay unchanged');
  assert.ok(Math.abs(parseFloat(marker.style.left) - 100 / 3) < 1e-7);
  assert.equal(marker.style.left, line.style.left);
  assert.ok(Math.abs(parseFloat(context.el.timelineStartCursor.style.left) - parseFloat(line.style.left)) < 1e-7,
    'the slider stops on the existing gold line instead of jumping to the full-day position');
  assert.ok(context.el.timelineStartCursor.classList.contains('note-linked'));
  assert.ok(marker.classList.contains('is-linked'));
  assertScale(context);
});

test('right slider snaps at the displayed note line without moving the start time', () => {
  const { context, drag, addNote } = timeline();
  drag('end', [0.75]);
  addNote(720);
  // In the visible 00:00–18:00 range, the noon note is two thirds across.
  drag('end', [2 / 3]);
  assert.equal(context.timelineCursors.end.snap, 720);
  assert.equal(context.timelineZoom.start, 0);
  assert.equal(context.timelineZoom.end, 1080);
  assert.ok(Math.abs(parseFloat(context.el.timelineEndCursor.style.left) - 200 / 3) < 1e-7);
  assert.ok(context.el.timelineEndCursor.classList.contains('note-linked'));
  assertScale(context);
});

test('zoomed log block midpoints remain snap targets', () => {
  const { context, drag } = timeline();
  drag('start', [0.5]);
  context.entries = [{ id: 'evening', start: 1140, end: 1200, level: 'INFO' }];
  // The 19:30 midpoint is 62.5% across the visible 12:00–24:00 range.
  drag('start', [0.625]);
  assert.equal(context.timelineCursors.start.snap, 1170);
  assert.equal(context.timelineZoom.start, 720);
  assert.equal(context.timelineZoom.end, 1440);
  assert.equal(context.el.timelineStartCursor.style.left, '62.5%');
  assert.ok(context.el.timelineStartCursor.classList.contains('log-linked'));
  assertScale(context);
});

test('log midpoint snapping preserves fractional times and the linked highlight', () => {
  const { context, drag } = timeline();
  context.entries = [{ id: 'fractional', start: 600.123, end: 601.456, level: 'INFO' }];
  const midpoint = (600.123 + 601.456) / 2;
  drag('start', [midpoint / 1440]);
  assert.equal(context.timelineCursors.start.snap, midpoint);
  assert.equal(context.timelineZoom.start, 0);
  assert.equal(context.timelineZoom.end, 1440);
  assert.ok(context.el.timelineStartCursor.classList.contains('log-linked'));
  assertScale(context);
});

test('releasing a drag saves the displayed note snap and keeps its golden marker visible', () => {
  const { context, drag, addNote } = timeline();
  drag('start', [0.25]);
  const marker = addNote(720);
  const slider = context.el.timelineStartCursor;
  let saved;
  context.persist = () => { saved = JSON.parse(JSON.stringify(context.state.ui)); };
  context.bindTimelineCursor(slider, 'start');
  const event = x => ({ clientX: x, pointerId: 1, isPrimary: true, button: 0,
    preventDefault() {}, stopPropagation() {} });
  slider.listeners.pointerdown(event(350));
  slider.listeners.pointermove(event(100 + 1000 / 3));
  assert.equal(context.timelineCursors.start.snap, 720);
  slider.listeners.pointerup(event(100 + 1000 / 3));
  assert.equal(saved.timelineZoom.start, 360);
  assert.equal(saved.timelineZoom.end, 1440);
  assert.equal(saved.timelineCursors.start.snap, 720);
  assert.ok(Math.abs(saved.timelineCursors.start.ratio - 1 / 3) < 1e-7);
  assert.equal(saved.timelineCursors.start.rangeRatio, 0.25);
  assert.ok(marker.classList.contains('is-linked'));
  assert.ok(slider.classList.contains('note-linked'));
  assert.ok(!slider.classList.contains('dragging'));
  assert.ok(!slider.hasPointerCapture(1));
  assertScale(context);
});

test('grabbing a saved snapped slider again does not jump or change the zoom', () => {
  const { context, drag, addNote } = timeline();
  drag('start', [0.25]);
  const marker = addNote(720);
  drag('start', [1 / 3]);
  const before = JSON.stringify([context.timelineZoom, context.timelineCursors]);
  const slider = context.el.timelineStartCursor;
  context.bindTimelineCursor(slider, 'start');
  const event = x => ({ clientX: x, pointerId: 1, isPrimary: true, button: 0,
    preventDefault() {}, stopPropagation() {} });
  const x = 100 + context.timelineCursors.start.ratio * 1000;
  slider.listeners.pointerdown(event(x));
  slider.listeners.pointermove(event(x + 5));
  slider.listeners.pointerup(event(x + 5));
  assert.equal(JSON.stringify([context.timelineZoom, context.timelineCursors]), before);
  assert.ok(marker.classList.contains('is-linked'));
  assertScale(context);
});

test('adjusting the other endpoint keeps the snapped cursor on the moving gold line', () => {
  const { context, drag, addNote } = timeline();
  const marker = addNote(360);
  context.renderTimeline([]);
  drag('start', [0.25]);
  drag('end', [0.75]);
  assert.equal(context.timelineZoom.start, 0);
  assert.equal(context.timelineZoom.end, 1080);
  assert.equal(context.timelineCursors.start.snap, 360);
  const line = context.el.timeline.querySelector('.timeline-note-lines').children[0];
  assert.equal(marker.style.left, line.style.left);
  assert.ok(Math.abs(parseFloat(context.el.timelineStartCursor.style.left) - parseFloat(line.style.left)) < 1e-7);
  assert.ok(marker.classList.contains('is-linked'));
  assertScale(context);
});

test('two nearby note snaps retain the existing zoom instead of collapsing its boundaries', () => {
  const { context, drag, addNote } = timeline();
  drag('start', [0.25]);
  addNote(720);
  addNote(721);
  drag('start', [1 / 3]);
  drag('end', [(721 - 360) / 1080]);
  assert.equal(context.timelineZoom.start, 360);
  assert.equal(context.timelineZoom.end, 1440);
  assert.equal(context.timelineCursors.start.snap, 720);
  assert.equal(context.timelineCursors.end.snap, 721);
  assertScale(context);
});

test('hidden notes do not create snap targets at their old full-day positions', () => {
  const { context, drag, addNote } = timeline();
  drag('start', [0.5]);
  const marker = addNote(360);
  context.renderTimeline([]);
  assert.ok(marker.hidden);
  drag('start', [0.25]);
  assert.equal(context.timelineCursors.start.snap, null);
  assert.equal(context.timelineZoom.start, 360);
  assert.equal(context.timelineZoom.end, 1440);
  assertScale(context);
});

test('moving past a displayed snap releases it without immediately snapping back', () => {
  const { context, drag, addNote } = timeline();
  drag('start', [0.25]);
  const marker = addNote(720);
  const dragState = drag('start', [1 / 3]);
  const snapX = 100 + 1000 / 3;
  context.moveTimelineCursor('start', { clientX: snapX + 5 }, dragState);
  assert.equal(context.timelineCursors.start.snap, 720);
  context.moveTimelineCursor('start', { clientX: snapX + 12 }, dragState);
  assert.equal(context.timelineCursors.start.snap, null);
  assert.ok(!marker.classList.contains('is-linked'));
  assert.equal(context.timelineZoom.end, 1440);
  assertScale(context);
});

test('displayed snap targets cannot cross the other slider or bypass the minimum span', () => {
  const { context, drag, addNote } = timeline();
  drag('start', [0.5]);
  drag('end', [840 / 1440]);
  const end = context.timelineZoom.end;
  addNote(830);
  // The 13:50 note is visible, but is less than one hour before the 14:00 end.
  drag('start', [11 / 12]);
  assert.equal(context.timelineCursors.start.snap, null);
  assert.ok(Math.abs(context.timelineZoom.start - 780) < 1e-7);
  assert.ok(Math.abs(context.timelineZoom.end - end) < 1e-7);
  assertScale(context);
});

test('keyboard steps zoom by one hour and stop before crossing', () => {
  const { context } = timeline();
  const handlers = {};
  context.bindTimelineCursor({ addEventListener: (name, handler) => { handlers[name] = handler; } }, 'start');
  for (let i = 0; i < 24; i++) {
    handlers.keydown({ key: 'ArrowRight', preventDefault() {} });
    assert.ok(Math.abs(context.timelineZoomRange() - Math.max(60, 1440 - (i + 1) * 60)) < 1e-7);
    assertScale(context);
  }
});

test('restoring old crossed cursor positions repairs their order', () => {
  const { context } = timeline();
  for (const [start, end] of [[0.9, 0.1], [0, 0], [1, 1]]) {
    context.timelineCursors = context.normalizeTimelineCursors({
      start: { ratio: start, snap: null }, end: { ratio: end, snap: null }
    });
    Object.assign(context.timelineZoom, context.timelineZoomFromCursors());
    assertScale(context);
  }
});

test('restoring zoom with two snapped notes does not drift', () => {
  const { context, drag, addNote } = timeline();
  drag('start', [0.25]);
  addNote(720);
  addNote(900);
  drag('start', [1 / 3]);
  drag('end', [0.5]);
  assert.equal(context.timelineCursors.start.snap, 720);
  assert.equal(context.timelineCursors.end.snap, 900);
  const expected = JSON.stringify([context.timelineZoom, context.timelineCursors]);
  for (let i = 0; i < 10; i++) {
    context.state.ui = JSON.parse(JSON.stringify({
      timelineZoom: context.timelineZoom, timelineCursors: context.timelineCursors
    }));
    context.syncCollapseState();
    context.renderTimeline([]);
    assertScale(context);
  }
  assert.equal(JSON.stringify([context.timelineZoom, context.timelineCursors]), expected);
});

test('refresh restores the same zoom and repairs old slider/zoom mismatches', () => {
  const { context, drag } = timeline();
  drag('start', [0.5]);
  context.state.ui.timelineZoom = { start: 0, end: 1000 };
  context.syncCollapseState();
  assert.equal(context.timelineZoom.start, 720);
  assert.equal(context.timelineZoom.end, 1440);
  assertScale(context);
  context.state.ui = { timelineZoom: { start: 120, end: 480 }, timelineCursors: null };
  context.syncCollapseState();
  assert.equal(context.timelineZoom.start, 120);
  assert.equal(context.timelineZoom.end, 480);
  assertScale(context);
});

test('older saved snaps restore at the displayed line while retaining their saved zoom', () => {
  const { context, addNote } = timeline();
  const marker = addNote(720);
  context.state.ui = {
    timelineZoom: { start: 360, end: 1440 },
    timelineCursors: { start: { ratio: 0.5, snap: 720 }, end: { ratio: 1, snap: null } }
  };
  context.syncCollapseState();
  context.renderTimeline([]);
  assert.equal(context.timelineZoom.start, 360);
  assert.equal(context.timelineZoom.end, 1440);
  assert.equal(context.timelineCursors.start.rangeRatio, 0.25);
  assert.ok(Math.abs(context.timelineCursors.start.ratio - 1 / 3) < 1e-7);
  assert.ok(Math.abs(parseFloat(context.el.timelineStartCursor.style.left) - parseFloat(marker.style.left)) < 1e-7);
  assertScale(context);
});

test('double-click reset restores the full day and both slider endpoints', () => {
  const { context, drag } = timeline();
  drag('start', [0.25]);
  drag('end', [0.75]);
  context.resetTimelineZoom();
  assert.equal(context.timelineZoom.start, 0);
  assert.equal(context.timelineZoom.end, 1440);
  assert.equal(context.timelineCursors.start.ratio, 0);
  assert.equal(context.timelineCursors.end.ratio, 1);
  assert.ok(context.el.timelineAxis.innerHTML.startsWith('<span>00:00:00</span>'));
  assert.ok(context.el.timelineAxis.innerHTML.endsWith('<span>24:00:00</span>'));
  assertScale(context);
});
