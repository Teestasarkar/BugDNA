"use client";

/**
 * Client providers.
 *
 * One place that establishes the query client, the theme, the realtime bridge and
 * the toast surface.
 *
 * The QueryClient is created inside `useState` rather than at module scope. At
 * module scope a single instance would be shared across every request during
 * SSR, which leaks one user's cached data into another's render — the classic
 * Next.js mistake with TanStack Query.
 */
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { useRealtime } from "@/hooks/use-realtime";
import { useCurrentUser } from "@/hooks/use-api";
import { resolveTheme, useUiStore } from "@/stores/ui.store";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Realtime events drive freshness for the data that changes; polling on
        // window focus on top of that is redundant traffic.
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          if (failureCount >= 2) return false;
          if (error instanceof ApiError) {
            if (error.isAuthError) return false;
            return error.retryable;
          }
          return true;
        },
      },
      mutations: {
        // Mutations are user-initiated; a silent retry could double-submit.
        retry: false,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <TooltipProvider>
        <RealtimeBridge>{children}</RealtimeBridge>
      </TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  );
}

/**
 * Applies the theme to `<html>`.
 *
 * The class is also written by an inline script in the root layout, before
 * hydration, so there is no flash of the wrong theme. This keeps it in sync
 * afterwards and follows the OS when the user has chosen "system".
 */
function ThemeSync() {
  const theme = useUiStore((state) => state.theme);

  React.useEffect(() => {
    const apply = () => {
      const resolved = resolveTheme(theme);
      document.documentElement.classList.toggle("dark", resolved === "dark");
      document.documentElement.style.colorScheme = resolved;
    };

    apply();

    if (theme !== "system") return;

    // Follow the OS while set to "system".
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return null;
}

/**
 * Opens the socket only for signed-in users.
 *
 * A visitor on the landing page has no session, and the handshake would be
 * rejected — so the connection is gated on knowing who they are.
 */
function RealtimeBridge({ children }: { children: React.ReactNode }) {
  const { data: user } = useCurrentUser();
  useRealtime(Boolean(user));

  return <>{children}</>;
}
