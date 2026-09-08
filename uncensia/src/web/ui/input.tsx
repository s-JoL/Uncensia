import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "./cn.ts";

const field =
  "w-full rounded-md border border-input bg-card px-3 text-foreground placeholder:text-muted-foreground/70 " +
  "transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 " +
  "disabled:opacity-60 aria-invalid:border-destructive";

const FieldContext = createContext<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>({});
export const useFieldControl = () => useContext(FieldContext);

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...useFieldControl()} className={cn(field, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...useFieldControl()} className={cn(field, "resize-y py-2 leading-relaxed", className)} {...props} />;
}

/**
 * Label, control and message as one unit, so a form cannot drift into labels
 * that are not associated with anything.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const id = htmlFor ?? generatedId;
  const descriptionId = error || hint ? `${id}-description` : undefined;
  return (
    <FieldContext.Provider value={{ id, "aria-describedby": descriptionId, "aria-invalid": error ? true : undefined }}>
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label htmlFor={id} className="text-sm font-medium text-foreground/90">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={descriptionId} className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
    </FieldContext.Provider>
  );
}
