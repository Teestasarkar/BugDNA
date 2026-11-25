import { api } from "../lib/api";
import { pct } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { ErrorNote, Loading } from "../components/ui";

const GROUPS: Record<string, string> = {
  size: "Size",
  diffusion: "Diffusion",
  content: "What kind of files",
  purpose: "Purpose",
  history: "History of the touched files",
  experience: "Author experience",
};

export default function Methodology() {
  const m = useAsync(api.metrics, []);
  if (m.error) return <ErrorNote message={m.error} />;
  if (!m.data) return <Loading />;
  const d = m.data;
  const groups = Object.keys(GROUPS).map((g) => ({ g, items: d.feature_specs.filter((f) => f.group === g) }));

  return (
    <div className="prose">
      <div className="page-head">
        <h1>Methodology</h1>
        <p>How the data was collected, how "defect-causing" was decided, and what the numbers do and do not mean.</p>
      </div>

      <h2>1. Data</h2>
      <p>
        {d.dataset.repos} public GitHub repositories that merge pull requests by squashing, so every PR is exactly one
        commit on the default branch ("Title (#123)"). From each, the most recent 400 human-authored PRs that changed
        at least one source file and merged before the label cutoff: {d.dataset.prs.toLocaleString()} PRs in total.
        Bot PRs (Dependabot, Renovate, pre-commit and similar) and documentation-only PRs are excluded: they cannot be
        defect-inducing under the labelling below, and including them would inflate every metric with easy negatives.
      </p>

      <h2>2. Labels: SZZ</h2>
      <p>
        A PR is labelled <b>defect-inducing</b> when a later bug fix had to change lines it wrote. For every later commit
        whose title describes a defect fix, the deleted and modified source lines are run through{" "}
        <code>git blame -w</code> at the fix's parent, ignoring blank lines, comment-only lines and revisions listed in
        the repository's <code>.git-blame-ignore-revs</code>. Any PR blamed is labelled positive.
      </p>
      <p>
        PRs merged before the 2025-09-01 cutoff are labelled, and fixes are searched through each repository's latest
        commit at clone time (November 2026). Every labelled PR therefore had at least 13 months for its defects to be
        found, except in pydantic-core, whose development stopped in January 2026. {pct(d.dataset.defect_rate, 1)} of PRs are labelled
        defect-inducing.
      </p>
      <p><b>Known noise.</b> SZZ is the standard approach for this, and it is imperfect:</p>
      <ul>
        <li>Fixes that only add lines cannot be traced, so some defect-inducing PRs are labelled clean.</li>
        <li>A blamed line may have been correct when written and broken by something else.</li>
        <li>Fix detection reads titles. Fixes that don't say so are missed, and lint, typo, docs and test "fixes" are excluded by rule.</li>
        <li>Fixes touching more than 50 source files are skipped, because sweeping changes blame almost everything.</li>
      </ul>

      <h2>3. Features</h2>
      <p>
        28 features, all computable at merge time from the diff and the base branch's history before the PR. One Python
        function computes them for both training (from a git clone) and live scoring (from the GitHub API), which keeps
        training and serving consistent.
      </p>
      {groups.map(({ g, items }) => items.length > 0 && (
        <div key={g} style={{ marginBottom: 14 }}>
          <h3 style={{ margin: "14px 0 6px" }}>{GROUPS[g]}</h3>
          <ul>{items.map((f) => <li key={f.name}><b>{f.label}</b> (<code>{f.name}</code>): {f.description}</li>)}</ul>
        </div>
      ))}

      <h2>4. Evaluation</h2>
      <p>
        Each repository is split by merge date: oldest 60% train, next 20% validation, newest 20% test. The model is
        always tested on a repository's future, never its past. Hyperparameters (a grid of depth, minimum child weight
        and L2), early stopping and the decision threshold (maximum F1) were all chosen on validation. The test split
        was scored once.
      </p>
      <ul>
        <li>Test ROC-AUC <b>{d.test.roc_auc.toFixed(3)}</b>, PR-AUC <b>{d.test.pr_auc.toFixed(3)}</b> (base rate {d.test.base_rate.toFixed(3)}).</li>
        <li>At the validation-chosen threshold: precision <b>{pct(d.test.precision, 1)}</b>, recall <b>{pct(d.test.recall, 1)}</b>, flagging {pct(d.test.flagged_share)} of PRs.</li>
        <li>Lines-changed baseline ROC-AUC {d.baselines.size_only_roc_auc.toFixed(3)}; logistic regression {d.baselines.logistic_regression_roc_auc.toFixed(3)}.</li>
        <li>Leave-repositories-out (5 folds, grouped by repo): ROC-AUC {d.cross_project.roc_auc_mean.toFixed(3)} ± {d.cross_project.roc_auc_std.toFixed(3)}, which is the relevant number when scoring a repository outside the dataset.</li>
      </ul>

      <h2>5. Explanations and remediation</h2>
      <p>
        Every score is decomposed with exact TreeSHAP (XGBoost's built-in implementation; training checks it against
        the <code>shap</code> package{d.shap_max_abs_diff_vs_shap_package !== null && `, max difference ${d.shap_max_abs_diff_vs_shap_package.toExponential(1)}`}).
        The three features pushing risk up the most become the top risk factors. Each has a remediation rule that
        quotes the PR's own value against the dataset median. The rules are written by hand, not learned. They are
        advice attached to a measured signal.
      </p>

      <h2>6. Limits</h2>
      <ul>
        <li>The score estimates the chance a later fix will touch this PR's lines. It is not a judgement of code quality, and a low score is not a guarantee.</li>
        <li>Review activity (comments, approvals, CI results) is not used. Git history doesn't record it, and the live API scores PRs before review finishes.</li>
        <li>Live scoring reads at most the 10 largest pre-existing files' histories and identifies authors by GitHub login, whereas training used commit e-mail. Small differences from the offline features are possible.</li>
      </ul>
    </div>
  );
}
