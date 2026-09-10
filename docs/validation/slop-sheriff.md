# Slop Sheriff validation

## Accepted scope

Own the runtime review policy, rename the repository and public branding,
provide configurable cowboy voice and clean artwork, retain the core lanes,
add spec-testing, writing-quality and test-health specialists, and show each
finding's consequence in at most 300 characters with expandable full analysis.
No production deployment or paid review is included.

The comparison baseline is `b1e10994224000a79cae97cbc281193fd58dab13`.
The selected approach preserves Eve's authored workflow, native child sessions,
signed checkpoints, exact-head recovery and deterministic publication.

## Offline evidence

On 10 September 2026, with Bun 1.4.2, Eve 0.52.5 and AI SDK 7.0.97:

- `bun run check`: TypeScript, 265 tests, 32 native Eve runtime gates,
  discovery with no diagnostics, and production build passed.
- `bun run replay:pr61`: all four recorded finding transitions passed.
- Generated tool JSON Schema checks cover all finding categories, required
  bounded impact summaries, application-owned fields, path constraints,
  duplicate identities and specialist reports.
- The authenticated Convex memory HTTP path accepts all three new axes through
  the real internal action validators without model calls.
- A temporary mutation allowing 301-character impact summaries made three
  impact contract tests fail. The source was restored byte for byte before
  the completion gate.
- The native smoke test caught and now covers Eve's first-child timing:
  standing instructions resolve before the incoming routing message. Fixed
  child authority and an application-authored task policy cover that first
  turn; later turns use the bound role.
- A repeated smoke run exposed a fixture race in Eve's local `just-bash`
  metadata snapshot writes and concurrent reconnects. A native-backend
  regression reproduces the truncated-file failure; the fixture serializes
  only metadata lifecycle operations for the same sandbox. Review lanes and
  independent sandboxes remain concurrent; the Vercel backend is unchanged.

## Visible comments and artwork

The production presenter generated synthetic before/after examples, rendered
locally with Bun Markdown. The browser checks covered collapsed and expanded
impact, both voice settings, keyboard Enter toggling, all progress/failure
states, clean and changes-requested results, and a 390-pixel viewport with no
horizontal overflow. GitHub's own styling was not exercised by this local
render. No PR comment was posted as a test.

- [Before/after and status captures](slop-sheriff-comments.png)
- [Narrow-screen expanded impact](slop-sheriff-comments-mobile.png)

The brand image and avatar were visually inspected after removing grain,
book lettering and subtitles. The image tool does not report its model version.

## Bounded implementation review

Reviewed the complete branch and working-tree change against the accepted
scope, with reuse, claim/specification and engineering-quality coverage.
Discoverability was inactive because no public website or crawler behavior
changed. The review included config authority, old state and Check migration,
canonical identities, specialist scope, signed report assembly, Eve lifecycle,
comment escaping and the voice toggle. The Convex change only extends the
existing internal action's axis validator; storage and authorization stay on
the existing path.

The 90-day history inspection used file-level fallback for the large channel
and publication modules. Hotspots were the old standing instructions and
architecture document (19 touches each), GitHub channel (14 touches,
891 additions/110 deletions), and publication (12 touches, 1,643 additions/306
deletions). No additional architectural defect was established from churn.
The new design reuses the existing workflow and preserves migration identities.
Symbol history also covered `findingBody` (four touches, 35 additions/eight
deletions) and `fetchTrustedConfig` (one touch, 18 additions).

The review corrected the policy's location rule to allow base-side findings
for deleted files. No unresolved Blocking or Important implementation finding
remained. No Definition of Ready or Definition of Done exists in this checkout;
the declared repository gate and workflow checks were used.

## Measurement limits

The [policy inventory](slop-sheriff-policy-metrics.json) counts authored policy
text with `o200k_base`, including the first child task procedure. It excludes
framework/tool schemas, evidence, model history and provider cache effects.
This is a prompt-size comparison, not a latency, billed-token or cost benchmark.

The new lanes have deterministic routing and reporting coverage. Their
model-dependent finding quality, false positives, duplicate control and real
review completion remain unmeasured. A separately authorized real-model canary
must compare the same exact revisions and requirements, preserve canonical
finding and revalidation outcomes, and report phase latency, input/output
and cache tokens, and cost. Existing replay measurements describe recorded
production data, not observed performance of this new policy.
