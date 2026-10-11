'use strict';
/* Tiny promise wrapper around IndexedDB, with an in-memory fallback for
   browsers that block it (private mode, some captive-portal mini browsers). */

const DB = (() => {
  const STORES = {
    items: { keyPath: 'key' },                         // hub records, key = "col:id"
    outbox: { keyPath: 'seq', autoIncrement: true },   // writes waiting to sync
    mine: { keyPath: 'id' },                           // personal notes, never synced
    meta: {},                                          // sync cursor, owner key, ...
  };

  let dbp = null;
  let memory = null; // Map<store, Map<key, value>> when IndexedDB is unavailable
  let memSeq = 0;

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('no IndexedDB'));
        const r = indexedDB.open('campus-companion', 1);
        r.onupgradeneeded = () => {
          for (const [name, opts] of Object.entries(STORES)) r.result.createObjectStore(name, opts);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }).catch(err => {
        console.warn('IndexedDB unavailable, data will not survive a reload:', err);
        memory = new Map(Object.keys(STORES).map(s => [s, new Map()]));
        return null;
      });
    }
    return dbp;
  }

  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function store(name, mode = 'readonly') {
    const db = await open();
    return db ? db.transaction(name, mode).objectStore(name) : null;
  }

  function memKey(name, value, key) {
    if (key !== undefined) return key;
    const kp = STORES[name].keyPath;
    if (STORES[name].autoIncrement && value[kp] === undefined) value[kp] = ++memSeq;
    return value[kp];
  }

  return {
    get isPersistent() { return !memory; },
    async get(name, key) {
      const s = await store(name);
      return s ? req(s.get(key)) : memory.get(name).get(key);
    },
    async all(name) {
      const s = await store(name);
      return s ? req(s.getAll()) : [...memory.get(name).values()];
    },
    async count(name) {
      const s = await store(name);
      return s ? req(s.count()) : memory.get(name).size;
    },
    async put(name, value, key) {
      const s = await store(name, 'readwrite');
      if (s) return req(key === undefined ? s.put(value) : s.put(value, key));
      memory.get(name).set(memKey(name, value, key), value);
    },
    async del(name, key) {
      const s = await store(name, 'readwrite');
      return s ? req(s.delete(key)) : memory.get(name).delete(key);
    },
    async clear(name) {
      const s = await store(name, 'readwrite');
      return s ? req(s.clear()) : memory.get(name).clear();
    },
    /* Runs fn(api) inside one readwrite transaction; api has put(value) and del(key). */
    async batch(name, fn) {
      const db = await open();
      if (!db) {
        const m = memory.get(name);
        fn({ put: v => m.set(memKey(name, v), v), del: k => m.delete(k) });
        return;
      }
      return new Promise((resolve, reject) => {
        const t = db.transaction(name, 'readwrite');
        const s = t.objectStore(name);
        fn({ put: v => s.put(v), del: k => s.delete(k) });
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },
  };
})();
