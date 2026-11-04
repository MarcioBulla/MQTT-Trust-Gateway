## Automatic Help documentation for user-facing features

This repository has a reusable Codex subagent defined at `.codex/agents/help-ui.toml` named `help_ui`.

### Delegation rule for the primary agent

For **every new or materially changed user-facing feature**, automatically delegate the corresponding Help documentation work to the `help_ui` subagent **without waiting for a separate user request**. This includes new or changed dialogs, forms, settings, navigation pages, certificate operations, firmware flows, and user-visible behavior in backend features.

Follow this sequence:

1. Implement the feature and establish its actual behavior, UI labels, inputs/outputs, security implications, and limitations.
2. Once the implementation is stable enough to document, spawn/delegate to `help_ui` with the feature name, relevant files/routes, expected user workflow, and any known constraints. Do not ask the user to request Help separately.
3. Ask `help_ui` to update the shared Help topic registry/library, add or update the relevant contextual `(?)` preview with **Read more**, and write or revise the full Help article. Include diagrams and verified Linux/OpenSSL or Zephyr instructions only when relevant.
4. Coordinate edits: the primary agent and `help_ui` must not write to the same frontend files simultaneously. If necessary, complete or hand off ownership of shared files first.
5. Wait for the Help task, review the changes, and run the relevant frontend checks. Treat Help coverage as part of the feature's definition of done.
6. In the final feature report, mention the Help topic(s), contextual trigger(s), tests, and any unresolved documentation gaps.

### Scope and exceptions

- **Required:** any addition or change that affects an operator's workflow or understanding of the Gateway. Update existing articles for changed behavior; do not create duplicates.
- **Not needed:** pure internal refactors, formatting changes, test-only changes, or behavior-neutral dependency bumps. Document the exception briefly when ambiguity exists.
- The `help_ui` subagent **must not spawn another `help_ui`** or independently change PKI, MQTT, authorization, database, or other business logic.
- If subagents are unavailable, do not silently skip Help. Either implement the Help changes in the primary task or report clearly that the feature is not documentation-complete.
- Keep all Help UI labels, summaries, full articles, diagrams, commands, and code comments in English.
- Check claims against the implementation, and use the configured Zephyr MCP when Zephyr-specific guidance is needed. Never invent support or commands.

### Definition of done for a user-facing feature

A new feature is complete only when the feature behavior and its relevant Help content are aligned: a discoverable full Help article exists, the contextual `(?)` points to a brief summary and **Read more** link where appropriate, links resolve, themes/accessibility are preserved, and appropriate tests pass.

## Automatic README review after agent handoffs

A reusable `readme_maintainer` subagent is defined in `.codex/agents/readme-maintainer.toml`, using `gpt-6-luna` with medium reasoning effort.

After receiving implementation and Help completion summaries, the primary agent must delegate a README review to `readme_maintainer` before reporting the feature complete. Supply a consolidated handoff containing the task/branch, changed files, actual implemented behavior, user-visible workflows, validation results, limitations/pending work, and the Help summary. The reviewer reads those summaries, verifies relevant claims against the implementation, and decides whether README.md needs changes.

- Give the reviewer exclusive ownership of README.md for that review; serialize overlapping documentation edits.
- Include necessary README changes with the corresponding feature commit. The reviewer must not commit, push, tag, publish, or deploy.
- Move completed and verified capabilities from WIP to Features. For partial deliveries, describe the implemented portion and retain outstanding work in WIP.
- Pure internal, test-only, or behavior-neutral changes may receive a no-change decision. Record the reason rather than making cosmetic edits.
- The reviewer reports updated/no change, affected sections, verified claims, checks, and remaining gaps. The primary agent reviews that report before the final feature delivery.
- README-only maintenance and reviewer handoffs do not recursively trigger Help or another README review. Subagents must not dispatch this reviewer themselves.
- If delegation is unavailable, the primary agent performs and explicitly reports the same review.
