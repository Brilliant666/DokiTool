// Deterministic request/transaction boundary model. Production task-store.js is
// exercised unchanged; this fake supplies only browser IndexedDB scheduling.
export function fakeIndexedDB(options = {}) {
  const records = new Map();
  let writes = 0;
  return {
    records,
    get writes() { return writes; },
    open() {
      const request = {};
      if (options.openHangs) return request;
      queueMicrotask(() => {
        if (options.openFails) { request.error = new Error('open failed'); request.onerror?.(); return; }
        request.result = {
          close() {}, createObjectStore() {},
          transaction() {
            const tx = { pending: 0, stopped: false, abort() { this.stopped = true; this.onabort?.(); } };
            const operation = action => {
              const result = {}; tx.pending++;
              queueMicrotask(() => {
                if (tx.stopped) return;
                try { result.result = action(); result.onsuccess?.(); }
                catch (error) { tx.error = error; tx.stopped = true; tx.onerror?.(); }
                tx.pending--;
                queueMicrotask(() => { if (!tx.pending && !tx.stopped) { tx.stopped = true; tx.oncomplete?.(); } });
              });
              return result;
            };
            tx.objectStore = () => ({
              put(value) { if (options.writeHangs) { tx.pending++; return {}; } return operation(() => { writes++; if (options.writeFails) throw new Error('write failed'); records.set(value.id, structuredClone(value)); }); },
              get(id) { return operation(() => structuredClone(records.get(id))); },
              getAll() { return operation(() => structuredClone([...records.values()])); },
              delete(id) { return operation(() => records.delete(id)); },
            });
            return tx;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
}
