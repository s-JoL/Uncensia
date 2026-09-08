import { uiText } from "../i18n.tsx";
import { Menu as MenuIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button.tsx";
import { cn } from "./cn.ts";

/**
 * The bar every screen wears. It owns the phone-only rail button, so no screen
 * has to remember that the sidebar is hidden below `md`.
 */
export function PageHeader({
  title,
  onOpenRail,
  children,
}: {
  title: ReactNode;
  onOpenRail: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 px-3 md:px-8">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label={uiText("菜单")} onClick={onOpenRail}>
        <MenuIcon />
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-lg font-medium tracking-tight">{title}</h1>
      {children}
    </header>
  );
}

/** Scrolling body with a reading-width column, shared by the settings-like pages. */
export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8", className)}>{children}</div>
    </div>
  );
}

/** A titled block of settings or rows. */
export function Section({
  title,
  hint,
  actions,
  className,
  id,
  children,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      {title ? (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{title}</h2>
            {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Padded content inside a `Section`; rows opt out of it to keep their own edges. */
export function SectionBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-col gap-4 p-4", className)}>{children}</div>;
}

/**
 * One item in a list: an icon or thumbnail, a two-line label, then actions.
 *
 * The actions drop to a second line rather than squeezing the label, because on
 * a phone a row that keeps its buttons in place shrinks the name it describes
 * down to one character.
 */
export function Row({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 last:border-b-0",
        "[&>*:first-child]:min-w-48",
        className,
      )}
    >
      {children}
    </div>
  );
}
