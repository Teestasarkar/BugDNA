import { AppShell } from "@/components/layout/app-shell";

/**
 * Authenticated layout.
 *
 * A route group, so every page inside it gets the shell (and the auth gate the
 * shell performs) without each one importing it.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
