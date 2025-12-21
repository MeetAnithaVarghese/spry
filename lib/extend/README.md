# Spry Hooks, Plugins, and Extensions

This module provides a **minimal, runtime-safe extension system** for Spry. It
is built around two cooperating pieces:

- `hook.ts` — defining, validating, discovering, and executing hooks
- `extension.ts` — importing extension modules and discovering hook
  implementations

The design deliberately avoids decorators, frameworks, AST scanning, or global
registries. Everything is explicit, inspectable, and testable.

Use `lib/extend` when you need:

- Plugin systems
- Extension points
- Safe third-party code execution
- Structured observability
- Zero framework lock-in

At the highest level:

1. **The host defines hook contracts** (using `hookDefn`)
2. **Extensions implement hooks** (using `hook` or `hook.async`)
3. **The host loads extensions** (using `ExtensionHandle`)
4. **Hooks are discovered, validated, and optionally executed**

Hooks are just **typed functions with metadata**, and extensions are just
**modules**.

## The Simplest Possible Hook

### Defining a Hook

A hook definition is a **contract**: an ID plus a Zod function signature.

```ts
import * as z from "@zod/zod";
import { hookDefn } from "./hook.ts";

export const add = hookDefn(
  "spry.math.add",
  { input: [z.number(), z.number()], output: z.number() },
);
```

This defines:

- A unique hook ID (`spry.math.add`)
- A runtime-validated function shape
- An isolated issue sink owned by the hook

No implementations yet. Just a contract.

### Implementing the Hook (in an Extension)

An extension author implements the hook with **no generics and no types**.

```ts
import { hook } from "./hook.ts";
import { add } from "./hook_defs.ts";

export const addImpl = hook(add, (a, b) => a + b);
```

What happens automatically:

- Input/output validated via Zod
- Errors are captured into the hook’s IssueSink
- Metadata is attached using a non-enumerable symbol

The result is a **HookImpl function**, safe to scan reflectively.

### Discovering and Running the Hook

```ts
const mod = await import("./my-extension.ts");

const res = await add.collect(mod, {
  run: { args: [2, 3] },
});

res.executed?.[0].value; // 5
```

At this level, you already have:

- Safe discovery
- Safe execution
- Structured results
- Zero framework assumptions

## Hooks with Context Objects

Hooks often take a **single context object** instead of positional args.

```ts
const CtxSchema = z.object({
  file: z.string(),
});

export const onLoaded = hookDefn(
  "spry.playbook.onLoaded",
  { input: [CtxSchema], output: z.void() },
);
```

Implementation:

```ts
export const onLoadedImpl = hook(onLoaded, (ctx) => {
  console.log("Loaded", ctx.file);
});
```

This pattern scales naturally as more capabilities are added.

## Issues — Structured Error Reporting

Hooks can optionally accept an **IssueSink**.

```ts
import { IssueSinkSchema } from "./hook.ts";

const CtxSchema = z.object({
  file: z.string(),
  issues: IssueSinkSchema.optional(),
});
```

At runtime, the host can inject issues automatically:

```ts
await onLoaded.collect(mod, {
  run: {
    args: [{ file: "a.md" }],
    injectIssuesIntoFirstArg: true,
  },
});
```

Inside the implementation:

```ts
ctx.issues?.info("FILE_LOADED", `Loaded ${ctx.file}`);
```

Key properties:

- Each hook owns its own issue store
- Issues are timestamped and structured
- Zod validation errors are captured with detail

This makes hooks **observable without throwing**.

## Event Bus — Typed, Optional, Decoupled

Hooks may opt into an **event bus**.

```ts
type Events = {
  note: { message: string };
  warn: { code: string };
};

export const onLoadedWithBus = hookDefn(
  "spry.playbook.onLoadedWithBus",
  { input: [CtxSchema], output: z.void() },
  { bus: true },
);
```

Implementations can emit events:

```ts
ctx.bus?.emit("note", { message: "hello" });
```

Hosts can listen:

```ts
onLoadedWithBus.bus?.on("note", (d) => {
  console.log(d.message);
});
```

Properties:

- Fully type-safe
- Built on `EventTarget`
- Optional and injectable
- Supports `AbortSignal`

This allows hooks to communicate **without coupling**.

## AbortSignal and Lifecycle Control

Hooks may also accept `AbortSignal`:

```ts
const CtxSchema = z.object({
  file: z.string(),
  signal: z.custom<AbortSignal>().optional(),
});
```

This enables:

- Cancellation
- Long-running or async hooks
- Host-controlled lifecycle

No special framework required.

## Defensive Execution

All hook implementations are **defensively wrapped**.

If an implementation throws:

```ts
export const explodeImpl = hook(explode, () => {
  throw new Error("boom");
});
```

Then:

- The error is captured into issues
- Execution result is marked `rejected`
- The host decides whether to throw

This makes hooks safe in **plugin-heavy environments**.

## Extension Modules (`extension.ts`)

Hooks live inside **extension modules**, which are just ES modules.

### Loading an Extension

```ts
import { extensionHandle } from "./extension.ts";

const ext = extensionHandle("./my-extension.ts");
const imported = await ext.import();
```

The result contains:

- `module` — the imported module
- `entrypoint` — optional default export which can initialize or perform global
  setup
- `hooks` — discovered hook implementations

### How Hook Discovery Works

`extension.ts`:

- Iterates over module exports
- Uses `isHookImpl` to identify valid hook implementations
- Extracts metadata via `getHookImplMeta`
- Records issues instead of throwing

Malformed exports are skipped safely.

### Default Entrypoint (Optional)

Extensions may also export a default function:

```ts
export default function entry(ctx) {
  return { api: "something" };
}
```

This is orthogonal to hooks and entirely optional.

## Registering Hooks into a Host System

Discovered hooks can be registered into any registry:

```ts
registerExtensionHooks(imported, registry);
```

The registry decides:

- Routing
- Dispatch
- Execution order
- Composition

Spry deliberately does **not** impose a registry model.

## Design Principles (Why It’s Built This Way)

- No decorators → predictable runtime behavior
- Zod → runtime safety, not compile-time illusions
- Symbols → non-intrusive metadata
- Issues over throws → resilience
- Optional surfaces → progressive adoption
- No global state → testability

This module is **infrastructure**, not a framework.

## Typical Usage Pattern

1. Host defines hooks (`hookDefn`)
2. Extensions implement hooks (`hook`)
3. Host loads extensions (`ExtensionHandle`)
4. Hooks are discovered and registered
5. Hooks are executed via `collect`

Each step is explicit and independently testable.
