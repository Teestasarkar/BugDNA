"use client";

/**
 * Application shell.
 *
 * Sidebar navigation, a top bar with search and notifications, and the page
 * content. The layout is a CSS grid rather than fixed positioning, so the
 * sidebar collapse is a single column-width change and content reflows without
 * transform hacks.
 *
 * Auth handling lives here rather than in middleware on purpose: the session is
 * an httpOnly cookie on the *API's* origin, which Next.js middleware cannot read.
 * So the shell asks the API who the user is, and redirects if the answer is
 * nobody. One request, and it is the same request every page needs anyway.
 */
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bell,
  ChevronLeft,
  FolderGit2,
  GitPullRequest,
  LayoutDashboard,
  Menu,
  Search,
  Settings,
  ShieldAlert,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { InfoTooltip } from "@/components/ui/tooltip";
import { LoadingState } from "@/components/states";
import { Logo, LogoMark } from "@/components/layout/logo";
import { CommandPalette } from "@/components/layout/command-palette";
import { NotificationBell } from "@/components/layout/notification-bell";
import { UserMenu } from "@/components/layout/user-menu";
import { ConnectionIndicator } from "@/components/layout/connection-indicator";
import { useCurrentUser } from "@/hooks/use-api";
import { useUiStore } from "@/stores/ui.store";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Also treat these prefixes as "current" for highlighting. */
  match?: string[];
}

const NAV: Array<{ heading?: string; items: NavItem[] }> = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      {
        href: "/pulls",
        label: "Pull requests",
        icon: GitPullRequest,
        match: ["/pulls"],
      },
      { href: "/analyses", label: "Analyses", icon: ShieldAlert, match: ["/analyses"] },
    ],
  },
  {
    heading: "Insight",
    items: [
      {
        href: "/repositories",
        label: "Repositories",
        icon: FolderGit2,
        match: ["/repositories"],
      },
      { href: "/timeline", label: "Deployments", icon: Activity, match: ["/timeline"] },
      { href: "/teams", label: "Teams", icon: Users, match: ["/teams"] },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const { data: user, isLoading, isError } = useCurrentUser();

  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const mobileNavOpen = useUiStore((state) => state.mobileNavOpen);
  const setMobileNavOpen = useUiStore((state) => state.setMobileNavOpen);
  const toggleCommandPalette = useUiStore((state) => state.toggleCommandPalette);

  // ---- redirect when signed out ------------------------------------------
  React.useEffect(() => {
    if (isError) {
      const next = encodeURIComponent(pathname ?? "/dashboard");
      router.replace(`/login?next=${next}`);
    }
  }, [isError, pathname, router]);

  // ---- global shortcuts ---------------------------------------------------
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Cmd/Ctrl+K opens search from anywhere.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
        return;
      }

      // Bare "/" too, but not while typing in a field.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "/" && !typing) {
        event.preventDefault();
        toggleCommandPalette();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleCommandPalette]);

  // Close the mobile drawer on navigation.
  React.useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname, setMobileNavOpen]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Loading BugDNA" />
      </div>
    );
  }

  // The redirect effect is already running; render nothing rather than flashing
  // a broken shell.
  if (isError || !user) return null;

  return (
    <div
      className={cn(
        "grid min-h-dvh w-full",
        // Sidebar column collapses to an icon rail; content takes the rest.
        collapsed ? "lg:grid-cols-[4rem_1fr]" : "lg:grid-cols-[15rem_1fr]",
      )}
    >
      {/* --- mobile scrim ------------------------------------------------- */}
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation"
        />
      )}

      {/* --- sidebar ------------------------------------------------------ */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-sidebar-border",
          "bg-sidebar transition-transform duration-200 lg:static lg:z-auto lg:w-auto lg:translate-x-0",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* brand */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-b border-sidebar-border",
            collapsed ? "justify-center px-2" : "justify-between px-4",
          )}
        >
          {collapsed ? <LogoMark /> : <Logo />}

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setMobileNavOpen(false)}
            className="lg:hidden"
            aria-label="Close navigation"
          >
            <X />
          </Button>
        </div>

        {/* nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Main">
          {NAV.map((group, groupIndex) => (
            <div key={groupIndex} className={groupIndex > 0 ? "mt-5" : undefined}>
              {group.heading && !collapsed && (
                <p className="mb-1.5 px-2 text-[0.6875rem] font-medium uppercase tracking-wide text-sidebar-foreground/50">
                  {group.heading}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    collapsed={collapsed}
                    pathname={pathname ?? ""}
                  />
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* footer */}
        <div className="shrink-0 border-t border-sidebar-border p-2">
          <ul className="space-y-0.5">
            <NavLink
              item={{ href: "/notifications", label: "Notifications", icon: Bell }}
              collapsed={collapsed}
              pathname={pathname ?? ""}
            />
            <NavLink
              item={{ href: "/settings", label: "Settings", icon: Settings }}
              collapsed={collapsed}
              pathname={pathname ?? ""}
            />
          </ul>

          <Separator className="my-2 bg-sidebar-border" />

          <div
            className={cn(
              "flex items-center",
              collapsed ? "justify-center" : "justify-between gap-2",
            )}
          >
            {!collapsed && <ConnectionIndicator />}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
              className="hidden lg:inline-flex"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <ChevronLeft className={cn("transition-transform", collapsed && "rotate-180")} />
            </Button>
          </div>
        </div>
      </aside>

      {/* --- main --------------------------------------------------------- */}
      <div className="flex min-w-0 flex-col">
        {/* top bar */}
        <header
          className={cn(
            "sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border",
            "bg-background/85 px-3 backdrop-blur-md sm:px-5",
          )}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setMobileNavOpen(true)}
            className="lg:hidden"
            aria-label="Open navigation"
          >
            <Menu />
          </Button>

          {/* Search is a button, not an input: it opens the palette, and a fake
              input that does not accept typing is a worse affordance. */}
          <button
            type="button"
            onClick={toggleCommandPalette}
            className={cn(
              "flex h-9 flex-1 items-center gap-2 rounded-md border border-input bg-transparent",
              "px-3 text-sm text-muted-foreground transition-colors",
              "hover:border-ring/50 hover:bg-muted/40 sm:max-w-md",
            )}
          >
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 text-left">
              Search repositories, pull requests, findings…
            </span>
            <kbd className="hidden shrink-0 rounded border border-border bg-muted px-1.5 font-mono text-[0.6875rem] sm:inline-block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1">
            <div className="lg:hidden">
              <ConnectionIndicator compact />
            </div>
            <NotificationBell />
            <UserMenu user={user} />
          </div>
        </header>

        {/* page */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <CommandPalette />
    </div>
  );
}

function NavLink({
  item,
  collapsed,
  pathname,
}: {
  item: NavItem;
  collapsed: boolean;
  pathname: string;
}) {
  // Exact match for the dashboard, prefix match for sections — so
  // /analyses/abc123 still highlights "Analyses".
  const active =
    pathname === item.href ||
    (item.match?.some((prefix) => pathname.startsWith(prefix)) ?? false);

  const link = (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-2 text-sm font-medium transition-colors",
        collapsed && "justify-center px-0",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <item.icon className="size-4 shrink-0" aria-hidden />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );

  return (
    <li>
      {collapsed ? <InfoTooltip label={item.label}>{link}</InfoTooltip> : link}
    </li>
  );
}
