#!/bin/sh
# SpryMD.org quick init
# Usage:
#   curl -fsSL https://sprymd.org/init.sh | sh
#   curl -fsSL https://sprymd.org/init.sh | sh -s -- --target-dir [dir] --dialect [dialect]
#
# Arguments:
#   target-dir: Directory to initialize Spry in (default: current directory)
#   dialect: Database dialect - 'sqlite' or 'postgres' (default: sqlite)
#
# Behavior:
# - Verifies Deno is installed
# - Runs the Spry CLI init in the current dir (or optional target dir)
# - Prints next-step commands
set -eu
CLI_URL="https://cdn.jsdelivr.net/gh/programmablemd/spry@latest/lib/sqlpage/cli.ts"
say() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
command -v deno >/dev/null 2>&1 || err "Deno not found.
Install Deno first:
  curl -fsSL https://deno.land/install.sh | sh
Then re-run:
  curl -fsSL https://sprymd.org/init.sh | sh "

# Parse arguments
TARGET_DIR="."
DIALECT="sqlite"

while [ $# -gt 0 ]; do
  case "$1" in
    --target-dir)
      if [ -n "${2:-}" ]; then
        TARGET_DIR="$2"
        shift 2
      else
        err "--target-dir requires a value"
      fi
      ;;
    --dialect)
      if [ -n "${2:-}" ]; then
        DIALECT="$2"
        shift 2
      else
        err "--dialect requires a value (sqlite or postgres)"
      fi
      ;;
    -*)
      err "Unknown option: $1"
      ;;
    *)
      # First positional argument is target directory
      if [ "$TARGET_DIR" = "." ]; then
        TARGET_DIR="$1"
      # Second positional argument is dialect (for backward compatibility)
      elif [ "$DIALECT" = "sqlite" ]; then
        DIALECT="$1"
      else
        err "Too many arguments"
      fi
      shift
      ;;
  esac
done

# Validate dialect parameter
if [ "$DIALECT" != "sqlite" ] && [ "$DIALECT" != "postgres" ]; then
  err "Invalid dialect: $DIALECT
Supported dialects: sqlite, postgres
Usage:
  curl -fsSL https://sprymd.org/init.sh | sh
  curl -fsSL https://sprymd.org/init.sh | sh -s -- --target-dir [dir] --dialect [dialect]"
fi

# Normalize and ensure target dir exists
if [ "$TARGET_DIR" != "." ]; then
  mkdir -p "$TARGET_DIR"
  cd "$TARGET_DIR"
fi
say "Initializing Spry in: $(pwd)"
say "Database dialect: $DIALECT"
say "Running Spry CLI init…"
# --node-modules-dir=auto is used to ensure Node-style deps (if any) resolve
deno run --node-modules-dir=auto -A "$CLI_URL" init --dialect "$DIALECT"
say ""
say "✅ Spry initialized with $DIALECT dialect."
say ""
say "Next steps:"
if [ -x "./spry.ts" ]; then
  say "  ./spry.ts help"
else
  # Fallback in case spry.ts isn't marked executable
  say "  deno run -A ./spry.ts help"
fi
say ""
say "Tip: Keep this two-step install handy for docs:"
say "  1) curl -fsSL https://deno.land/install.sh | sh"
say "  2) curl -fsSL https://sprymd.org/init.sh | sh"
say ""
say "For PostgreSQL:"
say "  curl -fsSL https://sprymd.org/init.sh | sh -s -- --target-dir . --dialect postgres"