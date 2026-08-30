"use client";

/**
 * Connect a repository.
 *
 * Lists what the user's GitHub token can actually see, annotated with what is
 * already connected. Two details that matter:
 *
 *  - **A repository the token cannot pull is disabled, with the reason.**
 *    Connecting it would succeed and then every analysis would fail at the diff
 *    fetch, which is a far more confusing failure than being told up front.
 *  - **A missing `repo` scope is called out at the top**, because that is the
 *    single most common reason private repositories do not appear at all.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Lock,
  Search,
  Star,
  TriangleAlert,
} from "lucide-react";
import { PageBody, PageHeader } from "../../page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InfoTooltip } from "@/components/ui/tooltip";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/states";
import { GithubIcon } from "@/components/icons";
import {
  useAvailableRepositories,
  useConnectRepository,
  useCurrentUser,
} from "@/hooks/use-api";
import { number as fmtNumber, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AvailableRepository } from "@/types/api";

export default function ConnectRepositoryPage() {
  const router = useRouter();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: user } = useCurrentUser();
  const { data, isLoading, isError, error, refetch, isFetching } = useAvailableRepositories({
    page,
    ...(debounced ? { search: debounced } : {}),
  });

  const connect = useConnectRepository();
  const repositories = data?.data ?? [];
  const meta = data?.meta;

  const missingRepoScope =
    user?.github.connected === true && user.github.canReadPrivateRepos === false;

  return (
    <PageBody>
      <PageHeader
        breadcrumb={
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/repositories">
              <ArrowLeft />
              Repositories
            </Link>
          </Button>
        }
        title="Connect a repository"
        description="Pick a repository and BugDNA will pull its open pull requests, ready to analyse."
      />

      {/* --- scope warning ------------------------------------------------- */}
      {missingRepoScope && (
        <Alert variant="warning" icon>
          <AlertTitle>Private repositories are not visible</AlertTitle>
          <AlertDescription>
            Your GitHub authorization was granted without the{" "}
            <code className="font-mono text-xs">repo</code> scope, so only public
            repositories appear below — and their diffs may not be readable either.
            Reconnect GitHub from{" "}
            <Link href="/settings" className="font-medium underline">
              settings
            </Link>{" "}
            and grant it.
          </AlertDescription>
        </Alert>
      )}

      {/* --- search ------------------------------------------------------- */}
      <div className="relative max-w-md">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search your repositories"
          className="h-9 pl-8"
          aria-label="Search repositories"
        />
      </div>

      {/* --- list --------------------------------------------------------- */}
      {isLoading ? (
        <ListSkeleton rows={6} />
      ) : isError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
          </CardContent>
        </Card>
      ) : repositories.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              icon={GithubIcon as never}
              title={debounced ? "No repositories match" : "No repositories found"}
              description={
                debounced
                  ? "Try a different search term."
                  : "Your GitHub account has no repositories BugDNA can read, or they are all archived."
              }
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <ul className="space-y-2">
            {repositories.map((repository) => (
              <AvailableRepositoryRow
                key={repository.githubId}
                repository={repository}
                onConnect={() =>
                  connect.mutate(
                    { owner: repository.owner, name: repository.name },
                    {
                      onSuccess: (result) =>
                        router.push(`/repositories/${result.repositoryId}`),
                    },
                  )
                }
                connecting={connect.isPending && connect.variables?.name === repository.name}
              />
            ))}
          </ul>

          {/* --- pagination ------------------------------------------------ */}
          {(page > 1 || meta?.hasNextPage) && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Page {page}
                {meta?.cached && " · from cache"}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!meta?.hasNextPage}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </PageBody>
  );
}

function AvailableRepositoryRow({
  repository,
  onConnect,
  connecting,
}: {
  repository: AvailableRepository;
  onConnect: () => void;
  connecting: boolean;
}) {
  // Without pull access the diff endpoints will fail, so connecting is refused
  // rather than deferred to a confusing analysis failure later.
  const blocked = !repository.canPull;

  return (
    <li
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-lg border border-border bg-card p-4",
        repository.connected && "border-risk-low-border bg-risk-low-bg/20",
      )}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">
            {repository.fullName}
          </span>

          {repository.private && (
            <InfoTooltip label="Private repository.">
              <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            </InfoTooltip>
          )}

          {repository.connected && (
            <Badge variant="outline" className="border-risk-low-border text-risk-low">
              <Check className="size-3" />
              connected
            </Badge>
          )}
        </div>

        {repository.description && (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {repository.description}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {repository.language && <span>{repository.language}</span>}
          {repository.stars > 0 && (
            <span className="flex items-center gap-1">
              <Star className="size-3" aria-hidden />
              {fmtNumber(repository.stars)}
            </span>
          )}
          <span>{fmtNumber(repository.openIssues)} open issues</span>
          {repository.pushedAt && <span>pushed {relativeTime(repository.pushedAt)}</span>}
        </div>

        {blocked && (
          <p className="flex items-center gap-1.5 text-xs text-risk-moderate">
            <TriangleAlert className="size-3" aria-hidden />
            Your GitHub authorization cannot read this repository&apos;s contents, so
            its diffs would be unavailable.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <a
          href={repository.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`View ${repository.fullName} on GitHub`}
        >
          <ExternalLink className="size-3.5" />
        </a>

        {repository.connected && repository.connectedRepositoryId ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/repositories/${repository.connectedRepositoryId}`}>Open</Link>
          </Button>
        ) : (
          <Button size="sm" onClick={onConnect} loading={connecting} disabled={blocked}>
            Connect
          </Button>
        )}
      </div>
    </li>
  );
}
