'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['', 'tests', 'scripts'].flatMap(directory => fs.readdirSync(path.join(root, directory))
  .filter(file => /\.(?:js|cjs)$/.test(file)).map(file => path.join(root, directory, file)));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { process.exit(result.status || 1); }
}
console.log('Syntax checked ' + files.length + ' JavaScript files.');
