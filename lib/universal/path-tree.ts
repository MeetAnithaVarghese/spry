/**
 * The Path-Tree  module builds a folder/file “forest” from arbitrary payloads while preserving
 * strong typing for both `Path` (a branded string if you like) and `Node` (your payload).
 * Zod schemas are constructed *inside* generic functions so your concrete `Path`/`Node`
 * types flow through, and the module returns those schemas alongside data for validation
 * or JSON-Schema emission.
 *
 * 1) Generics flow into Zod via function scope
 *    - We define the Zod schemas inside `pathTree<Node, Path>()`, `pathTreeNavigation()`,
 *      and `forestToEdges()` so the schemas “capture” your generic types. This avoids
 *      factory helpers while still keeping bulletproof types.
 *    - Returned object shape includes `schemas: { path, node, forest, ... }`. These schemas
 *      are already typed with your `Path`/`Node`.
 *
 * 2) Async return types in type aliases
 *    - `pathTree` is `async`. If you write types that index into its return type, wrap with
 *      `Awaited<...>`:
 *        z.infer<Awaited<ReturnType<typeof pathTree<MyNode, MyPath>>>>["schemas"]["node"]
 *    - In call sites, you must `await pathTree(...)` before accessing `.schemas` or other fields.
 *
 * 3) Path normalization is opinionated (and configurable)
 *    - `normalize()` collapses repeated delimiters, optionally forces absolute paths (default true),
 *      removes trailing delimiter except root, and treats empty input as root.
 *    - If your runtime uses backslashes or multiple possible delimiters, set `pathDelim` explicitly.
 *
 * 4) Virtual nodes (synthetic folders) are expected
 *    - With `synthesizeContainers: true` (default), missing parent directories are materialized as
 *      “virtual” container nodes so every file has a container parent. This simplifies traversal/UI.
 *    - Virtual nodes set `virtual: true` and may have empty `payloads`.
 *
 * 5) “Index” files define canonical routes
 *    - Names in `indexBasenames` (default: "index", "index.sql", "index.md", "index.html") act as a
 *      container’s canonical entry. `canonicalOf(node)` prefers that child’s path when present.
 *    - Breadcrumbs also prefer `hrefs.index` for linking when available.
 *
 * 6) Fast lookups and stable ordering
 *    - `treeByPath` (Map) provides O(1) node lookup by normalized path.
 *    - `parentMap` maps path→parent path; `itemToNodeMap` maps payload item→owning node.
 *    - Siblings are sorted by: (optional folder-first) → `basename` → `path`, unless you supply
 *      a custom `compare(a, b)`; type it as `(a: RuntimeNode, b: RuntimeNode) => number`.
 *
 * 7) Breadcrumbs always return container nodes
 *    - Even if the starting item is a file, `ancestors(item)` walks up container-to-container,
 *      ensuring each crumb exposes its `children` for UI rendering. Hrefs include:
 *        - `canonical` (container path as-is)
 *        - `index` (index child path, if present)
 *        - `trailingSlash` (container path with slash added; root stays "/")
 *
 * 8) Serializers and payload shaping
 *    - `asciiTreeText()` prints a simple visual tree (optionally counts payloads).
 *    - `jsonText()` emits JSON for the whole forest or a subtree. If you must hide or shape payloads,
 *      use `payloadMapper` (per item) or `payloadsSerializer` (entire array).
 *
 * 9) Edges generation logic (for routers/graphs)
 *    - Conceptually builds edges with canonical routes:
 *        (1) parentDirIndex → dirIndex (for a child “index.*” under a directory)
 *        (2) dirIndex → other child payload routes in that directory
 *    - Leading `/` is stripped in emitted routes. Self-edges are skipped and duplicates deduped.
 *
 * 10) Validation and JSON-Schema emission
 *    - Because the module returns concrete Zod schemas, it’s trivial to validate results:
 *        const forest = await pathTree(...);
 *        const ok = forest.schemas.forest.safeParse(forest.roots);
 *    - For JSON-Schema, use your preferred adapter (e.g., zod-to-json-schema) on the returned schemas.
 *
 * Performance/scale tips:
 * - `normalize()` and map lookups are hot paths; avoid unnecessary string churn in `nodePath`.
 * - Use `folderFirst: false` and skip custom `compare` if you don’t care about directory-first ordering.
 * - If you don’t need `itemToNodeMap`, you can still ignore it; it is built for convenience.
 *
 * Common pitfalls checklist:
 * - [ ] Did you `await pathTree(...)` before `forest.schemas` or `forest.roots`?
 * - [ ] Are you wrapping `ReturnType<...>` with `Awaited<...>` in your type-level inferences?
 * - [ ] Are your “index” filenames listed if you rely on canonical linking?
 * - [ ] If your delimiter isn’t "/", did you set `pathDelim`?
 * - [ ] If a file appears to be “missing” in breadcrumbs, remember we show containers, not the file itself.
 */
import { z } from "@zod/zod";

// deno-lint-ignore no-explicit-any
type Any = any; // internal convenience only

// ===========================================================================
// Public generic types derived from the APIs (bullet‑proof for juniors)
// ===========================================================================

// ✅ replace previous aliases
export type PathTreeNode<Node, Path extends string = string> = z.infer<
  Awaited<ReturnType<typeof pathTree<Node, Path>>>["schemas"]["node"]
>;

export type Forest<Node, Path extends string = string> = z.infer<
  Awaited<ReturnType<typeof pathTree<Node, Path>>>["schemas"]["forest"]
>;

export type Breadcrumb<Node, Path extends string = string> = z.infer<
  Awaited<
    ReturnType<typeof pathTreeNavigation<Node, Path>>
  >["schemas"]["breadcrumb"]
>;

export type Breadcrumbs<Node, Path extends string = string> = z.infer<
  Awaited<
    ReturnType<typeof pathTreeNavigation<Node, Path>>
  >["schemas"]["breadcrumbsList"]
>;

export type Edge<Node, Path extends string = string> = z.infer<
  Awaited<ReturnType<typeof forestToEdges<Node, Path>>>["schemas"]["edge"]
>;

export type Edges<Node, Path extends string = string> = z.infer<
  Awaited<ReturnType<typeof forestToEdges<Node, Path>>>["schemas"]["edges"]
>;

// ===========================================================================
// Core: pathTree
// ===========================================================================

// Runtime model used to type Zod schemas generically in this function
type RuntimeNode<Node, Path extends string = string> = {
  path: Path;
  basename: string;
  children: RuntimeNode<Node, Path>[];
  payloads?: Node[];
  virtual?: true;
};

/**
 * Build a forest from a stream (sync or async) of payload nodes.
 *
 * Key behaviors
 * - normalize(): collapses duplicate delimiters, coerces absolute (opt), trims trailing delimiter.
 * - synthesizeContainers: creates missing parent containers so every file has a folder.
 * - indexBasenames: names (e.g., "index.sql") treated as a container's canonical entry.
 * - treeByPath: Map for O(1) lookups by normalized path.
 */
export async function pathTree<Node, Path extends string = string>(
  payloadsSupplier: AsyncIterable<Node> | Iterable<Node>,
  options: {
    /** Extract the path string from a node */
    nodePath: (n: Node) => Path;
    /** Directory separator. Default: "/" */
    pathDelim?: string;
    /** Create container/folder nodes for missing intermediate directories. Default: true */
    synthesizeContainers?: boolean;
    /** Index-like basenames under a container. Default: ["index","index.sql","index.md","index.html"] */
    indexBasenames?: string[];
    /** Put folders before files in sibling ordering (like `tree`). Default: true */
    folderFirst?: boolean;
    /** Optional custom sort for sibling nodes. If omitted: (folderFirst?) → basename → path */
    compare?: (
      a: RuntimeNode<Node, Path>,
      b: RuntimeNode<Node, Path>,
    ) => number;
    /** Ensure paths are normalized as absolute (prepend delim if missing). Default: true */
    forceAbsolute?: boolean;
    // if provided, we will use this for payloads instead of z.custom()
    payloadSchema?: z.ZodType<Node>;
  },
) {
  // ---- Local type aliases for clarity -------------------------------------
  type P = Path;
  type N = Node;
  type RN = RuntimeNode<N, P>;

  // ---- Options & defaults --------------------------------------------------
  const delim = options.pathDelim ?? "/";
  const synthesize = options.synthesizeContainers ?? true;
  const folderFirst = options.folderFirst ?? true;
  const forceAbs = options.forceAbsolute ?? true;
  const indexNames = (options.indexBasenames ?? [
    "index",
    "index.sql",
    "index.md",
    "index.html",
  ]).map((s) => s.toLowerCase());

  // -----------------------------
  // Helpers (returned to caller)
  // -----------------------------
  function escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const delimRe = new RegExp(`${escapeRegExp(delim)}+`, "g");

  function normalize(p: string): P {
    if (!p) return (delim as unknown) as P;
    let s = p.trim();
    s = s.replace(delimRe, delim); // unify delimiters
    if (forceAbs && !s.startsWith(delim)) s = delim + s; // coerce absolute
    if (s.length > delim.length && s.endsWith(delim)) {
      s = s.slice(0, -delim.length); // strip trailing
    }
    if (!s.length) s = delim; // empty→root
    return (s as unknown) as P;
  }

  const splitSegments = (p: string) => {
    const np = normalize(p);
    const body = np.startsWith(delim) ? np.slice(delim.length) : np;
    return body.length ? body.split(delim) : [];
  };

  const joinSegments = (segments: string[]): P => ((normalize(
    (forceAbs ? delim : "") + segments.join(delim),
  ) as unknown) as P);

  const dirname = (p: string): P => {
    const segs = splitSegments(p);
    if (segs.length <= 1) return (delim as unknown) as P;
    return joinSegments(segs.slice(0, -1));
  };

  const basename = (p: string): string => {
    const segs = splitSegments(p);
    return segs.length ? segs[segs.length - 1] : delim; // root label is delim
  };

  const isContainerPath = (p: string) => {
    const name = basename(p);
    return name !== delim && !name.includes(".");
  };

  const isIndexFile = (p: string) =>
    indexNames.includes(basename(p).toLowerCase());

  const defaultCompare = (a: RN, b: RN) => {
    if (folderFirst) {
      const af = isContainerPath(a.path);
      const bf = isContainerPath(b.path);
      if (af !== bf) return af ? -1 : 1;
    }
    const n = a.basename.localeCompare(b.basename);
    return n || a.path.localeCompare(b.path);
  };

  const compare = options.compare ?? defaultCompare;

  // ---- Buckets -------------------------------------------------------------
  type NodeBucket = { path: P; items: N[] };
  const buckets = new Map<P, NodeBucket>();
  const bucketFor = (p: P) => {
    let b = buckets.get(p);
    if (!b) {
      b = { path: p, items: [] };
      buckets.set(p, b);
    }
    return b;
  };

  const mkNode = (payload: P, virtual?: true): RN => ({
    path: payload,
    basename: basename(payload),
    children: [],
    ...(virtual ? { virtual: true as const } : null),
  });

  const treeByPath = new Map<P, RN>();
  const ensureTreeNode = (p: P, virtual?: true) => {
    let node = treeByPath.get(p);
    if (!node) {
      node = mkNode(p, virtual);
      treeByPath.set(p, node);
    }
    return node;
  };

  // ---- Ingest payloads (sync or async) ------------------------------------
  const payloads = (payloadsSupplier as AsyncIterable<N>)[Symbol.asyncIterator]
    ? (payloadsSupplier as AsyncIterable<N>)
    : (async function* () {
      for (const x of payloadsSupplier as Iterable<N>) yield x;
    })();

  for await (const payload of payloads) {
    const p = normalize(options.nodePath(payload) as unknown as string);
    bucketFor(p).items.push(payload);
  }

  // ---- Synthesize containers ----------------------------------------------
  const ROOT = delim as unknown as P;

  if (synthesize) {
    for (const p of buckets.keys()) {
      let cur = dirname(p);
      while (cur !== (delim as unknown as P)) {
        bucketFor(cur);
        cur = dirname(cur);
      }
    }
    for (const [p] of buckets) {
      if (isIndexFile(p)) {
        const dir = dirname(p);
        if (dir !== ROOT) bucketFor(dir);
      }
    }
  }

  // ---- Build tree ----------------------------------------------------------
  for (const [p, b] of buckets) {
    const node = ensureTreeNode(
      p,
      (b.items.length === 0) ? (true as const) : undefined,
    );
    if (b.items.length) node.payloads = b.items;
  }

  const roots: RN[] = [];
  for (const [p, node] of treeByPath) {
    if (p === ROOT) continue;
    const parentPath = dirname(p);
    const isRoot = parentPath === ROOT;
    if (isRoot || !treeByPath.has(parentPath)) roots.push(node);
    else {
      const parent = treeByPath.get(parentPath)!;
      if (parent !== node) parent.children.push(node);
      else roots.push(node);
    }
  }

  (function sortRec(arr: RN[]) {
    arr.sort(compare);
    for (const c of arr) sortRec(c.children);
  })(roots);

  const parentMap = new Map<P, P | null>();
  const itemToNodeMap = new Map<N, RN>();
  (function buildMaps(nodes: RN[], parentPath: P | null) {
    for (const node of nodes) {
      parentMap.set(node.path, parentPath);
      if (node.payloads) {
        for (const it of node.payloads) itemToNodeMap.set(it, node);
      }
      buildMaps(node.children, node.path);
    }
  })(roots, null);

  const canonicalOf = (node: RN): P => {
    const idx = node.children.find((c) => isIndexFile(c.path));
    return (idx ? idx.path : node.path) as P;
  };

  // ---- Zod schemas (generic, inside function so P/N flow through) ---------
  const pathSchema = z.string() as unknown as z.ZodType<P>;

  /**
   * If provided, we use your payload schema (document it yourself or we add a default doc).
   * We wrap with `.describe(...)` so JSON Schema has a helpful blurb even if you pass one in.
   */
  const payloadItemSchema = (
    (options.payloadSchema ?? z.unknown())
      .describe("Original (untyped) payload item stored at this exact path.")
  ) as z.ZodType<Node>;

  const nodeSchema: z.ZodType<RN> = z.lazy(() =>
    z.object({
      path: pathSchema, // already described above
      basename: z.string().describe(
        "Last segment of the path (no delimiter). Root uses the delimiter.",
      ),
      children: z.array(nodeSchema).describe(
        "Child nodes under this container or file node.",
      ),
      payloads: z.array(payloadItemSchema).optional().describe(
        "Zero or more original payload items for this exact node path.",
      ),
      virtual: z.literal(true).optional().describe(
        "True if this node was synthesized as a container (no direct payloads).",
      ),
    }).strict().describe("Path tree node (container or file).")
  );

  const forestSchema = z.array(nodeSchema).describe(
    "Forest: array of root nodes (top-level entries after synthesis/sort).",
  );

  return {
    // data
    roots,
    normalize,
    dirname,
    basename,
    isContainerPath,
    isIndexFile,
    treeByPath,
    parentMap,
    itemToNodeMap,
    canonicalOf,

    // schemas (fully generic)
    schemas: {
      path: pathSchema,
      node: nodeSchema,
      forest: forestSchema,
    },
  };
}

// ===========================================================================
// Navigation helpers (breadcrumbs)
// ===========================================================================

/**
 * Helpers to compute breadcrumb trails for a given item. Crumbs are **containers**.
 */
export function pathTreeNavigation<Node, Path extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, Path>>>,
) {
  function ancestors(item: Node) {
    const asContainer = (p: string) =>
      (forest.isContainerPath(p) ? p : forest.dirname(p)) as Path;
    const withSlash = (p: string) =>
      (p === "/" || p.endsWith("/")) ? p : `${p}/`;

    const start = forest.itemToNodeMap.get(item);
    if (!start) {
      return [] as Array<
        {
          node: (typeof forest)["roots"][number];
          hrefs: { canonical: string; index?: string; trailingSlash: string };
        }
      >;
    }

    const crumbs: Array<{
      node: (typeof forest)["roots"][number];
      hrefs: { canonical: string; index?: string; trailingSlash: string };
    }> = [];

    let curPath: Path | undefined = asContainer(start.path);

    while (curPath) {
      const curNode = forest.treeByPath.get(curPath) as
        | (typeof forest)["roots"][number]
        | undefined;
      if (!curNode) break;
      const idxChild = curNode.children.find((c) => forest.isIndexFile(c.path));
      crumbs.push({
        node: curNode,
        hrefs: {
          canonical: curNode.path,
          index: idxChild?.path,
          trailingSlash: withSlash(curNode.path),
        },
      });
      const parentContainerPath =
        (forest.parentMap.get(curPath) as string | null | undefined) as Path;
      if (!parentContainerPath) break;
      curPath = parentContainerPath;
    }

    return crumbs.reverse();
  }

  const breadcrumbHrefsSchema = z.object({
    canonical: z.string().describe(
      "Container path as-is (preferred canonical link for the container).",
    ),
    index: z.string().optional().describe(
      "First index child path if present (e.g., 'index.sql').",
    ),
    trailingSlash: z.string().describe(
      "Container path with a trailing slash (root remains '/').",
    ),
  }).strict().describe("Link variants used by different routers.");

  const breadcrumbSchema = z.object({
    node: forest.schemas.node.describe(
      "Container-level node referenced by this breadcrumb.",
    ),
    hrefs: breadcrumbHrefsSchema,
  }).strict().describe(
    "Single breadcrumb from root to the item's owning container.",
  );

  const breadcrumbsListSchema = z.array(breadcrumbSchema).describe(
    "Ordered breadcrumb trail (root → … → owning container).",
  );
  const breadcrumbsMapSchema = z.record(z.string(), breadcrumbsListSchema)
    .describe("Map breadcrumb trail (path: root → … → owning container).");

  return {
    ancestors,
    schemas: {
      breadcrumb: breadcrumbSchema,
      breadcrumbsList: breadcrumbsListSchema,
      breadcrumbsMap: breadcrumbsMapSchema,
    },
  };
}

// ===========================================================================
// Serializers (text/JSON). Use returned schemas for validation if needed.
// ===========================================================================

export function pathTreeSerializers<Node, Path extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, Path>>>,
) {
  function asciiTreeText(
    opts: { showPath?: boolean; includeCounts?: boolean } = {},
  ) {
    const showPath = opts.showPath ?? true;
    const includeCounts = opts.includeCounts ?? false;

    const lines: string[] = [];
    const render = (
      node: (typeof forest.roots)[number],
      prefix: string,
      isLast: boolean,
    ) => {
      const branch = isLast ? "└── " : "├── ";
      const count = includeCounts && node.payloads?.length
        ? ` (${node.payloads.length})`
        : "";
      const label = showPath
        ? `${node.basename} [${node.path}]`
        : node.basename;
      lines.push(`${prefix}${branch}${label}${count}`);
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      node.children.forEach((child, i, arr) =>
        render(child, nextPrefix, i === arr.length - 1)
      );
    };

    forest.roots.forEach((r, i) =>
      render(r, "", i === forest.roots.length - 1)
    );
    return lines.join("\n");
  }

  function jsonText(options?: {
    path?: Path;
    space?: number | string;
    includePayloads?: boolean;
    payloadMapper?: (p: Node) => unknown;
    payloadsSerializer?: (arr: Node[]) => unknown;
  }) {
    const includePayloads = options?.includePayloads ?? true;
    const serializePayloads = (arr?: Node[]) => {
      if (!includePayloads || !arr) return undefined;
      if (options?.payloadsSerializer) return options.payloadsSerializer(arr);
      if (options?.payloadMapper) return arr.map(options.payloadMapper);
      return arr;
    };

    const toJson = (
      n: {
        path: Path;
        basename: string;
        virtual?: true;
        children: Any[];
        payloads?: Node[];
      },
    ): Any => ({
      path: n.path,
      basename: n.basename,
      ...(n.virtual ? { virtual: true as const } : null),
      ...(serializePayloads(n.payloads) !== undefined
        ? { payloads: serializePayloads(n.payloads) }
        : null),
      children: (n.children as typeof n[]).map(toJson),
    });

    if (options?.path) {
      const key = forest.normalize(options.path as unknown as string) as Path;
      const node = forest.treeByPath.get(key);
      return JSON.stringify(
        node ? toJson(node as Any) : null,
        null,
        options?.space,
      );
    }

    const rootsJson = (forest.roots as Any[]).map((r) => toJson(r));
    return JSON.stringify(rootsJson, null, options?.space);
  }

  return {
    asciiTreeText,
    jsonText,
    schemas: {
      node: forest.schemas.node,
      forest: forest.schemas.forest,
    },
  };
}

// ===========================================================================
// Edges extraction (generic + strongly typed schemas)
// ===========================================================================

export function forestToEdges<Node, Path extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, Path>>>,
) {
  const edges: { parent: string; child: string }[] = [];
  const seen = new Set<string>();

  const norm = (p?: string | null) => (p ?? "").replace(/^\/+/, "");

  const rootIndexRoute = (() => {
    const roots = Array.isArray(forest?.roots) ? forest.roots : [];
    for (const n of roots) {
      if (
        typeof n?.basename === "string" &&
        n.basename.toLowerCase() === "index.sql"
      ) {
        const pp = n?.path;
        if (typeof pp === "string") return norm(pp);
      }
    }
    return null as string | null;
  })();

  const getIndexRoute = (node: Any): string | null => {
    if (
      typeof node?.basename === "string" &&
      node.basename.toLowerCase() === "index.sql"
    ) {
      const pp = node?.payloads?.[0]?.path;
      return typeof pp === "string" ? norm(pp) : null;
    }
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (const k of kids) {
      if (
        typeof k?.basename === "string" &&
        k.basename.toLowerCase() === "index.sql"
      ) {
        const pp = k?.payloads?.[0]?.path;
        if (typeof pp === "string") return norm(pp);
      }
    }
    return null;
  };

  const getPayloadRoutes = (node: Any): string[] => {
    const ps = Array.isArray(node?.payloads) ? node.payloads : [];
    const out: string[] = [];
    for (const p of ps) {
      if (typeof (p as Any)?.path === "string") {
        out.push(norm((p as Any).path));
      }
    }
    return out;
  };

  const addEdge = (parent: string | null, child: string | null) => {
    if (!parent || !child) return;
    if (parent === child) return;
    const key = `${parent}→${child}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({ parent, child });
    }
  };

  const walk = (node: Any, parentIndex: string | null) => {
    const ownIndex = getIndexRoute(node);
    const children = Array.isArray(node?.children) ? node.children : [];

    for (const childNode of children) {
      const childIndex = getIndexRoute(childNode);
      const childPayloads = getPayloadRoutes(childNode);

      if (childIndex) addEdge(parentIndex, childIndex);
      for (const ch of childPayloads) {
        if (!(childIndex && ch === childIndex)) {
          addEdge(ownIndex ?? parentIndex, ch);
        }
      }
      walk(childNode, childIndex ?? ownIndex ?? parentIndex);
    }
  };

  const roots = Array.isArray(forest?.roots) ? forest.roots : [];
  for (const root of roots) {
    const isRootIndex = typeof root?.basename === "string" &&
      root.basename.toLowerCase() === "index.sql";
    walk(root, isRootIndex ? null : rootIndexRoute);
  }

  const edgeSchema = z.object({
    parent: z.string().describe(
      "Canonical parent route (no leading '/'). Often a directory's index route.",
    ),
    child: z.string().describe(
      "Child route (no leading '/'). Either a directory's index or a file route.",
    ),
  }).strict().describe(
    "Directed edge linking canonical parent route to a child route.",
  );

  const edgesSchema = z.array(edgeSchema)
    .describe("Flat list of route edges derived from the forest.");

  return { edges, schemas: { edge: edgeSchema, edges: edgesSchema } };
}
