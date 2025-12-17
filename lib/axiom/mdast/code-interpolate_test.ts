import { assertEquals } from "@std/assert";
import { renderer } from "../../universal/render.ts";
import { codeInterpolationStrategy } from "./code-interpolate.ts";
import {
  Executable,
  Materializable,
  playbooksFromFiles,
} from "../projection/playbook.ts";
import { CodeFrontmatter, codeFrontmatter } from "./code-frontmatter.ts";

const executableIDs = ["init", "prime"] as const;
type ExecutableID = typeof executableIDs[number];

const materializableIDs = [
  "path1/name.txt",
  "admin/name.txt",
  "admin/name.md",
  "admin/home.txt",
  "debug.txt",
  "index.sql",
  "api/ambulatory-glucose-profile/index.sql",
  "../sqlpage/templates/gri_component.handlebars",
] as const;
type MaterializableID = typeof materializableIDs[number];

const injectableIDs = [
  "admin-layout",
  "api-head.sql",
  "handlebars.sql",
  "global-layout",
] as const;
type InjectableID = typeof injectableIDs[number];

const partialIDs = [
  "greet-user",
  "global-layout",
  "admin-layout",
  "api-head.sql",
  "handlebars.sql",
] as const;
type PartialID = typeof partialIDs[number];

Deno.test(
  "markdown-driven partials, interpolation, and injection (via playbooksFromFiles)",
  async (t) => {
    const fixtureUrl = new URL(
      "./code-interpolate_test.ts-fixture01.md",
      import.meta.url,
    );
    const pbff = await playbooksFromFiles([fixtureUrl.pathname]);
    const { directives } = pbff;

    const rs = codeInterpolationStrategy(directives, {
      approach: "safety-first",
      globals: {
        siteName: "Synthetic1",
        md: {
          link(text: string, url: string): string {
            return `[${text}](${url})`;
          },
        },
      },
      safeFunctions: {
        unsafeEval: ([code]) => eval(String(code)),
        mdLink: ([text, url]) => `[${text}](${url})`,
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
          "code DEFAULTS:0000",
          "yaml META:0000",
          "text HEAD:0000",
          "markdown HEAD:0001",
          "md PARTIAL:greet-user",
          "md PARTIAL:global-layout",
          "md PARTIAL:admin-layout",
          "sql PARTIAL:api-head.sql",
          "sql PARTIAL:handlebars.sql",
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
      const d = await r.diagnostics(Object.values(pbff.materializablesById));
      assertEquals(d.injectables?.map((i) => i[0]), [
        "admin-layout",
        "api-head.sql",
        "handlebars.sql",
        "global-layout",
      ]);
      assertEquals(d.injectDiags, [
        {
          target: "path1/name.txt",
          inject: true,
          why: "PARTIAL global-layout: not re:/^api/)",
          how: "prepend",
          weight: 0,
        },
        {
          target: "admin/name.txt",
          inject: true,
          why: "PARTIAL admin-layout: re:/^admin/)",
          how: "prepend",
          weight: 100,
        },
        {
          target: "admin/name.txt",
          inject: true,
          why: "PARTIAL global-layout: not re:/^api/)",
          how: "prepend",
          weight: 0,
        },
        {
          target: "admin/name.md",
          inject: true,
          why: "PARTIAL admin-layout: re:/^admin/)",
          how: "prepend",
          weight: 100,
        },
        {
          target: "admin/name.md",
          inject: true,
          why: "PARTIAL global-layout: not re:/^api/)",
          how: "prepend",
          weight: 0,
        },
        {
          target: "admin/home.txt",
          inject: true,
          why: "PARTIAL admin-layout: re:/^admin/)",
          how: "prepend",
          weight: 100,
        },
        {
          target: "admin/home.txt",
          inject: true,
          why: "PARTIAL global-layout: not re:/^api/)",
          how: "prepend",
          weight: 0,
        },
        {
          target: "debug.txt",
          inject: true,
          why: "PARTIAL global-layout: not re:/^api/)",
          how: "prepend",
          weight: 0,
        },
        {
          target: "index.sql",
          inject: true,
          why: "PARTIAL global-layout: not re:/^api/)",
          how: "prepend",
          weight: 0,
        },
        {
          target: "api/ambulatory-glucose-profile/index.sql",
          inject: true,
          why: "PARTIAL api-head.sql: re:/^api/)",
          how: "prepend",
          weight: 99,
        },
        {
          target: "api/ambulatory-glucose-profile/index.sql",
          inject: true,
          why: "PARTIAL global-layout: not re:/.handlebars$/)",
          how: "prepend",
          weight: 0,
        },
        {
          target: "../sqlpage/templates/gri_component.handlebars",
          inject: true,
          why: "PARTIAL global-layout: not re:/^api/)",
          how: "prepend",
          weight: 0,
        },
      ]);
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
          injectedTmpls: [
            {
              path: "path1/name.txt",
              templateName: "global-layout",
            },
          ],
        },
        {
          text: "# global layout (injected for any path)\n" +
            "## admin layout (injected for any admin/* paths)\n" +
            "This text will be interpolated but will result in no mutations though it will\n" +
            "get injections from the global PARTIAL.",
          mutation: "mutated",
          error: undefined,
          injectedTmpls: [
            {
              path: "admin/name.txt",
              templateName: "admin-layout",
            },
            {
              path: "admin/name.txt",
              templateName: "global-layout",
            },
          ],
        },
        {
          text: "# global layout (injected for any path)\n" +
            "## admin layout (injected for any admin/* paths)\n" +
            "This text will be interpolated: **5** = 5;\n" + "\n" +
            "- [ ] confirm locals are visible: site = Synthetic1",
          mutation: "mutated",
          error: undefined,
          injectedTmpls: [
            {
              path: "admin/name.md",
              templateName: "admin-layout",
            },
            {
              path: "admin/name.md",
              templateName: "global-layout",
            },
          ],
        },
      ]);
    });

    await t.step("exercise multiple interpolation types", async () => {
      const result = await r.renderOne(materializablesById["debug.txt"]);
      assertEquals(result.error, undefined);
      assertEquals(result.text, debugTxtGolden);
    });
  },
);

const debugTxtGolden = `# global layout (injected for any path)
markdown link: [demo](https://example.com) (comes from "safeFunctions")
siteName: Synthetic1 (comes from "globals")

- missing partial:
partial "non-existent" not found (available: 'greet-user', 'global-layout', 'admin-layout', 'api-head.sql', 'handlebars.sql')

- greet-user with wrong args:
partial "greet-user" arguments invalid: ✖ Invalid input: expected string, received undefined
  → at userName)

- greet-user with correct args:
# PARTIAL greet-user

- path: debug.txt
- userName: Debug User
- mood: alert

- greet-user with correct args using unsafe interpolator:
partial "greet-user" arguments invalid: ✖ Invalid input: expected string, received undefined
  → at userName)
# PARTIAL greet-user

- path: debug.txt
- userName: Zoya
- mood: cheerful

- full ctx (unsafe):
{"siteName":"Synthetic1","md":{}}

- captured/memoized (synonyms):
-----
# global layout (injected for any path)
## admin layout (injected for any admin/* paths)
This text will be interpolated: **5** = 5;

- [ ] confirm locals are visible: site = Synthetic1
-----

====
# global layout (injected for any path)
## admin layout (injected for any admin/* paths)
This text will be interpolated: **5** = 5;

- [ ] confirm locals are visible: site = Synthetic1
====
`.trim();
