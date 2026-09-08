/** Copy old browser preferences/drafts once; never resurrect a signed-out token. */
export function migrateLegacyStorage(storage: Storage) {
  const marker = "uncensia.storage-migrated";
  if (storage.getItem(marker) === "1") return;
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
  for (const key of keys) {
    if (!key?.startsWith("luma.")) continue;
    const current = "uncensia." + key.slice(5);
    if (storage.getItem(current) === null) storage.setItem(current, storage.getItem(key) ?? "");
  }
  storage.setItem(marker, "1");
}

if (typeof window !== "undefined") migrateLegacyStorage(localStorage);
