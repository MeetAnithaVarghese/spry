-- DUCKDB JSON ETL SCRIPT (REVISED)
-- FIX: Replaced unsupported 'LAST_VALUE IGNORE NULLS' with a standard SQL correlating subquery
-- to label content rows with the preceding section header.

-------------------------------------------------------------------------------------------------
-- 1. SIMULATE SOURCE DATA AND CONVERT TO DUCKDB's JSON TYPE
-------------------------------------------------------------------------------------------------
WITH RawData AS (
    -- This CTE simulates your source table where the column is correctly CAST to the JSON type.
    SELECT
        'TC-CMMC-0001' AS extracted_id,
        'my_test_case.json' AS file_basename,
        -- The complex, escaped JSON string provided by the user, cast to the DuckDB JSON type.
        CAST(
            '[{""paragraph"":""@id TC-CMMC-0001""},{""code_block"":{""code"":""doc-classify:requirementID: REQ-CMMC-001Priority: HighTags: [CMMC Self-Assessment]Scenario Type: Happy Path"",""type"":""code"",""language"":""yaml"",""metadata"":""HFM""}},{""paragraph"":""**Description**""},{""paragraph"":""Verify that all CMMC Level 1 and Level 2 self-assessment sections are correctlydisplayed in the left-side navigation panel.""},{""paragraph"":""**Preconditions**""},{""list"":[{""item"":[{""paragraph"":""Valid user credentials are available.""}],""checked"":true},{""item"":[{""paragraph"":""User account has access to both CMMC Level 1 and Level 2 self-assessmentmodules.""}],""checked"":true},{""item"":[{""paragraph"":""Application environment is loaded with all expected sections.""}],""checked"":true}]},{""paragraph"":""**Steps**""},{""list"":[{""item"":[{""paragraph"":""Login with valid credentials and verify that the landing page displays the**CMMC Level 1 Self-Assessment** section.""}],""checked"":true},{""item"":[{""paragraph"":""Verify the list of sections displayed on the left-side navigation panel.""}],""checked"":true},{""item"":[{""paragraph"":""Compare the displayed list with the **expected Level 1 sections**.""}],""checked"":true},{""item"":[{""paragraph"":""Navigate to the **CMMC Level 2 Self-Assessment** page.""}],""checked"":true},{""item"":[{""paragraph"":""Verify the list of sections displayed on the left panel.""}],""checked"":true},{""item"":[{""paragraph"":""Compare the displayed list with the **expected Level 2 sections**.""}],""checked"":true}]},{""paragraph"":""**Expected Results**""},{""list"":[{""item"":[{""paragraph"":""All expected sections are visible in the left navigation panel.""}],""checked"":true},{""item"":[{""paragraph"":""Sections appear in the correct defined order for each level.""}],""checked"":true},{""item"":[{""paragraph"":""No extra or unconfigured sections are displayed.""}],""checked"":true}]},{""paragraph"":""**Expected Level 1 Sections**""},{""list"":[{""item"":[{""paragraph"":""Company Information""}],""checked"":true},{""item"":[{""paragraph"":""Access Control""}],""checked"":true},{""item"":[{""paragraph"":""Identification & Authentication""}],""checked"":true},{""item"":[{""paragraph"":""Media Protection""}],""checked"":true},{""item"":[{""paragraph"":""Physical Protection""}],""checked"":true},{""item"":[{""paragraph"":""System & Communications Protection""}],""checked"":true},{""item"":[{""paragraph"":""System & Information Integrity""}],""checked"":true},{""item"":[{""paragraph"":""Policy Framework Assessment""}],""checked"":true}]},{""paragraph"":""**Expected Level 2 Sections**""},{""list"":[{""item"":[{""paragraph"":""Company Information""}],""checked"":true},{""item"":[{""paragraph"":""Access Control""}],""checked"":true},{""item"":[{""paragraph"":""Audit & Accountability""}],""checked"":true},{""item"":[{""paragraph"":""Awareness & Training""}],""checked"":true},{""item"":[{""paragraph"":""Configuration Management""}],""checked"":true},{""item"":[{""paragraph"":""Identification & Authentication""}],""checked"":true},{""item"":[{""paragraph"":""Incident Response""}],""checked"":true},{""item"":[{""paragraph"":""Maintenance""}],""checked"":true},{""item"":[{""paragraph"":""Media Protection""}],""checked"":true},{""item"":[{""paragraph"":""Personnel Security""}],""checked"":true},{""item"":[{""paragraph"":""Physical Protection""}],""checked"":true},{""item"":[{""paragraph"":""Risk Assessment""}],""checked"":true},{""item"":[{""paragraph"":""Security Assessment""}],""checked"":true},{""item"":[{""paragraph"":""System & Communications Protection""}],""checked"":true},{""item"":[{""paragraph"":""System & Information Integrity""}],""checked"":true}]},{""section"":{""depth"":4,""title"":""Evidence"",""body"":[{""paragraph"":""@id TC-CMMC-0001""},{""code_block"":{""code"":""role: evidencecycle: 1.1assignee: prathithastatus: passed"",""type"":""code"",""language"":""yaml"",""metadata"":""META""}},{""paragraph"":""**Attachment**""},{""list"":[{""item"":[{""paragraph"":""[Results JSON](./evidence/TC-CMMC-0001/1.1/result.auto.json)""}]},{""item"":[{""paragraph"":""[CMMC Level 1 navigation screenshot](./evidence/TC-CMMC-0001/1.1/cmmc1.auto.png)""}]},{""item"":[{""paragraph"":""[CMMC Level 2 navigation screenshot](./evidence/TC-CMMC-0001/1.1/cmmc2.auto.png)""}]},{""item"":[{""paragraph"":""[Run MD](./evidence/TC-CMMC-0001/1.1/run.auto.md/;)""}]}]}]}}]}]' AS JSON) AS body_json
)

, UnnestedData AS (
    -- UNNEST the root JSON array, converting the single large document into rows of elements
    SELECT
        rd.extracted_id,
        rd.file_basename,
        ROW_NUMBER() OVER (PARTITION BY rd.extracted_id ORDER BY (SELECT 0)) AS item_order,
        UNNEST(rd.body_json) AS item
    FROM RawData rd
)

, HeaderAndContentItems AS (
    -- Identify which rows are section headers, content, or exclusion markers
    SELECT
        ud.extracted_id,
        ud.item_order,
        JSON_EXTRACT_STRING(ud.item, '$.paragraph') AS paragraph_text,
        ud.item AS content_item,

        -- Identify if this row is a major section header we care about
        CASE
            WHEN paragraph_text LIKE '**Description**' THEN 'Description'
            WHEN paragraph_text LIKE '**Preconditions**' THEN 'Preconditions'
            WHEN paragraph_text LIKE '**Steps**' THEN 'Steps'
            WHEN paragraph_text LIKE '**Expected Results**' THEN 'ExpectedResults'
            ELSE NULL
        END AS section_header_name,

        -- Flag rows that mark the start of sections we want to EXCLUDE (Level 1/2 sections, Evidence)
        CASE
            WHEN paragraph_text LIKE '**Expected Level%' THEN TRUE
            WHEN JSON_EXTRACT_STRING(ud.item, '$.section') IS NOT NULL THEN TRUE
            ELSE FALSE
        END AS is_exclusion_marker
    FROM UnnestedData ud
)

, LabeledContent AS (
    -- Use a Correlating Subquery to label the content rows with the nearest preceding header name.
    SELECT
        haci.extracted_id,
        haci.item_order,
        haci.content_item,

        -- Subquery: Finds the 'section_header_name' from the closest preceding row that is a header
        (
            SELECT T.section_header_name
            FROM HeaderAndContentItems T
            WHERE T.extracted_id = haci.extracted_id
            AND T.item_order < haci.item_order      -- Must precede the current item
            AND T.section_header_name IS NOT NULL   -- Must be an actual header we care about
            ORDER BY T.item_order DESC              -- Get the closest one (highest order)
            LIMIT 1
        ) AS current_section_label

    FROM HeaderAndContentItems haci
    -- Filter 1: Keep only rows that are NOT the header themselves (i.e., keep content rows)
    WHERE haci.section_header_name IS NULL
    -- Filter 2: Exclude ID markers and code blocks
    AND haci.paragraph_text NOT LIKE '@id %'
    AND JSON_EXTRACT_STRING(haci.content_item, '$.code_block') IS NULL
)

, FilteredContent AS (
    -- Apply the final filter to remove content belonging to the excluded sections (Level 1/2, Evidence)
    SELECT
        lc.extracted_id,
        lc.item_order,
        lc.content_item,
        lc.current_section_label
    FROM LabeledContent lc
    WHERE lc.current_section_label IS NOT NULL
    -- Stop processing content when the first exclusion marker (e.g., "**Expected Level 1 Sections**") is reached
    AND lc.item_order < (
        SELECT MIN(item_order) FROM HeaderAndContentItems
        WHERE extracted_id = lc.extracted_id
        AND is_exclusion_marker = TRUE
    )
)

, AggregatedSections AS (
    -- Aggregate the filtered content arrays by their section label
    SELECT
        extracted_id,
        current_section_label,
        -- LIST aggregates the content items into an array for easier final processing
        LIST(content_item ORDER BY item_order) AS section_content_array
    FROM FilteredContent
    GROUP BY 1, 2
)

-------------------------------------------------------------------------------------------------
-- 7. FINAL PRESENTATION AND CLEANUP (Now that the data is correctly structured)
-------------------------------------------------------------------------------------------------
SELECT
    extracted_id,

    -- Description (Single paragraph text)
    MAX(CASE WHEN current_section_label = 'Description' THEN
        JSON_EXTRACT_STRING(section_content_array[1], '$.paragraph')
    END) AS case_description_text,

    -- Preconditions (List items, simple formatting cleanup)
    MAX(CASE WHEN current_section_label = 'Preconditions' THEN
        REPLACE(
            REPLACE(
                REPLACE(
                    ARRAY_TO_STRING(section_content_array, CHR(10)),
                    '{"list":[{', CHR(10) || '* '), -- Start of list
                '"}],""checked"":true}', ''),     -- End of list item artifacts
            '{"item":[{"paragraph":"', '')         -- Middle list item artifacts
    END) AS case_preconditions_text,

    -- Steps (List items, using ARRAY_TRANSFORM for numbering)
    MAX(CASE WHEN current_section_label = 'Steps' THEN
        ARRAY_TO_STRING(
            ARRAY_TRANSFORM(
                -- UNNEST the list items from the aggregated content array (complex, but robust)
                (SELECT UNNEST(JSON_EXTRACT(element, '$.list[0].item')) FROM UNNEST(section_content_array) AS t(element)),
                -- Function to prepend the index (starting at 1) and extract the paragraph text
                (item, idx) -> (idx + 1)::VARCHAR || '. ' || JSON_EXTRACT_STRING(item, '$.paragraph')
            ), CHR(10)
        )
    END) AS case_steps_text,

    -- Expected Results (List items, simple formatting cleanup)
    MAX(CASE WHEN current_section_label = 'ExpectedResults' THEN
        REPLACE(
            REPLACE(
                REPLACE(
                    ARRAY_TO_STRING(section_content_array, CHR(10)),
                    '{"list":[{', CHR(10) || '* '), -- Start of list
                '"}],""checked"":true}', ''),     -- End of list item artifacts
            '{"item":[{"paragraph":"', '')         -- Middle list item artifacts
    END) AS case_expected_results_text

FROM AggregatedSections
GROUP BY 1;