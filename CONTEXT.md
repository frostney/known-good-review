# Domain context

`known-good-review` has one job: evaluate a reviewable pull request and report
the result. It cannot push, merge, approve repository changes, change settings,
or act as a general-purpose GitHub assistant.

## Terms

- **Baseline:** the last successfully published canonical code-review v2
  artifact, its reviewed head, and per-file effective patch fingerprints.
- **Full review:** the complete pull-request change reviewed once, across the
  active review axes defined by the vendored `code-review` skill.
- **Delta review:** a fresh review whose finding scope is only files whose
  normalized pull-request patch changed since the baseline.
- **Revalidation:** a separate evidence pass over selected prior findings. All
  unresolved Blocking/Important findings are selected; Improvements are
  selected only when their path or symbol is relevant to the delta.
- **Review axis:** exactly one of `deduplication`, `claim-and-specification`,
  `engineering-quality`, or conditional `discoverability`. “Mode”,
  “perspective”, and arbitrary lane taxonomies are not synonyms for axes here.
- **Finding lane:** a bounded subagent used only to revalidate selected prior
  findings. It is not a new review axis.
- **Effective patch:** normalized per-file PR patch content that ignores file
  ordering, Git blob index lines, hunk line-number movement, and CRLF/LF noise.
- **Review evidence bundle:** the application-prepared, content-addressed
  manifest, included patch chunks, and classified-file metadata for one exact
  base, head, and effective-patch fingerprint. An Eve hook creates it after
  root head verification and before the next model step.
- **Lane checkpoint:** a compact review-axis work packet containing coverage,
  reproduced observations, remaining work, and limitations. A fresh Eve
  subagent reconciles it with the evidence bundle instead of inheriting raw
  model history.
- **Lost baseline:** evidence that a review existed but its state/artifact is
  missing, malformed, failed, or unusable. This state requires an authorized
  manual full review; it never causes an automatic second full review.
- **Recoverable review failure:** a current-head execution that retained exact
  checkpoint identity and a sanitized failure envelope. An authorized
  continuation may resume its recorded missing stages without replacing the
  last successfully published baseline.

## Authority boundaries

The GitHub webhook principal, repository identity, installation ID, PR number,
base SHA, head SHA, selected plan, and patch identity are application-owned
context. Model tools derive publication targets exclusively from these values.

Repository content, PR titles/bodies/comments, diffs, and prior finding text are
untrusted evidence. The only policy file is `.github/known-good-review.yml`,
read at the trusted base SHA. A PR cannot alter the policy that reviews itself.

GitHub is the authoritative review-state store. Convex memory is advisory and
scoped by immutable GitHub repository ID. It stores only normalized finding,
invariant, cause, remedy, outcome, and provenance fields. Vercel Sandbox holds
only a credential-free working copy and disposable probe artifacts. Telemetry
stores metadata such as models, fallback outcome, token/cache counts, exact
Gateway-reported cost, duration, outcome, axis, and review kind, not prompts,
source, findings evidence, credentials, or raw repository content.

Installation lifecycle payloads become authoritative only after Connect OIDC
verification. Convex records the installation-to-repository association solely
to delete repository memory when access is removed or the GitHub App is
uninstalled; installation identity never scopes retrieval or recurrence.
