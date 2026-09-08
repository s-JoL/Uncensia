import { useCallback, useEffect, useState, type SetStateAction } from "react";
import type { FileRecord, ImageReferenceRole } from "@shared/types.ts";

interface Draft { text: string; attachments: FileRecord[]; roles: Record<string,ImageReferenceRole> }
const empty = (): Draft => ({text:"",attachments:[],roles:{}});
function read(key: string): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (saved && typeof saved.text === "string" && Array.isArray(saved.attachments) && saved.roles) return saved;
  } catch { /* Storage may be unavailable; an in-memory draft still works. */ }
  return empty();
}

/** Drafts are per conversation and browser tab; media remains a server ID. */
export function useChatDraft(conversationId: string) {
  const key = `uncensia.draft.${conversationId || "new"}`;
  const [state,setState] = useState(() => ({key,...read(key)}));
  useEffect(() => { if (state.key !== key) setState({key,...read(key)}); }, [key,state.key]);
  useEffect(() => {
    if (state.key !== key) return;
    try {
      if (!state.text && !state.attachments.length) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key,JSON.stringify({text:state.text,attachments:state.attachments,roles:state.roles}));
    } catch { /* A storage quota must not block typing or sending. */ }
  }, [key,state]);
  const update = useCallback(<K extends keyof Draft>(field: K, value: SetStateAction<Draft[K]>) => {
    setState(previous => {
      const current = previous.key === key ? previous : {key,...read(key)};
      return {...current,[field]: typeof value === "function" ? (value as (old:Draft[K]) => Draft[K])(current[field]) : value};
    });
  },[key]);
  return {
    draft:state.text, attachments:state.attachments, referenceRoles:state.roles,
    setDraft:useCallback((value:SetStateAction<string>) => update("text",value),[update]),
    setAttachments:useCallback((value:SetStateAction<FileRecord[]>) => update("attachments",value),[update]),
    setReferenceRoles:useCallback((value:SetStateAction<Record<string,ImageReferenceRole>>) => update("roles",value),[update]),
  };
}
