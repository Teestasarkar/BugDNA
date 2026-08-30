"use client";

/**
 * User menu.
 *
 * Identity, theme, GitHub connection state and sign-out. The GitHub row is not
 * decorative: it shows the remaining rate limit and whether the `repo` scope was
 * granted, which are the two things that silently break the product when wrong.
 */
import Link from "next/link";
import { Check, LogOut, Monitor, Moon, Settings, Sun, TriangleAlert } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage, initialsOf } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GithubIcon } from "@/components/icons";
import { useSignOut } from "@/hooks/use-api";
import { useUiStore, type Theme } from "@/stores/ui.store";
import { number, rateLimitWarning } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CurrentUser } from "@/types/api";

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function UserMenu({ user }: { user: CurrentUser }) {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const signOut = useSignOut();

  const rateWarning = rateLimitWarning(
    user.github.rateLimitRemaining,
    user.github.rateLimitResetAt,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Account menu">
          <Avatar className="size-7">
            {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
            <AvatarFallback>{initialsOf(user.name ?? user.githubLogin)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-64">
        {/* --- identity ------------------------------------------------- */}
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{user.name ?? user.githubLogin}</p>
          <p className="truncate text-xs text-muted-foreground">
            {user.email ?? `@${user.githubLogin}`}
          </p>
          {user.isDemo && (
            <span className="mt-1.5 inline-block rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary">
              demo account
            </span>
          )}
        </div>

        <DropdownMenuSeparator />

        {/* --- github --------------------------------------------------- */}
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2">
            <GithubIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 text-xs font-medium">
              {user.github.connected ? "GitHub connected" : "GitHub not connected"}
            </span>
            {user.github.connected && (
              <Check className="size-3 shrink-0 text-risk-low" aria-hidden />
            )}
          </div>

          {user.github.connected && (
            <div className="mt-1 space-y-0.5 pl-5.5 text-[0.6875rem] text-muted-foreground">
              {user.github.mode === "mock" && (
                <p className="text-risk-moderate">running on fixtures (mock mode)</p>
              )}
              {!user.github.canReadPrivateRepos && (
                <p className="flex items-center gap-1 text-risk-moderate">
                  <TriangleAlert className="size-2.5" />
                  no `repo` scope — private repositories are unreachable
                </p>
              )}
              {user.github.rateLimitRemaining !== null && (
                <p className={cn(rateWarning && "text-risk-moderate")}>
                  {number(user.github.rateLimitRemaining)} API requests remaining
                </p>
              )}
            </div>
          )}
        </div>

        <DropdownMenuSeparator />

        {/* --- theme ---------------------------------------------------- */}
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        {THEMES.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => setTheme(option.value)}
            className="justify-between"
          >
            <span className="flex items-center gap-2">
              <option.icon />
              {option.label}
            </span>
            {theme === option.value && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem variant="destructive" onClick={() => signOut.mutate(false)}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
