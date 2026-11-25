import { NavLink, Outlet, Link } from "react-router-dom";
import { useTheme } from "../lib/theme";
import { Logo } from "./ui";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/prs", label: "Explorer" },
  { to: "/drivers", label: "Risk drivers" },
  { to: "/analyze", label: "Analyze a PR" },
  { to: "/methodology", label: "Methodology" },
];

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
  const label = theme === "system" ? "Theme: system" : theme === "dark" ? "Theme: dark" : "Theme: light";
  return (
    <button className="icon-btn" onClick={() => setTheme(next)} title={`${label} (click to change)`} aria-label={label}>
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" fill="currentColor" /></svg>
      ) : theme === "light" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor" /><g stroke="currentColor" strokeWidth="2" strokeLinecap="round">{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <line key={a} x1="12" y1="2.5" x2="12" y2="4.5" transform={`rotate(${a} 12 12)`} />)}</g></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></svg>
      )}
    </button>
  );
}

export default function Layout() {
  return (
    <>
      <header className="topbar">
        <div className="shell">
          <Link to="/" className="brand"><Logo /> PR Risk Radar</Link>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>
            ))}
          </nav>
          <span className="spacer" />
          <ThemeToggle />
        </div>
      </header>
      <main>
        <div className="shell">
          <Outlet />
        </div>
      </main>
      <footer className="footer">
        <div className="shell">
          <span>PR Risk Radar · XGBoost + TreeSHAP over real GitHub history, labelled with SZZ</span>
          <a href="https://github.com/Teestasarkar/BugDNA/tree/pr-risk-radar">Source on GitHub</a>
        </div>
      </footer>
    </>
  );
}
