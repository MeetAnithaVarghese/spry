-- SQLITE ETL SCRIPT — FINAL SYNTAX FIX
-- FIX: Removed the problematic "CREATE TABLE X AS SELECT" structure for the final table.
--      Instead, we use "CREATE TABLE X" followed by "INSERT INTO X SELECT".
--      Also, hierarchy logic is integrated into the final INSERT step to minimize dependencies.
------------------------------------------------------------------------------

-- 1. CLEAN AND PARSE THE RAW CONTENT
------------------------------------------------------------------------------

DROP TABLE IF EXISTS t_raw_data;
CREATE  TABLE t_raw_data AS
SELECT
    urpe.file_basename,
    urt.uniform_resource_id,
    
    -- Clean and fix corrupted escapes
    REPLACE(
        REPLACE(
            REPLACE(
                REPLACE(
                    SUBSTR(CAST(urt.content AS TEXT), 2, LENGTH(CAST(urt.content AS TEXT)) - 2),
                    CHAR(10), '' 
                ),
                CHAR(13), ''
            ),
            '\x22', '"' -- Fix escaped quotes
        ),
        '\n', '' -- Fix escaped newlines
    ) AS cleaned_json_text
FROM uniform_resource_transform urt
INNER JOIN ur_ingest_session_fs_path_entry urpe
    ON urt.uniform_resource_id = urpe.uniform_resource_id;


-- 2. LOAD doc-classify ROLE→DEPTH MAP
------------------------------------------------------------------------------

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


-- 3. JSON TRAVERSAL
------------------------------------------------------------------------------

DROP TABLE IF EXISTS t_all_sections_flat;
CREATE  TABLE t_all_sections_flat AS
SELECT
    td.uniform_resource_id,
    td.file_basename,
    jt_title.value AS title,
    CAST(jt_depth.value AS INTEGER) AS depth,
    jt_body.value AS body_json_string
FROM t_raw_data td,
    json_tree(td.cleaned_json_text, '$') AS jt_section,
    json_tree(td.cleaned_json_text, '$') AS jt_depth,
    json_tree(td.cleaned_json_text, '$') AS jt_title,
    json_tree(td.cleaned_json_text, '$') AS jt_body
WHERE 
    jt_section.key = 'section' 
    AND jt_depth.parent = jt_section.id 
    AND jt_depth.key = 'depth' 
    AND jt_depth.value IS NOT NULL
    AND jt_title.parent = jt_section.id 
    AND jt_title.key = 'title' 
    AND jt_title.value IS NOT NULL
    AND jt_body.parent = jt_section.id 
    AND jt_body.key = 'body' 
    AND jt_body.value IS NOT NULL;


-- 4. NORMALIZE + ROLE ATTACH & CODE EXTRACTION (CRITICAL: Robust Delimiter Injection)
------------------------------------------------------------------------------

DROP TABLE IF EXISTS t_all_sections;
CREATE  TABLE t_all_sections AS
SELECT
    s.uniform_resource_id,
    s.file_basename,
    s.depth,
    s.title,
    s.body_json_string,
    
    -- Extract @id (Test Case ID)
    TRIM(SUBSTR(
        s.body_json_string,
        INSTR(s.body_json_string, '@id') + 4,
        INSTR(SUBSTR(s.body_json_string, INSTR(s.body_json_string, '@id') + 4), '"') - 1
    )) AS extracted_id,
    
    -- Extract and clean raw YAML/code content
    CASE 
        WHEN INSTR(s.body_json_string, '"code":"') > 0 THEN
            -- CRITICAL FIX: Inject CHAR(10) before known keys to force separation for robust SUBSTR/INSTR logic
            REPLACE(
                REPLACE(
                    REPLACE(
                        REPLACE(
                            REPLACE(
                                REPLACE(
                                    REPLACE(
                                        REPLACE(
                                            -- Start with the extracted code string
                                            SUBSTR(
                                                s.body_json_string,
                                                INSTR(s.body_json_string, '"code":"') + 8,
                                                INSTR(s.body_json_string, '","type":') - (INSTR(s.body_json_string, '"code":"') + 8)
                                            ),
                                            
                                            -- CASE keys
                                            'Tags:', CHAR(10) || 'Tags:'
                                        ),
                                        'Scenario Type:', CHAR(10) || 'Scenario Type:'
                                    ),
                                    'Priority:', CHAR(10) || 'Priority:'
                                ),
                                'requirementID:', CHAR(10) || 'requirementID:'
                            ),
                            -- EVIDENCE keys
                            'cycle:', CHAR(10) || 'cycle:'
                        ),
                        'assignee:', CHAR(10) || 'assignee:'
                    ),
                    'status:', CHAR(10) || 'status:'
                ),
                'issue_id:', CHAR(10) || 'issue_id:'
            )
        ELSE NULL
    END AS code_content,
    
    rm.role_name
FROM t_all_sections_flat s
LEFT JOIN t_role_depth_map rm
    ON s.uniform_resource_id = rm.uniform_resource_id
   AND s.depth = rm.role_depth;


-- 5. EVIDENCE HISTORY JSON ARRAY (Aggregates all evidence history)
------------------------------------------------------------------------------

DROP TABLE IF EXISTS t_evidence_history_json;
CREATE  TABLE t_evidence_history_json AS
WITH evidence_positions AS (
    -- Stage 1A: Calculate extraction positions safely in a separate CTE
    SELECT
        tas.uniform_resource_id,
        tas.extracted_id AS test_case_id,
        tas.file_basename,
        tas.code_content,

        -- Find end positions for parsing logic
        CASE 
            WHEN INSTR(tas.code_content, CHAR(10) || 'assignee:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'assignee:') 
            WHEN INSTR(tas.code_content, CHAR(10) || 'status:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'status:')
            WHEN INSTR(tas.code_content, CHAR(10) || 'issue_id:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'issue_id:')
            ELSE LENGTH(tas.code_content) + 1
        END AS end_of_cycle_pos,

        CASE 
            WHEN INSTR(tas.code_content, CHAR(10) || 'status:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'status:')
            WHEN INSTR(tas.code_content, CHAR(10) || 'issue_id:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'issue_id:')
            ELSE LENGTH(tas.code_content) + 1
        END AS end_of_assignee_pos,
        
        CASE
            WHEN INSTR(tas.code_content, CHAR(10) || 'issue_id:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'issue_id:')
            ELSE LENGTH(tas.code_content) + 1
        END AS end_of_status_pos
    FROM t_all_sections tas
    WHERE tas.role_name = 'evidence' AND tas.extracted_id IS NOT NULL AND tas.code_content IS NOT NULL
), 
evidence_temp AS (
    -- Stage 1B: Extract fields using calculated positions
    SELECT
        ep.uniform_resource_id,
        ep.test_case_id,
        ep.file_basename,

        TRIM(SUBSTR(ep.code_content, INSTR(ep.code_content, 'cycle:') + 6, ep.end_of_cycle_pos - (INSTR(ep.code_content, 'cycle:') + 6))) AS val_cycle,
        TRIM(SUBSTR(ep.code_content, INSTR(ep.code_content, 'assignee:') + 9, ep.end_of_assignee_pos - (INSTR(ep.code_content, 'assignee:') + 9))) AS val_assignee,
        TRIM(SUBSTR(ep.code_content, INSTR(ep.code_content, 'status:') + 7, ep.end_of_status_pos - (INSTR(ep.code_content, 'status:') + 7))) AS val_status,
        CASE WHEN INSTR(ep.code_content, 'issue_id:') > 0 THEN TRIM(SUBSTR(ep.code_content, INSTR(ep.code_content, 'issue_id:') + 9)) ELSE '' END AS val_issue_id
    FROM evidence_positions ep
)
-- Stage 2: Aggregate the extracted values into a structured JSON string (array)
SELECT
    et.uniform_resource_id,
    et.test_case_id,
    
    '[' || GROUP_CONCAT(
        JSON_OBJECT(
            'cycle', et.val_cycle,
            'assignee', et.val_assignee,
            'status', et.val_status,
            'issue_id', et.val_issue_id,
            'file_basename', et.file_basename
        )
    , ',') || ']' AS evidence_history_json
FROM evidence_temp et
GROUP BY et.uniform_resource_id, et.test_case_id;


-- 5.5 LATEST EVIDENCE STATUS (Finds the single latest record for each test case PER FILE)
------------------------------------------------------------------------------

DROP TABLE IF EXISTS t_latest_evidence_status;
CREATE  TABLE t_latest_evidence_status AS
WITH evidence_positions AS (
    -- Stage 1A: Calculate extraction positions safely
    SELECT
        tas.uniform_resource_id,
        tas.file_basename, 
        tas.extracted_id AS test_case_id,
        tas.code_content,
        
        -- Find end position for cycle
        CASE 
            WHEN INSTR(tas.code_content, CHAR(10) || 'assignee:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'assignee:') 
            WHEN INSTR(tas.code_content, CHAR(10) || 'status:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'status:')
            WHEN INSTR(tas.code_content, CHAR(10) || 'issue_id:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'issue_id:')
            ELSE LENGTH(tas.code_content) + 1
        END AS end_of_cycle_pos,

        -- Find end position for assignee
        CASE 
            WHEN INSTR(tas.code_content, CHAR(10) || 'status:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'status:')
            WHEN INSTR(tas.code_content, CHAR(10) || 'issue_id:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'issue_id:')
            ELSE LENGTH(tas.code_content) + 1
        END AS end_of_assignee_pos,
        
        -- Find end position for status
        CASE
            WHEN INSTR(tas.code_content, CHAR(10) || 'issue_id:') > 0 THEN INSTR(tas.code_content, CHAR(10) || 'issue_id:')
            ELSE LENGTH(tas.code_content) + 1
        END AS end_of_status_pos

    FROM t_all_sections tas
    WHERE tas.role_name = 'evidence' AND tas.extracted_id IS NOT NULL AND tas.code_content IS NOT NULL
), 
evidence_details AS (
    -- Stage 1B: Extract fields using calculated positions
    SELECT
        ep.uniform_resource_id,
        ep.file_basename,
        ep.test_case_id,
        
        TRIM(SUBSTR(ep.code_content, INSTR(ep.code_content, 'cycle:') + 6, ep.end_of_cycle_pos - (INSTR(ep.code_content, 'cycle:') + 6))) AS val_cycle,
        TRIM(SUBSTR(ep.code_content, INSTR(ep.code_content, 'assignee:') + 9, ep.end_of_assignee_pos - (INSTR(ep.code_content, 'assignee:') + 9))) AS val_assignee,
        TRIM(SUBSTR(ep.code_content, INSTR(ep.code_content, 'status:') + 7, ep.end_of_status_pos - (INSTR(ep.code_content, 'status:') + 7))) AS val_status,
        CASE WHEN INSTR(ep.code_content, 'issue_id:') > 0 THEN TRIM(SUBSTR(ep.code_content, INSTR(ep.code_content, 'issue_id:') + 9)) ELSE '' END AS val_issue_id
    FROM evidence_positions ep
),
-- Use ROW_NUMBER() to find the latest (highest cycle) for each test case PER FILE
ranked_evidence AS (
    SELECT
        *,
        ROW_NUMBER() OVER (
            -- FIX: Partition by uniform_resource_id AND test_case_id
            PARTITION BY uniform_resource_id, test_case_id
            ORDER BY val_cycle DESC
        ) AS rn
    FROM evidence_details
)
-- Select only the latest record (rank = 1)
SELECT
    uniform_resource_id,
    test_case_id,
    file_basename AS latest_file_basename, 
    val_cycle AS latest_cycle,
    val_assignee AS latest_assignee,
    val_status AS latest_status,
    val_issue_id AS latest_issue_id
FROM ranked_evidence
WHERE rn = 1;

DROP VIEW IF EXISTS v_section_hierarchy_summary;
CREATE VIEW v_section_hierarchy_summary AS
SELECT
    s.file_basename,
    (SELECT title FROM t_all_sections p WHERE p.uniform_resource_id = s.uniform_resource_id AND p.role_name = 'project'  ORDER BY p.depth LIMIT 1) AS project_title,
    -- Concatenate inner section titles (Strategy, Plan, Suite) to show hierarchy
    GROUP_CONCAT(
        CASE s.role_name
            WHEN 'strategy' THEN 'Strategy: ' || s.title
            WHEN 'plan'     THEN 'Plan: ' || s.title
            WHEN 'suite'    THEN 'Suite: ' || s.title
            ELSE NULL
        END, ' | '
    ) AS inner_sections,
    -- Count the number of test cases associated with this file
    COUNT(CASE WHEN s.role_name = 'case' THEN 1 ELSE NULL END) AS test_case_count
FROM t_all_sections s
GROUP BY s.uniform_resource_id, s.file_basename;

-- Step 1: Materialize HierarchyData into a temporary table
-- DROP TABLE IF EXISTS temp_hierarchy;

-- CREATE  TABLE temp_hierarchy AS
-- WITH Ranked AS (
--     SELECT 
--         uniform_resource_id,
--         file_basename,
--         role_name,
--         title,
--         ROW_NUMBER() OVER (
--             PARTITION BY uniform_resource_id, file_basename, role_name
--             ORDER BY depth ASC
--         ) AS rn
--     FROM t_all_sections
--     WHERE role_name IN ('project','strategy','plan','suite')
-- )
-- SELECT
--     uniform_resource_id,
--     file_basename,
--     -- Use MAX/CASE to pivot the hierarchy roles into columns.
--     MAX(CASE WHEN role_name='project' THEN title END) AS project_name,
--     MAX(CASE WHEN role_name='strategy' THEN title END) AS strategy_name,
--     MAX(CASE WHEN role_name='plan' THEN title END) AS plan_name,
--     MAX(CASE WHEN role_name='suite' THEN title END) AS suite_name
-- FROM Ranked
-- WHERE rn = 1
-- GROUP BY uniform_resource_id, file_basename;


-- -- 6.2 Define the Final Target Table
-- DROP TABLE IF EXISTS t_analyzed_test_data;
-- CREATE TABLE t_analyzed_test_data (
--     uniform_resource_id TEXT,
--     file_basename TEXT,
--     project_name TEXT,
--     strategy_name TEXT,
--     plan_name TEXT,
--     suite_name TEXT,
--     case_id TEXT,
--     case_title TEXT,
--     requirement_id TEXT,
--     case_priority TEXT,
--     case_tags TEXT,
--     case_scenario_type TEXT,
--     case_description_text TEXT,
--     case_preconditions_text TEXT,
--     case_steps_text TEXT,
--     case_expected_results_text TEXT,
--     evidence_history_json TEXT
-- );

-- -- 6.3 Insert data into target table (Using CTE and extra parentheses for stability)
-- -- 6.3 Insert data into target table (Using two-stage CTE for parser stability - THIS IS THE FINAL FIX)
-- INSERT INTO t_analyzed_test_data (
--     uniform_resource_id,
--     file_basename,
--     project_name,
--     strategy_name,
--     plan_name,
--     suite_name,
--     case_id,
--     case_title,
--     requirement_id,
--     case_priority,
--     case_tags,
--     case_scenario_type,
--     case_description_text,
--     case_preconditions_text,
--     case_steps_text,
--     case_expected_results_text,
--     evidence_history_json
-- )
-- -- CTE 1: Calculates all the complex string extraction fields
-- WITH BodyTextRaw AS (
--     SELECT
--         tc.uniform_resource_id,
--         tc.extracted_id,
        
--         -- Description Text Extraction
--         REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
--             TRIM(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, '"**Description**"},') + 20,
--                 INSTR(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, '"**Description**"},') + 20),
--                 '{"paragraph":"**Preconditions**"') - 1)),
--             '{"list":[{', CHAR(10) || '* '), '{"paragraph":"', CHAR(10)), '"item":[', ''), '"},', CHAR(10))) AS case_description_text,

--         -- Preconditions Text Extraction
--         REPLACE(REPLACE(REPLACE(REPLACE(
--             TRIM(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, '"**Preconditions**"},') + 22,
--                 INSTR(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, '"**Preconditions**"},') + 22),
--                 '{"paragraph":"**Steps**"') - 1)),
--             '{"list":[{', CHAR(10) || '* '), '{"paragraph":"', CHAR(10)), '"item":[', ''), '"},', CHAR(10))) AS case_preconditions_text,

--         -- Steps Text Extraction
--         REPLACE(REPLACE(REPLACE(REPLACE(
--             TRIM(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, '"**Steps**"},') + 14,
--                 INSTR(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, '"**Steps**"},') + 14),
--                 '{"paragraph":"**Expected Results**"') - 1)),
--             '{"list":[{', CHAR(10) || '1. '), '{"paragraph":"', CHAR(10)), '"item":[', ''), '"},', CHAR(10))) AS case_steps_text,

--         -- Expected Results Text Extraction
--         REPLACE(REPLACE(REPLACE(REPLACE(
--             TRIM(SUBSTR(tc.body_json_string, INSTR(tc.body_json_string, '"**Expected Results**"},') + 25)),
--             '{"list":[{', CHAR(10) || '* '), '{"paragraph":"', CHAR(10)), '"item":[', ''), '"},', CHAR(10))) AS case_expected_results_text
        
--     FROM t_all_sections tc
--     WHERE tc.role_name = 'case'
-- ),
-- -- CTE 2: Assembles the final data set using simple joins and selections
-- FinalCaseData AS (
--     SELECT
--         tc.uniform_resource_id,
--         tc.file_basename,
--         hd.project_name,
--         hd.strategy_name,
--         hd.plan_name,
--         hd.suite_name,
--         tc.extracted_id AS case_id,
--         tc.title AS case_title,

--         -- Requirement ID
--         TRIM(SUBSTR(tc.code_content, INSTR(tc.code_content, 'requirementID:') + 14,
--              INSTR(tc.code_content, CHAR(10) || 'Priority:') - (INSTR(tc.code_content, 'requirementID:') + 14))) AS requirement_id,

--         -- Priority
--         TRIM(SUBSTR(tc.code_content, INSTR(tc.code_content, 'Priority:') + 9,
--              INSTR(tc.code_content, CHAR(10) || 'Tags:') - (INSTR(tc.code_content, 'Priority:') + 9))) AS case_priority,

--         -- Tags
--         TRIM(SUBSTR(tc.code_content, INSTR(tc.code_content, 'Tags:') + 5,
--              INSTR(tc.code_content, CHAR(10) || 'Scenario Type:') - (INSTR(tc.code_content, 'Tags:') + 5))) AS case_tags,

--         -- Scenario Type
--         TRIM(SUBSTR(tc.code_content, INSTR(tc.code_content, 'Scenario Type:') + 14)) AS case_scenario_type,

--         -- Body Text Fields (Now selected simply from the first CTE)
--         btr.case_description_text,
--         btr.case_preconditions_text,
--         btr.case_steps_text,
--         btr.case_expected_results_text,
        
--         -- Evidence History JSON Lookup
--         (
--             SELECT IFNULL(eh.evidence_history_json, '[]')
--             FROM t_evidence_history_json eh
--             WHERE eh.uniform_resource_id = tc.uniform_resource_id
--               AND eh.test_case_id = tc.extracted_id
--         ) AS evidence_history_json
        
--     FROM t_all_sections tc
--     INNER JOIN BodyTextRaw btr
--         ON tc.uniform_resource_id = btr.uniform_resource_id
--        AND tc.extracted_id = btr.extracted_id
--     LEFT JOIN temp_hierarchy hd
--         ON tc.uniform_resource_id = hd.uniform_resource_id
--        AND tc.file_basename = hd.file_basename
-- )
-- SELECT * FROM FinalCaseData;



-- -- 7. TEST CASE DETAIL VIEW (Final View for querying, joining the main view with latest status)
-- ------------------------------------------------------------------------------

-- DROP VIEW IF EXISTS v_test_case_detail;
-- CREATE VIEW v_test_case_detail AS
-- SELECT
--     tca.uniform_resource_id,
--     tca.file_basename,
--     tca.project_name,
--     tca.strategy_name,
--     tca.plan_name,
--     tca.suite_name,
--     tca.case_id,
--     tca.case_title,
--     tca.requirement_id,
--     tca.case_priority,
--     tca.case_tags,
--     tca.case_scenario_type,
    
--     -- Test Case Body Details (Clean Text Columns)
--     tca.case_description_text,
--     tca.case_preconditions_text,
--     tca.case_steps_text,
--     tca.case_expected_results_text,
    
--     -- Evidence History (Full JSON Array)
--     tca.evidence_history_json, 

--     -- Latest Evidence Details from Step 5.5 (Use COALESCE for friendly 'No Data' strings)
--     COALESCE(les.latest_cycle, 'N/A') AS latest_cycle,
--     COALESCE(les.latest_status, 'No Run') AS latest_status,
--     COALESCE(les.latest_assignee, 'Unassigned') AS latest_assignee,
--     COALESCE(les.latest_issue_id, 'None') AS latest_issue_id,
--     COALESCE(les.latest_file_basename, 'N/A') AS latest_evidence_file_basename

-- FROM t_analyzed_test_data tca 
-- LEFT JOIN t_latest_evidence_status les 
--     -- Join on BOTH resource ID and case ID for accuracy
--     ON tca.case_id = les.test_case_id
--    AND tca.uniform_resource_id = les.uniform_resource_id;