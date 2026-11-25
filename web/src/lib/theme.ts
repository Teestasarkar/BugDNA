import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "rr-theme";

function readStored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: theme still applies for this visit */
  }
  window.dispatchEvent(new Event("rr-theme"));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readStored);
  return [theme, (t) => { setTheme(t); applyTheme(t); }];
}

export function initTheme() {
  const t = readStored();
  if (t !== "system") document.documentElement.setAttribute("data-theme", t);
}

const TOKENS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--risk-up", "--risk-down", "--grid", "--axis", "--muted", "--ink", "--ink-2",
  "--surface", "--critical", "--wash-1"] as const;
export type ChartColors = Record<(typeof TOKENS)[number], string>;

function read(): ChartColors {
  const s = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((t) => [t, s.getPropertyValue(t).trim()])) as ChartColors;
}

/** SVG presentation attributes can't take var(); resolve tokens and re-read when the theme flips. */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(read);
  useEffect(() => {
    const update = () => setColors(read());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    window.addEventListener("rr-theme", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("rr-theme", update);
    };
  }, []);
  return colors;
}
