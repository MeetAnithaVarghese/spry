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

The system lives in:

```
lib/interpolate/
  partial.ts   – typed fragment definitions + injections
  unsafe.ts    – dynamic JS-powered interpolation engine (current)
  safe.ts      – restricted, non-JS interpreter (new, secure version)
  capture.ts   – output-capture layer feeding later interpolation
```

Use this subsystem when you need:

- Parameterized task bodies (`--interpolate` / `-I`)
- Reusable code snippets embedded in Markdown (`PARTIAL`)
- Automatic wrapping or decoration of generated text
- Deep interpolation with nested fragments
- The ability for later tasks to reference the _captured outputs_ of earlier
  tasks

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

---

# What “Interpolation” Means

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

---

# Module Overview

## `lib/interpolate/partial.ts` — Typed Content Fragments

`partial.ts` defines:

- `partialContent` – factory for reusable named fragments
- `PartialCollection` – registry for defining/lookup of partials
- Optional Zod validation on locals
- Injection rules (glob-based, prepend/append wrapping)

Key points for juniors:

1. Partials are small reusable templates.
2. They accept locals and can validate them.
3. They can wrap content automatically using `--inject`.
4. They are fully reusable and decoupled—they do not depend on any Spry runtime.

---

## `lib/interpolate/unsafe.ts` — Dynamic JS Evaluator (Older Engine)

This is Spry’s original interpolation engine.

Capabilities:

- Evaluates full JavaScript expressions inside `${ ... }`
- Allows nested fragment rendering via `await partial("name", locals)`
- Full variable and context binding
- Recursion protection
- Mutation reporting (`mutated/unmodified/error`)

Why “unsafe”?

- It executes dynamic JavaScript and must only run on trusted Markdown.

Why still used?

- Most Spry automation currently depends on its expressive power.
- The CLI (`run`, `task`) still defaults to it.

---

## `lib/interpolate/safe.ts` — Safer Restricted Engine (Past Tense)

The safe interpreter (from earlier internal branches) avoids dynamic JavaScript:

- `${var}` substitution only
- `${partial('name')}` fragment expansion
- No arbitrary expressions (`x + y`, `fn()`, etc.)
- Designed for regulated environments (HIPAA/SOC2/CMMC)

It was designed to match the `unsafe.ts` API so switching engines is seamless.

---

## `lib/interpolate/capture.ts` — Capturing Interpolated/Executed Output

This module completes the interpolation pipeline.

### What it does

`capture.ts` provides factories that:

- Decide **if** a task’s output should be captured,
- Decide **where** it should be captured:

  - to the filesystem, or
  - to an in-memory history map,
- Make captured output available to **later interpolations**.

### Why it's part of interpolation

Captured output becomes part of the interpolation context:

```ts
interpCtx: (() => ({ captured }));
```

This allows expressions like:

```bash
echo "Previous result: ${captured['step1'].text()}"
```

This closes the loop:

1. Interpolation → produces script
2. Execution → produces output
3. Capture → stores output
4. Interpolation (next task) → can read captured output

### Capture behaviors

- `typicalOnCapture` → write files or memory entries
- `gitignorableOnCapture` → write files **and** add ignore rules to `.gitignore`
- `captureFactory` → async version used in the runbook executor
- `captureFactorySync` → sync version for tests or simple flows

This is the “evidence collection layer” of Spry automation.

---

# How These Modules Work Together

Overall flow:

```
PARTIAL (Markdown)
     |
runbooksFromFiles()
     |
partialContent() → PartialCollection
     |
unsafeInterpolator / safeInterpolator
     |
interpolateUnsafely()
     |
execute task (shell, deno-task, sql, etc.)
     |
captureFactory() captures output → history
     |
next interpolation sees { captured }
```

### 1. Markdown defines partials

```bash PARTIAL footer { text: { type: "string" } }
echo "footer: ${text}"
```

### 2. `runbooksFromFiles` builds `PartialCollection<Locals>`

Extracts all partials with type schemas and injection metadata.

### 3. Interpolators call partials

Both engines do:

```ts
const frag = partials.get("footer");
const { content } = await frag.content(locals);
```

### 4. Interpolation inserts fragment results into task bodies

```bash
${await partial("footer", { text: "hello" })}
```

### 5. Execution runs the interpolated script

Shell/Deno/SQL/etc. produce outputs.

### 6. `captureFactory` stores the outputs

Into:

- files (`./results/xyz.out`)
- or memory (`captured["xyz"]`)

### 7. Later interpolations can reference earlier outputs

```bash
echo "Prev: ${captured["xyz"].text()}"
```

This is especially powerful for multi-step build pipelines, reproducible
workflows, and compliance evidence chains.

---

# Quick Mental Model

### partial.ts

Reusable, type-safe templates No JS execution Can wrap content based on globs

### unsafe.ts

Full-power JS evaluation Trusted-only Features full expressions and nested
interpolation

### safe.ts

Restricted, secure evaluator No dynamic JS Same fragment API

### capture.ts

Collects output of each step Feeds previous results back into interpolation
Supports evidence capture & chaining

---

# Summary

Spry Text Interpolation provides:

- **Fragments** (`partial.ts`)
- **Dynamic interpolation** (`unsafe.ts`)
- **Safe interpolation** (`safe.ts`)
- **Execution evidence capture** feeding back into interpolation (`capture.ts`)

Together they form a composable, type-safe, execution-time template system
designed for modern Markdown-runbook automation.
