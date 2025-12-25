import {
  createLanguageEngine,
  defineLanguageInitCatalog,
  suggestedSuffixFromLanguage,
  toStdinBytes,
  writeTempSource,
} from "../code-shell.ts";
import { SqlInitBase, sqlLanguage } from "./governance.ts";

export type PgInit = SqlInitBase & {
  host?: string;
  port?: string;
  user?: string;
  dbname?: string;
  password?: string;
};

export const psqlEngine = createLanguageEngine<typeof sqlLanguage, PgInit>({
  language: sqlLanguage,
  defaultBins: ["psql"],
  capabilities: { stdin: true, file: true },
  preferredMode: "stdin",

  planInvocation: async ({ bin, init, input, runtimeArgs, mode }) => {
    const base = [
      bin,
      ...(init?.host ? ["-h", init.host] : []),
      ...(init?.port ? ["-p", init.port] : []),
      ...(init?.user ? ["-U", init.user] : []),
      ...(init?.dbname ? ["-d", init.dbname] : []),
      "-v",
      "ON_ERROR_STOP=1",
      ...(runtimeArgs ?? []),
    ];

    if (mode === "stdin") {
      return { argv: base, stdin: toStdinBytes(input), mode: "stdin" };
    }

    const suffix = suggestedSuffixFromLanguage(input, sqlLanguage, ".sql");
    const sqlFilePath = await writeTempSource(input, suffix);
    return {
      argv: [...base, "-f", sqlFilePath],
      cleanupPaths: [sqlFilePath],
      mode: "file",
    };
  },

  mapEnv: ({ init, env }) => {
    if (!init?.password) return undefined;
    if (env?.PGPASSWORD !== undefined) return undefined;
    return { PGPASSWORD: init.password };
  },
});

export function pgInit(init: Omit<PgInit, "engineId">): PgInit {
  return { ...init, engineId: psqlEngine.id };
}

/* -------------------------------------------------------
 * Env parsing: PG* or prefixed env (e.g. APP_PGHOST)
 * ----------------------------------------------------- */

export type PgEnvReadOptions = {
  /** Optional prefix like "APP_" to read APP_PGHOST, APP_PGPORT, etc. */
  prefix?: string;

  /**
   * Optional DSN env var names to check in order (first present wins).
   * Defaults cover common patterns.
   */
  dsnVars?: readonly string[];

  /**
   * If true, read password from env (PGPASSWORD / <prefix>PGPASSWORD).
   * Default false (catalogs stay non-sensitive).
   */
  readPasswordFromEnv?: boolean;

  /**
   * Default host/port fallback (only used if neither DSN nor PG* are provided).
   * If omitted, leaves fields undefined.
   */
  defaults?: { host?: string; port?: string };
};

export function pgEnv(opts: PgEnvReadOptions = {}): Omit<PgInit, "engineId"> {
  const prefix = opts.prefix ?? "";
  const dsnVars = opts.dsnVars ??
    ["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL"];
  const readPasswordFromEnv = opts.readPasswordFromEnv ?? false;

  const read = (k: string) => Deno.env.get(prefix + k) ?? Deno.env.get(k);

  // DSN takes precedence if present.
  for (const v of dsnVars) {
    const dsn = Deno.env.get(prefix + v) ?? Deno.env.get(v);
    if (dsn) {
      return {
        ...parsePgDsn(dsn),
        password: readPasswordFromEnv
          ? (read("PGPASSWORD") ?? undefined)
          : undefined,
      };
    }
  }

  const host = read("PGHOST") ?? opts.defaults?.host;
  const port = read("PGPORT") ?? opts.defaults?.port;
  const user = read("PGUSER") ?? undefined;
  const dbname = read("PGDATABASE") ?? undefined;

  const password = readPasswordFromEnv
    ? (read("PGPASSWORD") ?? undefined)
    : undefined;

  return { host, port, user, dbname, password };
}

function parsePgDsn(dsn: string): Omit<PgInit, "engineId"> {
  // Supports: postgres://user:pass@host:port/db?sslmode=...
  // Also supports "postgresql://"
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    // If it’s not a URL, return empty and let caller handle.
    return {};
  }
  const user = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  const host = url.hostname || undefined;
  const port = url.port || undefined;

  const path = url.pathname?.startsWith("/")
    ? url.pathname.slice(1)
    : url.pathname;
  const dbname = path || undefined;

  // We don’t currently model sslmode/appname in PgInit; keep minimal.
  return { host, port, user, dbname, password };
}

/* -------------------------------------------------------
 * Catalog builder: multiple named PG connections from env
 * ----------------------------------------------------- */

export type PgCatalogFromEnvSpec = Record<
  string,
  {
    prefix?: string;
    require?: ReadonlyArray<"host" | "port" | "user" | "dbname">;
    defaults?: { host?: string; port?: string };
    readPasswordFromEnv?: boolean;
    dsnVars?: readonly string[];
  }
>;

export function definePgCatalogFromEnv(spec: PgCatalogFromEnvSpec) {
  const entries: Record<string, PgInit> = {};

  for (const [name, s] of Object.entries(spec)) {
    const init = pgEnv({
      prefix: s.prefix,
      defaults: s.defaults,
      readPasswordFromEnv: s.readPasswordFromEnv,
      dsnVars: s.dsnVars,
    });

    for (const req of s.require ?? []) {
      const v = (init as Record<string, unknown>)[req];
      if (typeof v !== "string" || v.length === 0) {
        throw new Error(
          `Missing required PG setting '${req}' for catalog entry '${name}'.`,
        );
      }
    }

    entries[name] = pgInit(init);
  }

  return defineLanguageInitCatalog(entries);
}

/* -------------------------------------------------------
 * pgpass support (password lookup only)
 * ----------------------------------------------------- */

export type PgPassLookup = {
  host?: string; // if undefined, treat as wildcard match
  port?: string;
  dbname?: string;
  user?: string;
};

export async function pgPasswordFromPgpass(
  q: PgPassLookup,
  opts: { pgpassPath?: string } = {},
): Promise<string | undefined> {
  const path = opts.pgpassPath ??
    Deno.env.get("PGPASSFILE") ??
    (Deno.env.get("HOME") ? `${Deno.env.get("HOME")}/.pgpass` : undefined);

  if (!path) return undefined;

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return undefined;
  }

  // pgpass format:
  // hostname:port:database:username:password
  // supports '*' wildcards in the first four fields
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
    l && !l.startsWith("#")
  );
  for (const line of lines) {
    const parts = splitPgpassLine(line);
    if (!parts) continue;

    const [host, port, db, user, pass] = parts;
    if (!pass) continue;

    if (
      pgpassMatch(host, q.host) &&
      pgpassMatch(port, q.port) &&
      pgpassMatch(db, q.dbname) &&
      pgpassMatch(user, q.user)
    ) {
      return pass;
    }
  }
  return undefined;
}

function splitPgpassLine(
  line: string,
): [string, string, string, string, string] | undefined {
  // pgpass allows escaping ':' and '\'
  const out: string[] = [];
  let cur = "";
  let esc = false;
  for (const ch of line) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === ":") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);

  if (out.length !== 5) return undefined;
  return out as [string, string, string, string, string];
}

function pgpassMatch(rule: string, value?: string): boolean {
  if (rule === "*") return true;
  if (value === undefined) return false;
  return rule === value;
}

/* -------------------------------------------------------
 * pg_service.conf support (basic)
 * ----------------------------------------------------- */

export type PgService = {
  host?: string;
  port?: string;
  user?: string;
  dbname?: string;
  password?: string;
  // leaving sslmode, options, etc out of PgInit; add if you want later
};

export async function pgServiceFromConf(
  serviceName: string,
  opts: { serviceFilePath?: string } = {},
): Promise<PgService | undefined> {
  const path = opts.serviceFilePath ??
    Deno.env.get("PGSERVICEFILE") ??
    (Deno.env.get("HOME")
      ? `${Deno.env.get("HOME")}/.pg_service.conf`
      : undefined);

  if (!path) return undefined;

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return undefined;
  }

  const ini = parseIni(text);
  const section = ini[serviceName];
  if (!section) return undefined;

  return {
    host: section.host,
    port: section.port,
    user: section.user,
    dbname: section.dbname,
    password: section.password,
  };
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const m = line.match(/^\[([^\]]+)\]$/);
    if (m) {
      current = m[1]!.trim();
      if (!result[current]) result[current] = {};
      continue;
    }

    const eq = line.indexOf("=");
    if (eq >= 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (!result[current]) result[current] = {};
      result[current]![k] = v;
    }
  }
  return result;
}

/* -------------------------------------------------------
 * Secret providers (no hard deps)
 * ----------------------------------------------------- */

export type PgSecret = {
  host?: string;
  port?: string;
  user?: string;
  dbname?: string;
  password?: string;
};

export type PgSecretProvider = {
  kind: string;
  getPgSecret(): Promise<PgSecret>;
};

export async function hydratePgInitWithSecrets(
  base: Omit<PgInit, "engineId">,
  provider: PgSecretProvider,
): Promise<Omit<PgInit, "engineId">> {
  const s = await provider.getPgSecret();
  return {
    host: base.host ?? s.host,
    port: base.port ?? s.port,
    user: base.user ?? s.user,
    dbname: base.dbname ?? s.dbname,
    password: base.password ?? s.password,
  };
}

/* -------------------------------------------------------
 * AWS Secrets Manager (HTTP + SigV4 is non-trivial)
 * -----------------------------------------------------
 * Opinionated stance:
 * - don’t implement SigV4 by hand here unless you already have it elsewhere
 * - instead, support these patterns:
 *   (a) local dev: AWS CLI provides decrypted secret: env var holds JSON
 *   (b) runtime: use a provided fetcher (injected) that already signs requests
 */

export function pgSecretFromJsonEnv(
  envVar: string,
  opts: {
    passwordField?: string;
    userField?: string;
    hostField?: string;
    portField?: string;
    dbField?: string;
  } = {},
): PgSecretProvider {
  const passwordField = opts.passwordField ?? "password";
  const userField = opts.userField ?? "username";
  const hostField = opts.hostField ?? "host";
  const portField = opts.portField ?? "port";
  const dbField = opts.dbField ?? "dbname";

  return {
    kind: "json-env",
    // deno-lint-ignore require-await
    async getPgSecret() {
      const raw = Deno.env.get(envVar);
      if (!raw) throw new Error(`Missing env var ${envVar}`);
      const j = JSON.parse(raw) as Record<string, unknown>;
      return {
        password: typeof j[passwordField] === "string"
          ? (j[passwordField] as string)
          : undefined,
        user: typeof j[userField] === "string"
          ? (j[userField] as string)
          : undefined,
        host: typeof j[hostField] === "string"
          ? (j[hostField] as string)
          : undefined,
        port: typeof j[portField] === "string"
          ? String(j[portField])
          : undefined,
        dbname: typeof j[dbField] === "string"
          ? (j[dbField] as string)
          : undefined,
      };
    },
  };
}

/**
 * Generic “bring your own fetch” provider.
 * Use this for:
 * - AWS Secrets Manager (SigV4-signed fetcher)
 * - Azure Key Vault (Bearer token fetcher)
 * - GCP Secret Manager (Bearer token fetcher)
 */
export function pgSecretFromFetcher(init: {
  kind: string;
  fetchJson: () => Promise<unknown>;
  map: (json: unknown) => PgSecret;
}): PgSecretProvider {
  return {
    kind: init.kind,
    async getPgSecret() {
      const j = await init.fetchJson();
      return init.map(j);
    },
  };
}
