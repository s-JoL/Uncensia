import { uiText, LanguageSelect } from "./i18n.tsx";
import {
  FolderClosed,
  ListTodo,
  Images,
  LogOut,
  type LucideIcon,
  MessagesSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bootstrap, ConversationSearchHit, ConversationSummary } from "@shared/types.ts";
import { api, ApiError, token } from "./api.ts";
import { Chat } from "./screens/chat.tsx";
import {
  Button,
  cn,
  Empty,
  Field,
  Input,
  Menu,
  MenuItem,
  Modal,
  Sheet,
  Spinner,
  ThemeToggle,
  useToast,
} from "./ui.tsx";

// Chat is what a cold load almost always wants; the rest are a tab away and
// only worth downloading once someone goes there.
const Studio = lazy(() => import("./screens/studio.tsx").then((m) => ({ default: m.Studio })));
const Library = lazy(() => import("./screens/library.tsx").then((m) => ({ default: m.Library })));
const Settings = lazy(() => import("./screens/settings/index.tsx").then((m) => ({ default: m.Settings })));
const Tasks = lazy(() => import("./screens/tasks.tsx").then((m) => ({ default: m.Tasks })));
const Projects = lazy(() => import("./screens/projects.tsx").then((m) => ({ default: m.Projects })));

export type Screen = "chat" | "studio" | "settings" | "files" | "memory" | "tasks" | "projects";

interface Route {
  screen: Screen;
  conversationId: string;
  projectId?: string;
  /** Message the transcript should open on, when arriving from a search hit. */
  focusSeq?: number;
}

const SCREEN_PATHS: Record<Exclude<Screen, "chat">, string> = {
  studio: "/studio",
  files: "/library",
  memory: "/library/memory",
  settings: "/settings",
  tasks: "/tasks",
  projects: "/projects",
};

const NAV: Array<{ id: Screen; label: string; icon: LucideIcon }> = [
  { id: "chat", label: uiText("对话"), icon: MessagesSquare },
  { id: "studio", label: uiText("创作台"), icon: Images },
  { id: "files", label: uiText("资料库"), icon: FolderClosed },
  { id: "projects", label: uiText("项目"), icon: FolderClosed },
  { id: "tasks", label: uiText("任务"), icon: ListTodo },
  { id: "settings", label: uiText("设置"), icon: Settings2 },
];

/**
 * The address bar is the only state that survives an iOS tab eviction, so the
 * open conversation lives there rather than in memory alone.
 */
function readRoute(): Route {
  const pathname = window.location.pathname;
  if (pathname.startsWith("/projects/")) return {screen:"projects",conversationId:"",projectId:pathname.slice(10)};
  if (pathname === "/library/memory") return { screen: "memory", conversationId: "" };
  if (pathname.startsWith("/c/")) return { screen: "chat", conversationId: pathname.slice(3) };
  // Prefix match so a deeper link such as /settings/models still lands on the
  // right screen instead of silently falling through to a new chat.
  const entry = Object.entries(SCREEN_PATHS).find(
    ([, value]) => pathname === value || pathname.startsWith(`${value}/`),
  );
  return { screen: (entry?.[0] as Screen) ?? "chat", conversationId: "" };
}

function routePath(route: Route) {
  if (route.screen === "projects" && route.projectId) return `/projects/${route.projectId}`;
  if (route.screen !== "chat") return SCREEN_PATHS[route.screen];
  return route.conversationId ? `/c/${route.conversationId}` : "/";
}

export function App() {
  const toast = useToast();
  const [ready, setReady] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  /** The snapshot on screen, so a failed reload can tell a cold start from a refresh. */
  const shown = useRef<Bootstrap | null>(null);
  shown.current = bootstrap;

  const load = useCallback(async () => {
    try {
      setBootstrap(await api.bootstrap());
      setError("");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (caught instanceof ApiError && caught.status === 401) {
        token.clear();
        setBootstrap(null);
        setError("");
      } else if (shown.current) {
        // Settings reload on every save. A snapshot that failed to refresh is
        // stale, not gone, and tearing the workspace down over it would throw
        // away whatever the reader was in the middle of.
        toast(message, true);
      } else {
        setError(message);
      }
    } finally {
      setReady(true);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ready) return <Empty className="h-full">{uiText("正在加载…")}</Empty>;
  if (error) return <Unreachable message={error} onRetry={load} />;
  if (!bootstrap) return <Login onDone={load} />;
  return <Workspace bootstrap={bootstrap} reload={load} />;
}

/**
 * Nothing below this point works without the bootstrap snapshot, so a first
 * load that failed has only the server's reason and a way to ask again. It is
 * not the sign-in form: the token may be perfectly good and the server simply
 * down, and offering a code to type would send the reader after the wrong fault.
 */
function Unreachable({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Mark />
            Uncensia
          </div>
          <p className="text-sm text-muted-foreground">{uiText("连不上服务器，稍后再试一次。")}</p>
        </div>
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {message}
        </p>
        <Button
          variant="primary"
          size="lg"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onRetry();
            setBusy(false);
          }}
        >
          {busy ? uiText("重试中…") : uiText("重试")}
        </Button>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Asking up front avoids a rejected first attempt just to learn that a
  // second factor exists.
  useEffect(() => {
    void api
      .loginChallenge()
      .then((challenge) => setNeedsTotp(challenge.totpRequired))
      .catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const session = await api.login(code.trim(), totp.trim());
            token.set(session.token);
            await onDone();
          } catch (caught) {
            if (caught instanceof ApiError && caught.code === "totp_required") {
              setNeedsTotp(true);
              setError(uiText("请输入验证器里的动态码"));
            } else {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Mark />
            Uncensia
          </div>
          <LanguageSelect />
          <p className="text-sm text-muted-foreground">{uiText("输入访问码进入。第一次启动时，访问码会打在服务器日志里。")}</p>
        </div>
        <Field error={error}>
          <Input
            value={code}
            autoFocus
            type="password"
            placeholder={uiText("访问码")}
            data-testid="signin-code"
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        {needsTotp ? (
          <Input
            value={totp}
            placeholder={uiText("6 位动态验证码")}
            inputMode="numeric"
            autoComplete="one-time-code"
            onChange={(event) => setTotp(event.target.value)}
          />
        ) : null}
        <Button
          variant="primary"
          size="lg"
          type="submit"
          data-testid="signin-submit"
          disabled={busy || !code.trim() || (needsTotp && totp.trim().length < 6)}
        >
          {busy ? uiText("验证中…") : uiText("进入")}
        </Button>
      </form>
    </div>
  );
}

const Mark = () => (
  <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
    <Sparkles className="size-3.5" />
  </span>
);

/** Buckets by recency, the way a reader thinks about their own threads. */
function groupByDay(conversations: ConversationSummary[]) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const buckets: Array<[string, ConversationSummary[]]> = [
    [uiText("今天"), []],
    [uiText("昨天"), []],
    [uiText("最近 7 天"), []],
    [uiText("更早"), []],
  ];
  for (const conversation of conversations) {
    const at = conversation.updatedAt;
    const index = at >= startOfToday ? 0 : at >= startOfToday - day ? 1 : at >= startOfToday - 6 * day ? 2 : 3;
    buckets[index]![1].push(conversation);
  }
  return buckets.filter(([, items]) => items.length > 0);
}

/**
 * Hits are grouped by conversation, because a phrase someone is looking for
 * usually appears several times in the same thread and an ungrouped list buries
 * every other conversation that also matched.
 */
function SearchResults({
  hits,
  onOpen,
}: {
  hits: ConversationSearchHit[];
  onOpen: (hit: ConversationSearchHit) => void;
}) {
  if (!hits.length) return <p className="px-3 py-6 text-center text-sm text-muted-foreground">{uiText("没有匹配的消息")}</p>;
  const grouped = new Map<string, ConversationSearchHit[]>();
  for (const hit of hits) {
    const existing = grouped.get(hit.conversationId);
    if (existing) existing.push(hit);
    else grouped.set(hit.conversationId, [hit]);
  }
  return (
    <div className="flex flex-col gap-3 px-2 py-1">
      {[...grouped.values()].map((group) => (
        <div key={group[0]!.conversationId} className="flex flex-col gap-1">
          <div className="truncate px-1 text-xs font-medium text-muted-foreground">
            {group[0]!.title || uiText("未命名对话")}
          </div>
          {group.map((hit) => (
            <button
              key={hit.seq}
              className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
              onClick={() => onOpen(hit)}
            >
              <span className="text-xs text-muted-foreground">{hit.role === "user" ? uiText("你") : uiText("助手")}</span>
              <span className="line-clamp-2 text-sm">{hit.snippet}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Workspace({ bootstrap, reload }: { bootstrap: Bootstrap; reload: () => Promise<void> }) {
  const toast = useToast();
  const [route, setRoute] = useState<Route>(readRoute);
  /** `null` until the first list arrives, so the rail never claims an empty history. */
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ConversationSearchHit[]>([]);
  const [searchError, setSearchError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const { screen, conversationId: activeId } = route;
  const searching = query.trim().length > 0;

  const navigate = useCallback((next: Route, replace = false) => {
    setRoute(next);
    setRailOpen(false);
    const path = routePath(next);
    if (path === window.location.pathname) return;
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
  }, []);

  /**
   * Search as you type, one request in flight: the previous one is aborted, so a
   * slow answer for "牛" can never land on top of the results for "牛肉丸".
   */
  useEffect(() => {
    const text = query.trim();
    setSearchError("");
    if (!text) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api
        .searchConversations(text, controller.signal)
        .then((result) => setHits(result.items))
        // The results on screen answer the previous keystroke, so a search that
        // failed has to say so: leaving them up reads as "this is what matched".
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setHits([]);
          setSearchError(error instanceof Error ? error.message : String(error));
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** Going to Settings and back should land on the conversation you left. */
  const lastChatId = useRef("");
  if (screen === "chat" && activeId) lastChatId.current = activeId;

  const refreshConversations = useCallback(async () => {
    const list = await api.conversations();
    setConversations(list.items);
    return list.items;
  }, []);

  useEffect(() => {
    void refreshConversations().catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), true);
    });
  }, [refreshConversations, toast]);

  const removeConversation = async (id: string) => {
    try {
      await api.deleteConversation(id);
      const items = await refreshConversations();
      if (activeId === id) navigate({ screen: "chat", conversationId: items[0]?.id ?? "" }, true);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const groups = useMemo(() => groupByDay(conversations ?? []), [conversations]);

  const rail = (
    <>
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 font-semibold">
          <Mark />
          Uncensia
        </div>
        <div className="flex items-center gap-0.5">
          <ThemeToggle />
          <LanguageSelect />
          <Menu
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={uiText("更多")}>
                <MoreHorizontal />
              </Button>
            }
          >
            <MenuItem
              danger
              onSelect={async () => {
                await api.logout().catch(() => undefined);
                token.clear();
                await reload();
              }}
            >
              <LogOut />
              {uiText("退出登录")}</MenuItem>
          </Menu>
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label={uiText("收起")}
            onClick={() => setRailOpen(false)}
          >
            <X />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 px-3 pb-2">
        <Button
          variant="ghost"
          className="h-11 justify-start rounded-xl"
          onClick={() => navigate({ screen: "chat", conversationId: "" })}
        >
          <Plus />
          {uiText("新对话")}</Button>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder={uiText("搜索所有对话")}
              className="h-8 pl-8 text-sm"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
      </div>

      <nav className="flex flex-col gap-1 px-3 pb-4">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            aria-current={screen === id || (id === "files" && screen === "memory") ? "page" : undefined}
            title={label}
            data-testid={`nav-${id}`}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
              screen === id || (id === "files" && screen === "memory")
                ? "bg-sidebar-accent text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
            onClick={() =>
              navigate(
                id === "chat"
                  ? { screen: "chat", conversationId: activeId || lastChatId.current }
                  : { screen: id, conversationId: "" },
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {searchError ? (
          <p className="px-3 py-6 text-center text-sm text-destructive">{searchError}</p>
        ) : searching ? (
          <SearchResults
            hits={hits}
            onOpen={(hit) =>
              navigate({ screen: "chat", conversationId: hit.conversationId, focusSeq: hit.seq })
            }
          />
        ) : conversations === null ? (
          <p className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
            <Spinner />
            {uiText("正在加载…")}</p>
        ) : conversations.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">{uiText("还没有对话")}</p>
        ) : (
          groups.map(([label, items]) => (
            <div key={label} className="px-2 pt-2">
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground/80">{label}</div>
              {items.map((conversation) => {
                const active = conversation.id === activeId && screen === "chat";
                return (
                  <div
                    key={conversation.id}
                    className={cn(
                      "group flex items-center gap-1 rounded-md pr-1 transition-colors",
                      active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
                    )}
                  >
                    <button
                      className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
                      onClick={() => navigate({ screen: "chat", conversationId: conversation.id })}
                    >
                      {conversation.title || uiText("未命名对话")}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={uiText("删除对话")}
                      className={cn(
                        "text-muted-foreground opacity-0 transition-opacity hover:text-destructive",
                        "group-hover:opacity-100 focus-visible:opacity-100",
                        active && "opacity-100",
                      )}
                      onClick={() => setPendingDelete(conversation)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>


    </>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 flex-col bg-sidebar md:flex">
        {rail}
      </aside>

      <Sheet open={railOpen} onOpenChange={setRailOpen} title={uiText("导航")}>
        {rail}
      </Sheet>

      <Modal
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={uiText("删除对话")}
        description={
          pendingDelete
            ? uiText("「{0}」的转写会一并删掉，无法恢复。", [pendingDelete.title || uiText("未命名对话")])
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {uiText("取消")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = pendingDelete?.id;
                setPendingDelete(null);
                if (id) void removeConversation(id);
              }}
            >
              {uiText("删除")}</Button>
          </>
        }
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {screen === "chat" ? (
          <Chat
            bootstrap={bootstrap}
            conversationId={activeId}
            focusSeq={route.focusSeq}
            onConversationCreated={async (id) => {
              navigate({ screen: "chat", conversationId: id }, true);
              await refreshConversations();
            }}
            onConversationChanged={refreshConversations}
            onOpenRail={() => setRailOpen(true)}
          />
        ) : (
          <Suspense fallback={<Empty>{uiText("正在加载…")}</Empty>}>
            {screen === "studio" ? <Studio onOpenRail={() => setRailOpen(true)} /> : null}
            {screen === "tasks" ? <Tasks onOpenRail={() => setRailOpen(true)} /> : null}
            {screen === "projects" ? <Projects key={route.projectId ?? "list"} projectId={route.projectId} modelId={bootstrap.defaultModelId} onOpenRail={() => setRailOpen(true)} onSelect={projectId=>navigate({screen:"projects",conversationId:"",projectId})} onConversation={id=>{navigate({screen:"chat",conversationId:id}); void refreshConversations();}} /> : null}
            {screen === "settings" ? (
              <Settings bootstrap={bootstrap} reload={reload} onOpenRail={() => setRailOpen(true)} />
            ) : null}
            {screen === "files" || screen === "memory" ? <Library key={screen} initialTab={screen === "memory" ? "memory" : "files"} onOpenRail={() => setRailOpen(true)} /> : null}
          </Suspense>
        )}
      </main>
    </div>
  );
}
