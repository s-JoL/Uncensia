import type { FileRecord, ImageReferenceRole } from "@shared/types.ts";

const KEY = "uncensia.chat.attachment";
export function handToChat(file: FileRecord, role: ImageReferenceRole = "context") {
  sessionStorage.setItem(KEY, JSON.stringify({ file, role }));
  window.history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function takeChatAttachment(): { file: FileRecord; role: ImageReferenceRole } | undefined {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return;
  sessionStorage.removeItem(KEY);
  try { return JSON.parse(raw); } catch { return; }
}
