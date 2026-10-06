/** A text adapter for Tavern character cards, not a Tavern runtime/editor.
 * Reads Character Card V1 (flat), V2 (`chara_card_v2`) and V3 (`chara_card_v3`)
 * as JSON, or embedded in a PNG's `chara` / `ccv3` text chunk, which is how
 * cards are usually shared.
 * Sources: https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
 *          https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
 * The original document is never rewritten; unsupported fields are reported. */
export interface CharacterCardPreview {
  name: string;
  character: string;
  scene: string;
  examples: string;
  /** The card's first message; applied as the reply the story opens with. */
  opening: string;
  /** Lorebook entries flattened into setting text, or "" when there are none. */
  lore: string;
  creatorNotes: string;
  notices: string[];
}

export const CHARACTER_CARD_MAX_BYTES = 1_000_000;
const LORE_MAX_CHARS = 6000;

/**
 * The card JSON a PNG carries, or null. V3 cards keep `ccv3` beside a V2
 * `chara` for older readers; the newer one wins. Text chunks are Latin-1 by
 * the PNG spec, and the value is base64 of UTF-8 JSON.
 */
export function extractCardFromPng(bytes: Uint8Array): string | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Record<string, string> = {};
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8, end = start + length;
    if (end + 4 > bytes.length) break;
    if (type === "tEXt" || type === "iTXt") {
      const data = bytes.subarray(start, end);
      const zero = data.indexOf(0);
      const keyword = String.fromCharCode(...data.subarray(0, zero)).toLowerCase();
      if (keyword === "chara" || keyword === "ccv3") {
        // iTXt: keyword\0 compression-flag compression-method lang\0 translated\0 text
        let text = data.subarray(zero + 1);
        if (type === "iTXt") {
          if (text[0] !== 0) { offset = end + 4; continue; } // compressed text is not supported
          let rest = text.subarray(2);
          for (let skip = 0; skip < 2; skip++) rest = rest.subarray(rest.indexOf(0) + 1);
          text = rest;
        }
        found[keyword] = new TextDecoder().decode(base64ToBytes(new TextDecoder("latin1").decode(text).trim()));
      }
    }
    if (type === "IEND") break;
    offset = end + 4;
  }
  return found.ccv3 ?? found.chara ?? null;
}

function base64ToBytes(value: string) {
  const binary = atob(value.replace(/\s+/g, ""));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function previewCharacterCard(text: string): CharacterCardPreview {
  if (new TextEncoder().encode(text).length > CHARACTER_CARD_MAX_BYTES) throw new Error("角色卡 JSON 最大支持 1 MB");
  let card: unknown;
  try { card = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error("无法读取 JSON，请检查文件或粘贴完整内容"); }
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error("角色卡必须是 JSON 对象");
  const root = card as Record<string, unknown>;
  let data: Record<string, unknown>;
  if (root.spec === "chara_card_v2" || root.spec === "chara_card_v3") {
    const expected = root.spec === "chara_card_v2" ? "2.0" : "3.0";
    if (root.spec_version !== undefined && root.spec_version !== expected) throw new Error(`${String(root.spec)} 的 spec_version 应为 ${expected}`);
    if (!root.data || typeof root.data !== "object" || Array.isArray(root.data)) throw new Error("角色卡缺少 data 对象");
    data = root.data as Record<string, unknown>;
  } else if (root.spec === undefined && typeof root.name === "string") {
    data = root; // V1: the fields sit at the top level.
  } else {
    throw new Error("目前支持 Character Card V1、V2、V3（JSON 或 PNG）");
  }
  // Fields are optional — real cards omit many — but a present field must have its type.
  const str = (field: string) => {
    const value = data[field];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new Error(`角色卡 ${field} 必须是文字`);
    return value;
  };
  const list = (field: string) => {
    const value = data[field];
    if (value === undefined || value === null) return [] as string[];
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`角色卡 ${field} 必须是文字数组`);
    return value as string[];
  };
  const name = str("name").trim();
  if (!name) throw new Error("角色卡名称不能为空");
  // Exact format substitution only. User names, lore activation and arbitrary
  // macros are not guessed or executed by this adapter.
  const prose = (value: string) => value.replaceAll("{{char}}", () => name).replaceAll("<BOT>", () => name).trim();
  const greetings = list("alternate_greetings");
  const notices: string[] = [];
  if (str("first_mes")) notices.push("开场白已放进场景，第一条回复会从这里开始。");
  if (greetings.length) notices.push(`另有 ${greetings.length} 条备选开场白未使用。`);
  if (str("system_prompt") || str("post_history_instructions")) notices.push("额外提示指令未应用；通用指令和写作方式保持原值。");
  const book = data.character_book as { entries?: Array<Record<string, unknown>> } | undefined;
  const entries = Array.isArray(book?.entries) ? book.entries.filter(entry => entry && entry.enabled !== false && typeof entry.content === "string" && (entry.content as string).trim()) : [];
  let lore = entries.map(entry => {
    const keys = Array.isArray(entry.keys) ? (entry.keys as unknown[]).filter(key => typeof key === "string").join(" / ") : "";
    return `${keys ? `【${keys}】` : "-"} ${prose(entry.content as string)}`;
  }).join("\n");
  if (lore.length > LORE_MAX_CHARS) {
    lore = lore.slice(0, LORE_MAX_CHARS);
    notices.push("世界书较长，只放入了前面的部分。");
  }
  if (entries.length) notices.push(`世界书 ${entries.length} 条已作为常驻设定放进“世界”，不会按关键词触发。`);
  const extensions = data.extensions;
  if (extensions && typeof extensions === "object" && Object.keys(extensions).length) notices.push("扩展功能未启用，原始数据仍在原文件中。");
  const character = [name, prose(str("description")), prose(str("personality"))].filter(Boolean).join("\n\n");
  const scene = prose(str("scenario"));
  const examples = prose(str("mes_example"));
  const opening = prose(str("first_mes"));
  if ([character, scene, examples, opening, lore].some(value => /\{\{[^}]+\}\}/.test(value))) notices.push("除角色名外的模板标记（如 {{user}}）保留为文本，请在草稿中按需填写。");
  return { name, character, scene, examples, opening, lore, creatorNotes: str("creator_notes"), notices };
}
