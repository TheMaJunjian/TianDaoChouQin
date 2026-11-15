'use strict';
// Same in-memory File System Access surface is used by Node and disposable browser tests.
function memoryDirectory(name = 'backups', control = { writes: 0 }) {
  const children = new Map();
  const missing = () => Object.assign(new Error('Missing file'), { name: 'NotFoundError' });
  const mismatch = () => Object.assign(new Error('Different entry type'), { name: 'TypeMismatchError' });
  return { name, kind: 'directory', children, control,
    async *keys() { yield* children.keys(); },
    async *entries() { yield* children.entries(); },
    async isSameEntry(other) { return this === other; },
    async resolve(other) {
      if (this === other) { return []; }
      for (const [name, child] of children) {
        if (child === other) { return [name]; }
        if (child.kind === 'directory') {
          const path = await child.resolve(other);
          if (path) { return [name, ...path]; }
        }
      }
      return null;
    },
    async getDirectoryHandle(name, options = {}) {
      if (!children.has(name)) {
        if (!options.create) { throw missing(); }
        children.set(name, memoryDirectory(name, control));
      }
      if (children.get(name).kind !== 'directory') { throw mismatch(); }
      return children.get(name);
    },
    async getFileHandle(name, options = {}) {
      if (!children.has(name)) {
        if (!options.create) { throw missing(); }
        children.set(name, { name, kind: 'file', contents: '',
          async getFile() { const text = this.contents; return { name, size: new TextEncoder().encode(text).length,
            text: async () => { control.reads = (control.reads || 0) + 1; return text; } }; },
          async createWritable() {
            const file = this; let pending;
            return { async write(text) {
              control.writes++;
              if (control.failAt === control.writes) { throw new Error('Simulated disk full'); }
              pending = text;
              if (control.onWrite) { await control.onWrite(file, text); }
            }, async close() { file.contents = pending; }, async abort() {} };
          }
        });
      }
      if (children.get(name).kind !== 'file') { throw mismatch(); }
      return children.get(name);
    }
  };
}
module.exports = { memoryDirectory };
