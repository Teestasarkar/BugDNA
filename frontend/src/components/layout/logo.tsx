import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Brand mark.
 *
 * The glyph is a double helix rendered as two offset sine paths with connecting
 * rungs — "DNA" for a tool that reads the genetics of a change. Drawn inline
 * rather than as an asset so it inherits `currentColor` and works in both themes
 * with no second file.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-6 text-primary", className)}
      aria-hidden
    >
      {/* two strands */}
      <path
        d="M8 2c0 5 8 5 8 10s-8 5-8 10"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M16 2c0 5-8 5-8 10s8 5 8 10"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.45"
      />
      {/* rungs */}
      <path d="M9.2 6.5h5.6M9 17.5h6M8.4 12h7.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

export function Logo({
  className,
  href = "/dashboard",
  showTagline = false,
}: {
  className?: string;
  href?: string;
  showTagline?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn("flex items-center gap-2 transition-opacity hover:opacity-80", className)}
    >
      <LogoMark />
      <span className="flex flex-col leading-none">
        <span className="text-base font-bold tracking-tight">BugDNA</span>
        {showTagline && (
          <span className="mt-0.5 text-[0.625rem] text-muted-foreground">
            Pre-merge risk intelligence
          </span>
        )}
      </span>
    </Link>
  );
}
