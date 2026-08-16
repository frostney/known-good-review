# Skill provenance

All project and runtime skills were installed with the owner-maintained Skills
CLI (`skills` 1.5.22). No skill directory was populated with an ad-hoc file copy.
`skills-lock.json` records hashes computed with the CLI's content-hash algorithm.

## known-good-route

- Source: `https://github.com/frostney/known-good-route`
- Handoff revision: `8cc9ce28814f26e4bc56680bb284ef2ac307739a`
- Fetched main used for hardening: `2664e3045f6bf5674b5464ccd5fcf260f5baf03d`
- Source pull request: `https://github.com/frostney/known-good-route/pull/38`
- Consumed merged revision: `e3aad669dc127e5af6b1fea1ccccf0cc70b0e093`
- Commit subject: `feat(code-review): define review axes and v2 findings (#38)`
- Latest checked main revision: `0b54d8adb0b2a827120a954d5905827e51d3236b`

The local commit clarifies fresh review, targeted revalidation, and combined
operations; names review axes consistently; requires one lane per active axis;
uses all-candidate collection before coordinator filtering; and upgrades both
`code-review` and `codebase-audit` findings JSON to schema version 2 with no v1
reader or migration.

The complete `code-review` skill, including all four references, is installed
into `agent/skills/code-review` for Eve. The Skills CLI normalizes its
frontmatter for Eve; its procedure and references come from the same current
known-good-route source as the development copy. The applicable project-local
suite under `.agents/skills` now also includes `agent-writing` and
`typescript-stack`. The catalog's Convex, React, and FreePascal stack skills are
not installed because they do not apply to this repository. `skills-lock.json`
records `frostney/known-good-route` as the source and the Skills CLI content hash
for every installed skill; this repository does not author those skills.

## mattpocock/skills

- Source: `https://github.com/mattpocock/skills`
- Revision fetched at install time: `068b6e0c62393147daf03530149cdce209c93da8`
- Installed project skills: `grilling`, `grill-with-docs`, `domain-modeling`

These were fetched from the current upstream repository by the Skills CLI, not
copied from a global Claude/Codex installation. `run-retro` and the other
development workflow skills are project-local known-good-route installs.

The upstream `grill-with-docs` frontmatter contains the Claude-specific
`disable-model-invocation` key. The current Agent Skills validator rejects that
non-standard key, so the project-local copy removes only that key; its skill
body remains the fetched revision above and it is still invoked explicitly by
the workflow skills.
