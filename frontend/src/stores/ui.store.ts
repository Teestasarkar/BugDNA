/**
 * UI state.
 *
 * Zustand's role in this app is deliberately narrow: it holds **client state
 * that no server owns** — is the sidebar collapsed, is the command palette open,
 * which theme did the user pick. Anything that comes from the API is TanStack
 * Query's job, and keeping that line clean is what stops the two from fighting
 * over who has the truth.
 *
 * The persisted slice is intentionally small (theme, sidebar, density). Persisting
 * more would mean a stale value surviving a deploy and being hard to explain.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Theme = "light" | "dark" | "system";
export type Density = "comfortable" | "compact";

interface UiState {
  // --- persisted ---
  theme: Theme;
  sidebarCollapsed: boolean;
  density: Density;
  /** Diff view preference, remembered across pull requests. */
  diffView: "unified" | "split";
  /** Whether to hide generated/lockfile diffs by default. */
  hideGeneratedFiles: boolean;

  // --- ephemeral ---
  commandPaletteOpen: boolean;
  mobileNavOpen: boolean;

  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setDensity: (density: Density) => void;
  setDiffView: (view: "unified" | "split") => void;
  setHideGeneratedFiles: (hide: boolean) => void;

  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setMobileNavOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "system",
      sidebarCollapsed: false,
      density: "comfortable",
      diffView: "unified",
      hideGeneratedFiles: true,

      commandPaletteOpen: false,
      mobileNavOpen: false,

      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setDensity: (density) => set({ density }),
      setDiffView: (diffView) => set({ diffView }),
      setHideGeneratedFiles: (hideGeneratedFiles) => set({ hideGeneratedFiles }),

      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      toggleCommandPalette: () =>
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
    }),
    {
      name: "bugdna.ui",
      // `createJSONStorage` returns undefined during SSR, which is what keeps
      // Next.js from trying to touch localStorage on the server.
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // Only the durable preferences are written; open/closed states are not.
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        density: state.density,
        diffView: state.diffView,
        hideGeneratedFiles: state.hideGeneratedFiles,
      }),
    },
  ),
);

/** Resolve `system` against the OS preference. Safe to call during SSR. */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
