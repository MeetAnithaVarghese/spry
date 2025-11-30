This _generates_ `mdast` `code` nodes either as immediately imported files (when
the source is not marked as `utf8`) or as a ref when it's `utf8`. Unless you
include `import --base` the default base directory is `.`.

IMPORTANT: If your globs have `{..}` in there, be sure to quote the glob
otherwise it can be unquoted.

```import --base "${mdSrcDirname}/../sundry" --interpolate
bash **/*.bash --graph INJECTED_BASH1 --cwd ${cwd}
bash "**/*.{sh,bash}" --graph INJECTED_BASH2 --cwd ${cwd}
text "**/*.{sh,bash,txt,text,html,json}" --graph INJECTED_FS_TEXT
utf8 "**/*.{pdf,doc,docx,ppt,pptx,xls,xlsx}" --graph INJECTED_FS_BIN
json https://microsoftedge.github.io/Demos/json-dummy-data/64KB.json --label --graph INJECTED_REMOTE
```

When importing text the content is immediately loaded but if the content is
binary then it's the responsibility of the processing engine to streatm it and
do something with it.
