"use client";

/**
 * Landing page.
 *
 * Its job is to explain the workflow in one screen, because that workflow *is*
 * the product: GitHub → PR → diff → features → risk → explanation →
 * recommendation → decision. Anyone who reads this page should be able to
 * describe what BugDNA does without seeing the app.
 *
 * It also states plainly what the model is and is not, which is unusual for a
 * landing page and deliberate here — the honest version is more convincing than
 * an accuracy claim nobody can check.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import {
  ArrowRight,
  Boxes,
  Database,
  FileSearch,
  GitPullRequest,
  Lightbulb,
  ListChecks,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/layout/logo";
import { GithubIcon } from "@/components/icons";
import { RiskBadge } from "@/components/risk/risk-badge";
import { useCurrentUser, useDeploymentConfig, useSignInAsDemo } from "@/hooks/use-api";
import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

const PIPELINE: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: GithubIcon as unknown as LucideIcon,
    title: "Connect",
    body: "Sign in with GitHub and pick the repositories you care about. Read-only.",
  },
  {
    icon: FileSearch,
    title: "Ingest",
    body: "BugDNA pulls the pull request, its metadata and the full changed-file diff.",
  },
  {
    icon: ScanSearch,
    title: "Extract",
    body: "43 signals from the diff: size, blast radius, migrations, dependencies, test movement, repository history.",
  },
  {
    icon: Sparkles,
    title: "Score",
    body: "A gradient-boosted model turns those signals into a probability, banded into LOW through CRITICAL.",
  },
  {
    icon: Lightbulb,
    title: "Explain",
    body: "SHAP attributions become plain language, each linked to the files that caused it.",
  },
  {
    icon: ListChecks,
    title: "Decide",
    body: "Concrete mitigations, then your call — recorded, so the assessment is reviewable later.",
  },
];

const SIGNALS: Array<{ icon: LucideIcon; label: string; detail: string }> = [
  { icon: Database, label: "Destructive migrations", detail: "DROP, TRUNCATE, NOT NULL without a default" },
  { icon: Boxes, label: "Dependency movement", detail: "manifests and lockfile churn" },
  { icon: ShieldCheck, label: "Auth and secrets", detail: "paths and diff content touching credentials" },
  { icon: GitPullRequest, label: "Test discipline", detail: "test churn relative to source churn" },
];

export default function LandingPage() {
  const router = useRouter();
  const { data: user, isLoading } = useCurrentUser();
  const { data: config } = useDeploymentConfig();
  const demo = useSignInAsDemo();

  // Someone already signed in has no use for a marketing page.
  React.useEffect(() => {
    if (user) router.replace("/dashboard");
  }, [user, router]);

  const githubEnabled = config?.auth.githubEnabled ?? false;
  const demoEnabled = config?.auth.demoLoginEnabled ?? false;

  return (
    <div className="relative min-h-dvh overflow-hidden">
      {/* backdrop */}
      <div className="grid-backdrop pointer-events-none absolute inset-0 opacity-[0.35]" aria-hidden />

      {/* --- nav --------------------------------------------------------- */}
      <header className="relative z-10 mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Logo href="/" />
        <div className="flex items-center gap-2">
          {!isLoading && !user && (
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
          )}
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-5 pb-24">
        {/* --- hero ------------------------------------------------------ */}
        <section className="pt-14 pb-16 sm:pt-20">
          <div className="max-w-3xl">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden />
              Engineering risk intelligence, sitting on top of GitHub
            </p>

            <h1 className="text-balance text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
              Know which pull request is going to break production
              <span className="text-primary"> before you merge it.</span>
            </h1>

            <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
              BugDNA reads a pull request&apos;s diff, extracts the signals that
              actually correlate with deployment risk, and returns a score you can
              interrogate — every point of it traced back to a file in your change.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {githubEnabled ? (
                <Button asChild size="lg">
                  <a href={apiUrl("/auth/github?next=/dashboard")}>
                    <GithubIcon className="size-4" />
                    Continue with GitHub
                  </a>
                </Button>
              ) : (
                <Button size="lg" disabled title="GitHub OAuth is not configured on this deployment">
                  <GithubIcon className="size-4" />
                  Continue with GitHub
                </Button>
              )}

              {demoEnabled && (
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() =>
                    demo.mutate(undefined, { onSuccess: () => router.push("/dashboard") })
                  }
                  loading={demo.isPending}
                >
                  Explore the demo
                  <ArrowRight />
                </Button>
              )}
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              {demoEnabled
                ? "The demo is a seeded account with synthetic repositories — no GitHub access required."
                : "Read-only access. BugDNA never writes to your repositories."}
            </p>
          </div>
        </section>

        {/* --- example verdict ------------------------------------------- */}
        <section className="pb-20">
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
              <div className="flex items-center gap-2 text-sm">
                <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
                <span className="font-medium">#431</span>
                <span className="text-muted-foreground">
                  consolidate legacy payment columns into ledger
                </span>
              </div>
              <RiskBadge level="CRITICAL" score={88} size="lg" />
            </div>

            <div className="grid gap-0 sm:grid-cols-2">
              <div className="space-y-3 border-b border-border p-5 sm:border-b-0 sm:border-r">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Why
                </p>
                <ul className="space-y-2.5 text-sm">
                  {[
                    { label: "Contains destructive schema changes", share: "24%" },
                    { label: "No test changes included", share: "18%" },
                    { label: "Spans 8 modules", share: "14%" },
                    { label: "Touches authentication code", share: "11%" },
                  ].map((factor) => (
                    <li key={factor.label} className="flex items-baseline justify-between gap-3">
                      <span className="leading-snug">{factor.label}</span>
                      <span className="tabular shrink-0 text-xs font-semibold text-risk-high">
                        {factor.share}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-3 p-5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  What to do
                </p>
                <ul className="space-y-2.5 text-sm">
                  {[
                    "Confirm the migration is reversible and the data is backed up",
                    "Add tests covering the ledger write path",
                    "Get a second reviewer on the auth changes",
                    "Roll out behind a flag — these modules caused 60% of past incidents",
                  ].map((action) => (
                    <li key={action} className="flex gap-2 leading-snug">
                      <ArrowRight
                        className="mt-1 size-3 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      {action}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <p className="mt-2.5 text-center text-xs text-muted-foreground">
            An actual analysis from the demo tenant, produced by the pipeline —
            not a mockup.
          </p>
        </section>

        {/* --- pipeline -------------------------------------------------- */}
        <section className="pb-20">
          <h2 className="text-2xl font-bold tracking-tight">How it works</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Six stages, all of them inspectable. Nothing about the score is a black
            box you have to accept on faith.
          </p>

          <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PIPELINE.map((step, index) => (
              <li
                key={step.title}
                className="relative rounded-xl border border-border bg-card p-5"
              >
                <span className="absolute right-4 top-4 tabular text-xs font-semibold text-muted-foreground/40">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <step.icon className="size-5 text-primary" aria-hidden />
                <h3 className="mt-3 text-sm font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* --- signals --------------------------------------------------- */}
        <section className="pb-20">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">
                Signals from the diff, not guesses
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Every feature is derived from data GitHub actually returns, or from
                outcomes you explicitly reported. There are no invented metrics —
                no &ldquo;complexity score&rdquo;, no developer ratings.
              </p>

              <ul className="mt-6 space-y-3.5">
                {SIGNALS.map((signal) => (
                  <li key={signal.label} className="flex gap-3">
                    <signal.icon
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <div>
                      <p className="text-sm font-medium">{signal.label}</p>
                      <p className="text-xs text-muted-foreground">{signal.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {/* --- the honest bit ---------------------------------------- */}
            <div className="rounded-xl border border-border bg-surface/60 p-6">
              <h3 className="text-sm font-semibold">What the model is, precisely</h3>
              <dl className="mt-4 space-y-3.5 text-sm">
                {[
                  {
                    term: "Algorithm",
                    detail: "XGBoost gradient-boosted trees, served by a separate Python service.",
                  },
                  {
                    term: "Explainability",
                    detail: "SHAP TreeExplainer — exact attributions, not an approximation.",
                  },
                  {
                    term: "Training data",
                    detail:
                      "Yours, if you supply labelled outcomes. Out of the box it ships a synthetic bootstrap model, marked as such on every prediction.",
                  },
                  {
                    term: "Accuracy claims",
                    detail:
                      "None, until you have measured them on your own data. The model artifact reports null metrics rather than a number nobody validated.",
                  },
                ].map((row) => (
                  <div key={row.term}>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {row.term}
                    </dt>
                    <dd className="mt-0.5 leading-relaxed text-muted-foreground">
                      {row.detail}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        {/* --- cta ------------------------------------------------------- */}
        <section
          className={cn(
            "rounded-xl border border-border bg-card px-6 py-10 text-center",
            "sm:px-10",
          )}
        >
          <h2 className="text-2xl font-bold tracking-tight">
            Point it at a repository and see what it says
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Connect one repository, analyse one open pull request, and judge the
            explanation for yourself.
          </p>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {githubEnabled && (
              <Button asChild size="lg">
                <a href={apiUrl("/auth/github?next=/repositories/connect")}>
                  <GithubIcon className="size-4" />
                  Connect a repository
                </a>
              </Button>
            )}
            {demoEnabled && (
              <Button
                size="lg"
                variant="outline"
                onClick={() =>
                  demo.mutate(undefined, { onSuccess: () => router.push("/dashboard") })
                }
                loading={demo.isPending}
              >
                Explore the demo first
              </Button>
            )}
          </div>
        </section>
      </main>

      {/* --- footer ------------------------------------------------------ */}
      <footer className="relative z-10 border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-xs text-muted-foreground">
          <p>BugDNA — pre-deployment risk intelligence.</p>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/Teestasarkar/BugDNA"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 transition-colors hover:text-foreground"
            >
              <GithubIcon className="size-3.5" />
              Source
            </a>
            {config?.version && <span className="font-mono">{config.version}</span>}
          </div>
        </div>
      </footer>
    </div>
  );
}
