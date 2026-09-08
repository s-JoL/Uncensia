import type { RoleplayContext } from "./types.ts";

export const ROLEPLAY_LIMITS: Record<Exclude<keyof RoleplayContext, "enabled">, number> = {
  character: 6_000, persona: 3_000, world: 10_000, scene: 6_000, style: 3_000, examples: 6_000,
};

/** Validate writes before any conversation settings change. Old stored rows are
 * still normalized on read; a new write must not silently discard user prose. */
export function roleplayInputError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "角色设定必须是一个对象";
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") return "角色设定 enabled 必须是布尔值";
  for (const [key, limit] of Object.entries(ROLEPLAY_LIMITS)) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string") return `角色设定 ${key} 必须是文字`;
    if (input[key].length > limit) return `角色设定 ${key} 超过 ${limit} 字，请缩短后保存`;
  }
}
