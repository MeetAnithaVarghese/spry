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
```

Use this subsystem when you need:

- Parameterized task bodies (`--interpolate` / `-I`)
- Reusable code snippets embedded in Markdown (`PARTIAL`)
- Automatic wrapping or decoration of generated text
- Deep interpolation with nested fragments

Spry’s runbook execution pipeline consumes this module to produce final scripts
that are ready to run through Bash, Deno, SQL engines, or custom execution
strategies.

Together, these modules allow Spry to:

- Extract _PARTIAL_ fragments from Markdown runbooks,
- Apply type-checked locals,
- Wrap and compose fragments using glob-based injection,
- Interpolate variables, expressions, and nested fragments inside tasks,
- Render the final text before execution (`#!/usr/bin/env -S` scripts, shell,
  SQL, JSON, etc.).

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

You can think of interpolation as Spry’s equivalent of “template rendering,” but
specifically designed for executable runbooks and Markdown-embedded automation.

# Module Overview

## `lib/interpolate/partial.ts`

### Reusable Typed Content Fragments

`partial.ts` defines:

- `partialContent` – a factory that creates a _partial fragment_, i.e. reusable
  named piece of text
- `PartialCollection` – a registry for creating, storing, and looking up
  partials
- Local-schema validation (Zod via JSON spec)
- “Injection” rules:

  - partials can automatically wrap other content
  - behavior controlled by glob patterns, prepend/append/both modes

### Tips

1. Partials are reusable building blocks:

   - Like small templates you can insert anywhere.
   - They can be nested (`partial` inside another `partial`).

2. Partials can validate inputs:

   - If the fragment expects `newLocal: string`, Spry can enforce it.

3. Partials can wrap content automatically:

   - With `--inject`, Spry finds all matching files/paths and wraps them.

4. `partial.ts` is standalone and reusable:

   - It doesn’t depend on any Spry runtime.
   - It belongs to the interpolation family but can be used in any subsystem.

## `lib/interpolate/unsafe.ts`

### Dynamic Template Evaluation (Older Engine)

This is Spry’s original interpolation engine. It provides:

- An async template interpreter that can evaluate full JavaScript expressions
  inside `${...}`
- Dynamic variable binding
- Execution of nested fragments via `partial("name", locals)`
- Recursion-safe interpolation for deep fragment chains
- Detailed status reporting (mutated/unmodified/error)

Example template:

```text
"Task output: ${ctx.value * 3}, user=${user}, now=${new Date().toISOString()}"
```

### Why it is “unsafe”

Because it essentially compiles:

```js
return ${expr};
```

in a dynamic `AsyncFunction`, meaning:

- It can run arbitrary JavaScript
- It must only be used on trusted Markdown / trusted runbook content

### Why it still exists

- Spry runbooks often contain real code (shell, SQL, JS) that needs powerful
  interpolation.
- Many features (partial fragments, helpers, nested interpolation) were
  originally implemented here.
- Existing runbooks and users depend on its expressive power.

This module is the engine used today by the CLI (`task`, `run`) until the safe
interpreter fully replaces it.

## `lib/interpolate/safe.ts`

### The New Safer Interpolator (Past Tense in This Document)

The new safe interpreter—already implemented in earlier internal branches—is
designed to:

- Avoid dynamic JS evaluation
- Provide only authorized operations
- Support variable substitution without executing arbitrary expressions
- Preserve the same partial-fragment API as `unsafe.ts`
- Work well in compliance, reproducible automation, and locked-down environments

Feature set included:

- `${var}` substitution
- `${partial('name')}` fragment insertion
- No `${x + y}`, no function calls, no JS runtime

It was intended for environments where Spry is running automation for regulated
workloads (HIPAA, SOC2, CMMC, RWD/RWE pipelines, etc.).

Although it is not yet rolled out in Spry mainline, the design and API remain
aligned with the current `partial.ts` so that switching engines is seamless.

# How These Three Modules Work Together

Here is the mental model:

```
PARTIAL (Markdown)
     |
runbooksFromFiles()
     |
partialContent() → PartialCollection
     |
     V
unsafeInterpolator / safeInterpolator
     |
interpolateUnsafely()
     |
task.value before execution
```

### 1. Markdown defines partials

Developers write:

```bash PARTIAL footer { text: { type: "string" } }
echo "footer: ${text}"
```

### 2. `runbooksFromFiles` turns them into PartialContent objects

The parser converts Markdown into:

- `RunnableTask` objects
- A `PartialCollection<FragmentLocals>` built by `partial.ts`

### 3. Interpolators consume partials

Both engines — `unsafe.ts` and `safe.ts` — call:

```ts
partials.get(name);
```

and then:

```ts
partial.content(locals);
```

which returns:

- `content: string`
- `interpolate: boolean`
- `locals` (possibly updated)

### 4. Interpolators insert fragment output into templates

Example:

```bash
echo "Output: ${await partial("footer", { text: "hello"})}"
```

### 5. Interpolation produces the final text to execute

And then Spry runs that text through the shell, SQL engine, or other execution
strategies.

# Quick Mental Model

### partial.ts

- Think of partials as _tiny reusable templates_
- They can validate locals
- They can automatically wrap other content
- They do NOT run JavaScript
- They are safe and type-checked

### unsafe.ts

- Think of this as a _powerful but sharp_ tool
- Can run arbitrary JS expressions
- Should be used only for trusted runbooks
- Currently powers `--interpolate`

### safe.ts

- Think of this as the _secure engine_
- No dynamic JS
- Good for regulated environments
- Same API as `unsafe.ts` but without code execution

# Summary

Spry Text Interpolation provides:

- Fragments (`partial.ts`)
- Powerful dynamic interpolation (`unsafe.ts`)
- Safer restricted interpolation (`safe.ts`)

Everything is designed so the developer can choose between expressiveness
(`unsafe.ts`) and safety (`safe.ts`), while keeping the same fragment and
template interface (`partial.ts`).
