# Domain docs

This is a single-context repository. Before exploring or changing domain behavior, read the root `CONTEXT.md` and any relevant decisions in `docs/adr/`.

Use the glossary's terms consistently in code, tests, issues and explanations. Reports are submitted records that authorized Supervisors may correct directly. They have no review/resolution process; historical workflow data is retained. Keep this separate from retained Daywork and legacy approval decisions.

If an optional context map or ADR directory is absent, proceed without creating it merely for setup. New architecture decisions can be recorded under `docs/adr/` when the work establishes one. If a future `CONTEXT-MAP.md` appears, follow it to the relevant context documents as well.

Flag a conflict with an existing ADR explicitly instead of silently overriding it. If a needed domain concept is missing, note the gap rather than inventing a conflicting synonym.
