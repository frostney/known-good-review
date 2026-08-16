---
name: typescript-stack
description: >-
  Applies strict, runtime-aligned TypeScript conventions for compiler setup,
  types, modules, APIs, tests, and validation without imposing a frontend
  framework. Use when scaffolding, configuring, writing, reviewing, or
  upgrading TypeScript in web, service, CLI, library, or tooling projects.
license: Unlicense OR MIT
compatibility: >-
  Requires a TypeScript compiler and the runtime or bundler selected by the
  project.
---

# TypeScript stack

Preserve valid project and framework conventions. Apply this skill to the
language layer; let framework skills own routing, rendering, deployment, and
framework-required file shapes, and let `project-structure` own
language-neutral repository policy.

## Compiler and runtime

- Verify the current stable TypeScript version and runtime compatibility from
  primary sources before adding or upgrading the compiler. Pin the selected
  version in the project lockfile.
- Start from the runtime or framework's maintained `tsconfig` base when one
  exists. Otherwise enable `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, and
  `useUnknownInCatchVariables`.
- Align `target`, `lib`, module format, module resolution, emitted extensions,
  and ambient types with the actual runtime and deployment target. Do not make
  bundler, Node, Bun, or browser assumptions that the project does not satisfy.
- Use `noEmit` when another tool owns output. When TypeScript emits production
  code, validate the emitted artifact on the target runtime as well as running
  the typecheck.

## Types and APIs

- Do not use `any`. Accept `unknown` at untrusted boundaries, validate or narrow
  it once, and keep the validated type downstream.
- Prefer inference inside an implementation and explicit types at public,
  serialized, asynchronous, and dependency boundaries.
- Model variant state with discriminated unions and exhaustively handle it.
  Avoid boolean combinations that admit invalid states.
- Use full, domain-specific names. Avoid catch-all `utils`, `helpers`, or `lib`
  modules.
- Avoid non-null assertions and type assertions. When an external invariant
  requires one, keep it at the boundary and explain the invariant locally.
- Use `@ts-expect-error` only for an intentional, described type-level test.
  Never use `@ts-ignore` to make the project gate pass.

## Modules and validation

- Follow the runtime, framework, and project's established module boundaries and
  public API layout. Keep dependency direction visible and avoid cycles.
- Test observable runtime behavior and type contracts that can regress. Keep
  compile-time fixtures separate from runtime assertions.
- Run focused tests, the repository gate, and TypeScript with no emit. If the
  compiler owns production emission, validate the emitted output on its target
  runtime instead.
