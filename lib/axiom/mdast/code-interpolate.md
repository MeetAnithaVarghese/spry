# Spry Text Interpolation

> Fragments • Templates • Execution-Time Rendering

Spry Text Interpolation is the subsystem that transforms Markdown-embedded
runbooks into executable, fully rendered task scripts. It provides:

- Reusable fragments (“partials”) with optional type-checked locals and
  automatic wrapper/injection behavior.
- Template interpolation for inserting variables, expressions, and fragment
  output into task bodies.
- Safe and unsafe execution engines, allowing Spry to support both highly
  dynamic templates and strict, compliance-oriented workflows.

Use this subsystem when you need:

- Parameterized task bodies (`--interpolate` / `-I`)
- Reusable code snippets embedded in Markdown (`PARTIAL`)
- Automatic wrapping or decoration of generated text
- Deep interpolation with nested fragments
- The ability for later tasks to reference the _captured outputs_ ("memoized
  results") of earlier tasks

Spry’s runbook execution pipeline consumes this module to produce final scripts
ready for Bash, Deno, SQL engines, or custom execution strategies.

Together, these modules allow Spry to:

- Extract _PARTIAL_ fragments from Markdown runbooks,
- Apply type-checked locals,
- Wrap and compose fragments using glob-based injection,
- Interpolate variables, expressions, and nested fragments,
- Capture results into files or in-memory stores for **later interpolation**,
- Render final text before execution (`#!/usr/bin/env -S` scripts, shell, SQL,
  JSON, etc.).

## What “Interpolation” Means

Interpolation is the process of taking a string that contains expressions,
variables, and references to partial fragments, and producing a final string
where those elements are replaced by their results.

Example:

```text
"Hello ${name}! Today is ${ctx.date}"
```

After interpolation:

```text
"Hello Zoya! Today is 2025-12-01"
```

In Spry:

- Interpolation happens _right before_ a task is executed.
- Interpolation can access:

  - The task’s own locals
  - Global interpolation context (`ctx`)
  - Safe helpers (e.g., `safeJsonStringify`)
  - Partial fragments (`${await partial("my-fragment", { x: 1 })}`)
  - **Captured outputs** from earlier tasks (`captured["my-key"].text()`)

Think of interpolation as Spry’s execution-time template renderer, specifically
designed for Markdown-embedded automation.
