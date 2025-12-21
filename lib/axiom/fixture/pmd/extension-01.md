Define "extensions" which mean that we want these executable scripts files as
part of our stream but the actual definition of what to do with them comes
later.

```ts extn1.ts --extension "${mdSrcDirname}/extension-01.ts"
// the extension will be imported as a Deno module and be available
// in the mdast
```
