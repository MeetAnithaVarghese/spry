const IDENT_RX = /^[A-Za-z_$][\w$]*$/;

const assertValidIdentifier = (name: string, label = "identifier") => {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `Invalid ${label} "${name}". Use a simple JavaScript identifier.`,
    );
  }
};

/**
 * Compile a raw JavaScript expression string into an async function
 * that receives `(ctx, locals)` and evaluates the expression using
 * the provided context and local bindings.
 *
 * This is intentionally **unsafe**: the expression is executed via
 * dynamic `AsyncFunction` construction. Callers must validate or
 * sandbox input before use.
 *
 * Rules:
 * - `ctxName` must not collide with any local key.
 * - Each local key must be a valid JavaScript identifier.
 *
 * @param expr     The raw JS expression to evaluate (e.g. "x + y").
 * @param ctxName  The identifier exposed inside the expression for `ctx`.
 * @param localKeys Keys that will be mapped from the `locals` object.
 * @returns An async function `(ctx, locals) => Promise<unknown>`.
 */
export function unsafeJsExpr(
  expr: string,
  ctxName: string,
  localKeys: readonly string[],
) {
  // Prevent naming collisions between the context identifier and locals.
  if (localKeys.includes(ctxName)) {
    throw new Error(
      `Local key "${ctxName}" conflicts with ctxName. Rename the local or choose another ctxName.`,
    );
  }

  // Ensure all local variable names are valid JS identifiers.
  for (const key of localKeys) {
    assertValidIdentifier(key, "local key");
  }

  // Generate "const <key> = __l['<key>'];" bindings.
  const localDecls = localKeys
    .map((key) => `const ${key} = __l[${JSON.stringify(key)}];`)
    .join("\n");

  const ctxDecl = `const ${ctxName} = __ctx;`;

  // The function body evaluates the expression and returns its result.
  const body = [
    `"use strict";`,
    localDecls,
    ctxDecl,
    `return (${expr});`,
  ].join("\n");

  // Obtain the AsyncFunction constructor reliably.
  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as new (
      ...args: string[]
    ) => (ctx: unknown, locals: Record<string, unknown>) => Promise<unknown>;

  // Final compiled async function:
  return new AsyncFunction("__ctx", "__l", body);
}
