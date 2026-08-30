"use client";

/**
 * Sign-in.
 *
 * Handles four states honestly rather than showing one button and hoping:
 *
 *  - GitHub OAuth configured → offer it
 *  - not configured → say so, and explain what an operator must set
 *  - demo account seeded → offer it, and say what it is
 *  - arrived here with an `?error=` from a failed callback → show that error
 *
 * The `next` parameter is preserved through the whole flow, so a user who was
 * deep-linked to an analysis lands back on it rather than the dashboard.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Info, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Logo } from "@/components/layout/logo";
import { GithubIcon } from "@/components/icons";
import { LoadingState } from "@/components/states";
import { useCurrentUser, useDeploymentConfig, useSignInAsDemo } from "@/hooks/use-api";
import { apiUrl } from "@/lib/api";

export default function LoginPage() {
  return (
    // useSearchParams needs a Suspense boundary in the App Router.
    <React.Suspense fallback={<LoadingState label="Loading" />}>
      <LoginContent />
    </React.Suspense>
  );
}

function LoginContent() {
  const router = useRouter();
  const params = useSearchParams();

  const next = params.get("next") ?? "/dashboard";
  const errorCode = params.get("error");
  const errorMessage = params.get("message");

  const { data: user, isLoading: userLoading } = useCurrentUser();
  const { data: config, isLoading: configLoading } = useDeploymentConfig();
  const demo = useSignInAsDemo();

  // Already signed in — go where they were headed.
  React.useEffect(() => {
    if (user) router.replace(next);
  }, [user, next, router]);

  if (userLoading || configLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Loading" />
      </div>
    );
  }

  const githubEnabled = config?.auth.githubEnabled ?? false;
  const githubMode = config?.auth.githubMode ?? "live";
  const demoEnabled = config?.auth.demoLoginEnabled ?? false;

  // Preserve the destination across the OAuth round trip.
  const signInHref = apiUrl(`/auth/github?next=${encodeURIComponent(next)}`);

  return (
    <div className="relative flex min-h-dvh flex-col">
      <div className="grid-backdrop pointer-events-none absolute inset-0 opacity-30" aria-hidden />

      <header className="relative z-10 mx-auto flex h-16 w-full max-w-6xl items-center px-5">
        <Logo href="/" />
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pb-16">
        <div className="w-full max-w-sm">
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="space-y-1.5">
              <h1 className="text-lg font-semibold tracking-tight">Sign in to BugDNA</h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                BugDNA reads your pull requests to assess deployment risk. It needs
                read access, and never writes to your repositories.
              </p>
            </div>

            {/* --- callback error ---------------------------------------- */}
            {errorCode && (
              <Alert variant="danger" className="mt-4" icon>
                <AlertTitle>
                  {errorCode === "ACCESS_DENIED"
                    ? "Authorization cancelled"
                    : "Sign-in failed"}
                </AlertTitle>
                <AlertDescription>
                  {errorMessage ??
                    "GitHub did not complete the sign-in. Please try again."}
                </AlertDescription>
              </Alert>
            )}

            {/* --- mock mode notice -------------------------------------- */}
            {githubMode === "mock" && (
              <Alert variant="info" className="mt-4" icon>
                <AlertTitle>Fixture mode</AlertTitle>
                <AlertDescription>
                  This deployment is running with <code className="font-mono">GITHUB_MODE=mock</code>.
                  Signing in uses deterministic fixtures instead of the real GitHub
                  API — the whole workflow runs, with no credentials and no network.
                </AlertDescription>
              </Alert>
            )}

            {/* --- actions ----------------------------------------------- */}
            <div className="mt-5 space-y-2.5">
              {githubEnabled ? (
                <Button asChild size="lg" className="w-full">
                  <a href={signInHref}>
                    <GithubIcon className="size-4" />
                    Continue with GitHub
                  </a>
                </Button>
              ) : (
                <>
                  <Button size="lg" className="w-full" disabled>
                    <GithubIcon className="size-4" />
                    Continue with GitHub
                  </Button>
                  <Alert variant="warning" icon>
                    <AlertTitle>GitHub sign-in is not configured</AlertTitle>
                    <AlertDescription>
                      An operator needs to create a GitHub OAuth App and set{" "}
                      <code className="font-mono text-xs">GITHUB_CLIENT_ID</code> and{" "}
                      <code className="font-mono text-xs">GITHUB_CLIENT_SECRET</code> on
                      this deployment. See <code className="font-mono text-xs">docs/DEPLOYMENT.md</code>.
                    </AlertDescription>
                  </Alert>
                </>
              )}

              {demoEnabled && (
                <>
                  <div className="relative py-1">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="bg-card px-2 text-xs text-muted-foreground">or</span>
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    size="lg"
                    className="w-full"
                    onClick={() => demo.mutate(undefined, { onSuccess: () => router.push(next) })}
                    loading={demo.isPending}
                  >
                    View the demo
                    <ArrowRight />
                  </Button>

                  <p className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                    A seeded account with three synthetic repositories, 24 pull
                    requests and real analyses. It can only ever see its own data.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* --- scope explanation ------------------------------------- */}
          {githubEnabled && githubMode === "live" && (
            <div className="mt-4 rounded-lg border border-border bg-surface/50 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <TriangleAlert className="size-3.5 text-muted-foreground" aria-hidden />
                What BugDNA will ask for
              </p>
              <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
                <li>
                  <code className="font-mono">read:user</code> — your profile, to
                  create your account
                </li>
                <li>
                  <code className="font-mono">user:email</code> — your primary
                  email address
                </li>
                <li>
                  <code className="font-mono">repo</code> — read access to
                  repository contents and pull request diffs
                </li>
              </ul>
              <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground/80">
                The <code className="font-mono">repo</code> scope is what allows
                private repositories and their diffs to be read. Your access token
                is encrypted with AES-256-GCM before being stored.
              </p>
            </div>
          )}

          <div className="mt-5 text-center">
            <Button asChild variant="ghost" size="sm">
              <Link href="/">
                <ArrowLeft />
                Back
              </Link>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
