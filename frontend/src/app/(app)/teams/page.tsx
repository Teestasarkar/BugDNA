"use client";

/**
 * Teams.
 *
 * A team is the unit that shares repositories, and team membership is the second
 * half of the tenancy predicate — so this page is also the answer to "how do I
 * let my colleague see this repository's risk history".
 */
import * as React from "react";
import Link from "next/link";
import { ArrowRight, FolderGit2, Plus, Users } from "lucide-react";
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
import { FieldHint, Input, Label, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/states";
import { useCreateTeam, useTeams } from "@/hooks/use-api";
import { number as fmtNumber, relativeTime } from "@/lib/format";

export default function TeamsPage() {
  const { data: teams, isLoading, isError, error, refetch, isFetching } = useTeams();

  return (
    <PageBody>
      <PageHeader
        title="Teams"
        description="Share repositories and see risk rolled up across a whole team."
        action={<CreateTeamDialog />}
      />

      {isLoading ? (
        <ListSkeleton rows={2} />
      ) : isError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
          </CardContent>
        </Card>
      ) : !teams || teams.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              icon={Users}
              title="You are not in a team yet"
              description="Create one to share connected repositories with colleagues and get a team-level view of risk, override rates and recurring patterns."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {teams.map((team) => (
            <Card key={team.id}>
              <CardHeader>
                <div className="min-w-0 space-y-1">
                  <CardTitle>
                    <Link href={`/teams/${team.id}`} className="hover:underline">
                      {team.name}
                    </Link>
                  </CardTitle>
                  {team.description && (
                    <CardDescription className="line-clamp-2">
                      {team.description}
                    </CardDescription>
                  )}
                </div>
                <div className="col-start-2 row-span-2 shrink-0">
                  <Badge variant="muted" className="font-normal">
                    {team.role.toLowerCase()}
                  </Badge>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Users className="size-3" aria-hidden />
                    {fmtNumber(team.counts.members)} member
                    {team.counts.members === 1 ? "" : "s"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FolderGit2 className="size-3" aria-hidden />
                    {fmtNumber(team.counts.repositories)} repositor
                    {team.counts.repositories === 1 ? "y" : "ies"}
                  </span>
                  <span>owned by {team.owner.githubLogin}</span>
                  <span>joined {relativeTime(team.joinedAt)}</span>
                </div>

                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link href={`/teams/${team.id}`}>
                    Open team dashboard
                    <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageBody>
  );
}

function CreateTeamDialog() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");

  const create = useCreateTeam();
  const valid = name.trim().length >= 2;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          New team
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a team</DialogTitle>
          <DialogDescription>
            You will be its owner. Repositories you connect can then be shared with
            everyone in it.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="team-name">Name</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Platform Engineering"
              autoFocus
            />
            <FieldHint>A URL slug is generated from this.</FieldHint>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="team-description">
              Description{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="team-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder="What this team owns."
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  ...(description.trim() ? { description: description.trim() } : {}),
                },
                {
                  onSuccess: () => {
                    setOpen(false);
                    setName("");
                    setDescription("");
                  },
                },
              )
            }
          >
            Create team
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
