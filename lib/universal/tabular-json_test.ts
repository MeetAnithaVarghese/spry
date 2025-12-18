import { z } from "@zod/zod";
import {
  arrowStyleSqlFieldAccessSqlSupplier,
  dotStyleSqlFieldAccessSqlSupplier,
  snakeCaseColumnSupplier,
  TabularJson,
} from "./tabular-json.ts";
import { unindentWhitespace } from "./tmpl-literal-aide.ts";
import { assertEquals } from "@std/assert/equals";
import { assert } from "@std/assert";

// Define a synthetic, complex JSON shape with multiple levels of nesting
const syntheticShape = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number(),
  address: z.object({
    street: z.string(),
    city: z.string(),
    zipcode: z.string(),
    geo: z.object({
      lat: z.number(),
      lng: z.number(),
    }),
  }),
  hobbies: z.array(z.string()),
  isActive: z.boolean(),
  metadata: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    history: z.array(
      z.object({
        date: z.string(),
        action: z.string(),
      }),
    ),
  }),
  preferences: z.object({
    notifications: z.object({
      email: z.boolean(),
      sms: z.boolean(),
    }),
  }),
});

Deno.test("tabularJs - should handle flattenArrays option correctly", async (tc) => {
  const tabularJson = new TabularJson(syntheticShape)
    .columnSupplier(snakeCaseColumnSupplier)
    .schemaColumns({
      // rename/define these specific fields differently than defaults
      id: { name: "identity" },
      address: {
        zipcode: {
          name: "postal_code",
        },
      },
    });

  const data = {
    id: "123",
    name: "John Doe",
    age: 30,
    address: {
      street: "123 Main St",
      city: "Anytown",
      zipcode: "12345",
      geo: {
        lat: 40.7128,
        lng: -74.0060,
      },
    },
    hobbies: ["reading", "gaming"],
    isActive: true,
    metadata: {
      createdAt: "2021-01-01T00:00:00Z",
      updatedAt: "2021-01-02T00:00:00Z",
      history: [
        { date: "2021-01-01", action: "created" },
        { date: "2021-01-02", action: "updated" },
      ],
    },
    preferences: {
      notifications: {
        email: true,
        sms: false,
      },
    },
  };

  // deno-lint-ignore require-await
  await tc.step("flattenArrays: true", async () => {
    const flattened = tabularJson.tabularJs({ flattenArrays: true })(data);

    assertEquals(flattened["identity"], "123"); // 'id' renamed 'identity'
    assertEquals(flattened["address_street"], "123 Main St");
    assertEquals(flattened["metadata_created_at"], "2021-01-01T00:00:00Z");
    assertEquals(flattened["hobbies_0"], "reading");
    assertEquals(flattened["hobbies_1"], "gaming");
    assertEquals(flattened["is_active"], true);
    assertEquals(flattened["address_geo_lat"], 40.7128);
    assertEquals(flattened["metadata_history_0_date"], "2021-01-01");
    assertEquals(flattened["metadata_history_0_action"], "created");
    assertEquals(flattened["metadata_history_1_date"], "2021-01-02");
    assertEquals(flattened["metadata_history_1_action"], "updated");
    assertEquals(flattened["preferences_notifications_email"], true);
    assertEquals(flattened["preferences_notifications_sms"], false);
  });

  // deno-lint-ignore require-await
  await tc.step("flattenArrays: false", async () => {
    const flattened = tabularJson.tabularJs({ flattenArrays: false })(data);

    assertEquals(flattened["identity"], "123"); // 'id' renamed 'identity'
    assertEquals(flattened["address_street"], "123 Main St");
    assertEquals(flattened["metadata_created_at"], "2021-01-01T00:00:00Z");
    assertEquals(flattened["hobbies"], ["reading", "gaming"]);
    assertEquals(flattened["is_active"], true);
    assertEquals(flattened["address_geo_lat"], 40.7128);
    assertEquals(flattened["metadata_history"], [
      { date: "2021-01-01", action: "created" },
      { date: "2021-01-02", action: "updated" },
    ]);
    assertEquals(flattened["preferences_notifications_email"], true);
    assertEquals(flattened["preferences_notifications_sms"], false);
  });
});

Deno.test("tabularSqlView - should generate correct SQL for complex shape with arrow accessors", () => {
  // Initialize the TabularJson with the synthetic shape
  const tabularJson = new TabularJson(syntheticShape)
    .columnSupplier(snakeCaseColumnSupplier)
    .schemaColumns({
      // optionally rename/define these specific fields differently than defaults
      address: {
        zipcode: {
          name: "postal_code",
        },
      },
    })
    .jsonFieldAccessSql(arrowStyleSqlFieldAccessSqlSupplier);

  const viewName = "user_view";
  const sqlSelect = "SELECT * FROM users";
  const jsonColumnNameInCTE = "data";

  const { createDDL, dropDDL } = tabularJson.tabularSqlView(
    viewName,
    sqlSelect,
    jsonColumnNameInCTE,
    false,
  );

  assertEquals(dropDDL(), "DROP VIEW IF EXISTS user_view;");
  assertEquals(
    createDDL(),
    unindentWhitespace(`
        CREATE VIEW user_view AS
            WITH jsonSupplierCTE AS (
                SELECT * FROM users
            )
            SELECT
                data ->> 'id' AS id,
                data ->> 'name' AS name,
                data ->> 'age' AS age,
                data -> 'address' ->> 'street' AS address_street,
                data -> 'address' ->> 'city' AS address_city,
                data -> 'address' ->> 'zipcode' AS postal_code,
                data -> 'address' -> 'geo' ->> 'lat' AS address_geo_lat,
                data -> 'address' -> 'geo' ->> 'lng' AS address_geo_lng,
                data ->> 'isActive' AS is_active,
                data -> 'metadata' ->> 'createdAt' AS metadata_created_at,
                data -> 'metadata' ->> 'updatedAt' AS metadata_updated_at,
                data -> 'metadata' -> 'history' ->> 'date' AS metadata_history_date,
                data -> 'metadata' -> 'history' ->> 'action' AS metadata_history_action,
                data -> 'preferences' -> 'notifications' ->> 'email' AS preferences_notifications_email,
                data -> 'preferences' -> 'notifications' ->> 'sms' AS preferences_notifications_sms
            FROM jsonSupplierCTE;`),
  );
});

Deno.test("tabularSqlView - should generate correct SQL for complex shape with dot accessor", () => {
  // Initialize the TabularJson with the synthetic shape
  const tabularJson = new TabularJson(syntheticShape)
    .columnSupplier(snakeCaseColumnSupplier)
    .schemaColumns({
      // optionally rename/define these specific fields differently than defaults
      address: {
        zipcode: {
          name: "postal_code",
        },
      },
    })
    .jsonFieldAccessSql(dotStyleSqlFieldAccessSqlSupplier);

  const viewName = "user_view";
  const sqlSelect = "SELECT * FROM users";
  const jsonColumnNameInCTE = "data";

  const { createDDL, dropDDL } = tabularJson.tabularSqlView(
    viewName,
    sqlSelect,
    jsonColumnNameInCTE,
    false,
  );

  assertEquals(dropDDL(), "DROP VIEW IF EXISTS user_view;");
  assertEquals(
    createDDL(),
    unindentWhitespace(`
        CREATE VIEW user_view AS
            WITH jsonSupplierCTE AS (
                SELECT * FROM users
            )
            SELECT
                data ->> '$.id' AS id,
                data ->> '$.name' AS name,
                data ->> '$.age' AS age,
                data ->> '$.address.street' AS address_street,
                data ->> '$.address.city' AS address_city,
                data ->> '$.address.zipcode' AS postal_code,
                data ->> '$.address.geo.lat' AS address_geo_lat,
                data ->> '$.address.geo.lng' AS address_geo_lng,
                data ->> '$.isActive' AS is_active,
                data ->> '$.metadata.createdAt' AS metadata_created_at,
                data ->> '$.metadata.updatedAt' AS metadata_updated_at,
                data ->> '$.metadata.history.date' AS metadata_history_date,
                data ->> '$.metadata.history.action' AS metadata_history_action,
                data ->> '$.preferences.notifications.email' AS preferences_notifications_email,
                data ->> '$.preferences.notifications.sms' AS preferences_notifications_sms
            FROM jsonSupplierCTE;`),
  );
});

Deno.test("tabular-json - FHIR Patient shape (flatten + SQL DDL)", async (tc) => {
  // Define the FHIR Patient resource shape using Zod
  const fhirPatientResourceShape = z.object({
    id: z.string(),
    identifier: z.array(z.object({
      use: z.string().optional(),
      type: z.object({
        coding: z.array(z.object({
          system: z.string().optional(),
          code: z.string().optional(),
          display: z.string().optional(),
        })).optional(),
        text: z.string().optional(),
      }).optional(),
      system: z.string().optional(),
      value: z.string().optional(),
    })),
    name: z.array(z.object({
      use: z.string().optional(),
      family: z.string().optional(),
      given: z.array(z.string()).optional(),
      prefix: z.array(z.string()).optional(),
      suffix: z.array(z.string()).optional(),
    })),
    gender: z.enum(["male", "female", "other", "unknown"]).optional(),
    birthDate: z.string().optional(),
    address: z.array(z.object({
      use: z.string().optional(),
      type: z.string().optional(),
      text: z.string().optional(),
      line: z.array(z.string()).optional(),
      city: z.string().optional(),
      district: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })),
    contact: z.array(z.object({
      relationship: z.array(z.object({
        coding: z.array(z.object({
          system: z.string().optional(),
          code: z.string().optional(),
          display: z.string().optional(),
        })).optional(),
        text: z.string().optional(),
      })).optional(),
      name: z.object({
        family: z.string().optional(),
        given: z.array(z.string()).optional(),
      }).optional(),
      telecom: z.array(z.object({
        system: z.string().optional(),
        value: z.string().optional(),
        use: z.string().optional(),
      })).optional(),
      address: z.object({
        use: z.string().optional(),
        type: z.string().optional(),
        text: z.string().optional(),
        line: z.array(z.string()).optional(),
        city: z.string().optional(),
        district: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional(),
      }).optional(),
      gender: z.enum(["male", "female", "other", "unknown"]).optional(),
      organization: z.object({
        reference: z.string().optional(),
        display: z.string().optional(),
      }).optional(),
    })).optional(),
  });

  const samplePatient = {
    id: "patient-123",
    identifier: [{
      use: "official",
      system: "http://hospital.org/mrn",
      value: "12345",
    }],
    name: [{
      family: "Doe",
      given: ["John"],
    }],
    gender: "male",
    birthDate: "1974-12-25",
    address: [{
      use: "home",
      line: ["123 Main St"],
      city: "Anytown",
      postalCode: "12345",
      country: "USA",
    }],
    contact: [{
      relationship: [{
        coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v2-0131",
          code: "N",
          display: "Next of Kin",
        }],
        text: "Next of Kin",
      }],
      name: {
        family: "Smith",
        given: ["Jane"],
      },
      telecom: [{
        system: "phone",
        value: "555-1234",
        use: "home",
      }],
      address: {
        line: ["456 Another St"],
        city: "Somewhere",
        postalCode: "67890",
        country: "USA",
      },
      gender: "female",
    }],
  };

  await tc.step(
    "tabularJs: flattenArrays=true produces indexed columns and preserves key fields",
    () => {
      const tabularJson = new TabularJson(fhirPatientResourceShape)
        .columnSupplier(snakeCaseColumnSupplier);

      const flattenJs = tabularJson.tabularJs({ flattenArrays: true });
      const flatData = flattenJs(samplePatient);

      assertEquals(flatData["id"], "patient-123");

      // Arrays should be flattened with stable index suffixes.
      assertEquals(flatData["identifier_0_use"], "official");
      assertEquals(flatData["identifier_0_system"], "http://hospital.org/mrn");
      assertEquals(flatData["identifier_0_value"], "12345");

      assertEquals(flatData["name_0_family"], "Doe");
      assertEquals(flatData["name_0_given_0"], "John");

      assertEquals(flatData["gender"], "male");
      assertEquals(flatData["birth_date"], "1974-12-25");

      assertEquals(flatData["address_0_city"], "Anytown");
      assertEquals(flatData["address_0_postal_code"], "12345");
      assertEquals(flatData["address_0_country"], "USA");

      // Deep nested arrays within optional contact subtree.
      assertEquals(flatData["contact_0_name_family"], "Smith");
      assertEquals(flatData["contact_0_name_given_0"], "Jane");
      assertEquals(flatData["contact_0_telecom_0_system"], "phone");
      assertEquals(flatData["contact_0_telecom_0_value"], "555-1234");
      assertEquals(flatData["contact_0_address_city"], "Somewhere");
      assertEquals(flatData["contact_0_address_postal_code"], "67890");

      // Very deep: relationship -> coding -> [0] fields
      assertEquals(
        flatData["contact_0_relationship_0_coding_0_system"],
        "http://terminology.hl7.org/CodeSystem/v2-0131",
      );
      assertEquals(flatData["contact_0_relationship_0_coding_0_code"], "N");
      assertEquals(
        flatData["contact_0_relationship_0_coding_0_display"],
        "Next of Kin",
      );
    },
  );

  await tc.step(
    "tabularJs: flattenArrays=false preserves arrays as-is at array fields",
    () => {
      const tabularJson = new TabularJson(fhirPatientResourceShape)
        .columnSupplier(snakeCaseColumnSupplier);

      const flattenJs = tabularJson.tabularJs({ flattenArrays: false });
      const flatData = flattenJs(samplePatient);

      assertEquals(flatData["id"], "patient-123");

      // Array fields should remain arrays when flattenArrays=false.
      assertEquals(flatData["identifier"], samplePatient.identifier);
      assertEquals(flatData["name"], samplePatient.name);
      assertEquals(flatData["address"], samplePatient.address);
      assertEquals(flatData["contact"], samplePatient.contact);

      // Scalars still present
      assertEquals(flatData["gender"], "male");
      assertEquals(flatData["birth_date"], "1974-12-25");
    },
  );

  await tc.step(
    "tabularSqlView: arrowStyle supplier produces stable SQL prefixes and view wrapper",
    () => {
      const tabularJson = new TabularJson(fhirPatientResourceShape)
        .columnSupplier(snakeCaseColumnSupplier)
        .jsonFieldAccessSql(arrowStyleSqlFieldAccessSqlSupplier);

      const { dropDDL, createDDL } = tabularJson.tabularSqlView(
        "fhir_patient_view",
        "SELECT * FROM fhir_patients",
        "data",
        false,
      );

      assertEquals(dropDDL(), "DROP VIEW IF EXISTS fhir_patient_view;");

      const ddl = createDDL();

      // Structural checks (avoid brittle full-string comparisons for a large schema)
      assert(ddl.includes("CREATE VIEW fhir_patient_view AS"));
      assert(ddl.includes("WITH jsonSupplierCTE AS ("));
      assert(ddl.includes("SELECT * FROM fhir_patients"));
      assert(ddl.includes("FROM jsonSupplierCTE;"));

      // A few representative projections
      assert(ddl.includes("data ->> 'id' AS id"));
      assert(ddl.includes("data -> 'identifier'"));
      assert(ddl.includes("data -> 'name'"));
      assert(ddl.includes("data -> 'address'"));
      assert(ddl.includes("data -> 'contact'"));
    },
  );

  await tc.step("tabularSqlView: dotStyle supplier uses $. paths", () => {
    const tabularJson = new TabularJson(fhirPatientResourceShape)
      .columnSupplier(snakeCaseColumnSupplier)
      .jsonFieldAccessSql(dotStyleSqlFieldAccessSqlSupplier);

    const { dropDDL, createDDL } = tabularJson.tabularSqlView(
      "fhir_patient_view",
      "SELECT * FROM fhir_patients",
      "data",
      false,
    );

    assertEquals(dropDDL(), "DROP VIEW IF EXISTS fhir_patient_view;");

    const ddl = createDDL();

    assert(ddl.includes("CREATE VIEW fhir_patient_view AS"));
    assert(ddl.includes("data ->> '$.id' AS id"));
    assert(
      ddl.includes("data ->> '$.gender' AS gender") ||
        ddl.includes("data ->> '$.gender' AS gender"),
    );
    assert(
      ddl.includes("data ->> '$.birthDate' AS birth_date") ||
        ddl.includes("birth_date"),
    );

    // Representative nested path checks
    assert(ddl.includes("data ->> '$.identifier"));
    assert(ddl.includes("data ->> '$.name"));
    assert(ddl.includes("data ->> '$.address"));
    assert(ddl.includes("data ->> '$.contact"));
  });
});
