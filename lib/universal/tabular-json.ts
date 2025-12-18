/**
 * Tabular JSON
 *
 * Utilities for transforming hierarchical JSON into tabular shapes for analytics,
 * reporting, and SQL-friendly access patterns.
 *
 * This module centers on {@link TabularJson}, which:
 * - Validates unknown input against a Zod schema (a {@link https://deno.land/x/zod | ZodObject} shape).
 * - Flattens nested objects (and optionally arrays) into a single “row-like” object suitable for
 *   CSV export, denormalized analytics, indexing, or downstream ingestion.
 * - Generates SQL `VIEW` (or `MATERIALIZED VIEW`) DDL that projects JSON fields as columns.
 *
 * Key ideas
 * - **Schema-driven**: your Zod schema is the source of truth for valid structure and traversal.
 * - **Field path → column**: each field is visited as a path of {@link TabularJsonShapeField} entries;
 *   that path is translated into a {@link TabularJsonColumn} (name, type, SQL access, wrappers, etc.).
 * - **Customization hooks**:
 *   - {@link TabularJsonColumnSupplier} lets you override/augment column naming and behaviors.
 *   - {@link JsonFieldAccessSqlSupplier} lets you control how SQL accesses JSON fields per database dialect.
 *   - {@link TabularJsonColumns} lets you supply targeted overrides for specific schema paths.
 *
 * Quick start
 * ```ts
 * import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
 * import { TabularJson } from "./tabular-json.ts";
 *
 * const shape = z.object({
 *   id: z.string(),
 *   name: z.string(),
 *   address: z.object({
 *     city: z.string(),
 *   }),
 * });
 *
 * const tj = new TabularJson(shape);
 *
 * // JS flattening
 * const toRow = tj.tabularJs({ flattenArrays: true });
 * const row = toRow({ id: "1", name: "Ada", address: { city: "NYC" } });
 * // => { id: "1", name: "Ada", address_city: "NYC" } (names depend on column suppliers)
 *
 * // SQL view generation
 * const { dropDDL, createDDL } = tj.tabularSqlView(
 *   "user_view",
 *   "SELECT * FROM users",
 *   "data",
 *   false,
 * );
 * console.log(dropDDL());
 * console.log(createDDL());
 * ```
 *
 * SQL field access suppliers
 * - {@link arrowStyleSqlFieldAccessSqlSupplier}: PostgreSQL arrow operators (`->`, `->>`) with optional
 *   `COALESCE(...)` behavior for nullable/optional fields when a default-expression supplier is provided.
 * - {@link dotStyleSqlFieldAccessSqlSupplier}: JSONPath-like `$.a.b.c` access style (as implemented here)
 *   for path extraction; intended for PostgreSQL / SQLite-style JSON extraction functions/operators.
 *
 * Naming defaults
 * - {@link snakeCaseColumnSupplier} converts camelCase field names to snake_case and joins nested path
 *   segments with `_` (e.g., `address.geo.lat` → `address_geo_lat`).
 *
 * Notes and caveats
 * - Column customization is best done via {@link TabularJson#columnSupplier} and/or {@link TabularJson#schemaColumns}.
 * - Array flattening in {@link TabularJson#tabularJs} emits indexed columns (e.g., `history_0_date`) when enabled.
 * - The generated DDL uses a `WITH jsonSupplierCTE AS (...)` wrapper; provide any SQL in `jsonSupplierCTE`.
 *
 * @module
 */
import { z, ZodArray, ZodObject } from "@zod/zod";
import { unindentWhitespace } from "./tmpl-literal-aide.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/**
 * Zod v4 exports a public `ZodType` type, but in some toolchains (notably deno-ts),
 * schema nodes are inferred as the internal `$ZodType`.
 *
 * Unobvious: Using `z.ZodType` here keeps our signatures compatible with the
 * concrete types returned by `shape.shape[...]` without fighting `$ZodType` vs `ZodType`.
 */
type ZodT = z.ZodType;

/**
 * Represents a field in the JSON structure.
 */
export type TabularJsonShapeField<
  FieldName extends string,
  Type extends ZodT = ZodT,
> = {
  readonly name: FieldName;
  readonly field: Type;
};

/**
 * Represents a column in the SQL table or view.
 */
export type TabularJsonColumn<Type extends ZodT = ZodT> = {
  readonly name: string;
  readonly type: Type;
  readonly isEmittable: boolean;
  readonly sqlWrapExpr?: (suppliedSql: string) => string;
  readonly sqlAccessJsonField?: JsonFieldAccessSqlSupplier;
  readonly asSqlSelectName?: string;
};

/**
 * Given a shape, define optional column definitions.
 *
 * Unobvious: `keyof Shape["shape"]` widens to `string|number|symbol` in TS.
 * We intersect with `string` because our path-walking uses string keys.
 */
export type TabularJsonColumns<Shape extends ZodObject<z.ZodRawShape>> = {
  [Key in keyof Shape["shape"] & string]?: Shape["shape"][Key] extends
    ZodObject<z.ZodRawShape> ? TabularJsonColumns<Shape["shape"][Key]>
    : Partial<TabularJsonColumn<Shape["shape"][Key] & ZodT>>;
};

/**
 * Function to supply column details for the given fields path and shape.
 */
export type TabularJsonColumnSupplier<Shape> = (
  fieldsPath: TabularJsonShapeField<string, ZodT>[],
  shape: Shape,
) => TabularJsonColumn<ZodT> | undefined;

/**
 * Function to generate the SQL necessary to access a specific JSON field.
 */
export type JsonFieldAccessSqlSupplier = (
  jsonColumnName: string,
  fieldsPath: TabularJsonShapeField<string, ZodT>[],
  nullableDefaultSqlExpr?: (
    field: TabularJsonShapeField<string, ZodT>,
  ) => string,
) => string;

/**
 * Default supplier for PostgreSQL-dialect JSON field access SQL using arrow-style operators.
 */
export const arrowStyleSqlFieldAccessSqlSupplier: JsonFieldAccessSqlSupplier = (
  jsonColumnName,
  fieldsPath,
  nullableDefaultSqlExpr,
) => {
  // Unobvious: we progressively build an expression that can become a COALESCE(...) wrapper
  // at any intermediate hop. That means later path segments must chain from the wrapper,
  // not just the raw `jsonColumnName`.
  let fullPath = jsonColumnName;

  // Iterate through all fields except the last one (terminal field is extracted as text via ->>).
  fieldsPath.slice(0, -1).forEach((field) => {
    const optional = field.field instanceof z.ZodOptional ||
      field.field instanceof z.ZodNullable;

    const fieldAccess = `${fullPath} -> '${field.name}'`;

    // Unobvious: applying COALESCE at intermediate object hops helps avoid null-propagation
    // when you want a default object for a missing subtree (only if caller supplies a default expr).
    if (optional && nullableDefaultSqlExpr) {
      fullPath = `COALESCE(${fieldAccess}, ${nullableDefaultSqlExpr(field)})`;
    } else {
      fullPath = fieldAccess;
    }
  });

  // Terminal field: use ->> for text extraction.
  const terminalField = fieldsPath[fieldsPath.length - 1]!;
  fullPath = `${fullPath} ->> '${terminalField.name}'`;

  return fullPath;
};

/**
 * Supplier for dot-style JSON field access SQL.
 *
 * Uses a `$.x.y.z`-style path string.
 *
 * Important: JSON path syntax and operators vary by database.
 * This function preserves the original module’s intent (string-based path composition),
 * but callers should consider overriding this via {@link TabularJson#jsonFieldAccessSql}
 * to match the exact dialect (e.g., `json_extract(...)` in SQLite, `#>>` in PostgreSQL, etc.).
 */
export const dotStyleSqlFieldAccessSqlSupplier: JsonFieldAccessSqlSupplier = (
  jsonColumnName,
  fieldsPath,
  nullableDefaultSqlExpr,
) => {
  const jsonPath = fieldsPath.map((field) => `.${field.name}`).join("");

  // Unobvious: this is intentionally a single expression string builder; the module does not
  // validate that the resulting SQL is valid for the target database.
  let fullPath = `${jsonColumnName} ->> '$${jsonPath}'`;

  if (nullableDefaultSqlExpr) {
    // Terminal default only (as originally implemented).
    fullPath = `COALESCE(${fullPath}, ${
      nullableDefaultSqlExpr(fieldsPath[fieldsPath.length - 1]!)
    })`;
  }

  return fullPath;
};

/**
 * Helper function to convert camelCase to snake_case.
 */
const camelCaseToSnakeCase = (str: string) =>
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * Default column supplier using snake_case naming convention.
 */
export function snakeCaseColumnSupplier(
  fieldsPath: TabularJsonShapeField<string, ZodT>[],
  _shape?: unknown,
): TabularJsonColumn<ZodT> {
  const name = fieldsPath.map((f) => camelCaseToSnakeCase(f.name)).join("_");
  const lastField = fieldsPath[fieldsPath.length - 1]!.field;

  return {
    name,
    type: lastField,
    isEmittable: true,
  };
}

/**
 * Main class to handle JSON data, schema, and SQL view generation.
 */
export class TabularJson<Shape extends ZodObject<z.ZodRawShape>> {
  protected shapeSchema: Shape;
  protected columnSupplierFunctions: TabularJsonColumnSupplier<Shape>[] = [];
  protected shapeColumnsSearch: TabularJsonColumns<Shape>[] = [];
  protected jsonFieldAccessSqlSupplier: JsonFieldAccessSqlSupplier;

  constructor(schema: Shape) {
    this.shapeSchema = schema;
    this.jsonFieldAccessSqlSupplier = dotStyleSqlFieldAccessSqlSupplier;
  }

  jsonSchema(schema: Shape): this {
    this.shapeSchema = schema;
    return this;
  }

  schemaColumns(search: TabularJsonColumns<Shape>): this {
    this.shapeColumnsSearch.push(search);
    return this;
  }

  columnSupplier(supplier: TabularJsonColumnSupplier<Shape>): this {
    this.columnSupplierFunctions.push(supplier);
    return this;
  }

  jsonFieldAccessSql(supplier: JsonFieldAccessSqlSupplier): this {
    this.jsonFieldAccessSqlSupplier = supplier;
    return this;
  }

  /**
   * Resolve a column definition for the given field path.
   *
   * Unobvious: resolution order is:
   * 1) first non-undefined supplier result (in registration order)
   * 2) default snake_case column supplier
   * 3) merge any matching schemaColumns overrides (in registration order)
   */
  jsonFieldColumn(
    fieldsPath: TabularJsonShapeField<string, ZodT>[],
  ): TabularJsonColumn<ZodT> {
    let supplied: TabularJsonColumn<ZodT> | undefined;

    for (const supplier of this.columnSupplierFunctions) {
      const candidate = supplier(fieldsPath, this.shapeSchema);
      if (candidate) {
        supplied = candidate;
        break;
      }
    }

    // Unobvious: force a definite column early, so no `| undefined` can leak into merges.
    let merged: TabularJsonColumn<ZodT> = supplied ??
      snakeCaseColumnSupplier(fieldsPath, this.shapeSchema);

    for (const search of this.shapeColumnsSearch) {
      let found: Any = search;
      for (const field of fieldsPath) {
        if (!found) break;
        found = found[field.name];
      }
      if (found) merged = { ...merged, ...found };
    }

    return merged;
  }

  /**
   * Generates a JavaScript function to process data according to the schema.
   */
  tabularJs(
    options: { readonly flattenArrays: boolean } = { flattenArrays: true },
  ): (data: unknown) => { [key: string]: Any } {
    return (data: unknown) => {
      const parsedData = this.shapeSchema.safeParse(data);
      if (!parsedData.success) throw new Error("Invalid data shape");

      const result: { [key: string]: Any } = {};

      const recurse = (
        obj: Any,
        schema: ZodT,
        fieldsPath: readonly TabularJsonShapeField<string, ZodT>[] = [],
      ) => {
        // Unobvious: to correctly traverse nested structures, we must carry the current schema node
        // (not just the root schema). Otherwise nested keys would be looked up on the wrong object.
        if (
          !(schema instanceof ZodObject) || obj === null ||
          typeof obj !== "object"
        ) return;

        for (const key in obj) {
          // Unobvious: in Zod v4, `shape.shape[key]` is typed as internal `$ZodType`.
          // We treat it as `ZodT` because our `ZodT` alias is compatible with that toolchain.
          const field = (schema.shape as Record<string, ZodT>)[key];
          if (!field) continue;

          const currentField: TabularJsonShapeField<string, ZodT> = {
            name: key,
            field,
          };
          const column = this.jsonFieldColumn([...fieldsPath, currentField]);
          if (!column.isEmittable) continue;

          const value = obj[key];

          if (Array.isArray(value)) {
            if (options.flattenArrays) {
              value.forEach((item: Any, index: number) => {
                // Unobvious: include index in the field-path name segment so default naming yields
                // stable unique output keys (`history_0_date`, `history_1_date`, ...).
                const indexedName = `${key}_${index}`;
                const itemSchema = field instanceof ZodArray
                  ? (field.element as ZodT)
                  : field;

                if (typeof item === "object" && item !== null) {
                  recurse(item, itemSchema, [
                    ...fieldsPath,
                    { name: indexedName, field: itemSchema },
                  ]);
                } else {
                  result[`${column.name}_${index}`] = item;
                }
              });
            } else {
              result[column.name] = value;
            }
          } else if (typeof value === "object" && value !== null) {
            recurse(value, field, [...fieldsPath, currentField]);
          } else {
            result[column.name] = value;
          }
        }
      };

      recurse(parsedData.data, this.shapeSchema);
      return result;
    };
  }

  /**
   * Generates SQL column projections for the JSON schema.
   */
  tabularSqlColumns(jsonColumnAccessSQL: string) {
    const columns: (TabularJsonColumn<ZodT> & { columnExprSQL: string })[] = [];

    const recurse = (
      shape: ZodT,
      fieldsPath: readonly TabularJsonShapeField<string, ZodT>[] = [],
    ) => {
      if (shape instanceof ZodObject) {
        for (const key in shape.shape) {
          const field = (shape.shape as Record<string, ZodT>)[key];
          if (!field) continue;

          const currentField: TabularJsonShapeField<string, ZodT> = {
            name: key,
            field,
          };
          const column = this.jsonFieldColumn([...fieldsPath, currentField]);
          if (!column.isEmittable) continue;

          // Unobvious: column-level supplier wins over instance-level supplier so that a single
          // field can switch dialect or access strategy without impacting others.
          const jsonFieldAccessSupplier = column.sqlAccessJsonField ??
            this.jsonFieldAccessSqlSupplier;

          let columnExprSQL = jsonFieldAccessSupplier(jsonColumnAccessSQL, [
            ...fieldsPath,
            currentField,
          ]);

          if (column.sqlWrapExpr) {
            // Unobvious: wrapping happens after field access so wrappers can CAST/NULLIF/etc.
            // around the final extraction expression.
            columnExprSQL = column.sqlWrapExpr(columnExprSQL);
          }

          if (field instanceof ZodObject || field instanceof ZodArray) {
            recurse(field as unknown as ZodT, [...fieldsPath, currentField]);
          } else {
            columns.push({ ...column, columnExprSQL });
          }
        }
      } else if (shape instanceof ZodArray) {
        // Unobvious: arrays do not become columns themselves here; we recurse into element type.
        recurse(shape.element as unknown as ZodT, fieldsPath);
      }
    };

    recurse(this.shapeSchema);
    return columns;
  }

  /**
   * Generates SQL view creation and deletion statements.
   */
  tabularSqlView(
    viewName: string,
    jsonSupplierCTE: string,
    jsonColumnNameInCTE: string,
    isMaterialized = false,
  ) {
    const viewType = isMaterialized ? "MATERIALIZED VIEW" : "VIEW";
    const columns = this.tabularSqlColumns(jsonColumnNameInCTE);

    return {
      dropDDL: () => `DROP VIEW IF EXISTS ${viewName};`,
      createDDL: () =>
        // deno-fmt-ignore
        unindentWhitespace(`
          CREATE ${viewType} ${viewName} AS
              WITH jsonSupplierCTE AS (
                  ${jsonSupplierCTE.replaceAll("\n", "\n              ")}
              )
              SELECT
                  ${columns.map((col) => `${col.columnExprSQL} AS ${col.asSqlSelectName ?? col.name}`).join(",\n                  ")}
              FROM jsonSupplierCTE;`),
    };
  }
}
