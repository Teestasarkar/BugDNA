/**
 * Toasts.
 *
 * Hand-rolled on Zustand rather than pulling in a toast library, for two
 * reasons: the requirement is about forty lines of state, and toasts here need
 * to carry a risk level and an action (a link to the analysis that just
 * finished), which a generic library would make awkward.
 *
 * Behaviour worth noting: an `id` can be reused to *update* a toast in place.
 * That is what lets "Analysis queued" become "Analysis complete — 82/100"
 * without stacking two notifications for one event.
 */
import { create } from "zustand";
import type { RiskLevel } from "@/types/api";

export type ToastVariant = "neutral" | "success" | "warning" | "danger" | "loading";

export interface ToastAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  /** Renders a risk badge in the toast, for analysis results. */
  riskLevel?: RiskLevel;
  riskScore?: number;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss. 0 or undefined means it stays. */
  duration?: number;
  createdAt: number;
}

export interface ToastInput extends Omit<Toast, "id" | "createdAt" | "variant"> {
  id?: string;
  variant?: ToastVariant;
}

interface ToastState {
  toasts: Toast[];
  /** Adds or replaces a toast; returns its id. */
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

/** At most this many at once — beyond that they stop being readable. */
const MAX_VISIBLE = 4;

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  neutral: 5_000,
  success: 5_000,
  warning: 8_000,
  // Failures stay until dismissed: they usually need an action.
  danger: 0,
  // A loading toast is replaced by its outcome, not timed out.
  loading: 0,
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (input) => {
    const id = input.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const variant = input.variant ?? "neutral";
    const duration = input.duration ?? DEFAULT_DURATION[variant];

    const toast: Toast = { ...input, id, variant, duration, createdAt: Date.now() };

    set((state) => {
      const existing = state.toasts.findIndex((t) => t.id === id);

      // Reusing an id updates in place, preserving position in the stack.
      if (existing >= 0) {
        const next = [...state.toasts];
        next[existing] = toast;
        return { toasts: next };
      }

      return { toasts: [...state.toasts, toast].slice(-MAX_VISIBLE) };
    });

    clearTimer(id);
    if (duration > 0) {
      timers.set(
        id,
        setTimeout(() => get().dismiss(id), duration),
      );
    }

    return id;
  },

  dismiss: (id) => {
    clearTimer(id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  clear: () => {
    for (const id of timers.keys()) clearTimer(id);
    set({ toasts: [] });
  },
}));

/**
 * Imperative helpers.
 *
 * Callable from anywhere, including non-React code such as the socket event
 * handlers, which is why they read the store directly rather than via a hook.
 */
export const toast = {
  show: (input: ToastInput) => useToastStore.getState().push(input),

  success: (title: string, options: Partial<ToastInput> = {}) =>
    useToastStore.getState().push({ ...options, title, variant: "success" }),

  error: (title: string, options: Partial<ToastInput> = {}) =>
    useToastStore.getState().push({ ...options, title, variant: "danger" }),

  warning: (title: string, options: Partial<ToastInput> = {}) =>
    useToastStore.getState().push({ ...options, title, variant: "warning" }),

  loading: (title: string, options: Partial<ToastInput> = {}) =>
    useToastStore.getState().push({ ...options, title, variant: "loading" }),

  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
