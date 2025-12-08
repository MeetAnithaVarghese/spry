// directive_test.ts
import { assertEquals, assertStrictEquals } from "@std/assert";
import { directivesParser } from "./directive.ts";

Deno.test("directivesCandidate common and edge cases", async (t) => {
  await t.step("explicit nature + identity when requirement is 'both'", () => {
    const { isDirective: isTextInstructionsCandidate } = directivesParser({
      perNatureRequirement: {
        PARTIAL: "both",
      },
    });

    const ok = isTextInstructionsCandidate("PARTIAL Section123");
    assertEquals(ok, { nature: "PARTIAL", identity: "Section123" });

    const missingIdentity = isTextInstructionsCandidate("PARTIAL");
    assertStrictEquals(missingIdentity, false);
  });

  await t.step(
    "nature with auto identity when requirement is 'auto' (default)",
    () => {
      const { isDirective: isTextInstructionsCandidate } = directivesParser({
        perNatureRequirement: {
          TASK: "auto",
        },
        defaultPad: 3,
      });

      const first = isTextInstructionsCandidate("TASK");
      const second = isTextInstructionsCandidate("TASK");
      const explicit = isTextInstructionsCandidate("TASK buildIndex");

      // First two TASK lines should auto-generate incrementing identities
      assertEquals(first, { nature: "TASK", identity: "000" });
      assertEquals(second, { nature: "TASK", identity: "001" });

      // Explicit identity should be preserved
      assertEquals(explicit, { nature: "TASK", identity: "buildIndex" });
    },
  );

  await t.step("identityWithNaturePrefix and per-nature padding", () => {
    const { isDirective: isTextInstructionsCandidate } = directivesParser({
      identityWithNaturePrefix: true,
      perNaturePad: {
        NOTE: 2,
      },
    });

    const first = isTextInstructionsCandidate("NOTE");
    const second = isTextInstructionsCandidate("NOTE");

    assertEquals(first, { nature: "NOTE", identity: "NOTE-00" });
    assertEquals(second, { nature: "NOTE", identity: "NOTE-01" });
  });

  await t.step(
    "per-nature defaulting: unspecified nature behaves like 'auto'",
    () => {
      const { isDirective: isTextInstructionsCandidate } = directivesParser({
        perNatureRequirement: {
          PARTIAL: "both",
          // TASK not listed, should behave as "auto"
        },
        defaultPad: 2,
      });

      // PARTIAL still requires explicit identity
      const p1 = isTextInstructionsCandidate("PARTIAL header");
      const p2 = isTextInstructionsCandidate("PARTIAL");
      assertEquals(p1, { nature: "PARTIAL", identity: "header" });
      assertStrictEquals(p2, false);

      // TASK not configured => treated as "auto"
      const t1 = isTextInstructionsCandidate("TASK");
      const t2 = isTextInstructionsCandidate("TASK");
      assertEquals(t1, { nature: "TASK", identity: "00" });
      assertEquals(t2, { nature: "TASK", identity: "01" });
    },
  );

  await t.step("whitespace handling and simple parsing", () => {
    const { isDirective: isTextInstructionsCandidate } = directivesParser();

    const spaced = isTextInstructionsCandidate("   TASK   item01   ");
    assertEquals(spaced, { nature: "TASK", identity: "item01" });

    const tabs = isTextInstructionsCandidate("\tPARTIAL\tSectionA");
    assertEquals(tabs, { nature: "PARTIAL", identity: "SectionA" });
  });

  await t.step("non-directive or malformed lines are rejected", () => {
    const { isDirective: isTextInstructionsCandidate } = directivesParser();

    // Lowercase leading token is not a NATURE
    const lower = isTextInstructionsCandidate("partial Section123");
    assertStrictEquals(lower, false);

    // Empty and whitespace-only
    const empty = isTextInstructionsCandidate("");
    const spaces = isTextInstructionsCandidate("     ");
    assertStrictEquals(empty, false);
    assertStrictEquals(spaces, false);

    // Line that starts with a non-uppercase symbol
    const symbolStart = isTextInstructionsCandidate("#PARTIAL Section");
    assertStrictEquals(symbolStart, false);
  });

  await t.step("counters are independent per nature", () => {
    const { isDirective: isTextInstructionsCandidate } = directivesParser({
      defaultPad: 2,
    });

    const p1 = isTextInstructionsCandidate("PARTIAL");
    const p2 = isTextInstructionsCandidate("PARTIAL");
    const t1 = isTextInstructionsCandidate("TASK");
    const t2 = isTextInstructionsCandidate("TASK");

    // PARTIAL counter
    assertEquals(p1, { nature: "PARTIAL", identity: "00" });
    assertEquals(p2, { nature: "PARTIAL", identity: "01" });

    // TASK counter independent of PARTIAL
    assertEquals(t1, { nature: "TASK", identity: "00" });
    assertEquals(t2, { nature: "TASK", identity: "01" });
  });

  await t.step("resetCounters clears internal state", () => {
    const { isDirective: isTextInstructionsCandidate, resetCounters } =
      directivesParser({
        defaultPad: 2,
      });

    const beforeReset = isTextInstructionsCandidate("TASK");
    assertEquals(beforeReset, { nature: "TASK", identity: "00" });

    resetCounters();

    const afterReset = isTextInstructionsCandidate("TASK");
    // After reset, counter starts from 0 again
    assertEquals(afterReset, { nature: "TASK", identity: "00" });
  });
});
