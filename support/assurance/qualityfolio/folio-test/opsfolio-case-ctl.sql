-- 1. Configuration and Setup
----------------------------------------------------------------------------------------------------
---------------------------------------
-- 0. EXTENSIONS
---------------------------------------
INSTALL sqlite;
LOAD sqlite;
INSTALL json;
LOAD json;

---------------------------------------
-- 1. ATTACH THE SQLITE SOURCE DATABASE
---------------------------------------
ATTACH 'resource-surveillance.sqlite.db' AS qualityfolio (TYPE sqlite);

-- Drop previous tables to ensure clean run
DROP TABLE IF EXISTS qualityfolio.analyzed_test_data;
DROP TABLE IF EXISTS transformed_data;
DROP TABLE IF EXISTS t_evidence_history;
DROP TABLE IF EXISTS v_detailed_document_hierarchy;

-- 2. Step 1: Extract Base Data and Count
----------------------------------------------------------------------------------------------------

CREATE  TABLE transformed_data AS 
SELECT
    urt.content,
    urpe.file_basename,
    urpe.uniform_resource_id
FROM
    qualityfolio.uniform_resource_transform urt
INNER JOIN qualityfolio.ur_ingest_session_fs_path_entry urpe
    ON urt.uniform_resource_id = urpe.uniform_resource_id;

-- EMIT COUNT 1: Base Data
SELECT 'Step 1: Total records in transformed_data' AS label, COUNT(*) AS count_result FROM transformed_data;

----------------------------------------------------------------------------------------------------

-- 3. Step 2: Pre-aggregate Evidence History and Count (FIX: Explicit JSON CAST)
----------------------------------------------------------------------------------------------------

CREATE  TABLE t_evidence_history AS 
SELECT
    td.uniform_resource_id,
    JSON_EXTRACT_STRING(e_item, '$.test_case_id') AS test_case_id,
    LIST(
        JSON_OBJECT(
            'cycle', JSON_EXTRACT_STRING(e_item, '$.cycle'),
            'assignee', JSON_EXTRACT_STRING(e_item, '$.assignee'),
            'status', JSON_EXTRACT_STRING(e_item, '$.status'),
            'issue_id', JSON_EXTRACT_STRING(e_item, '$.issue_id')
        )
    ) AS evidence_history
FROM
    transformed_data td,
    -- CRITICAL FIX: Cast JSON_EXTRACT result to JSON type for UNNEST compatibility
    UNNEST(CAST(JSON_EXTRACT(td.content, '$.doc-classify') AS JSON)) AS e_item
WHERE
    JSON_EXTRACT_STRING(e_item, '$.role') = 'evidence'
GROUP BY
    td.uniform_resource_id,
    test_case_id;

-- EMIT COUNT 2: Evidence History
SELECT 'Step 2: Total records in t_evidence_history' AS label, COUNT(*) AS count_result FROM t_evidence_history;

----------------------------------------------------------------------------------------------------

-- 4. Step 3: Detailed Hierarchical Query and Count (FIX: Explicit JSON CAST)
----------------------------------------------------------------------------------------------------

CREATE  TABLE v_detailed_document_hierarchy AS
SELECT
    td.file_basename,
    
    -- Hierarchy Details
    JSON_EXTRACT_STRING(t_project, '$.id') AS project_id,
    h_project.text AS project_name,
    JSON_EXTRACT_STRING(t_strategy, '$.id') AS strategy_id,
    h_strategy.text AS strategy_name,
    JSON_EXTRACT_STRING(t_plan, '$.id') AS plan_id,
    h_plan.text AS plan_name,
    JSON_EXTRACT_STRING(t_suite, '$.id') AS suite_id,
    h_suite.text AS suite_name,

    -- Case (Test Case) Details
    JSON_EXTRACT_STRING(t_case, '$.id') AS case_id,
    COALESCE(JSON_EXTRACT_STRING(t_case, '$.title'), h_case.text) AS case_title,
    JSON_EXTRACT_STRING(t_case, '$.Priority') AS case_priority,
    JSON_EXTRACT_STRING(t_case, '$.requirementID') AS requirement_id,
    
    -- Evidence History
    teh.evidence_history
FROM
    transformed_data td,
    -- CRITICAL FIX APPLIED TO ALL doc-classify UNNESTS
    UNNEST(CAST(JSON_EXTRACT(td.content, '$.doc-classify') AS JSON)) AS t_case, 
    UNNEST(CAST(JSON_EXTRACT(td.content, '$.doc-classify') AS JSON)) AS t_suite,
    UNNEST(CAST(JSON_EXTRACT(td.content, '$.doc-classify') AS JSON)) AS t_plan,
    UNNEST(CAST(JSON_EXTRACT(td.content, '$.doc-classify') AS JSON)) AS t_strategy,
    UNNEST(CAST(JSON_EXTRACT(td.content, '$.doc-classify') AS JSON)) AS t_project,
    
    -- UNNEST heading blocks (These use the standard JSON_EXTRACT and UNNEST)
    UNNEST(JSON_EXTRACT(td.content, '$.heading')) AS h_project,
    UNNEST(JSON_EXTRACT(td.content, '$.heading')) AS h_strategy,
    UNNEST(JSON_EXTRACT(td.content, '$.heading')) AS h_plan,
    UNNEST(JSON_EXTRACT(td.content, '$.heading')) AS h_suite,
    UNNEST(JSON_EXTRACT(td.content, '$.heading')) AS h_case
    
-- LEFT JOIN pre-aggregated evidence data to the test case
LEFT JOIN t_evidence_history teh
    ON teh.uniform_resource_id = td.uniform_resource_id
    AND teh.test_case_id = JSON_EXTRACT_STRING(t_case, '$.id')
    
WHERE
    ----------------------------------------------------------------
    -- 1. IDENTIFY TEST CASE (METADATA FILTER)
    ----------------------------------------------------------------
    JSON_EXTRACT_STRING(t_case, '$.Priority') IS NOT NULL
    AND JSON_EXTRACT_STRING(t_case, '$.id') = JSON_EXTRACT_STRING(h_case.item, '$.id')

    ----------------------------------------------------------------
    -- 2. IDENTIFY CONTAINERS (ROLE FILTER) & LINK BY ID
    ----------------------------------------------------------------
    AND JSON_EXTRACT_STRING(t_suite, '$.role') = 'suite'
    AND JSON_EXTRACT_STRING(t_suite, '$.id') = JSON_EXTRACT_STRING(h_suite.item, '$.id')
    AND JSON_EXTRACT_STRING(t_plan, '$.role') = 'plan'
    AND JSON_EXTRACT_STRING(t_plan, '$.id') = JSON_EXTRACT_STRING(h_plan.item, '$.id')
    AND JSON_EXTRACT_STRING(t_strategy, '$.role') = 'strategy'
    AND JSON_EXTRACT_STRING(t_strategy, '$.id') = JSON_EXTRACT_STRING(h_strategy.item, '$.id')
    AND JSON_EXTRACT_STRING(t_project, '$.role') = 'project'
    AND JSON_EXTRACT_STRING(t_project, '$.id') = JSON_EXTRACT_STRING(h_project.item, '$.id')

    ----------------------------------------------------------------
    -- 3. VALIDATE HIERARCHY (STRUCTURAL FILTER - DEPTH-AGNOSTIC)
    ----------------------------------------------------------------
    AND h_case.start_line > h_suite.start_line AND h_suite.depth < h_case.depth 
    AND h_suite.start_line > h_plan.start_line AND h_plan.depth < h_suite.depth 
    AND h_plan.start_line > h_strategy.start_line AND h_strategy.depth < h_plan.depth 
    AND h_strategy.start_line > h_project.start_line AND h_project.depth = 1;

-- EMIT COUNT 3: Final Hierarchy
SELECT 'Step 3: Total records in v_detailed_document_hierarchy' AS label, COUNT(*) AS count_result FROM v_detailed_document_hierarchy;


----------------------------------------------------------------------------------------------------
-- 5. Export Results to SQLite
----------------------------------------------------------------------------------------------------

-- Create the target table in the SQLite database
CREATE TABLE qualityfolio.analyzed_test_data (
    file_basename VARCHAR,
    project_id VARCHAR,
    project_name VARCHAR,
    strategy_id VARCHAR,
    strategy_name VARCHAR,
    plan_id VARCHAR,
    plan_name VARCHAR,
    suite_id VARCHAR,
    suite_name VARCHAR,
    case_id VARCHAR,
    case_title VARCHAR,
    case_priority VARCHAR,
    requirement_id VARCHAR,
    evidence_history JSON
);

-- Copy the results from the temporary table into the permanent SQLite table
INSERT INTO qualityfolio.analyzed_test_data
SELECT
    file_basename,
    project_id,
    project_name,
    strategy_id,
    strategy_name,
    plan_id,
    plan_name,
    suite_id,
    suite_name,
    case_id,
    case_title,
    case_priority,
    requirement_id,
    evidence_history
FROM v_detailed_document_hierarchy;

-- 6. Cleanup
----------------------------------------------------------------------------------------------------

-- Disconnect from the SQLite database
DETACH qualityfolio;