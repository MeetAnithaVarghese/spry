# Test Fixtures

## Sources

- [x] `sundry/*` contains sundry synthetic files for general purpose ingestion
- [x] `pmd/*` contains _Programmable Markdown_ synthetic / test fixtures
- [x] `pmd/comprehensive.md` is a complex markdown with many example node types

## Golden

- [x] `golden/*` contains "golden" files which are matched against expectations
      in test cases; they are organized with the same directories and filenames
      with test case names in the basename. For example
      `mod_test.ts-relCounts.json` means the "relCounts" test case in
      `mod_test.ts`.
