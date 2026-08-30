"use client";

import { Avatar as AvatarPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Avatar.
 *
 * The fallback renders after a short delay rather than immediately, so a fast
 * image load does not flash initials first.
 */
export function Avatar({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative flex size-8 shrink-0 overflow-hidden rounded-full border border-border/60",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image className={cn("aspect-square size-full", className)} {...props} />
  );
}

export function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      delayMs={300}
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-[0.65rem] font-medium uppercase text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Initials from a GitHub login or display name. */
export function initialsOf(value: string | null | undefined): string {
  if (!value) return "?";
  const parts = value.replace(/[^a-zA-Z0-9\s-]/g, "").split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return value.slice(0, 2).toUpperCase();
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${(parts[0] ?? "")[0] ?? ""}${(parts[1] ?? "")[0] ?? ""}`.toUpperCase();
}
