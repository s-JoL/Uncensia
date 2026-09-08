import type { ModelSpec } from "@shared/types.ts";

/**
 * Existing default category settings for the Google adapter. Model rows may
 * supply `params.safetySettings`; an already shaped config takes precedence.
 * These are request settings, not a guarantee that a provider accepts either
 * the settings or a particular request. Do not infer rejection causes from a
 * missing response. This field is only attached to `google-generative` here.
 */
const SAFETY_OFF = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
].map((category) => ({ category, threshold: "OFF" }));

/**
 * Last-mile request shaping, applied after the protocol adapter has built the
 * payload.
 */
export function applyModelParameters(payload: unknown, spec: ModelSpec) {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...(payload as Record<string, unknown>) };
  if (spec.apiMode === "google-generative") {
    // The Google client takes generation options under `config`, so the setting
    // goes there rather than at the top level, and an existing config is kept.
    const configured = (spec.params as { safetySettings?: unknown } | undefined)?.safetySettings;
    const config = { ...((next.config as Record<string, unknown> | undefined) ?? {}) };
    if (Number.isFinite(spec.temperature)) config.temperature = spec.temperature;
    if (Number.isFinite(spec.topP)) config.topP = spec.topP;
    if (config.safetySettings === undefined) {
      config.safetySettings = Array.isArray(configured) ? configured : SAFETY_OFF;
    }
    next.config = config;
  } else {
    if (Number.isFinite(spec.temperature)) next.temperature = spec.temperature;
    if (Number.isFinite(spec.topP)) next.top_p = spec.topP;
  }

  return next;
}
