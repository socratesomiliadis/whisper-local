"use strict";

// Transcript records stay in this origin's IndexedDB; no server storage.
class LocalLibrary {
  constructor() {
    this.pending = Promise.resolve();
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open("whisper-local-library", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("transcripts", { keyPath: "id" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(
          new Error("Close other Whisper Local tabs to open the library."),
        );
    });
    // Opening may fail in restricted browsers; report it when the UI reads it.
    this.db.catch(() => {});
  }

  async transaction(mode, action) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("transcripts", mode);
      const request = action(transaction.objectStore("transcripts"));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error || new Error("Local save was interrupted."));
    });
  }

  mutate(action) {
    const task = this.pending.catch(() => {}).then(action);
    this.pending = task;
    return task;
  }

  put(record) {
    return this.mutate(() =>
      this.transaction("readwrite", (store) => store.put(record)),
    );
  }

  delete(id) {
    return this.mutate(() =>
      this.transaction("readwrite", (store) => store.delete(id)),
    );
  }

  clear() {
    return this.mutate(() =>
      this.transaction("readwrite", (store) => store.clear()),
    );
  }

  async list() {
    await this.pending.catch(() => {});
    const records = await this.transaction("readonly", (store) =>
      store.getAll(),
    );
    return records.sort((a, b) => b.updated - a.updated);
  }

  async get(id) {
    await this.pending.catch(() => {});
    return this.transaction("readonly", (store) => store.get(id));
  }
}

// Store-only ZIP: Unicode filenames, checksums, and no runtime dependency.
function transcriptZip(files) {
  const encoder = new TextEncoder();
  const chunks = [],
    directory = [];
  let offset = 0;
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(12, 33, true); // 1980-01-01
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x800, true);
    entry.setUint16(14, 33, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.set(name, 46);
    chunks.push(local, data);
    directory.push(central);
    offset += local.length + data.length;
  }
  const directoryLength = directory.reduce(
    (total, entry) => total + entry.length,
    0,
  );
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, directoryLength, true);
  view.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end], { type: "application/zip" });
}

window.LocalLibrary = LocalLibrary;
window.transcriptZip = transcriptZip;
