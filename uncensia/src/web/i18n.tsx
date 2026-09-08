import translations from "./locales/en.json";

export type Language = "zh-CN" | "en";
const KEY = "uncensia.language";
const english: Record<string, string> = translations;

export function language(): Language {
  if (typeof window === "undefined") return "zh-CN";
  const saved = localStorage.getItem(KEY);
  if (saved === "zh-CN" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** Only application-owned UI strings are translated, never conversation data. */
export function uiText(source: string, values: unknown[] = []): string {
  const template = language() === "en" ? english[source] ?? source : source;
  return template.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
}

export function LanguageSelect() {
  return <select aria-label="Language / 语言" className="rounded-md border bg-background px-2 py-1 text-xs"
    value={language()} onChange={event => {
      localStorage.setItem(KEY, event.target.value);
      // Module-level option labels are localized at startup. Conversation and
      // composer state is persisted by the ordinary reload/reconnect path.
      window.location.reload();
    }}>
    <option value="en">English</option><option value="zh-CN">中文</option>
  </select>;
}
