const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(repoRoot, 'script.js'), 'utf8');

test('dashboard page exposes the named panel and main branding', () => {
  assert.match(html, /天道酬勤面板/i);
  assert.match(html, /天道酬勤/i);
  assert.match(html, /stats-grid|task-list/i);
});

test('dashboard script renders key metric and task data', () => {
  assert.match(script, /本周产出/i);
  assert.match(script, /算法题训练/i);
  assert.match(script, /document\.title = '天道酬勤面板'/i);
});
