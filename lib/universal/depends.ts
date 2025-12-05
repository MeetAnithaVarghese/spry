/**
 * Options to customize dependency resolution.
 *
 * Only two knobs:
 * - `getId`: how to get the node's id/name
 * - `getImplicit`: how to get regex sources for implicit deps
 */
export type DepResolverOptions<Node> = {
  getId: (node: Node) => string;
  getImplicit: (node: Node) => readonly string[] | undefined;
};

/**
 * Build a resolver for implicit + explicit dependencies from a set of nodes.
 */
export function depsResolver<Node extends WeakKey>(
  nodes: Iterable<Node>,
  options: DepResolverOptions<Node>,
) {
  const { getId, getImplicit } = options;

  const compiledCache = new WeakMap<
    Node,
    { regexes: readonly RegExp[]; badSources: readonly string[] }
  >();

  function getCompiledForNode(node: Node) {
    const cached = compiledCache.get(node);
    if (cached) return cached;

    const sources = getImplicit(node) ?? [];
    const regexes: RegExp[] = [];
    const badSources: string[] = [];

    for (const source of sources) {
      try {
        regexes.push(new RegExp(source));
      } catch {
        badSources.push(source);
      }
    }

    const compiled = { regexes, badSources };
    compiledCache.set(node, compiled);
    return compiled;
  }

  /**
   * Find tasks that should be *implicitly* depended on by `taskId`.
   */
  function implicitDeps(
    taskId: string,
    taskDeps: readonly string[] = [],
  ) {
    const implicit: string[] = [];
    const errors: { taskId: string; regEx: string }[] = [];

    const safeTaskDeps = Array.isArray(taskDeps) ? taskDeps : [];

    for (const node of nodes) {
      const { regexes, badSources } = getCompiledForNode(node);
      if (regexes.length === 0 && badSources.length === 0) continue;

      const nodeId = getId(node);

      for (const bad of badSources) {
        errors.push({ taskId: nodeId, regEx: bad });
      }

      let matches = false;
      for (const re of regexes) {
        if (re.test(taskId)) {
          matches = true;
          break;
        }
      }

      if (!matches) continue;

      if (!safeTaskDeps.includes(nodeId) && !implicit.includes(nodeId)) {
        implicit.push(nodeId);
      }
    }

    return { implicit, errors };
  }

  /**
   * Returns merged explicit + implicit deps for a given task.
   */
  function deps(
    taskId: string,
    taskDeps: readonly string[] | undefined,
    cellDepsCache?: Map<string, string[]>,
  ) {
    if (cellDepsCache) {
      const cached = cellDepsCache.get(taskId);
      if (cached) return cached;
    }

    const explicit = taskDeps ?? [];
    const { implicit } = implicitDeps(taskId, explicit);
    const merged = Array.from(new Set([...implicit, ...explicit]));

    cellDepsCache?.set(taskId, merged);
    return merged;
  }

  /**
   * Cycle detection over explicit + implicit deps.
   */
  function detectCycles(
    allTaskIds: Iterable<string>,
    getExplicitDeps: (taskId: string) => readonly string[] | undefined,
    cellDepsCache?: Map<string, string[]>,
  ): string[][] {
    const Color = {
      Unvisited: 0,
      Visiting: 1,
      Visited: 2,
    } as const;

    const color = new Map<string, number>();
    const cycles: string[][] = [];
    const stack: string[] = [];

    const getDepsFor = (taskId: string): readonly string[] =>
      deps(taskId, getExplicitDeps(taskId), cellDepsCache);

    function dfs(taskId: string) {
      const state = color.get(taskId) ?? Color.Unvisited;
      if (state === Color.Visiting) {
        const idx = stack.indexOf(taskId);
        if (idx !== -1) cycles.push(stack.slice(idx));
        return;
      }
      if (state === Color.Visited) return;

      color.set(taskId, Color.Visiting);
      stack.push(taskId);

      for (const dep of getDepsFor(taskId)) {
        dfs(dep);
      }

      stack.pop();
      color.set(taskId, Color.Visited);
    }

    for (const id of allTaskIds) {
      if ((color.get(id) ?? Color.Unvisited) === Color.Unvisited) {
        dfs(id);
      }
    }

    return cycles;
  }

  return {
    implicitDeps,
    deps,
    detectCycles,
  };
}
