import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "BugDNA — pre-merge risk intelligence for GitHub",
    template: "%s · BugDNA",
  },
  description:
    "BugDNA reads your pull requests before they merge, estimates the chance they cause a production problem, explains why, and tells you what to do about it.",
  applicationName: "BugDNA",
  keywords: [
    "pull request risk",
    "deployment risk",
    "code review",
    "engineering intelligence",
    "SHAP",
    "XGBoost",
  ],
  authors: [{ name: "Teesta Sarkar" }],
  openGraph: {
    title: "BugDNA — pre-merge risk intelligence",
    description:
      "Turn PR-level code-change signals into an interpretable, pre-merge risk assessment.",
    type: "website",
  },
  robots: {
    // A private engineering tool has no business being indexed.
    index: false,
    follow: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the light/dark surface colours so the mobile browser chrome blends in.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#111318" },
  ],
};

/**
 * Applies the stored theme before first paint.
 *
 * Without this there is a visible flash of the wrong theme on every load: the
 * class is set by React after hydration, which is far too late. Reading
 * localStorage in a blocking inline script is the standard fix, and the
 * try/catch matters because storage throws in some privacy modes.
 */
const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('bugdna.ui');
    var theme = stored ? (JSON.parse(stored).state || {}).theme : null;
    if (!theme || theme === 'system') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    if (theme === 'dark') document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = theme;
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
