---
name: agent-writing
description: >-
  Applies the user's ambient writing rules to agent-authored chat, status,
  review, issue, pull-request, and retrospective prose. Use whenever an agent
  communicates progress, decisions, findings, or outcomes to a person.
license: Unlicense OR MIT
---

# Agent writing

Write outcome-first, complete sentences. Keep each logical item focused on one
claim, decision, finding, or action and target about 300 characters. An issue or
other structured artifact may contain many such items.

- Never use an em dash.
- Never use the standalone words `seam`, `seams`, `honest`, `honestly`,
  `substrate`, or `substrates`, case-insensitively.
- Preserve quoted source, code, commands, identifiers, and required external
  text exactly.
- Omit filler, repeated summaries, self-congratulation, and routine tool
  narration.
- Keep each review reply and each retrospective impact item at 300 characters
  or fewer.

Before handoff, run `python3 agent-writing/scripts/check_prose.py` from this
suite's repository root when editing its Markdown.
