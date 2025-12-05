// Minimal, generic helper for attaching strongly-typed values
// into a node's `data` bag without prescribing its overall shape.

/**
 * Create a typed accessor for a `data[key]` slot on arbitrary nodes.
 *
 * @example
 *   const partialBag = dataBag<"partial", MyPartial>("partial");
 *   if (partialBag.is(node)) {
 *     // node.data.partial is now known to be MyPartial
 *   }
 */
export function dataBag<
  Key extends string,
  Value,
  Node extends { data?: unknown },
>(
  key: Key,
  onInit?: (node: Node, key: Key) => Value,
) {
  const ensureNodeData = (node: Node) => {
    if (node.data && typeof node.data === "object") {
      return node.data as Record<string, unknown>;
    }
    const bag: Record<string, unknown> = {};
    node.data = bag;
    return bag;
  };

  const is = (
    node: Node,
  ): node is Node & {
    data: Record<string, unknown> & { [P in Key]: Value };
  } => {
    let bag: Record<string, unknown> | undefined;

    if (node.data && typeof node.data === "object") {
      bag = node.data as Record<string, unknown>;
    }

    const existing = bag?.[key];

    if (existing !== undefined) return true;

    if (!onInit) return false;

    const data = ensureNodeData(node);
    const value = onInit(node, key);
    data[key] = value as unknown as Value;
    return true;
  };

  const attach = (node: Node, value: Value): void => {
    const bag = ensureNodeData(node);
    bag[key] = value as unknown as Value;
  };

  return { is, attach } as const;
}
