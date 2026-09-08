/** A text adapter for Character Card V2 JSON, not a Tavern runtime/editor.
 * Source: https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
 * The original document is never rewritten; unsupported fields are reported. */
export interface CharacterCardPreview {
  name: string;
  character: string;
  scene: string;
  examples: string;
  creatorNotes: string;
  notices: string[];
}

export const CHARACTER_CARD_MAX_BYTES = 1_000_000;

export function previewCharacterCard(text: string): CharacterCardPreview {
  if (new TextEncoder().encode(text).length > CHARACTER_CARD_MAX_BYTES) throw new Error("角色卡 JSON 最大支持 1 MB");
  let card: unknown;
  try { card = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("无法读取 JSON，请检查文件或粘贴完整内容"); }
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error("角色卡必须是 JSON 对象");
  const root = card as Record<string, unknown>;
  if (root.spec !== "chara_card_v2" || root.spec_version !== "2.0") throw new Error("目前支持 Character Card V2（chara_card_v2 / 2.0）JSON 的设定提取");
  if (!root.data || typeof root.data !== "object" || Array.isArray(root.data)) throw new Error("角色卡缺少 data 对象");
  const data = root.data as Record<string, unknown>;
  for (const field of ["name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions", "creator", "character_version"]) {
    if (typeof data[field] !== "string") throw new Error(`角色卡 ${field} 必须是文字`);
  }
  for (const field of ["alternate_greetings", "tags"]) {
    if (!Array.isArray(data[field]) || data[field].some(value => typeof value !== "string")) throw new Error(`角色卡 ${field} 必须是文字数组`);
  }
  if (!data.extensions || typeof data.extensions !== "object" || Array.isArray(data.extensions)) throw new Error("角色卡 extensions 必须是对象");
  const name = (data.name as string).trim();
  if (!name) throw new Error("角色卡名称不能为空");
  // Exact format substitution only. User names, lore activation and arbitrary
  // macros are not guessed or executed by this adapter.
  const prose = (value: unknown) => (value as string).replaceAll("{{char}}", () => name).trim();
  const notices: string[] = [];
  if (data.first_mes || (data.alternate_greetings as string[]).length) notices.push("开场白未加入对话，已有剧情会保留。");
  if (data.system_prompt || data.post_history_instructions) notices.push("额外提示指令未应用；通用指令和写作方式保持原值。");
  if (data.character_book) notices.push("这张卡含世界书，尚未导入或启用。");
  if (Object.keys(data.extensions).length) notices.push("扩展功能未启用，原始数据仍在原文件中。");
  const character = [name, prose(data.description), prose(data.personality)].filter(Boolean).join("\n\n");
  const scene = prose(data.scenario);
  const examples = prose(data.mes_example);
  if ([character, scene, examples].some(value => /\{\{[^}]+\}\}/.test(value))) notices.push("除角色名外的模板标记保留为文本，请在草稿中按需填写。");
  return { name, character, scene, examples, creatorNotes: data.creator_notes as string, notices };
}
