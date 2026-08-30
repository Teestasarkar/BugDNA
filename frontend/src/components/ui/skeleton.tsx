import { cn } from "@/lib/utils";

/**
 * Skeleton.
 *
 * Used to reserve the space a real element will occupy, so content does not jump
 * when it arrives. The shimmer is disabled under `prefers-reduced-motion` by the
 * `.shimmer` utility itself.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("shimmer rounded-md", className)}
      // Decorative: screen readers should hear the loading region's label, not
      // a series of empty boxes.
      aria-hidden
      {...props}
    />
  );
}

/** Several lines of text, the last one short — as real paragraphs look. */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3.5", index === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}
