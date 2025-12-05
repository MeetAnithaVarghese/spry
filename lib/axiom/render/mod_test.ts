import { assertEquals } from "@std/assert";
import { renderer } from "../../universal/render.ts";
import { CodeFrontmatter, codeFrontmatter } from "../mdast/code-frontmatter.ts";
import {
  Executable,
  Materializable,
  playbooksFromFiles,
} from "../projection/playbook.ts";
import { renderStrategy } from "./mod.ts";

const executableIDs = ["init", "prime"] as const;
type ExecutableID = typeof executableIDs[number];

const materializableIDs = [
  "path1/name.txt",
  "admin/name.txt",
  "admin/name.md",
  "admin/home.txt",
  "debug.txt",
] as const;
type MaterializableID = typeof materializableIDs[number];

const injectableIDs = ["admin-layout", "global-layout"] as const;
type InjectableID = typeof injectableIDs[number];

const partialIDs = ["greet-user", "global-layout", "admin-layout"] as const;
type PartialID = typeof partialIDs[number];

Deno.test(
  "markdown-driven partials, interpolation, and injection (via playbooksFromFiles)",
  async (t) => {
    const fixtureUrl = new URL("./mod_test.ts-fixture01.md", import.meta.url);
    const pbff = await playbooksFromFiles([fixtureUrl.pathname]);
    const { directives } = pbff;

    const rs = renderStrategy(directives, {
      globals: {
        siteName: "Synthetic1",
        mdHelpers: {
          link(text: string, url: string): string {
            return `[${text}](${url})`;
          },
        },
      },
    });
    const r = renderer(rs);

    await t.step("expected mdast Code nodes", () => {
      const { executablesById, materializablesById } = pbff;
      assertEquals(Object.keys(executablesById), [...executableIDs]);
      assertEquals(Object.keys(materializablesById), [...materializableIDs]);
    });

    await t.step("expected directives", () => {
      assertEquals(
        directives.map((d) => `${d.lang} ${d.directive}:${d.identity}`),
        [
          "yaml META:0000",
          "text HEAD:0000",
          "markdown HEAD:0001",
          "md PARTIAL:greet-user",
          "md PARTIAL:global-layout",
          "md PARTIAL:admin-layout",
          "text TAIL:0000",
        ],
      );
    });

    await t.step("expected injectables from directives", async () => {
      const injectables = rs.memory.injectables?.();
      assertEquals(
        (await Array.fromAsync(injectables!)).map(([key]) => key),
        [...injectableIDs],
      );
    });

    await t.step("expected partials from directives", async () => {
      assertEquals(
        (await Array.fromAsync(Object.entries(rs.memory.partials))).map((
          [key],
        ) => key),
        [...partialIDs],
      );
    });

    const _executablesById = pbff.executablesById as Record<
      ExecutableID,
      Executable
    >;

    const materializablesById = pbff.materializablesById as Record<
      MaterializableID,
      Materializable
    >;
    const _materializablesCodeFM = Object.entries(materializablesById).reduce(
      (acc, [key, value]) => {
        acc[key as MaterializableID] = codeFrontmatter(
          value,
        ) as CodeFrontmatter; // strip null from `CodeFrontmatter | null`
        return acc;
      },
      {} as Record<MaterializableID, CodeFrontmatter>,
    );

    await t.step("simple interpolation", async () => {
      const { results } = await r.renderAll([
        materializablesById["path1/name.txt"],
        materializablesById["admin/name.txt"],
        materializablesById["admin/name.md"],
      ]);
      assertEquals(results, [
        {
          text: "# global layout (injected for any path)\n" +
            "This text will be interpolated: 6 = 6;\n" +
            "-- also test nested expression: 6 = 6",
          mutation: "mutated",
          error: undefined,
        },
        {
          text: "# global layout (injected for any path)\n" +
            "## admin layout (injected for any admin/* paths)\n" +
            "This text will be interpolated but will result in no mutations though it will\n" +
            "get injections from the global PARTIAL.",
          mutation: "mutated",
          error: undefined,
        },
        {
          text: "# global layout (injected for any path)\n" +
            "## admin layout (injected for any admin/* paths)\n" +
            "This text will be interpolated: **5** = 5;\n" + "\n" +
            "- [ ] confirm locals are visible: site = Synthetic1",
          mutation: "mutated",
          error: undefined,
        },
      ]);
    });
  },
);
