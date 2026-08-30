"use client";

/**
 * Toast surface.
 *
 * Renders whatever is in the toast store, bottom-right. Points worth noting:
 *
 *  - `aria-live="polite"` on the region, so a screen reader announces a new
 *    toast without interrupting whatever the user is doing.
 *  - Analysis toasts carry a risk badge and score, because "Analysis complete"
 *    on its own is not the information the user wanted — the number is.
 *  - The container is `pointer-events-none` and each toast re-enables them, so
 *    the empty space around a toast never blocks a click underneath.
 */
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { useToastStore, type Toast as ToastData } from "@/stores/toast.store";
import { RISK_PRESENTATION } from "@/lib/risk";
import { cn } from "@/lib/utils";

const ICONS = {
  neutral: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  loading: Loader2,
} as const;

const ACCENTS = {
  neutral: "text-muted-foreground",
  success: "text-risk-low",
  warning: "text-risk-moderate",
  danger: "text-risk-critical",
  loading: "text-primary",
} as const;

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col-reverse items-end",
        "gap-2 p-4 sm:right-0 sm:left-auto sm:max-w-sm",
      )}
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} toast={item} onDismiss={() => dismiss(item.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  const Icon = ICONS[toast.variant];
  const risk = toast.riskLevel ? RISK_PRESENTATION[toast.riskLevel] : null;

  return (
    <div
      className={cn(
        "pointer-events-auto w-full overflow-hidden rounded-lg border border-border",
        "bg-popover shadow-lg",
        "animate-in slide-in-from-bottom-2 fade-in-0 duration-200",
      )}
    >
      <div className="flex gap-3 p-3.5">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            ACCENTS[toast.variant],
            toast.variant === "loading" && "animate-spin",
          )}
          aria-hidden
        />

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-2">
            <p className="flex-1 text-sm font-medium leading-snug">{toast.title}</p>

            {risk && toast.riskScore !== undefined && (
              <span
                className={cn(
                  "shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular",
                  risk.className,
                )}
              >
                {Math.round(toast.riskScore)}
              </span>
            )}
          </div>

          {toast.description && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {toast.description}
            </p>
          )}

          {toast.action && (
            <div className="pt-0.5">
              {toast.action.href ? (
                <Link
                  href={toast.action.href}
                  onClick={onDismiss}
                  className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  {toast.action.label}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick?.();
                    onDismiss();
                  }}
                  className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  {toast.action.label}
                </button>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            "-mr-1 -mt-1 shrink-0 self-start rounded-md p-1 text-muted-foreground/70",
            "transition-colors hover:bg-muted hover:text-foreground",
          )}
          aria-label="Dismiss notification"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
