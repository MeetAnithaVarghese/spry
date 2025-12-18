Define some "contributions" which mean that we want these files as part of our
stream but the actual definition of what to do with them comes later.

```contribute my-contributions --base ../sundry
**/* SUNDRY
```

💡 The `--base` is relative to this markdown file (because the test case sets it
up that way).

```contribute my-contributions2 --labeled --base ../sundry --dest SUNDRY
CSV **/*.csv
PDF *.pdf
zip **/*.zip ARCHIVE
```

Include these as `code` nodes into the Markdown AST tree. The labels become the
`lang`, the arguments after the file globs are `meta` and the content becomes
the `value`.

```contribute include --labeled --base ../sundry --dest INCLUDE
csv **/*.csv
sql **/!(*.partial).sql . --interpolate --injectable
sql *.partial.sql . --directive PARTIAL --interpolate --injectable
sql *.partial.sql . --directive PARTIAL --rewrite-path-find "(^|/)((?:[^/]+))\\.partial\\.sql$" --rewrite-path-replace "$1$2.sql" --interpolate --injectable
```

💡 The `include` keyword as the name of the `contribute` cell is special
(another option is to pass in `--include` flag at the cell level instead).
