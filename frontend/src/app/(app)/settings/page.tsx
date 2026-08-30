"use client";

/**
 * Settings.
 *
 * Account, GitHub connection, appearance — and a methodology section that is the
 * point of the page as much as the settings are.
 *
 * That section exposes the full feature catalogue and the live model metadata:
 * what is being measured, what the bands mean, which engine is serving, and
 * whether any evaluation metrics exist. A risk tool that cannot show you its own
 * inputs is asking to be taken on faith, and an engineer is right to refuse.
 */
import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  Cpu,
  Database,
  FlaskConical,
  Info,
  Monitor,
  Moon,
  RefreshCw,
  Server,
  Sun,
  Unplug,
} from "lucide-react";
import { PageBody, PageHeader } from "../page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InfoTooltip } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage, initialsOf } from "@/components/ui/avatar";
import { GithubIcon } from "@/components/icons";
import { LoadingState } from "@/components/states";
import {
  useCurrentUser,
  useDisconnectGithub,
  useFeatureCatalogue,
  useSystemStatus,
} from "@/hooks/use-api";
import { apiUrl } from "@/lib/api";
import { useUiStore, type Theme } from "@/stores/ui.store";
import { FACTOR_CATEGORY_LABEL, RISK_PRESENTATION } from "@/lib/risk";
import { absoluteTime, duration, number as fmtNumber, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export default function SettingsPage() {
  const { data: user, isLoading } = useCurrentUser();

  if (isLoading) return <LoadingState label="Loading settings" />;
  if (!user) return null;

  return (
    <PageBody>
      <PageHeader
        title="Settings"
        description="Your account, GitHub connection and how BugDNA measures risk."
      />

      <Tabs defaultValue="account">
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="methodology">Methodology</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        {/* ================= account ==================================== */}
        <TabsContent value="account" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>From your GitHub account.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <Avatar className="size-14">
                  {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
                  <AvatarFallback>
                    {initialsOf(user.name ?? user.githubLogin)}
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-2 font-medium">
                    {user.name ?? user.githubLogin}
                    {user.isDemo && (
                      <Badge variant="default" className="text-[0.625rem]">
                        demo account
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">@{user.githubLogin}</p>
                  {user.email && (
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  )}
                </div>
              </div>

              <dl className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-3">
                <Field label="Repositories connected" value={fmtNumber(user.counts.repositories)} />
                <Field label="Analyses requested" value={fmtNumber(user.counts.analyses)} />
                <Field label="Member since" value={absoluteTime(user.createdAt)} />
              </dl>
            </CardContent>
          </Card>

          <GithubConnectionCard user={user} />

          {user.teams.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Teams</CardTitle>
                <CardDescription>
                  Repositories shared with these teams are visible to you.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border">
                  {user.teams.map((team) => (
                    <li key={team.id} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/teams/${team.id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {team.name}
                        </Link>
                      </div>
                      <Badge variant="muted" className="font-normal">
                        {team.role.toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ================= appearance ================================= */}
        <TabsContent value="appearance" className="mt-4 space-y-4">
          <AppearanceCard />
        </TabsContent>

        {/* ================= methodology ================================ */}
        <TabsContent value="methodology" className="mt-4 space-y-4">
          <MethodologySection />
        </TabsContent>

        {/* ================= system ===================================== */}
        <TabsContent value="system" className="mt-4 space-y-4">
          <SystemSection />
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function GithubConnectionCard({
  user,
}: {
  user: NonNullable<ReturnType<typeof useCurrentUser>["data"]>;
}) {
  const disconnect = useDisconnectGithub();
  const github = user.github;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GithubIcon className="size-4" />
          GitHub connection
        </CardTitle>
        <CardDescription>
          BugDNA reads pull requests and diffs. It never writes to your
          repositories.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {github.connected ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              <Check className="size-4 shrink-0 text-risk-low" aria-hidden />
              <span className="font-medium">Connected</span>
              <span className="text-muted-foreground">
                since {absoluteTime(github.connectedAt)}
              </span>
              {github.mode === "mock" && (
                <Badge variant="outline" className="border-risk-moderate-border text-risk-moderate">
                  fixture mode
                </Badge>
              )}
            </div>

            {/* --- scopes -------------------------------------------------- */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Granted scopes</p>
              <div className="flex flex-wrap gap-1.5">
                {github.scopes.length === 0 ? (
                  <span className="text-xs text-muted-foreground">none reported</span>
                ) : (
                  github.scopes.map((scope) => (
                    <code
                      key={scope}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]"
                    >
                      {scope}
                    </code>
                  ))
                )}
              </div>

              {!github.canReadPrivateRepos && (
                <Alert variant="warning" icon>
                  <AlertTitle>Private repositories are unreachable</AlertTitle>
                  <AlertDescription>
                    Without the <code className="font-mono text-xs">repo</code> scope,
                    BugDNA cannot list private repositories or read their diffs.
                    Reconnect to grant it.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            {/* --- rate limit -------------------------------------------- */}
            {github.rateLimitRemaining !== null && (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    API rate limit
                  </p>
                  <p className="tabular text-xs">
                    <span
                      className={cn(
                        "font-medium",
                        github.rateLimitRemaining < 200 && "text-risk-moderate",
                      )}
                    >
                      {fmtNumber(github.rateLimitRemaining)}
                    </span>{" "}
                    <span className="text-muted-foreground">remaining</span>
                  </p>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      github.rateLimitRemaining < 200 ? "bg-risk-moderate" : "bg-risk-low",
                    )}
                    style={{
                      width: `${Math.min(100, (github.rateLimitRemaining / 5000) * 100)}%`,
                    }}
                  />
                </div>
                {github.rateLimitResetAt && (
                  <p className="text-[0.6875rem] text-muted-foreground">
                    Resets {relativeTime(github.rateLimitResetAt).replace(" ago", "")} from
                    now. BugDNA uses conditional requests, so unchanged data costs no
                    quota.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button asChild variant="outline" size="sm">
                <a href={apiUrl("/auth/github?next=/settings")}>
                  <RefreshCw />
                  Reconnect / re-grant scopes
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnect.mutate()}
                loading={disconnect.isPending}
              >
                <Unplug />
                Disconnect
              </Button>
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Disconnecting keeps your repositories and past analyses, but no new
              data can be fetched until you reconnect. Your access token is
              encrypted with AES-256-GCM at rest.
            </p>
          </>
        ) : (
          <>
            <Alert variant="warning" icon>
              <AlertTitle>GitHub is not connected</AlertTitle>
              <AlertDescription>
                BugDNA cannot fetch pull requests or diffs without it.
              </AlertDescription>
            </Alert>
            <Button asChild>
              <a href={apiUrl("/auth/github?next=/settings")}>
                <GithubIcon className="size-4" />
                Connect GitHub
              </a>
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function AppearanceCard() {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const hideGenerated = useUiStore((state) => state.hideGeneratedFiles);
  const setHideGenerated = useUiStore((state) => state.setHideGeneratedFiles);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Stored in this browser only.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium">Theme</p>
          <div className="flex flex-wrap gap-2">
            {THEMES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setTheme(option.value)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                  theme === option.value
                    ? "border-primary bg-accent text-accent-foreground"
                    : "border-border hover:bg-muted/50",
                )}
                aria-pressed={theme === option.value}
              >
                <option.icon className="size-4" aria-hidden />
                {option.label}
                {theme === option.value && <Check className="size-3.5" aria-hidden />}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Hide generated files in diffs</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Lockfiles and build output are collapsed by default. The extractor
              already discounts them, and a 900-line lockfile diff buries the lines
              that matter.
            </p>
          </div>
          <Switch
            checked={hideGenerated}
            onCheckedChange={setHideGenerated}
            aria-label="Hide generated files in diffs"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Methodology
// ---------------------------------------------------------------------------

function MethodologySection() {
  const { data: catalogue, isLoading } = useFeatureCatalogue();

  if (isLoading) return <LoadingState label="Loading methodology" />;
  if (!catalogue) return null;

  const model = catalogue.model;

  // Group features by category for readability.
  const byCategory = catalogue.features.reduce<Record<string, typeof catalogue.features>>(
    (accumulator, feature) => {
      (accumulator[feature.category] ??= []).push(feature);
      return accumulator;
    },
    {},
  );

  return (
    <>
      {/* --- what is serving ------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="size-4 text-muted-foreground" aria-hidden />
            The model
          </CardTitle>
          <CardDescription>What is scoring your pull requests right now.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {model ? (
            <>
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field
                  label="Engine"
                  value={
                    model.engine === "xgboost" ? (
                      <span className="flex items-center gap-1.5">
                        XGBoost
                        <Badge variant="outline" className="text-[0.625rem]">
                          trained
                        </Badge>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-risk-moderate">
                        <FlaskConical className="size-3" />
                        heuristic fallback
                      </span>
                    )
                  }
                />
                <Field label="Version" value={<code className="font-mono text-xs">{model.version}</code>} />
                <Field label="Features" value={fmtNumber(model.feature_count)} />
                <Field
                  label="Trained"
                  value={model.trained_at ? absoluteTime(model.trained_at) : "—"}
                />
              </dl>

              {/* The honesty section. */}
              {model.metrics === null ? (
                <Alert variant="neutral" icon>
                  <AlertTitle>No accuracy metrics are claimed</AlertTitle>
                  <AlertDescription className="space-y-1.5">
                    <p>
                      This model artifact reports no evaluation metrics, which means
                      one of two things: it is the transparent heuristic fallback, or
                      it was fitted on BugDNA&apos;s synthetic bootstrap dataset.
                    </p>
                    <p>
                      In the bootstrap case the model learns to approximate the
                      documented heuristic weights — it does <strong>not</strong>{" "}
                      predict real incidents, and BugDNA will not quote a figure it
                      has not measured. Supply labelled outcomes from your own
                      history and retrain to get metrics that mean something. See{" "}
                      <code className="font-mono text-xs">docs/ML_MODEL.md</code>.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Holdout metrics, from the operator&apos;s own labelled data
                  </p>
                  <dl className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {Object.entries(model.metrics).map(([key, value]) => (
                      <div key={key} className="rounded-lg border border-border p-2.5">
                        <dt className="font-mono text-[0.625rem] text-muted-foreground">
                          {key}
                        </dt>
                        <dd className="tabular mt-0.5 text-sm font-semibold">
                          {typeof value === "number" ? value.toFixed(4) : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </>
          ) : (
            <Alert variant="warning" icon>
              <AlertTitle>The risk service is not reachable</AlertTitle>
              <AlertDescription>
                Model metadata is unavailable. Existing analyses are unaffected; new
                ones will queue and retry.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* --- bands ------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>Risk bands</CardTitle>
          <CardDescription>
            How a probability becomes a word. This is a product decision, not a model
            output — the model returns a number, and these are the labels BugDNA
            chooses to put on it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {catalogue.riskBands.map((band) => (
              <li
                key={band.level}
                className={cn(
                  "rounded-lg border p-3",
                  RISK_PRESENTATION[band.level].className,
                )}
              >
                <p className="text-sm font-semibold">{band.level}</p>
                <p className="tabular mt-0.5 text-xs opacity-80">
                  {band.min} – {band.max}
                </p>
                <p className="mt-1.5 text-[0.6875rem] leading-relaxed opacity-90">
                  {RISK_PRESENTATION[band.level].summary}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* --- features --------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>
            What BugDNA measures ({catalogue.features.length} signals)
          </CardTitle>
          <CardDescription>
            Every feature is derived from data GitHub returns, or from deployment
            outcomes you reported. Feature set{" "}
            <code className="font-mono text-xs">v{catalogue.featureSetVersion}</code>.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {Object.entries(byCategory).map(([category, features]) => (
            <div key={category} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {FACTOR_CATEGORY_LABEL[category as keyof typeof FACTOR_CATEGORY_LABEL] ??
                  category}
              </p>
              <ul className="space-y-1.5">
                {features.map((feature) => (
                  <li
                    key={feature.key}
                    className="rounded-md border border-border/60 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{feature.label}</p>
                      <div className="flex items-center gap-1.5">
                        {feature.requiresHistory && (
                          <InfoTooltip label="Needs BugDNA to have observed this repository for a while. On a freshly connected repo it falls back to a documented neutral value, and the analysis says so.">
                            <Badge variant="muted" className="text-[0.625rem]">
                              needs history
                            </Badge>
                          </InfoTooltip>
                        )}
                        <code className="font-mono text-[0.625rem] text-muted-foreground/70">
                          {feature.key}
                        </code>
                      </div>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {feature.description}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

function SystemSection() {
  const { data: status, isLoading } = useSystemStatus();

  if (isLoading) return <LoadingState label="Checking system status" />;
  if (!status) return null;

  const dependencies = [
    { key: "database", label: "PostgreSQL", icon: Database, required: true, ...status.dependencies.database },
    { key: "redis", label: "Redis", icon: Server, required: true, ...status.dependencies.redis },
    { key: "ml", label: "Risk service", icon: Cpu, required: false, ...status.dependencies.mlService },
  ];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Dependencies</CardTitle>
          <CardDescription>
            Postgres and Redis are required. The risk service is not — the app stays
            usable for browsing and reading past analyses while it is down, and
            queued analyses retry.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {dependencies.map((dependency) => (
              <li
                key={dependency.key}
                className="flex items-center gap-3 rounded-lg border border-border p-3"
              >
                <dependency.icon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{dependency.label}</p>
                  {dependency.error && (
                    <p className="text-xs text-risk-critical">{dependency.error}</p>
                  )}
                </div>

                {dependency.latencyMs !== undefined && (
                  <span className="tabular text-xs text-muted-foreground">
                    {dependency.latencyMs}ms
                  </span>
                )}

                <span
                  className={cn(
                    "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.6875rem] font-medium",
                    dependency.ok ? "risk-low" : dependency.required ? "risk-critical" : "risk-moderate",
                  )}
                >
                  {dependency.ok ? (
                    <Check className="size-3" />
                  ) : (
                    <AlertTriangle className="size-3" />
                  )}
                  {dependency.ok ? "ok" : dependency.required ? "down" : "degraded"}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Analysis queue</CardTitle>
            <CardDescription>
              Analyses run asynchronously in a worker process.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {status.queue ? (
              <dl className="grid grid-cols-3 gap-3 text-center sm:grid-cols-5">
                {[
                  { label: "Waiting", value: status.queue.waiting },
                  { label: "Active", value: status.queue.active },
                  { label: "Delayed", value: status.queue.delayed },
                  { label: "Failed", value: status.queue.failed, accent: true },
                  { label: "Completed", value: status.queue.completed },
                ].map((entry) => (
                  <div key={entry.label}>
                    <dd
                      className={cn(
                        "tabular text-xl font-bold leading-none",
                        entry.accent && entry.value > 0 && "text-risk-high",
                      )}
                    >
                      {fmtNumber(entry.value)}
                    </dd>
                    <dt className="mt-1 text-[0.625rem] text-muted-foreground">
                      {entry.label}
                    </dt>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">Queue stats unavailable.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Deployment</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Version" value={<code className="font-mono text-xs">{status.version}</code>} />
              <Field label="Environment" value={status.environment} />
              <Field label="Uptime" value={duration(status.uptimeSeconds * 1000)} />
              <Field
                label="GitHub mode"
                value={
                  <span className="flex items-center gap-1.5">
                    {status.github.mode}
                    {status.github.mode === "mock" && (
                      <InfoTooltip label="Serving deterministic fixtures instead of the real GitHub API. The whole workflow runs with no credentials and no network.">
                        <Info className="size-3 text-muted-foreground" />
                      </InfoTooltip>
                    )}
                  </span>
                }
              />
              <Field
                label="Feature set"
                value={<code className="font-mono text-xs">v{status.analysis.featureSetVersion}</code>}
              />
              <Field
                label="High-risk threshold"
                value={`${status.analysis.highRiskThreshold}/100`}
              />
              <Field
                label="Worker concurrency"
                value={fmtNumber(status.analysis.concurrency)}
              />
              <Field
                label="Analysis timeout"
                value={duration(status.analysis.timeoutMs)}
              />
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
