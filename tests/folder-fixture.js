'use strict';
// Same in-memory File System Access surface is used by Node and disposable browser tests.
function memoryDirectory(name = 'backups', control = { writes: 0 }) {
  const children = new Map();
  const missing = () => Object.assign(new Error('Missing file'), { name: 'NotFoundError' });
  const mismatch = () => Object.assign(new Error('Different entry type'), { name: 'TypeMismatchError' });
  return { name, kind: 'directory', children, control,
    async *keys() { yield* children.keys(); },
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
          async getFile() { const text = this.contents; return { name, size: new TextEncoder().encode(text).length, text: async () => text }; },
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
