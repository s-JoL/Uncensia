import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { isMemoryKey, type MemoryCapability } from "@shared/types.ts";
import { countTokens } from "../prompts/context.ts";
import type { Store } from "../store/store.ts";
import {
  DELETE_MEMORY_DESCRIPTION,
  INTENT_DESCRIPTION,
  SET_MEMORY_DESCRIPTION,
  SET_MEMORY_VALUE_DESCRIPTION,
} from "./descriptions.ts";

const MALFORMED_KEY =
  "Keys are 1-64 characters of letters, digits, underscore or hyphen. Rewrite the key and try again.";

export function memoryTools(store: Store, config: MemoryCapability, conversationId?: string, currentConfig: () => MemoryCapability = () => config): AgentTool[] {
  if (!config.enabled || !config.writeEnabled) return [];
  const keyDescription = "A short snake_case name for this fact. Reuse a matching key from the current memory context; create a new key when no subject matches.";
  const deleteKeyDescription = "The exact key from the current memory context to delete.";
  const writable = () => {
    const current = currentConfig();
    if (!current.enabled || !current.writeEnabled) throw new Error("Memory writing is disabled");
    return current;
  };

  const setMemory: AgentTool = {
    name: "set_memory",
    label: "set_memory",
    description: SET_MEMORY_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        key: { type: "string", description: keyDescription },
        value: { type: "string", description: SET_MEMORY_VALUE_DESCRIPTION },
      },
      required: ["intent", "key", "value"],
    }),
    executionMode: "sequential",
    execute: async (_callId, params) => {
      const current = writable();
      const { key, value } = params as { key: string; value: string };
      if (!isMemoryKey(key)) {
        return { content: [{ type: "text", text: `Invalid key "${key}". ${MALFORMED_KEY}` }], details: {} };
      }
      if (value.length > current.charLimit) {
        return {
          content: [{ type: "text", text: `Value exceeds maximum length of ${current.charLimit} characters.` }],
          details: {},
        };
      }
      const tokenCount = countTokens(value);
      if (!store.saveMemoryWithinBudget(key, value, tokenCount, current.tokenLimit, conversationId)) {
        return {
          content: [{ type: "text", text: "Memory storage would exceed limit. Cannot save this memory." }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `Memory set for key "${key}" (${tokenCount} tokens). Current value: ${value}` }],
        details: { structuredContent: { memory: { key, value, tokenCount, type: "update" } } },
      };
    },
  };

  const deleteMemory: AgentTool = {
    name: "delete_memory",
    label: "delete_memory",
    description: DELETE_MEMORY_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        key: { type: "string", description: deleteKeyDescription },
      },
      required: ["intent", "key"],
    }),
    executionMode: "sequential",
    execute: async (_callId, params) => {
      writable();
      const { key } = params as { key: string };
      if (!isMemoryKey(key)) {
        return { content: [{ type: "text", text: `Invalid key "${key}". ${MALFORMED_KEY}` }], details: {} };
      }
      if (!store.deleteMemory(key)) {
        return { content: [{ type: "text", text: `Failed to delete memory for key "${key}"` }], details: {} };
      }
      return {
        content: [{ type: "text", text: `Memory deleted for key "${key}"` }],
        details: { structuredContent: { memory: { key, type: "delete" } } },
      };
    },
  };

  return [setMemory, deleteMemory];
}
