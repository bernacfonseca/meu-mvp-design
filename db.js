// ============================================================
// ACERVO — data layer (IndexedDB)
// Everything lives in the browser. No server, no network calls.
// ============================================================

const DB_NAME = 'acervo-db';
const DB_VERSION = 1;
const STORE_ITEMS = 'items';
const STORE_PROFILE = 'profile';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const store = db.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------- items ----------

export async function addItem(item) {
  const db = await openDB();
  const store = tx(db, STORE_ITEMS, 'readwrite');
  await wrap(store.add(item));
  return item;
}

export async function updateItem(id, patch) {
  const db = await openDB();
  const store = tx(db, STORE_ITEMS, 'readwrite');
  const existing = await wrap(store.get(id));
  if (!existing) throw new Error('Item não encontrado');
  const updated = { ...existing, ...patch };
  await wrap(store.put(updated));
  return updated;
}

export async function deleteItem(id) {
  const db = await openDB();
  const store = tx(db, STORE_ITEMS, 'readwrite');
  await wrap(store.delete(id));
}

export async function getAllItems() {
  const db = await openDB();
  const store = tx(db, STORE_ITEMS, 'readonly');
  const all = await wrap(store.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

// ---------- profile ----------

const PROFILE_ID = 'profile';

export async function getProfile() {
  const db = await openDB();
  const store = tx(db, STORE_PROFILE, 'readonly');
  const existing = await wrap(store.get(PROFILE_ID));
  return existing || { id: PROFILE_ID, name: '', bio: '', avatarBlob: null, defaultGrouping: 'month' };
}

export async function saveProfile(patch) {
  const db = await openDB();
  const current = await getProfile();
  const updated = { ...current, ...patch, id: PROFILE_ID };
  const store = tx(db, STORE_PROFILE, 'readwrite');
  await wrap(store.put(updated));
  return updated;
}

// ---------- blob <-> base64 (for backup export/import) ----------

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result); // data: URL
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function base64ToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

// ---------- export / import ----------

export async function exportAll() {
  const items = await getAllItems();
  const profile = await getProfile();

  const itemsOut = [];
  for (const item of items) {
    const out = { ...item };
    if (item.blob instanceof Blob) {
      out.blobData = await blobToBase64(item.blob);
      out.blob = undefined;
    }
    itemsOut.push(out);
  }

  let profileOut = { ...profile };
  if (profile.avatarBlob instanceof Blob) {
    profileOut.avatarData = await blobToBase64(profile.avatarBlob);
    profileOut.avatarBlob = undefined;
  }

  return {
    exportedAt: new Date().toISOString(),
    app: 'acervo',
    version: 1,
    profile: profileOut,
    items: itemsOut,
  };
}

export async function importAll(data) {
  if (!data || !Array.isArray(data.items)) {
    throw new Error('Arquivo de backup inválido');
  }
  const db = await openDB();

  // items
  const itemStore = tx(db, STORE_ITEMS, 'readwrite');
  for (const raw of data.items) {
    const item = { ...raw };
    if (item.blobData) {
      item.blob = await base64ToBlob(item.blobData);
    }
    delete item.blobData;
    await wrap(itemStore.put(item));
  }

  // profile
  if (data.profile) {
    const profile = { ...data.profile, id: PROFILE_ID };
    if (profile.avatarData) {
      profile.avatarBlob = await base64ToBlob(profile.avatarData);
    }
    delete profile.avatarData;
    const profileStore = tx(db, STORE_PROFILE, 'readwrite');
    await wrap(profileStore.put(profile));
  }
}

export async function clearAll() {
  const db = await openDB();
  await wrap(tx(db, STORE_ITEMS, 'readwrite').clear());
  await wrap(tx(db, STORE_PROFILE, 'readwrite').clear());
}
