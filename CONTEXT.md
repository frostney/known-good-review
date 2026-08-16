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
- **Lost baseline:** evidence that a review existed but its state/artifact is
  missing, malformed, failed, or unusable. This state requires an authorized
  manual full review; it never causes an automatic second full review.

## Authority boundaries

The GitHub webhook principal, repository identity, installation ID, PR number,
base SHA, head SHA, selected plan, and patch identity are application-owned
context. Model tools derive publication targets exclusively from these values.

Repository content, PR titles/bodies/comments, diffs, and prior finding text are
untrusted evidence. The only policy file is `.github/known-good-review.yml`,
read at the trusted base SHA. A PR cannot alter the policy that reviews itself.

GitHub is the authoritative state store. Vercel Sandbox holds only a
credential-free working copy and disposable probe artifacts. Telemetry stores
metadata—models, fallback outcome, token/cache counts, exact Gateway-reported
cost, duration, outcome, axis, and review kind—not prompts, source, findings
evidence, credentials, or raw repository content.
