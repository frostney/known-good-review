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
| `workflow` | 5.0.0-beta.42 | Removed; Eve owns the runtime |
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
- Remove the separately installed Workflow SDK. Eve 0.52.5 bundles and resolves its own runtime and exposes `eve/workflow-modules` for TypeScript. Chat's Workflow peer is optional; this application does not import `chat/workflow`. A clean frozen installation and compiled durable-child smoke verify that no leftover application SDK is needed.
- Keep the `ai` override synchronized at `7.0.97`. The lockfile resolves one AI SDK and Gateway version; Eve's `^7.0.82`, RAG's `^7.0.0`, and Chat's v7 peer ranges accept it.
- Refresh transitive resolutions with `bun update` within their package-owned ranges. This advances the RAG workpool/batch-worker and Convex helpers, Octokit, AWS/Smithy, and build dependencies. Preserve Eve's exact Nitro `3.0.260903-beta` and Undici `8.9.0` pins. Do not override framework-owned prereleases or force transitive packages across incompatible ranges.
- Convex, RAG, Octokit REST, OpenTelemetry API, js-tiktoken, YAML, and TypeScript already have their newest stable direct versions. No Convex schema or generated binding changes are required.
- Support only the latest stable Bun, currently 1.4.2. The single `Bun latest` CI job reads `packageManager` from `package.json`; updating that pin updates local requirements and CI together. The pinned checkout v7.0.1, setup-node v7.0.0, and setup-bun v2 action revisions are current.

## Migrations

Eve moves the internal subagent adapter and run-input builder into `subagents/` and requires an explicit `selfAgent` discriminator. The installed-boundary routing tests now use those paths and identify the root-copy call explicitly. Their lane, fallback, forged-envelope, compaction, and durable-hydration assertions remain intact.

Eve 0.52.5 declares `AlsContext.localDevRequest` as optional, but its concrete getter can return `undefined`. A shared test-only type view omits that unused property to accommodate `exactOptionalPropertyTypes`. It retains Eve's actual container, AsyncLocalStorage and serializer at runtime; no type assertion, compiler relaxation, mock serializer, or dependency patch is needed.

Eve now identifies projects through an `eve` dependency in the nearest package manifest. The smoke fixture declares the same Eve pin as the root and continues resolving the root installation. Its eval consumes background completion turns through the official client. A working delegation receipt cannot satisfy completion: the test attaches to the actual child session, checks its tool execution and result, and checks that the completion notification precedes the parent's final response.

Connect 2 makes automatic connector provisioning opt-in. This application uses existing connector credentials, installation-scoped tokens and explicit bot identity, not provisioning. The installed `connectGitHubCredentials`, `connectGitHubAdapter`, and `getToken` source and declarations preserve those call signatures. No provisioning or credential setup is added.

## Current API adoption

| Surface | Adopted pattern or verified reason to retain |
| --- | --- |
| Eve Workflow | Remove the independent SDK and use Eve's bundled runtime and ambient module types. Extend the same offline runtime smoke with `defineWorkflowTool`, `ctx.agent`, and a stable invocation key. Verify the waiting tool returns the actual child's final result before the parent continues. |
| Review orchestration | Keep the framework `experimental_workflow` tool: this app needs model-authored, conditional lane/scout continuations in one isolated program. Authored `defineWorkflowTool` is a different surface, not its replacement. Framework sandbox calls manage their own invocation IDs; explicit keys belong to `ctx.agent`. |
| Sandbox | Remove the Eve 0.38 ownership bootstrap and custom revalidation key. The versioned Eve image creates `/workspace`, assigns it to `vercel-sandbox`, and selects that user. Current backends use version-matched images and Eve invalidates templates from the authored definition. Preserve GitHub-only policies and the offline Docker fallback. Delete the three tests that only exercised the removed shell workaround. |
| Zod | Replace chained object strictness/passthrough and string URL/datetime methods with `z.strictObject`, `z.looseObject`, `z.url`, and `z.iso.datetime`. Extended strict objects inherit their policy. Keep refinements and every finding variant, path restriction, unknown-field policy and application-owned field. |
| AI SDK / Gateway / RAG | Use `gateway.embeddingModel` in both production embedding paths and real RAG component tests, replacing the deprecated alias. Retain RAG's current `textEmbeddingModel` constructor option and dimension checks. Existing SDK mocks, provider JSON Schema conversion and raw HTTP normalization remain the current official interfaces. |
| Gateway catalog and telemetry | Retain the public model catalog fetch: `getAvailableModels` does not expose the `tool-use` tags required for admission. Retain the bounded custom fetch for `getGenerationInfo`: its installed parameter type accepts only `id`, with no per-call signal. Retain native generation lookup and error classes. |
| Eve telemetry and routing | Keep the supported default `defineInstrumentation` events and durable `defineState` route. Instrumentation providers are explicitly experimental and do not supersede the default API. Preserve input/output redaction, durable telemetry identity, cache-inclusive usage and recovery. Recheck the compaction-budget comment against the current implementation. |
| Connect / Chat / Octokit | Existing credential and adapter APIs are current. Keep explicit installation scope, bot identity, bounded pagination and timeout handling. Connect 2's opt-in provisioning is unnecessary for existing connectors. |
| Convex / RAG | Existing validators, indexes, action boundaries, component usage and deletion/re-embedding flows use current APIs. Preserve admission and revocation behavior; no schema or generated binding change. |
| Remaining libraries | OpenTelemetry API, js-tiktoken, YAML and TypeScript use their current supported APIs. Bun's native test runner and just-bash's Eve backend remain the official deterministic test surfaces. No competing wrappers or speculative experimental migrations are added. |


## Validation

The final clean-install `bun run check` gate uses Bun 1.4.2 and Node 24.21.0. It covers 204 tests / 926 assertions, 14 runtime smoke gates, TypeScript, Eve discovery and the production build. `bun run replay:pr61` preserves all four recorded finding transitions. Before/after AI SDK conversion of 26 exported schemas produces byte-for-byte identical JSON Schema; existing rejection and report-assembly tests also pass. Exact-head CI and final review are recorded in the pull request.

The runtime smoke covers both background receipts and waiting authored workflows through real HTTP sessions and production instrumentation, with official deterministic models. A clean frozen installation contains no standalone `workflow` package. The three removed unit tests checked only the deleted ownership workaround; behavioral contract coverage remains. The earlier counterfactual that bypassed a child tool failed its execution assertion.

These checks establish offline contracts and runtime execution, not model finding quality or hosted sandbox execution. The ownership removal is verified against the versioned upstream Dockerfile and installed backend source. No paid model review, manual deployment, merge, or credential creation is part of this upgrade.

Existing local fixture Workflow data from Eve 0.45.0 produced corrupted-event-log diagnostics while resuming abandoned runs during development. It was retained separately under ignored `.agent/` and the test was repeated with fresh local state. This does not establish compatibility of live, in-flight framework workflows; the existing deployment drain/migration procedure still applies. Application-owned route hydration, recovery, revocation, and memory behavior remain covered offline.

## Sources

- [Eve 0.52.5 release](https://github.com/vercel/eve/releases/tag/eve%400.52.5) and the installed `eve/CHANGELOG.md`, state, subagent, sandbox, instrumentation, hooks, eval, workflow and project-layout guides.
- [AI SDK releases](https://github.com/vercel/ai/releases), installed AI SDK/Gateway changelogs, mock-provider documentation, declarations, schema conversion and transport source.
- [Connect changelog](https://github.com/vercel/vercel/blob/main/packages/connect/CHANGELOG.md) and the installed 2.0.4 credential-helper and token implementations.
- [Chat 4.40.0](https://github.com/vercel/chat/releases/tag/chat%404.40.0), [Sandbox 3.2.2](https://github.com/vercel/sandbox/releases/tag/%40vercel%2Fsandbox%403.2.2), [Zod 4.6.1](https://github.com/colinhacks/zod/releases/tag/v4.6.1), [just-bash 3.4.2](https://github.com/vercel-labs/just-bash/releases/tag/just-bash%403.4.2).
- [Eve versioned sandbox Dockerfile](https://github.com/vercel/eve/blob/eve%400.52.5/packages/eve/Dockerfile), [convex-test changes](https://github.com/get-convex/convex-test/compare/v0.0.56...v0.0.57).
- [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [Bun 1.4.2](https://bun.sh/blog/bun-v1.4.2), and npm registry metadata for every package above.
