/**
 * Moves the workspace to an application path from anywhere, including deep
 * settings sections. The workspace router already follows history changes, so
 * this records the entry and lets that one listener decide what to show.
 */
export function openPath(path: string) {
  if (window.location.pathname !== path) window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
