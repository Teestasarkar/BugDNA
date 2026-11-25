"""Score a live GitHub pull request with the same feature code the model was trained on.

`GitHubHistory` answers the `History` protocol from the REST API so that
`riskradar.features.compute_features` runs unchanged:

  file_events          GET /repos/{o}/{r}/commits?path=..&until=..&per_page=100
  author_changes       GET /repos/{o}/{r}/commits?author=..&until=..[&since=..]&per_page=1  (count via Link)
  author_path_changes  GET /repos/{o}/{r}/commits?author=..&path=<dir>&until=..&per_page=1
  repo_events          GET /repos/{o}/{r}/commits?until=..&per_page=100
  author_events        GET /repos/{o}/{r}/commits?author=..&until=..&per_page=100

Authors are identified by commit e-mail, exactly as in training (a GitHub login
would merge a person's several e-mails and overstate their experience relative
to what the model learned). For a merged PR that is the squash commit's author
e-mail; for an open PR, the e-mail on the author's latest base-branch commit,
which is what GitHub will most likely use when squashing.

A typical PR costs ~22 requests. Unauthenticated, GitHub allows 60 per hour per
IP, so set GITHUB_TOKEN (a fine-grained token with no permissions is enough for
public repositories) for anything beyond a demo.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx

from riskradar.features import (
    FILE_HISTORY_DEPTH,
    RECENT_DEPTH,
    Event,
    FileChange,
    PRChange,
    author_subsystems,
    compute_features,
    history_files,
)
from riskradar.text import is_bug_fix, strip_pr_suffix

API = "https://api.github.com"
PR_URL = re.compile(r"^(?:https?://)?(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)")
_STATUS = {"added": "added", "removed": "deleted", "modified": "modified", "renamed": "renamed",
           "copied": "added", "changed": "modified", "unchanged": "modified"}
MAX_FILE_PAGES = 3


class GitHubError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def parse_pr_url(url: str) -> tuple[str, str, int]:
    m = PR_URL.match(url.strip())
    if not m:
        raise GitHubError("Expected a URL like https://github.com/owner/repo/pull/123", status=422)
    return m.group(1), m.group(2), int(m.group(3))


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ts(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


@dataclass
class Client:
    token: str | None = field(default_factory=lambda: os.environ.get("GITHUB_TOKEN") or None)
    calls: int = 0
    rate_remaining: int | None = None

    def __post_init__(self) -> None:
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "User-Agent": "pr-risk-radar"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        self._http = httpx.Client(base_url=API, headers=headers, timeout=20.0)

    def close(self) -> None:
        self._http.close()

    def get(self, path: str, params: dict | None = None) -> httpx.Response:
        self.calls += 1
        r = self._http.get(path, params=params)
        remaining = r.headers.get("x-ratelimit-remaining")
        if remaining is not None:
            self.rate_remaining = int(remaining)
        if r.status_code in (403, 429) and (remaining == "0" or "rate limit" in r.text.lower()):
            reset = int(r.headers.get("x-ratelimit-reset", "0") or 0)
            wait = max(0, reset - int(time.time())) // 60
            hint = "" if self.token else " Set GITHUB_TOKEN on the server to raise the limit from 60 to 5,000/hour."
            raise GitHubError(f"GitHub API rate limit reached; resets in ~{wait} min.{hint}", status=429)
        if r.status_code == 404:
            raise GitHubError("Not found on GitHub (private repositories are not supported).", status=404)
        if r.status_code >= 400:
            raise GitHubError(f"GitHub returned {r.status_code}: {r.text[:200]}")
        return r

    def count(self, path: str, params: dict) -> int:
        r = self.get(path, {**params, "per_page": 1})
        m = re.search(r'[?&]page=(\d+)>; rel="last"', r.headers.get("link", ""))
        return int(m.group(1)) if m else len(r.json())


class GitHubHistory:
    def __init__(self, client: Client, owner: str, repo: str, branch: str, email: str | None) -> None:
        self.c, self.base, self.branch = client, f"/repos/{owner}/{repo}", branch
        self.author_query = email

    def _events(self, params: dict, depth: int) -> list[Event]:
        r = self.c.get(f"{self.base}/commits", {"sha": self.branch, "per_page": depth, **params})
        events = []
        for item in r.json():
            commit = item["commit"]
            email = (commit.get("author") or {}).get("email", "").strip().lower()
            title = strip_pr_suffix(commit.get("message", "").split("\n", 1)[0])
            events.append(Event(sha=item["sha"], timestamp=_ts(commit["committer"]["date"]),
                                author=email, is_fix=is_bug_fix(title)))
        return events

    def file_events(self, path: str, before: int) -> list[Event]:
        return self._events({"path": path, "until": _iso(before - 1)}, FILE_HISTORY_DEPTH)

    def repo_events(self, before: int) -> list[Event]:
        return self._events({"until": _iso(before - 1)}, RECENT_DEPTH)

    def author_events(self, authors: frozenset[str], before: int) -> list[Event]:
        if not self.author_query:
            return []
        return self._events({"author": self.author_query, "until": _iso(before - 1)}, RECENT_DEPTH)

    def author_changes(self, authors: frozenset[str], before: int, since: int | None = None) -> int:
        if not self.author_query:
            return 0
        params = {"sha": self.branch, "author": self.author_query, "until": _iso(before - 1)}
        if since is not None:
            params["since"] = _iso(since)
        return self.c.count(f"{self.base}/commits", params)

    def author_path_changes(self, authors: frozenset[str], path: str, before: int) -> int:
        if not self.author_query:
            return 0
        return self.c.count(f"{self.base}/commits", {"sha": self.branch, "author": self.author_query,
                                                     "path": path, "until": _iso(before - 1)})


def _email(item: dict) -> str:
    return ((item.get("commit") or {}).get("author") or {}).get("email", "").strip().lower()


def author_email(c: Client, owner: str, repo: str, pr: dict, commits: list[dict], login: str | None) -> str | None:
    """The commit e-mail training would have used for this PR's author (see module docstring)."""
    base = f"/repos/{owner}/{repo}"
    if pr.get("merged_at") and pr.get("merge_commit_sha"):
        merged = c.get(f"{base}/commits/{pr['merge_commit_sha']}").json()
        if len(merged.get("parents", [])) == 1:          # squash or rebase: the commit is the PR's own
            return _email(merged) or None
    if login:
        latest = c.get(f"{base}/commits", {"sha": pr["base"]["ref"], "author": login, "per_page": 1}).json()
        if latest:
            return _email(latest[0]) or None
    own = [_email(cm) for cm in commits if (cm.get("author") or {}).get("login") == login]
    return next((e for e in own if e), None)


def analyze_pr(url: str, client: Client | None = None) -> dict:
    """Fetch a PR, compute its 28 features exactly as training did, and return them with metadata."""
    owner, repo, number = parse_pr_url(url)
    own = client is None
    c = client or Client()
    try:
        pr = c.get(f"/repos/{owner}/{repo}/pulls/{number}").json()
        files_json: list[dict] = []
        for page in range(1, MAX_FILE_PAGES + 1):
            batch = c.get(f"/repos/{owner}/{repo}/pulls/{number}/files", {"per_page": 100, "page": page}).json()
            files_json += batch
            if len(batch) < 100:
                break
        commits = c.get(f"/repos/{owner}/{repo}/pulls/{number}/commits", {"per_page": 100}).json()

        login = (pr.get("user") or {}).get("login")
        email = author_email(c, owner, repo, pr, commits, login)
        files = tuple(FileChange(path=f["filename"], additions=int(f.get("additions", 0)),
                                 deletions=int(f.get("deletions", 0)),
                                 status=_STATUS.get(f.get("status", "modified"), "modified"),
                                 old_path=f.get("previous_filename")) for f in files_json)
        merged_at = pr.get("merged_at")
        as_of = _ts(merged_at) if merged_at else int(time.time())
        title = pr.get("title", "")
        change = PRChange(title=title, authors=frozenset({email} if email else set()),
                          timestamp=as_of, files=files)
        history = GitHubHistory(c, owner, repo, pr["base"]["ref"], email)
        features = compute_features(change, history)

        warnings = []
        if len(files_json) >= MAX_FILE_PAGES * 100:
            warnings.append(f"Only the first {MAX_FILE_PAGES * 100} files were read (GitHub API limit).")
        if pr.get("base", {}).get("ref") != (pr.get("base", {}).get("repo") or {}).get("default_branch"):
            warnings.append("This PR does not target the default branch; history is read from its base branch.")
        if not files:
            warnings.append("The PR has no file changes.")
        top = sorted(files, key=lambda f: (-f.churn, f.path))[:3]
        return {
            "pr": {"repo": f"{owner}/{repo}", "number": number, "title": title, "author": login,
                   "state": "merged" if merged_at else pr.get("state"), "url": pr.get("html_url"),
                   "created_at": pr.get("created_at"), "merged_at": merged_at, "base": pr["base"]["ref"],
                   "scored_as_of": _iso(as_of)},
            "features": features,
            "context": {"top_files": [f.path for f in top], "subsystems": author_subsystems(change),
                        "history_files": history_files(change)},
            "github": {"requests": c.calls, "rate_remaining": c.rate_remaining, "authenticated": bool(c.token)},
            "warnings": warnings,
        }
    except httpx.HTTPError as exc:
        raise GitHubError(f"Could not reach GitHub: {exc}") from exc
    finally:
        if own:
            c.close()
