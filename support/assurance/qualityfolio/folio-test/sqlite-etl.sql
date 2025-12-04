-- SQLITE ETL SCRIPT — FINAL VERSION FOR QF JSON STRUCTURE
-- Designed to run directly against 'resource-surveillance.sqlite.db'
------------------------------------------------------------------------------

-- 1. CLEAN AND PARSE THE RAW CONTENT
------------------------------------------------------------------------------

-- FIX: We must join here to correctly acquire 'file_basename' which is not 
-- in the 'uniform_resource_transform' table itself.
DROP TABLE IF EXISTS t_raw_data;
CREATE  TABLE t_raw_data AS
SELECT
    urpe.file_basename, -- <-- Now correctly sourced from the joined table
    urt.uniform_resource_id,
    -- Step 1: Convert BLOB -> text
    CAST(urt.content AS TEXT) AS raw_str,
    
    -- Step 2: Clean and fix corrupted escapes using nested REPLACE
    REPLACE(
        REPLACE(
            REPLACE(
                REPLACE(
                    -- Remove surrounding quotes (SUBSTR is SQLite compatible)
                    SUBSTR(CAST(urt.content AS TEXT), 2, LENGTH(CAST(urt.content AS TEXT)) - 2),

                    -- 1. CRITICAL FIX: Explicitly remove ACTUAL Newline characters (CHAR(10)) which break JSON parsers
                    CHAR(10), ''
                ),
                -- 2. CRITICAL FIX: Explicitly remove ACTUAL Carriage Return characters (CHAR(13))
                CHAR(13), ''
            ),
            -- 3. Replace literal escaped double quotes '\x22' with actual quote '"'
            '\x22', '"'
        ),
        -- 4. In case the literal string '\n' is still present (from previous steps), treat it as an empty string to avoid errors.
        --    This is a last-resort cleanup for residual issues.
        '\n', ''
    ) AS cleaned_json_text
FROM uniform_resource_transform urt
-- MANDATORY JOIN to get file_basename
INNER JOIN ur_ingest_session_fs_path_entry urpe
    ON urt.uniform_resource_id = urpe.uniform_resource_id;


-- 2. LOAD doc-classify ROLE→DEPTH MAP
------------------------------------------------------------------------------

-- Extracts role names and corresponding depths from the 'frontmatter' column.
-- NOTE: We still avoid joining 'ur_ingest_session_fs_path_entry' here to avoid 
-- reintroducing the previous error, as the 'file_basename' is now available 
-- via 't_raw_data' later in the script.
DROP TABLE IF EXISTS t_role_depth_map;
CREATE  TABLE t_role_depth_map AS
SELECT
    ur.uniform_resource_id,
    JSON_EXTRACT(role_map.value, '$.role') AS role_name,
    CAST(
        SUBSTR(
            JSON_EXTRACT(role_map.value, '$.select'),
            INSTR(JSON_EXTRACT(role_map.value, '$.select'), 'depth="') + 7,
            INSTR(SUBSTR(JSON_EXTRACT(role_map.value, '$.select'), INSTR(JSON_EXTRACT(role_map.value, '$.select'), 'depth="') + 7), '"') - 1
        )
    AS INTEGER) AS role_depth
FROM uniform_resource ur
    ,JSON_EACH(ur.frontmatter, '$.doc-classify') AS role_map
WHERE ur.frontmatter IS NOT NULL;


-- 3. JSON TRAVERSAL — REPLACING THE RECURSIVE CTE
------------------------------------------------------------------------------

-- Uses the working json_tree pattern to extract all sections (title, depth, body).
-- This step implicitly handles the deep, nested structure.

DROP TABLE IF EXISTS t_all_sections_flat;
CREATE  TABLE t_all_sections_flat AS
SELECT
    td.uniform_resource_id,
    td.file_basename,
    jt_title.value AS title,
    CAST(jt_depth.value AS INTEGER) AS depth,
    jt_body.value AS body_json_string
FROM t_raw_data td, -- Renamed from transformed_data
    json_tree(td.cleaned_json_text, '$') AS jt_section,
    json_tree(td.cleaned_json_text, '$') AS jt_depth,
    json_tree(td.cleaned_json_text, '$') AS jt_title,
    json_tree(td.cleaned_json_text, '$') AS jt_body
WHERE 
    -- Find the 'section' object itself, which acts as the common parent for title, depth, and body
    jt_section.key = 'section' 

    -- Get the depth value which is a direct child of the section object
    AND jt_depth.parent = jt_section.id 
    AND jt_depth.key = 'depth' 
    AND jt_depth.value IS NOT NULL
    
    -- Get the title value which is a direct child of the section object
    AND jt_title.parent = jt_section.id 
    AND jt_title.key = 'title' 
    AND jt_title.value IS NOT NULL
    
    -- Get the body value which is a direct child of the section object
    AND jt_body.parent = jt_section.id 
    AND jt_body.key = 'body' 
    AND jt_body.value IS NOT NULL;


-- 4. NORMALIZE + ROLE ATTACH
------------------------------------------------------------------------------

DROP TABLE IF EXISTS t_all_sections;
CREATE  TABLE t_all_sections AS
SELECT
    s.uniform_resource_id,
    s.file_basename,
    s.depth,
    s.title,
    -- Extract @id (This will be the test case ID) using SUBSTR/INSTR
    SUBSTR(
        s.body_json_string,
        INSTR(s.body_json_string, '@id') + 4,
        INSTR(SUBSTR(s.body_json_string, INSTR(s.body_json_string, '@id') + 4), '"') - 1
    ) AS extracted_id,
    s.body_json_string,
    rm.role_name
FROM t_all_sections_flat s
LEFT JOIN t_role_depth_map rm
    ON s.uniform_resource_id = rm.uniform_resource_id
   AND s.depth = rm.role_depth;


-- 5. EVIDENCE AGGREGATION
------------------------------------------------------------------------------

-- NOTE: Due to SQLite's lack of LIST aggregation and JSON_OBJECT in standard builds,
-- we fall back to concatenating the key/value pairs manually.

DROP TABLE IF EXISTS t_evidence_history_agg;
CREATE  TABLE t_evidence_history_agg AS
SELECT
    tas.uniform_resource_id,
    tas.extracted_id AS test_case_id,
    GROUP_CONCAT(
        '{"cycle":"' || SUBSTR(tas.body_json_string, INSTR(tas.body_json_string, 'cycle:') + 6, INSTR(SUBSTR(tas.body_json_string, INSTR(tas.body_json_string, 'cycle:') + 6), CHAR(10)) - 1) || '", ' ||
        '"assignee":"' || SUBSTR(tas.body_json_string, INSTR(tas.body_json_string, 'assignee:') + 9, INSTR(SUBSTR(tas.body_json_string, INSTR(tas.body_json_string, 'assignee:') + 9), CHAR(10)) - 1) || '", ' ||
        '"status":"' || SUBSTR(tas.body_json_string, INSTR(tas.body_json_string, 'status:') + 7, INSTR(SUBSTR(tas.body_json_string, INSTR(tas.body_json_string, 'status:') + 7), CHAR(10)) - 1) || '", ' ||
        '"issue_id":"' || SUBSTR(tas.body_json_string, INSTR(tas.body_json_string, 'issue_id:') + 9, INSTR(SUBSTR(tas.body_json_string, INSTR(tas.body_json_string, 'issue_id:') + 9), CHAR(10)) - 1) || '"}'
    ) AS evidence_history_json_array_string
FROM t_all_sections tas
WHERE tas.role_name = 'evidence'
  AND tas.extracted_id IS NOT NULL
GROUP BY tas.uniform_resource_id, tas.extracted_id;


-- 6. FINAL REPORT TABLE
------------------------------------------------------------------------------

-- NOTE: We use nested subqueries to simulate the joins based on role and depth,
-- as joining four times on depth-minus-one is too complex for standard SQLite.
-- Instead, we group and use MAX(CASE...) on the main sections table.

DROP TABLE IF EXISTS analyzed_test_data;
CREATE TABLE analyzed_test_data AS
SELECT
    tc.file_basename,
    (SELECT extracted_id FROM t_all_sections p WHERE p.uniform_resource_id = tc.uniform_resource_id AND p.role_name = 'project'  ORDER BY p.depth LIMIT 1) AS project_id,
    (SELECT title FROM t_all_sections p WHERE p.uniform_resource_id = tc.uniform_resource_id AND p.role_name = 'project'  ORDER BY p.depth LIMIT 1) AS project_name,
    (SELECT extracted_id FROM t_all_sections s WHERE s.uniform_resource_id = tc.uniform_resource_id AND s.role_name = 'strategy' ORDER BY s.depth LIMIT 1) AS strategy_id,
    (SELECT title FROM t_all_sections s WHERE s.uniform_resource_id = tc.uniform_resource_id AND s.role_name = 'strategy' ORDER BY s.depth LIMIT 1) AS strategy_name,
    (SELECT extracted_id FROM t_all_sections pl WHERE pl.uniform_resource_id = tc.uniform_resource_id AND pl.role_name = 'plan' ORDER BY pl.depth LIMIT 1) AS plan_id,
    (SELECT title FROM t_all_sections pl WHERE pl.uniform_resource_id = tc.uniform_resource_id AND pl.role_name = 'plan' ORDER BY pl.depth LIMIT 1) AS plan_name,
    (SELECT extracted_id FROM t_all_sections su WHERE su.uniform_resource_id = tc.uniform_resource_id AND su.role_name = 'suite' ORDER BY su.depth LIMIT 1) AS suite_id,
    (SELECT title FROM t_all_sections su WHERE su.uniform_resource_id = tc.uniform_resource_id AND su.role_name = 'suite' ORDER BY su.depth LIMIT 1) AS suite_name,

    tc.extracted_id AS case_id,
    tc.title AS case_title,

    -- Extract Priority and requirementID using SUBSTR/INSTR
    SUBSTR(
        tc.body_json_string,
        INSTR(tc.body_json_string, 'Priority:') + 9,
        INSTR(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, 'Priority:') + 9), CHAR(10)) - 1
    ) AS case_priority,
    SUBSTR(
        tc.body_json_string,
        INSTR(tc.body_json_string, 'requirementID:') + 14,
        INSTR(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, 'requirementID:') + 14), CHAR(10)) - 1
    ) AS requirement_id,

    '[' || IFNULL(eh.evidence_history_json_array_string, '') || ']' AS evidence_history

FROM t_all_sections tc
LEFT JOIN t_evidence_history_agg eh
    ON eh.uniform_resource_id = tc.uniform_resource_id
   AND eh.test_case_id = tc.extracted_id
WHERE tc.role_name = 'case';