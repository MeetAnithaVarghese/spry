## Spry Extensions

Spry Extensions provide a **minimal, runtime-safe capability system** for Spry.
They allow systems to define, discover, and execute named capabilities without
frameworks, registries, decorators, or hidden runtime magic.

Extensions are designed to be:

- Explicit
- Inspectable
- Testable
- Safe at runtime
- Friendly to plugins, automation, and AI-driven orchestration

The system is intentionally small. Most of the real documentation lives in the
tests, which serve as executable specifications.

## What Spry Extensions Are (and Are Not)

Spry Extensions are **not** a framework.

They do not require:

- Global registries
- Dependency injection containers
- Decorators or AST scanning
- Configuration files
- Build-time tooling

Instead:

- Extensions are just ES modules
- Capabilities are just functions
- Safety comes from Zod runtime validation
- Discovery happens by scanning exports

## Core Concepts

Spry Extensions revolve around two simple ideas:

### 1. Callable Definitions (Contracts)

A callable definition describes **what a capability is**, not how it is
implemented.

It consists of:

- A stable string identifier
- A runtime-validated function signature (inputs and output)

```ts
import * as z from "@zod/zod";
import { callableDefn } from "./extension.ts";

export const add = callableDefn(
  "spry.math.add",
  { input: [z.number(), z.number()], output: z.number() },
);
```

This defines a contract:

- ID: `spry.math.add`
- Inputs: two numbers
- Output: a number

There is no implementation yet. No execution happens at this stage.

Definitions are intentionally decoupled from:

- Export names
- Module paths
- Execution strategy

This allows refactoring without breaking callers.

### 2. Callable Implementations (Behavior)

A callable implementation provides **how the capability works**.

Implementations are created by wrapping a definition with logic:

```ts
import { callable } from "./extension.ts";
import { add } from "./defs.ts";

export const addImpl = callable(add, (a, b) => a + b);
```

What happens automatically:

- Inputs are validated before execution
- Outputs are validated after execution
- The implementation is tagged with metadata
- The function becomes discoverable by ID

Only wrapped implementations are discoverable. Raw functions are ignored
intentionally.

## Extensions Are Just Modules

An extension is simply an ES module that exports callable implementations.

There is no required base class, decorator, or registration step.

```ts
export const addImpl = callable(add, (a, b) => a + b);
export const subImpl = callable(sub, (a, b) => a - b);
```

That is a complete extension.

## Discovery and Execution

### Discovery

Discovery is done by **scanning module exports**.

```ts
import { scanCallables } from "./extension.ts";

const discovered = scanCallables(moduleExports);
```

Spry:

- Iterates exports
- Identifies wrapped implementations
- Extracts metadata safely
- Ignores malformed or unrelated exports

Discovery never executes code.

### Execution

Execution is ID-based and defensive.

```ts
import { call } from "./extension.ts";

const results = await call(moduleExports, [
  { id: "spry.math.add", args: [2, 3] },
]);
```

Execution guarantees:

- Runtime validation via Zod
- Per-call success or failure results
- No uncaught errors escaping the call boundary
- Optional handling of duplicate implementations

Results are structured:

```ts
{ id, ok: true, value }
{ id, ok: false, error }
```

This makes extensions safe to run in:

- Plugin systems
- Automation pipelines
- AI-driven orchestration
- Multi-tenant environments

## Optional Definition Indexing

Some hosts need visibility into **what capabilities exist**, not just how to run
them.

For that purpose, Spry provides `scanDefns()`:

```ts
import { scanDefns } from "./extension.ts";

const defsById = scanDefns(definitionModule);
```

This builds an in-memory map:

```
id → callable definition
```

Use cases include:

- Documentation generation
- Tooling and UI
- Host-side dynamic implementation
- Validation and governance

There is still **no registry**. The index is just a Map created when needed.

## Plain Zod Functions (Optional Convenience)

If a module exports a plain `z.function(...)`, it can be auto-tagged when
scanned:

```ts
export const plain = z.function({
  input: [z.number()],
  output: z.number(),
});
```

When `scanDefns()` runs, Spry will:

- Assign `id = exportName`
- Attach callable metadata
- Make it usable like any other definition

This supports rapid experimentation without losing safety.

## Error Handling Philosophy

Spry Extensions favor **defensive execution**.

- Validation errors are returned, not thrown
- Implementation errors are captured per call
- Hosts decide whether to propagate or ignore failures
- Batch execution is safe by default

This is critical for plugin-heavy and third-party environments.

## Design Principles

Spry Extensions are built on a few deliberate principles:

- Runtime truth over compile-time illusion
- Explicit metadata over hidden magic
- Functions over classes
- Modules over frameworks
- WeakMaps over global state
- Tests as executable documentation

The system is intentionally boring, predictable, and auditable.

## How to Learn the Details

The best way to understand Spry Extensions is **not this document**.

It is the tests.

The tests in `extension_test.ts` demonstrate:

- Definition patterns
- Implementation patterns
- Discovery behavior
- Execution semantics
- Error handling
- Duplicate resolution
- Sync and async behavior

They are designed to be read as documentation and trusted as specification.

## In Summary

Spry Extensions provide a practical foundation for:

- Plugin systems
- Extension points
- AI-driven capability routing
- Governed execution environments
- Long-lived, evolvable platforms

They deliberately stay out of your way while enforcing safety where it matters
most: at runtime.

This is infrastructure, not a framework.
