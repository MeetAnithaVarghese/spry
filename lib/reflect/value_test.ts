import { assertEquals } from "@std/assert";
import {
  detectedValueNature,
  TransformArrayValuesStream,
  TransformObjectValuesStream,
} from "./value.ts";

Deno.test("determineType function", () => {
  assertEquals(detectedValueNature("true").nature, "boolean");
  assertEquals(detectedValueNature("on").nature, "boolean");
  assertEquals(detectedValueNature("yes").nature, "boolean");
  assertEquals(detectedValueNature("false").nature, "boolean");
  assertEquals(detectedValueNature("off").nature, "boolean");
  assertEquals(detectedValueNature("no").nature, "boolean");
  assertEquals(detectedValueNature("123").nature, "number");
  assertEquals(detectedValueNature("123n").nature, "bigint");
  assertEquals(detectedValueNature("{Red}").nature, "union");
  assertEquals(detectedValueNature("2022-01-01").nature, "Date");
  assertEquals(detectedValueNature("John Doe").nature, "string");
});

Deno.test("TransformObjectValuesStream class", async () => {
  type Input = { age: string; name: string; isStudent: string };
  type Output = { age: number; name: string; isStudent: boolean };

  const stream = new TransformObjectValuesStream<Input, Output>();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const inputData: Input[] = [
    { age: "25", name: "John", isStudent: "true" },
    { age: "30", name: "Jane", isStudent: "false" },
    { age: "28", name: "Doe", isStudent: "true" },
  ];

  const expectedOutput: Output[] = [
    { age: 25, name: "John", isStudent: true },
    { age: 30, name: "Jane", isStudent: false },
    { age: 28, name: "Doe", isStudent: true },
  ];

  for (const data of inputData) {
    writer.write(data);
  }
  writer.close();

  for (const expected of expectedOutput) {
    const result = await reader.read();
    assertEquals(result.value, expected);
  }
});

Deno.test("TransformArrayValuesStream class", async () => {
  type Input = [string, string, string];
  type Output = [number, string, boolean];

  const stream = new TransformArrayValuesStream<Input, Output>();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const inputData: Input[] = [
    ["25", "John", "true"],
    ["30", "Jane", "false"],
    ["28", "Doe", "true"],
  ];

  const expectedOutput: Output[] = [
    [25, "John", true],
    [30, "Jane", false],
    [28, "Doe", true],
  ];

  for (const data of inputData) {
    writer.write(data);
  }
  writer.close();

  for (const expected of expectedOutput) {
    const result = await reader.read();
    assertEquals(result.value, expected);
  }
});
