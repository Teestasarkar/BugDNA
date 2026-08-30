import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge.
 *
 * Note there are no `success`/`warning`/`danger` variants. Those colours belong
 * to risk levels and nothing else (see globals.css), so a coloured badge is
 * produced by passing a risk class from `lib/risk.ts` rather than by choosing a
 * semantic colour here. That constraint is what keeps colour meaningful.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium " +
    "whitespace-nowrap w-fit shrink-0 [&_svg]:size-3 [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

export function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Component = asChild ? Slot.Root : "span";
  return <Component className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
