# Dependency upgrade, 10 September 2026

The upgrade starts at fetched `origin/main` commit
`11bfa50636b5aa69278af3a6806cfd384241fcc1`, which includes PRs 35 and 36.
Versions were checked against npm metadata and official release notes on
10 September 2026. All direct dependencies remain exactly pinned.

## Version audit

| Dependency | Previous | Selected |
| --- | --- | --- |
| `@ai-sdk/gateway` | 4.0.64 | 4.0.78 |
| `@chat-adapter/github` | 4.38.1 | 4.40.0 |
| `@convex-dev/rag` | 0.7.6 | 0.7.6 |
| `@octokit/rest` | 22.0.1 | 22.0.1 |
| `@opentelemetry/api` | 1.9.1 | 1.9.1 |
| `@vercel/connect` | 1.0.0 | 2.0.4 |
| `@vercel/sandbox` | 3.1.0 | 3.2.2 |
| `ai` | 7.0.79 | 7.0.97 |
| `chat` | 4.38.1 | 4.40.0 |
| `convex` | 1.45.0 | 1.45.0 |
| `eve` | 0.45.0 | 0.52.5 |
| `js-tiktoken` | 1.0.21 | 1.0.21 |
| `workflow` | 5.0.0-beta.42 | 5.0.0-beta.50 |
| `yaml` | 2.9.0 | 2.9.0 |
| `zod` | 4.4.3 | 4.6.1 |
| `@types/bun` | 1.3.14 | 1.4.2 |
| `@types/node` | 24.13.3 | 24.13.4 |
| `convex-test` | 0.0.56 | 0.0.57 |
| `just-bash` | 3.1.0 | 3.4.2 |
| `typescript` | 7.0.2 | 7.0.2 |
| `bun` | 1.3.14 | 1.4.2 |

## Compatibility decisions

- Keep Node `24.x`, the newest Node major supported by the Vercel deployment target and the minimum major required by Eve. `@types/node` advances to the newest 24.x release rather than following npm's `latest` tag, which currently points at 22.x.
- Keep Workflow on its existing v5 prerelease line, advancing the exact pin to `5.0.0-beta.50`. Stable `4.8.8` does not satisfy Chat 4.40.0's `^5.0.0-beta.35` peer contract. Eve also bundles the v5 runtime. Returning to v4 would require a coordinated framework downgrade; reverting this change restores the previous beta.42 application pin.
- Keep the `ai` override synchronized at `7.0.97`. The lockfile resolves one AI SDK and Gateway version; Eve's `^7.0.82`, RAG's `^7.0.0`, and Chat's v7 peer ranges accept it.
- Refresh transitive resolutions with `bun update` within their package-owned ranges. This advances the RAG workpool/batch-worker and Convex helpers, Octokit, AWS/Smithy, and build dependencies. Preserve Eve's exact Nitro `3.0.260903-beta` and Undici `8.9.0` pins. Do not override framework-owned prereleases or force transitive packages across incompatible ranges.
- Convex, RAG, Octokit REST, OpenTelemetry API, js-tiktoken, YAML, and TypeScript already have their newest stable direct versions. No Convex schema or generated binding changes are required.
- The pinned checkout v7.0.1, setup-node v7.0.0, and setup-bun v2 action revisions are current. Add Bun 1.4.2 to CI while retaining the existing Bun 1.3.14 and 1.4.0 compatibility jobs. Keep lockfile format 1 so those existing runtimes can consume it.

## Migrations

Eve moves the internal subagent adapter and run-input builder into `subagents/` and requires an explicit `selfAgent` discriminator. The installed-boundary routing tests now use those paths and identify the root-copy call explicitly. Their lane, fallback, forged-envelope, compaction, and durable-hydration assertions remain intact.

Eve 0.52.5 declares `AlsContext.localDevRequest` as optional, but its concrete getter can return `undefined`. A shared test-only type view omits that unused property to accommodate `exactOptionalPropertyTypes`. It retains Eve's actual container, AsyncLocalStorage and serializer at runtime; no type assertion, compiler relaxation, mock serializer, or dependency patch is needed.

Eve now identifies projects through an `eve` dependency in the nearest package manifest. The smoke fixture declares the same Eve pin as the root and continues resolving the root installation. Its eval consumes background completion turns through the official client. A working delegation receipt cannot satisfy completion: the test attaches to the actual child session, checks its tool execution and result, and checks that the completion notification precedes the parent's final response.

Connect 2 makes automatic connector provisioning opt-in. This application uses existing connector credentials, installation-scoped tokens and explicit bot identity, not provisioning. The installed `connectGitHubCredentials`, `connectGitHubAdapter`, and `getToken` source and declarations preserve those call signatures. No provisioning or credential setup is added.

AI SDK/Gateway patch changes include tool-choice enforcement, persisted tool validation, error normalization and provider metadata fixes. Zod changes include schema conversion and parsing fixes. The generated provider-facing schema and downstream assembly tests exercise the upgraded implementations.

## Validation

The full `bun run check` gate passes locally on Bun 1.3.14, 1.4.0 and 1.4.2 with Node 24.18.0, and on Bun 1.4.2 with Node 24.21.0. Each run passes 207 tests / 934 assertions, eight runtime smoke gates, TypeScript, zero Eve discovery errors/warnings and the production build. `bun run replay:pr61` preserves all four recorded finding transitions on all three Bun versions. Frozen installation also passes. Exact-head CI and the final review are recorded in the pull request. The deterministic tests establish offline contracts and runtime execution, not model finding quality. No paid model review, manual deployment, merge, or credential creation is part of this upgrade.

Before upgrading, the full gate passed with 207 tests / 934 assertions and five runtime smoke gates. The upgraded smoke has eight gates. A temporary counterfactual that returned the child completion marker without executing its tool failed specifically at `calledTool(fixture_step)`; the fixture was restored byte-for-byte.

Existing local fixture Workflow data from Eve 0.45.0 produced corrupted-event-log diagnostics while resuming abandoned runs during development. It was retained separately under ignored `.agent/` and the test was repeated with fresh local state. This does not establish compatibility of live, in-flight framework workflows; the existing deployment drain/migration procedure still applies. Application-owned route hydration, recovery, revocation, and memory behavior remain covered offline.

## Sources

- [Eve 0.52.5 release](https://github.com/vercel/eve/releases/tag/eve%400.52.5) and the installed `eve/CHANGELOG.md`, state, subagent, sandbox, instrumentation, hooks, eval, workflow and project-layout guides.
- [AI SDK releases](https://github.com/vercel/ai/releases), installed AI SDK/Gateway changelogs, mock-provider documentation, declarations, schema conversion and transport source.
- [Connect changelog](https://github.com/vercel/vercel/blob/main/packages/connect/CHANGELOG.md) and the installed 2.0.4 credential-helper and token implementations.
- [Chat 4.40.0](https://github.com/vercel/chat/releases/tag/chat%404.40.0), [Sandbox 3.2.2](https://github.com/vercel/sandbox/releases/tag/%40vercel%2Fsandbox%403.2.2), [Zod 4.6.1](https://github.com/colinhacks/zod/releases/tag/v4.6.1), [just-bash 3.4.2](https://github.com/vercel-labs/just-bash/releases/tag/just-bash%403.4.2).
- [Workflow beta.50](https://github.com/vercel/workflow/releases/tag/workflow%405.0.0-beta.50), [convex-test changes](https://github.com/get-convex/convex-test/compare/v0.0.56...v0.0.57).
- [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [Bun 1.4.2](https://bun.sh/blog/bun-v1.4.2), and npm registry metadata for every package above.
