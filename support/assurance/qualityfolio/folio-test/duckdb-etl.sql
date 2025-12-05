-- 1. Install and load the SQLite extension (only needs to be run once per session)
INSTALL sqlite; 
LOAD sqlite;

-- 2. Attach the external SQLite database
ATTACH 'resource-surveillance.sqlite.db' AS qualityfolio (TYPE sqlite);



-- 6.1 Materialize Hierarchy Data into a temporary table
DROP TABLE IF EXISTS temp_hierarchy;
CREATE TABLE temp_hierarchy AS
WITH Ranked AS (
    SELECT 
        uniform_resource_id,
        file_basename,
        role_name,
        title,
        ROW_NUMBER() OVER (
            PARTITION BY uniform_resource_id, file_basename, role_name
            ORDER BY depth ASC
        ) AS rn
    FROM qualityfolio.t_all_sections
    WHERE role_name IN ('project','strategy','plan','suite')
)
SELECT
    uniform_resource_id,
    file_basename,
    MAX(CASE WHEN role_name='project' THEN title END) AS project_name,
    MAX(CASE WHEN role_name='strategy' THEN title END) AS strategy_name,
    MAX(CASE WHEN role_name='plan' THEN title END) AS plan_name,
    MAX(CASE WHEN role_name='suite' THEN title END) AS suite_name
FROM Ranked
WHERE rn = 1
GROUP BY uniform_resource_id, file_basename;

DROP TABLE IF EXISTS t_analyzed_test_data;
CREATE TABLE t_analyzed_test_data (
    uniform_resource_id TEXT,
    file_basename TEXT,
    project_name TEXT,
    strategy_name TEXT,
    plan_name TEXT,
    suite_name TEXT,
    case_id TEXT,
    case_title TEXT,
    requirement_id TEXT,
    case_priority TEXT,
    case_tags TEXT,
    case_scenario_type TEXT,
    case_description_text TEXT,
    case_preconditions_text TEXT,
    case_steps_text TEXT,
    case_expected_results_text TEXT,
    evidence_history_json TEXT
);
-- 6.3 Insert data into target table in DuckDB (Using dedicated CTEs and SUBQUERY ISOLATION)
INSERT INTO t_analyzed_test_data
-- CTE 1: Calculate Start and End Markers for ALL Body Fields (No change - clean calculations only)
WITH MarkerIndices AS (
    SELECT
        uniform_resource_id,
        extracted_id,
        body_json_string,
        
        -- Start Positions (Used as constant reference)
        INSTR(body_json_string, '"**Description**"},') + 20 AS start_desc,
        INSTR(body_json_string, '"**Preconditions**"},') + 22 AS start_pre,
        INSTR(body_json_string, '"**Steps**"},') + 14 AS start_steps,
        INSTR(body_json_string, '"**Expected Results**"},') + 25 AS start_exp,
        
        -- End Markers (Used for dynamic length calculation)
        
        -- End of Description (Start of Preconditions)
        INSTR(SUBSTRING(body_json_string, INSTR(body_json_string, '"**Description**"},') + 20), '{"paragraph":"**Preconditions**"') - 1 AS length_desc,
        
        -- End of Preconditions (Start of Steps)
        INSTR(SUBSTRING(body_json_string, INSTR(body_json_string, '"**Preconditions**"},') + 22), '{"paragraph":"**Steps**"') - 1 AS length_pre,
        
        -- End of Steps (Start of Expected Results)
        INSTR(SUBSTRING(body_json_string, INSTR(body_json_string, '"**Steps**"},') + 14), '{"paragraph":"**Expected Results**"') - 1 AS length_steps,
        
        -- End of Expected Results (Earliest of next three markers)
        (
            COALESCE(
                NULLIF(
                    LEAST(
                        -- Marker 1: Next custom header (Expected Level 1 Sections)
                        INSTR(body_json_string, '{"paragraph":"**Expected Level 1 Sections**"'),
                        -- Marker 2: Next custom header (Expected Level 2 Sections)
                        INSTR(body_json_string, '{"paragraph":"**Expected Level 2 Sections**"'),
                        -- Marker 3: Next section (e.g., Evidence or another suite)
                        INSTR(body_json_string, '{"section":{"depth":')
                    ), 
                    0
                ), 
                LENGTH(body_json_string) + 1 -- If no marker is found, point past the end
            ) - (INSTR(body_json_string, '"**Expected Results**"},') + 25) -- Calculate length
        ) AS length_exp
        
    FROM t_all_sections
    WHERE role_name = 'case'
),
-- CTE 2: Perform String Manipulations (Crucial: Calculations are wrapped in subqueries)
BodyTextCleaned AS (
    SELECT
        mi.uniform_resource_id,
        mi.extracted_id,

        -- 1. Description Text Extraction (ISOLATED)
        (
            SELECT REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                TRIM(SUBSTRING(mi.body_json_string, mi.start_desc, mi.length_desc)),
                '{"list":[{', CHR(10) || '* '), '{"paragraph":"', CHR(10)), '"item":[', ''), '"},', CHR(10)))
        ) AS case_description_text,

        -- 2. Preconditions Text Extraction (ISOLATED - This resolves the AS error)
        (
            SELECT REPLACE(REPLACE(REPLACE(REPLACE(
                TRIM(SUBSTRING(mi.body_json_string, mi.start_pre, mi.length_pre)),
                '{"list":[{', CHR(10) || '* '), '{"paragraph":"', CHR(10)), '"item":[', ''), '"},', CHR(10)))
        ) AS case_preconditions_text,

        -- 3. Steps Text Extraction (ISOLATED)
        (
            SELECT REPLACE(REPLACE(REPLACE(REPLACE(
                TRIM(SUBSTRING(mi.body_json_string, mi.start_steps, mi.length_steps)),
                '{"list":[{', CHR(10) || '1. '), '{"paragraph":"', CHR(10)), '"item":[', ''), '"},', CHR(10)))
        ) AS case_steps_text,

        -- 4. Expected Results Text Extraction (ISOLATED)
        (
            SELECT REPLACE(REPLACE(REPLACE(REPLACE(
                TRIM(SUBSTRING(mi.body_json_string, mi.start_exp, mi.length_exp)),
                '{"list":[{', CHR(10) || '* '), '{"paragraph":"', CHR(10)), '"item":[', ''), '"},', CHR(10)))
        ) AS case_expected_results_text

    FROM MarkerIndices mi
)
-- Final SELECT: Simple joins and final data assembly
SELECT
    tc.uniform_resource_id,
    tc.file_basename,
    hd.project_name,
    hd.strategy_name,
    hd.plan_name,
    hd.suite_name,
    tc.extracted_id AS case_id,
    tc.title AS case_title,

    -- Attributes
    TRIM(SUBSTRING(tc.code_content, INSTR(tc.code_content, 'requirementID:') + 14,
         INSTR(tc.code_content, CHR(10) || 'Priority:') - (INSTR(tc.code_content, 'requirementID:') + 14))) AS requirement_id,
    TRIM(SUBSTRING(tc.code_content, INSTR(tc.code_content, 'Priority:') + 9,
         INSTR(tc.code_content, CHR(10) || 'Tags:') - (INSTR(tc.code_content, 'Priority:') + 9))) AS case_priority,
    TRIM(SUBSTRING(tc.code_content, INSTR(tc.code_content, 'Tags:') + 5,
         INSTR(tc.code_content, CHR(10) || 'Scenario Type:') - (INSTR(tc.code_content, 'Tags:') + 5))) AS case_tags,
    TRIM(SUBSTRING(tc.code_content, INSTR(tc.code_content, 'Scenario Type:') + 14)) AS case_scenario_type,

    -- Body Text Fields (Simple select from the CTE)
    btc.case_description_text,
    btc.case_preconditions_text,
    btc.case_steps_text,
    btc.case_expected_results_text,

    -- Evidence History JSON Lookup
    (
        SELECT IFNULL(evidence_history_json, '[]')
        FROM t_evidence_history_json eh
        WHERE eh.uniform_resource_id = tc.uniform_resource_id
          AND eh.test_case_id = tc.extracted_id
    ) AS evidence_history_json

FROM t_all_sections tc
INNER JOIN BodyTextCleaned btc
    ON tc.uniform_resource_id = btc.uniform_resource_id AND tc.extracted_id = btc.extracted_id
LEFT JOIN temp_hierarchy hd
    ON tc.uniform_resource_id = hd.uniform_resource_id AND tc.file_basename = hd.file_basename
WHERE tc.role_name = 'case';

SELECT Count(*) FROM t_analyzed_test_data;


CREATE TABLE qualityfolio.t_analyzed_test_data AS
SELECT * FROM t_analyzed_test_data;