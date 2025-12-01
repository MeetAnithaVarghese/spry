// lib/universal/zod-aide.ts
import { z } from "@zod/zod";

/**
 * Convert a JSON string (subset of JSON Schema) into a Zod schema.
 * See supported subset notes at bottom of file.
 *
 * SECURITY: Only use with trusted JSON if you extend this to run custom code.
 */
export function jsonToZod(json: string): z.ZodTypeAny {
  const schema = JSON.parse(json) as JS;
  return build(schema);
}

/* ===== Internals ======================================================== */

type JS = Record<string, unknown>;

// Zod's literal accepts: string | number | boolean | null | bigint
type Literal = string | number | boolean | null | bigint;

const isNum = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isArr = Array.isArray;

/** Runtime guard to safely feed values into z.literal(...) */
function isLiteral(v: unknown): v is Literal {
  const t = typeof v;
  return v === null || t === "string" || t === "number" || t === "boolean" ||
    t === "bigint";
}

/** z.union expects a tuple of at least 2 members at type level */
function toUnion(members: z.ZodTypeAny[]): z.ZodTypeAny {
  if (members.length === 0) {
    // No constraint → z.never() would be strict, but z.any() is more permissive
    return z.any();
  }
  if (members.length === 1) return members[0];
  return z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function applyNullability<T extends z.ZodTypeAny>(
  schema: T,
  s: JS,
): T | z.ZodNullable<T> {
  // JSON Schema nullability:
  //  - { type: ["X","null"] } handled elsewhere
  //  - { nullable: true } handled here
  if ((s as { nullable?: boolean }).nullable === true) return schema.nullable();
  return schema;
}

export function build(s: JS): z.ZodTypeAny {
  // --- const / enum -------------------------------------------------------
  if ("const" in s) {
    const value = (s as { const: unknown }).const;
    if (!isLiteral(value)) {
      // Fallback to deepEqual guard by using z.custom; but keep it simple:
      // treat unsupported literal as specific value via refinement of unknown.
      return z.unknown().refine((v) => Object.is(v, value), {
        message: "const mismatch",
      });
    }
    return z.literal(value);
  }

  if ("enum" in s) {
    const values = (s as { enum: unknown }).enum as unknown[];
    if (values.length === 0) {
      return z.never(); // empty enum is uninhabited
    }
    if (values.every((v) => typeof v === "string")) {
      // string enums map cleanly
      return z.enum(values as string[]);
    } else {
      // mixed-type enum → union of literals
      const lits: z.ZodTypeAny[] = [];
      for (const v of values) {
        if (isLiteral(v)) {
          lits.push(z.literal(v));
        } else {
          // fallback: match by deep equality as above
          lits.push(z.unknown().refine((x) => Object.is(x, v)));
        }
      }
      return toUnion(lits);
    }
  }

  // --- anyOf / oneOf / allOf ---------------------------------------------
  if ("anyOf" in s || "oneOf" in s) {
    const arr = ("anyOf" in s
      ? (s as { anyOf: JS[] }).anyOf
      : (s as { oneOf: JS[] }).oneOf) ?? [];
    const members = arr.map(build);
    const u = toUnion(members);
    return applyNullability(u, s);
  }

  if ("allOf" in s) {
    const arr = (s as { allOf: JS[] }).allOf ?? [];
    if (arr.length === 0) return z.any();
    let acc = build(arr[0]);
    for (let i = 1; i < arr.length; i++) {
      acc = z.intersection(acc, build(arr[i]));
    }
    return applyNullability(acc, s);
  }

  // --- type (including union-of-types via array) --------------------------
  const t = (s as { type?: string | string[] }).type;

  if (isArr(t)) {
    // e.g., ["string","null"] or ["number","string"]
    const includesNull = t.includes("null");
    const nonNull = t.filter((x) => x !== "null");
    if (nonNull.length === 0) return z.null();

    if (nonNull.length === 1) {
      const base = build({ ...s, type: nonNull[0] });
      return includesNull ? base.nullable() : base;
    }

    const members = nonNull.map((tt) => build({ ...s, type: tt }));
    const u = toUnion(members);
    return includesNull ? u.nullable() : u;
  }

  switch (t) {
    case "string": {
      let zz = z.string();
      const ss = s as {
        minLength?: number;
        maxLength?: number;
        pattern?: string;
      };
      if (isNum(ss.minLength)) zz = zz.min(ss.minLength);
      if (isNum(ss.maxLength)) zz = zz.max(ss.maxLength);
      if (isStr(ss.pattern)) zz = zz.regex(new RegExp(ss.pattern));
      return applyNullability(zz, s);
    }

    case "number":
    case "integer": {
      let zz = z.number();
      if (t === "integer") zz = zz.int();
      const ns = s as {
        minimum?: number;
        exclusiveMinimum?: number;
        maximum?: number;
        exclusiveMaximum?: number;
        multipleOf?: number;
      };
      if (isNum(ns.minimum)) zz = zz.min(ns.minimum);
      if (isNum(ns.exclusiveMinimum)) zz = zz.gt(ns.exclusiveMinimum);
      if (isNum(ns.maximum)) zz = zz.max(ns.maximum);
      if (isNum(ns.exclusiveMaximum)) zz = zz.lt(ns.exclusiveMaximum);
      if (isNum(ns.multipleOf)) zz = zz.multipleOf(ns.multipleOf);
      return applyNullability(zz, s);
    }

    case "boolean": {
      return applyNullability(z.boolean(), s);
    }

    case "null": {
      return z.null();
    }

    case "array": {
      // JSON Schema allows `items` to be a schema (homogeneous) or array (tuple)
      const as = s as {
        items?: JS | JS[];
        minItems?: number;
        maxItems?: number;
      };

      if (isArr(as.items)) {
        // Tuple: Zod's tuple has fixed length; it does not support .min/.max
        const tupleMembers = as.items.map(build) as [
          z.ZodTypeAny,
          ...z.ZodTypeAny[],
        ];
        const tup = z.tuple(tupleMembers);

        // If you need "minItems"/"maxItems" with tuple, you typically combine tuple + .rest()
        // but JSON Schema tuple with min/max is unusual. We document and ignore here.
        // (No .min/.max on ZodTuple; your errors were coming from calling those.)

        return applyNullability(tup, s);
      } else {
        const item = as.items ? build(as.items) : z.unknown();
        let arr = z.array(item);
        if (isNum(as.minItems)) arr = arr.min(as.minItems);
        if (isNum(as.maxItems)) arr = arr.max(as.maxItems);
        return applyNullability(arr, s);
      }
    }

    // ...inside build(s: JS)
    case "object": {
      const os = s as {
        properties?: Record<string, JS>;
        // legacy JSON Schema support (kept for compatibility)
        required?: string[];
        additionalProperties?: boolean | JS;
      };

      const props = os.properties ?? {};
      const legacyRequired = new Set<string>(
        Array.isArray(os.required) ? os.required : [],
      );

      const shape: Record<string, z.ZodTypeAny> = {};

      for (const [key, def] of Object.entries(props)) {
        // Build the child schema from the property definition
        // (the child may itself be an object/array/etc).
        const child = build(def);

        // New: property-level required flag (Zod-like)
        // e.g., properties: { id: { type: "integer", required: true } }
        const propRequired = typeof (def as JS).required === "boolean"
          ? (def as { required?: boolean }).required === true
          : undefined;

        // Precedence: property.required === true → required
        // else legacy top-level `required: []` → required
        // else optional.
        if (propRequired === true) {
          shape[key] = child;
        } else if (legacyRequired.has(key)) {
          shape[key] = child;
        } else {
          shape[key] = child.optional();
        }
      }

      let obj = z.object(shape);

      // additionalProperties handling (unchanged)
      if (os.additionalProperties === false) {
        obj = obj.strict();
      } else if (
        os.additionalProperties === true ||
        os.additionalProperties === undefined
      ) {
        obj = obj.catchall(z.unknown());
      } else {
        obj = obj.catchall(build(os.additionalProperties));
      }

      return applyNullability(obj, s);
    }

    case undefined: {
      // Heuristics when `type` is omitted
      const hasObjectHints = "properties" in s || "required" in s ||
        "additionalProperties" in s;
      const hasArrayHints = "items" in s;

      if (hasObjectHints) return build({ ...s, type: "object" });
      if (hasArrayHints) return build({ ...s, type: "array" });
      return z.any();
    }

    default: {
      // Unknown type → permissive
      return z.any();
    }
  }
}

/* ===== Supported subset quick notes =====================================

- type: "string" | "number" | "integer" | "boolean" | "null" | "object" | "array" | string[]
- enum, const
- anyOf/oneOf (→ union), allOf (→ intersection)
- string: minLength, maxLength, pattern
- number/integer: minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf
- array:
    - items: schema      → homogeneous array
    - items: schema[]    → tuple (fixed length). NOTE: JSON Schema minItems/maxItems
                           on tuple is ignored (ZodTuple has no .min/.max).
- object: properties, required, additionalProperties (false | true | schema)
- nullability: { type: ["X","null"] } or { nullable: true }

Unimplemented: $ref/$defs, format, patternProperties, dependentSchemas, if/then/else, uniqueItems, etc.
*/
