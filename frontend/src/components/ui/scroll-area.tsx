"use client";

import { ScrollArea as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

export function ScrollArea({
  className,
  children,
  viewportClassName,
  ...props
}: React.ComponentProps<typeof Primitive.Root> & { viewportClassName?: string }) {
  return (
    <Primitive.Root className={cn("relative overflow-hidden", className)} {...props}>
      <Primitive.Viewport
        className={cn("size-full rounded-[inherit] outline-none", viewportClassName)}
      >
        {children}
      </Primitive.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
      <Primitive.Corner />
    </Primitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Primitive.Scrollbar>) {
  return (
    <Primitive.Scrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none select-none transition-colors",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent p-[1px]",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent p-[1px]",
        className,
      )}
      {...props}
    >
      <Primitive.Thumb className="relative flex-1 rounded-full bg-border hover:bg-muted-foreground/60" />
    </Primitive.Scrollbar>
  );
}
