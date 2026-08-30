"use client";

/**
 * Team dashboard — the engineering-manager view.
 *
 * The rollups here answer questions an individual developer never asks: which
 * repository is trending worse, what risk patterns recur across the team, and —
 * the one that matters most — **how often do we merge high-risk changes anyway?**
 *
 * The override rate is the single most useful number on this page. A team that
 * overrides 90% of high-risk assessments either has a miscalibrated model or a
 * process problem, and either way it is worth knowing.
 *
 * Per-contributor rows show activity and average risk, deliberately without
 * ranking anyone. The model assesses changes, not people, and presenting a
 * leaderboard of "riskiest developers" would be both unkind and unsupported by
 * what BugDNA actually measures.
 */
import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Info,
  TriangleAlert,
  UserPlus,
  Users,
} from "lucide-react";
import { PageBody, PageHeader } from "../../page-header";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage, initialsOf } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InfoTooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldHint, Input, Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RiskBadge } from "@/components/risk/risk-badge";
import {
  RecurringFactorsChart,
  RiskDistributionBar,
  RiskTrendChart,
} from "@/components/charts";
import { ChartSkeleton, ErrorState, LoadingState } from "@/components/states";
import {
  useAddTeamMember,
  useRemoveTeamMember,
  useTeam,
  useTeamDashboard,
} from "@/hooks/use-api";
import { scoreToLevel } from "@/lib/risk";
import { number as fmtNumber, percent, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function TeamDashboardPage() {
  const params = useParams<{ id: string }>();
  const teamId = params.id;

  const [days, setDays] = React.useState(30);

  const { data: team, isLoading, isError, error, refetch } = useTeam(teamId);
  const {
    data: dashboard,
    isLoading: dashboardLoading,
    isError: dashboardError,
    error: dashboardErrorObject,
    refetch: refetchDashboard,
  } = useTeamDashboard(teamId, days);

  if (isLoading) return <LoadingState label="Loading team" />;

  if (isError) {
    return (
      <PageBody>
        <ErrorState error={error} onRetry={refetch} />
      </PageBody>
    );
  }

  if (!team) return null;

  const canManage = team.viewerRole === "OWNER" || team.viewerRole === "ADMIN";

  return (
    <PageBody>
      <PageHeader
        breadcrumb={
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/teams">
              <ArrowLeft />
              Teams
            </Link>
          </Button>
        }
        title={team.name}
        description={team.description ?? undefined}
        action={
          <>
            <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
              <SelectTrigger size="sm" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>
            {canManage && <AddMemberDialog teamId={teamId} />}
          </>
        }
      />

      {dashboardLoading ? (
        <ChartSkeleton height={260} />
      ) : dashboardError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={dashboardErrorObject} onRetry={refetchDashboard} />
          </CardContent>
        </Card>
      ) : dashboard ? (
        <>
          {/* --- headline numbers ---------------------------------------- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Repositories"
              value={fmtNumber(dashboard.totals.repositories)}
              hint={`${fmtNumber(dashboard.totals.openPullRequests)} open PRs`}
            />
            <Stat
              label="Analyses"
              value={fmtNumber(dashboard.totals.analyses)}
              hint={`in ${days} days`}
            />
            <Stat
              label="Average risk"
              value={
                dashboard.totals.avgRiskScore === null
                  ? "—"
                  : String(Math.round(dashboard.totals.avgRiskScore))
              }
              hint={`${fmtNumber(dashboard.totals.highRiskCount)} high or critical`}
              accent={
                dashboard.totals.avgRiskScore !== null &&
                dashboard.totals.avgRiskScore >= 60
              }
            />
            <Stat
              label="Override rate"
              value={
                dashboard.totals.overrideRate === null
                  ? "—"
                  : percent(dashboard.totals.overrideRate)
              }
              hint={`${fmtNumber(dashboard.totals.highRiskOverrides)} high-risk merges`}
              accent={
                dashboard.totals.overrideRate !== null &&
                dashboard.totals.overrideRate >= 50
              }
              tooltip="The share of high-risk assessments that were merged anyway. A consistently high rate means either the model is miscalibrated for this team, or high-risk changes are shipping without the flagged work being done. Both are worth investigating."
            />
          </div>

          {/* --- override warning ---------------------------------------- */}
          {dashboard.totals.overrideRate !== null &&
            dashboard.totals.overrideRate >= 50 &&
            dashboard.totals.highRiskOverrides >= 3 && (
              <Alert variant="warning" icon>
                <AlertTitle>
                  Most high-risk assessments are being merged anyway
                </AlertTitle>
                <AlertDescription>
                  {percent(dashboard.totals.overrideRate)} of high-risk pull requests
                  in the last {days} days were approved. That is worth a look: either
                  the thresholds are wrong for this team&apos;s codebase, or risky
                  changes are shipping without the recommended mitigations. The
                  recorded justifications are on each analysis.
                </AlertDescription>
              </Alert>
            )}

          {/* --- charts --------------------------------------------------- */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Team risk trend</CardTitle>
                <CardDescription>
                  Average score per day across all {dashboard.totals.repositories}{" "}
                  repositories.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RiskTrendChart data={dashboard.trend} height={228} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Distribution</CardTitle>
              </CardHeader>
              <CardContent>
                <RiskDistributionBar distribution={dashboard.distribution} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* --- repositories ----------------------------------------- */}
            <Card>
              <CardHeader>
                <CardTitle>Repositories</CardTitle>
                <CardDescription>Average risk over the window.</CardDescription>
              </CardHeader>
              <CardContent>
                {dashboard.repositories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No repositories are shared with this team yet. Assign one from its
                    settings.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Repository</TableHead>
                        <TableHead className="text-right">Analyses</TableHead>
                        <TableHead className="text-right">Avg risk</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dashboard.repositories
                        .slice()
                        .sort((a, b) => (b.avgRiskScore ?? -1) - (a.avgRiskScore ?? -1))
                        .map((repository) => (
                          <TableRow key={repository.id}>
                            <TableCell>
                              <Link
                                href={`/repositories/${repository.id}`}
                                className="font-mono text-xs hover:underline"
                              >
                                {repository.fullName}
                              </Link>
                            </TableCell>
                            <TableCell className="tabular text-right text-muted-foreground">
                              {fmtNumber(repository.analyses)}
                            </TableCell>
                            <TableCell className="text-right">
                              {repository.avgRiskScore === null ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <RiskBadge
                                  level={scoreToLevel(repository.avgRiskScore)}
                                  score={repository.avgRiskScore}
                                  size="sm"
                                  className="ml-auto"
                                />
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* --- recurring patterns ------------------------------------ */}
            <Card>
              <CardHeader>
                <CardTitle>Recurring risk patterns</CardTitle>
                <CardDescription>
                  What keeps raising scores across the team.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RecurringFactorsChart
                  factors={dashboard.recurringRiskFactors.slice(0, 7)}
                />
              </CardContent>
            </Card>
          </div>

          {/* --- contributors ------------------------------------------- */}
          {dashboard.contributors.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Pull request activity</CardTitle>
                <CardDescription>
                  Who is changing what, over the last {days} days.
                </CardDescription>
                <CardAction>
                  <InfoTooltip label="Shown for context on where change originates. BugDNA does not rank contributors: the model assesses changes, not people, and average risk mostly reflects the kind of work someone happens to be doing.">
                    <Info className="size-3.5 text-muted-foreground" aria-hidden />
                  </InfoTooltip>
                </CardAction>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Author</TableHead>
                      <TableHead className="text-right">PRs</TableHead>
                      <TableHead className="text-right">Avg churn</TableHead>
                      <TableHead className="text-right">Avg files</TableHead>
                      <TableHead className="text-right">Avg risk</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dashboard.contributors.map((contributor) => (
                      <TableRow key={contributor.login}>
                        <TableCell className="font-medium">{contributor.login}</TableCell>
                        <TableCell className="tabular text-right">
                          {fmtNumber(contributor.pullRequests)}
                        </TableCell>
                        <TableCell className="tabular text-right text-muted-foreground">
                          {contributor.avgChurn === null
                            ? "—"
                            : fmtNumber(Math.round(contributor.avgChurn))}
                        </TableCell>
                        <TableCell className="tabular text-right text-muted-foreground">
                          {contributor.avgFilesChanged === null
                            ? "—"
                            : Math.round(contributor.avgFilesChanged)}
                        </TableCell>
                        <TableCell className="text-right">
                          {contributor.avgRiskScore === null ? (
                            <span className="text-muted-foreground">
                              not analysed
                            </span>
                          ) : (
                            <span className="tabular">
                              {Math.round(contributor.avgRiskScore)}
                              <span className="ml-1 text-xs text-muted-foreground">
                                (n={contributor.analysedPullRequests})
                              </span>
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {dashboard.totals.repositories === 0 && (
            <Alert variant="info" icon>
              <AlertTitle>No repositories shared with this team</AlertTitle>
              <AlertDescription>
                Open a repository and assign it to {team.name} to see its risk rolled
                up here.{" "}
                <Link href="/repositories" className="font-medium underline">
                  View repositories
                </Link>
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : null}

      {/* --- members ---------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Users className="size-3.5 text-muted-foreground" aria-hidden />
            Members ({team.members.length})
          </CardTitle>
          <CardDescription>
            Everyone here can see the repositories shared with this team.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {team.members.map((member) => (
              <li key={member.id} className="flex items-center gap-3 py-2.5">
                <Avatar className="size-7 shrink-0">
                  {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt="" />}
                  <AvatarFallback>
                    {initialsOf(member.name ?? member.githubLogin)}
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.name ?? member.githubLogin}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    @{member.githubLogin} · joined {relativeTime(member.joinedAt)}
                  </p>
                </div>

                <Badge variant="muted" className="shrink-0 font-normal">
                  {member.role.toLowerCase()}
                </Badge>

                {canManage && member.id !== team.owner.id && (
                  <RemoveMemberButton
                    teamId={teamId}
                    userId={member.id}
                    login={member.githubLogin}
                  />
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </PageBody>
  );
}

function Stat({
  label,
  value,
  hint,
  accent = false,
  tooltip,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  tooltip?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          {label}
          {tooltip && (
            <InfoTooltip label={tooltip}>
              <Info className="size-3 text-muted-foreground/60" aria-hidden />
            </InfoTooltip>
          )}
        </p>
        {accent && (
          <TriangleAlert className="size-3 shrink-0 text-risk-moderate" aria-hidden />
        )}
      </div>
      <p
        className={cn(
          "tabular mt-2 text-2xl font-bold leading-none",
          accent && "text-risk-high",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function AddMemberDialog({ teamId }: { teamId: string }) {
  const [open, setOpen] = React.useState(false);
  const [login, setLogin] = React.useState("");
  const [role, setRole] = React.useState<"ADMIN" | "MEMBER" | "VIEWER">("MEMBER");

  const add = useAddTeamMember();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus />
          Add member
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a team member</DialogTitle>
          <DialogDescription>
            They must have signed in to BugDNA at least once — this deployment has no
            email transport, so it cannot send an invitation.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="member-login">GitHub username</Label>
            <Input
              id="member-login"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              placeholder="octocat"
              autoFocus
            />
            <FieldHint>Exactly as it appears on GitHub.</FieldHint>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="member-role">Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as typeof role)}>
              <SelectTrigger id="member-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ADMIN">Admin — can manage members</SelectItem>
                <SelectItem value="MEMBER">Member — full read access</SelectItem>
                <SelectItem value="VIEWER">Viewer — read only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={login.trim().length < 1}
            loading={add.isPending}
            onClick={() =>
              add.mutate(
                { teamId, githubLogin: login.trim(), role },
                {
                  onSuccess: () => {
                    setOpen(false);
                    setLogin("");
                  },
                },
              )
            }
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveMemberButton({
  teamId,
  userId,
  login,
}: {
  teamId: string;
  userId: string;
  login: string;
}) {
  const remove = useRemoveTeamMember();
  const [confirming, setConfirming] = React.useState(false);

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        className="shrink-0 text-xs text-muted-foreground"
      >
        Remove
      </Button>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        variant="destructive"
        size="sm"
        loading={remove.isPending}
        onClick={() => remove.mutate({ teamId, userId })}
        className="text-xs"
        aria-label={`Confirm removing ${login}`}
      >
        Confirm
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(false)}
        className="text-xs"
      >
        Cancel
      </Button>
    </div>
  );
}
