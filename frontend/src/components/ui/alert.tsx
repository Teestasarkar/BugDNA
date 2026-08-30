import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline alert.
 *
 * `info` and `neutral` use brand/neutral colours; `warning` and `danger` borrow
 * the risk palette, which is legitimate because they carry the same meaning —
 * "this needs your attention" — rather than a different one.
 */
const alertVariants = cva(
  "relative flex w-full gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:mt-0.5",
  {
    variants: {
      variant: {
        neutral: "border-border bg-muted/50 text-foreground [&>svg]:text-muted-foreground",
        info: "border-primary/25 bg-primary/5 text-foreground [&>svg]:text-primary",
        warning: "risk-moderate",
        danger: "risk-critical",
        success: "risk-low",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

const ICONS = {
  neutral: Info,
  info: Info,
  warning: AlertTriangle,
  danger: XCircle,
  success: CheckCircle2,
} as const;

export interface AlertProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof alertVariants> {
  /** Set false to omit the leading icon. */
  icon?: boolean;
}

export function Alert({
  className,
  variant = "neutral",
  icon = true,
  children,
  ...props
}: AlertProps) {
  const Icon = ICONS[variant ?? "neutral"];

  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon && <Icon aria-hidden />}
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("font-medium leading-snug", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-sm leading-relaxed opacity-90 [&_p]:leading-relaxed", className)}
      {...props}
    />
  );
}
