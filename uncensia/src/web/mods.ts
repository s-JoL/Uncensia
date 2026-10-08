import { useEffect, useState } from "react";
import type { ModRecord } from "@shared/types.ts";
import { api } from "./api.ts";

const CHANGED = "uncensia:mods-changed";
let cache: ModRecord[] | null = null;
let pending: Promise<ModRecord[]> | null = null;

function load() {
  return (pending ??= api.mods().then(({ items }) => (cache = items)).finally(() => { pending = null; }));
}

/** Tells every mounted reader to fetch again: after a settings edit or a run that changed a mod. */
export function modsChanged() {
  cache = null;
  window.dispatchEvent(new Event(CHANGED));
}

/** The enabled mods, shared by every slot that renders a contribution. */
export function useMods() {
  const [mods, setMods] = useState<ModRecord[]>(() => (cache ?? []).filter(mod => mod.enabled));
  useEffect(() => {
    let live = true;
    const refresh = () => void load().then(items => { if (live) setMods(items.filter(mod => mod.enabled)); }).catch(() => undefined);
    refresh();
    window.addEventListener(CHANGED, refresh);
    return () => { live = false; window.removeEventListener(CHANGED, refresh); };
  }, []);
  return mods;
}
