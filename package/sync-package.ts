#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Sync files from lib/universal/ to package/ for JSR publishing
 *
 * This script:
 * 1. Copies all .ts files from lib/universal/ to package/
 * 2. Copies .fixture and .sql files without modification
 * 3. Fixes import paths to use local imports (../universal/ -> ./)
 * 4. Excludes files with external dependencies (like doctor.ts)
 * 5. Preserves the package configuration files (deno.json, mod.ts, etc.)
 *
 * Usage:
 *   deno task sync-package           # Just sync files
 *   deno task publish-dry-run        # Sync + dry run publish
 *   deno task publish-package        # Sync + publish to JSR
 */

import { copy, ensureDir, exists } from "@std/fs";
import { join, relative } from "@std/path";

const SOURCE_DIR = "../lib/universal";
const TARGET_DIR = ".";
const EXCLUDED_FILES = ["doctor.ts", "sync-package.ts"]; // Files with external dependencies or package-specific files

async function syncPackage() {
  console.log("🔄 Syncing files from ../lib/universal/ to current directory...");

  // Ensure target directory exists
  await ensureDir(TARGET_DIR);

  // Get list of files in source directory
  const sourceFiles: string[] = [];
  const otherFiles: string[] = [];

  for await (const entry of Deno.readDir(SOURCE_DIR)) {
    if (entry.isFile) {
      if (EXCLUDED_FILES.includes(entry.name)) {
        console.log(`⏭️  Skipping ${entry.name} (excluded)`);
        continue;
      }

      if (entry.name.endsWith(".ts")) {
        sourceFiles.push(entry.name);
      } else if (entry.name.endsWith(".fixture") || entry.name.endsWith(".sql")) {
        otherFiles.push(entry.name);
      }
    }
  }

  console.log(`📁 Found ${sourceFiles.length} TypeScript files and ${otherFiles.length} other files to sync`);

  // Copy and fix TypeScript files
  for (const filename of sourceFiles) {
    const sourcePath = join(SOURCE_DIR, filename);
    const targetPath = join(TARGET_DIR, filename);

    console.log(`📄 Processing ${filename}...`);

    // Read source file
    const content = await Deno.readTextFile(sourcePath);

    // Fix import paths
    const fixedContent = fixImportPaths(content, filename);

    // Write to target
    await Deno.writeTextFile(targetPath, fixedContent);
  }

  // Copy other files (fixtures, SQL, etc.) without modification
  for (const filename of otherFiles) {
    const sourcePath = join(SOURCE_DIR, filename);
    const targetPath = join(TARGET_DIR, filename);

    console.log(`📄 Copying ${filename}...`);
    await copy(sourcePath, targetPath, { overwrite: true });
  }

  console.log("✅ Package sync complete!");
  console.log("📦 Ready to publish from current directory!");
}

function fixImportPaths(content: string, filename: string): string {
  // Fix relative imports from ../universal/ to ./
  let fixed = content.replace(/from\s+["']\.\.\/universal\/([^"']+)["']/g, 'from "./$1"');
  fixed = fixed.replace(/import\s+["']\.\.\/universal\/([^"']+)["']/g, 'import "./$1"');

  // Log if we made changes
  if (fixed !== content) {
    console.log(`  🔧 Fixed import paths in ${filename}`);
  }

  return fixed;
}

if (import.meta.main) {
  try {
    await syncPackage();
  } catch (error) {
    console.error("❌ Sync failed:", error);
    Deno.exit(1);
  }
}
