```bash task-0 --descr "A demo bash task"
echo "task-1 successful"
```

```http task-1 --descr "HTTPBin GET (basic HTTP + TLS)"
GET https://httpbin.org/get HTTP/1.1
Accept: application/json
```

Run the task and capture it's output in `task2Output`, can retrieve it using
`${captured.task2Output}` in any `--interpolate` (or `-I`) cells:

```http task-2 -C task2Output --dep task-3 --descr "HTTPBin POST JSON"
POST https://httpbin.org/post HTTP/1.1
Content-Type: application/json
Accept: application/json

{
  "name": "synthetic-user",
  "role": "tester",
  "active": true
}
```

Run the task and capture it's output in file `./task-3.txt`:

```http task-3 --capture ./task-3.json --gitignore --descr "HTTPBin Headers Echo"
GET https://httpbin.org/headers HTTP/1.1
Accept: application/json
X-Test-Header: spry
X-Test-Header: deterministic
```

The `-I` allows _unsafe_ interpolation so that we can use the output of
`task-2`:

```bash task-4 -I --descr "Show captured output"
#!/usr/bin/env -S cat
# from task-2 captured output: "${captured.task2Output.text().trim()}"
```

The `clean` task is "special" so we put it in its own `graph` (the name is not
relevant) so it is not run with the other tasks. You can create as many graphs
as necessary with isolate them from the "main" graph and allow execution using
`--graph` argument in `spry.ts`.

```bash clean --graph special --silent
rm -f task-3.json
rm -f .gitignore
```
