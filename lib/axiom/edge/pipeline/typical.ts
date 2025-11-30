import { toMarkdown } from "mdast-util-to-markdown";
import type { Heading, Paragraph, Root } from "types/mdast";
import type { Node } from "types/unist";
import { queryPosixPI } from "../../../universal/posix-pi.ts";
import { codeFrontmatter } from "../../mdast/code-frontmatter.ts";
import { headingText } from "../../mdast/node-content.ts";
import { type GraphEdgesTree, graphEdgesTree } from "../../projection/tree.ts";
import { isCodePartial } from "../../remark/code-partial.ts";
import { GraphEdge } from "../orchestrate.ts";
import {
  containedInSectionRule,
  createGraphRulesBuilder,
  frontmatterClassificationRule,
  headingLikeNodeDataBag,
  isBoldSingleLineParagraph,
  isColonSingleLineParagraph,
  IsSectionContainer,
  nodeDependencyRule,
  nodesClassificationRule,
  RuleContext,
  sectionFrontmatterRule,
  sectionSemanticIdRule,
  selectedNodesClassificationRule,
} from "../rule/mod.ts";

export type TypicalRelationship = string;

export type TypicalGraphEdge = GraphEdge<TypicalRelationship>;
export type TypicalRuleCtx = RuleContext;

// -----------------------------------------------------------------------------
// Section container callback (headings + heading-like paragraphs)
// -----------------------------------------------------------------------------

const headingLikeSectionContainer: IsSectionContainer = (node: Node) => {
  if (node.type === "heading") {
    return {
      nature: "heading" as const,
      label: headingText(node),
      mdLabel: toMarkdown(node as Heading),
    };
  }

  if (node.type !== "paragraph") return false;

  const candidate = isBoldSingleLineParagraph(node as Paragraph) ??
    isColonSingleLineParagraph(node as Paragraph);

  if (!candidate) return false;

  headingLikeNodeDataBag.attach(node, true);
  return {
    nature: "section" as const,
    ...candidate,
  };
};

export function typicalRules() {
  const builder = createGraphRulesBuilder<
    TypicalRelationship,
    TypicalRuleCtx,
    TypicalGraphEdge
  >();

  return builder
    .use(
      containedInSectionRule<
        TypicalRelationship,
        TypicalRuleCtx,
        TypicalGraphEdge
      >("containedInSection", headingLikeSectionContainer),
    )
    .use(
      sectionFrontmatterRule<
        TypicalRelationship,
        TypicalRuleCtx,
        TypicalGraphEdge
      >("frontmatter", ["containedInSection"] as TypicalRelationship[]),
    )
    .use(
      sectionSemanticIdRule<
        TypicalRelationship,
        TypicalRuleCtx,
        TypicalGraphEdge
      >("sectionSemanticId", ["containedInSection"] as TypicalRelationship[]),
    )
    .use(
      frontmatterClassificationRule<
        TypicalRelationship,
        TypicalRuleCtx,
        TypicalGraphEdge
      >("doc-classify"),
    )
    .use(
      selectedNodesClassificationRule<
        TypicalRelationship,
        TypicalRuleCtx,
        TypicalGraphEdge
      >("emphasis", "isImportant"),
    )
    .use(
      nodesClassificationRule<
        TypicalRelationship,
        TypicalRuleCtx,
        TypicalGraphEdge
      >("isCode", (node) => node.type === "code"),
    )
    .use(
      nodesClassificationRule<
        TypicalRelationship,
        TypicalRuleCtx,
        TypicalGraphEdge
      >("isPartial", (node) => isCodePartial(node) ? true : false),
    )
    .use(
      nodesClassificationRule<
        TypicalRelationship,
        TypicalRuleCtx,
        TypicalGraphEdge
      >("isTask", (node) => node.type === "listItem"),
    )
    .use(
      nodeDependencyRule<TypicalRelationship, TypicalRuleCtx, TypicalGraphEdge>(
        "codeDependsOn",
        (node): boolean => node.type === "code",
        (node, name): boolean => {
          const codeFM = codeFrontmatter(node);
          if (!codeFM) return false;
          return codeFM.pi.pos[0] == name;
        },
        (node) => {
          const codeFM = codeFrontmatter(node);
          if (!codeFM) return false;
          const qf = queryPosixPI(codeFM.pi);
          const deps = qf.getTextFlagValues("dep");
          return deps.length > 0 ? deps : false;
        },
      ),
    )
    .build();
}

// -----------------------------------------------------------------------------
// Build GraphEdgesTree for one markdown Root using `containedInSection`
// -----------------------------------------------------------------------------

export function buildGraphTreeForRoot(
  _root: Root,
  edges: TypicalGraphEdge[],
): GraphEdgesTree<TypicalRelationship, TypicalGraphEdge> {
  return graphEdgesTree<TypicalRelationship, TypicalGraphEdge>(edges, {
    relationships: ["containedInSection"],
  });
}
