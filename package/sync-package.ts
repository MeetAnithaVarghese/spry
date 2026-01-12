#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Sync files from lib/universal/ and lib/spawn/ to package/ for JSR publishing
 *
 * This script:
 * 1. Copies all .ts files from lib/universal/ to package/
 * 2. Copies .fixture and .sql files without modification
 * 3. Copies the entire lib/spawn/ folder to package/spawn/
 * 4. Fixes import paths to use local imports (../universal/ -> ./, ../spawn/ -> ./spawn/)
 * 5. Excludes files with external dependencies (like doctor.ts)
 * 6. Preserves the package configuration files (deno.json, mod.ts, etc.)
 *
 * Usage:
 *   deno task sync-package           # Just sync files
 *   deno task publish-dry-run        # Sync + dry run publish
 *   deno task publish-package        # Sync + publish to JSR
 */

import { copy, ensureDir, exists } from "@std/fs";
import { join, relative } from "@std/path";

const SOURCE_DIR = "../lib/universal";
const SPAWN_SOURCE_DIR = "../lib/spawn";
const TARGET_DIR = ".";
const SPAWN_TARGET_DIR = "./spawn";
const EXCLUDED_FILES = ["sync-package.ts"]; // Files with external dependencies or package-specific files

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

  // Copy spawn folder
  await copySpawnFolder();

  console.log("✅ Package sync complete!");
  console.log("📦 Ready to publish from current directory!");
}

async function copySpawnFolder() {
  console.log("📁 Copying spawn folder...");

  // Check if spawn source directory exists
  if (!(await exists(SPAWN_SOURCE_DIR))) {
    console.log("⚠️  Spawn source directory not found, skipping...");
    return;
  }

  // Copy the entire spawn folder
  await copy(SPAWN_SOURCE_DIR, SPAWN_TARGET_DIR, { overwrite: true });

  // Fix import paths in spawn folder files
  await fixSpawnImportPaths();

  console.log("✅ Spawn folder copied successfully");
}

async function fixSpawnImportPaths() {
  console.log("🔧 Fixing import paths in spawn folder...");

  // Recursively process all .ts files in spawn folder
  for await (const entry of Deno.readDir(SPAWN_TARGET_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      const filePath = join(SPAWN_TARGET_DIR, entry.name);
      const content = await Deno.readTextFile(filePath);
      const fixedContent = fixSpawnFileImportPaths(content, entry.name);

      if (fixedContent !== content) {
        await Deno.writeTextFile(filePath, fixedContent);
        console.log(`  🔧 Fixed import paths in spawn/${entry.name}`);
      }
    } else if (entry.isDirectory) {
      // Handle subdirectories (like sql-shell)
      const subDirPath = join(SPAWN_TARGET_DIR, entry.name);
      for await (const subEntry of Deno.readDir(subDirPath)) {
        if (subEntry.isFile && subEntry.name.endsWith(".ts")) {
          const filePath = join(subDirPath, subEntry.name);
          const content = await Deno.readTextFile(filePath);
          const fixedContent = fixSpawnFileImportPaths(content, `${entry.name}/${subEntry.name}`);

          if (fixedContent !== content) {
            await Deno.writeTextFile(filePath, fixedContent);
            console.log(`  🔧 Fixed import paths in spawn/${entry.name}/${subEntry.name}`);
          }
        }
      }
    }
  }
}

function fixSpawnFileImportPaths(content: string, filename: string): string {
  // Fix imports from universal paths to appropriate relative path
  let fixed = content;

  if (filename.includes("/")) {
    // For files in subdirectories (like sql-shell/), fix ../../universal/ to ../../
    fixed = content.replace(/from\s+["']\.\.\/\.\.\/universal\/([^"']+)["']/g, 'from "../../$1"');
    fixed = fixed.replace(/import\s+["']\.\.\/\.\.\/universal\/([^"']+)["']/g, 'import "../../$1"');
    // Also fix ../universal/ to ../../ (in case some files use this pattern)
    fixed = fixed.replace(/from\s+["']\.\.\/universal\/([^"']+)["']/g, 'from "../../$1"');
    fixed = fixed.replace(/import\s+["']\.\.\/universal\/([^"']+)["']/g, 'import "../../$1"');
  } else {
    // For files in spawn root, use ../
    fixed = content.replace(/from\s+["']\.\.\/universal\/([^"']+)["']/g, 'from "../$1"');
    fixed = fixed.replace(/import\s+["']\.\.\/universal\/([^"']+)["']/g, 'import "../$1"');
  }

  return fixed;
}

function fixImportPaths(content: string, filename: string): string {
  // Fix relative imports from ../universal/ to ./
  let fixed = content.replace(/from\s+["']\.\.\/universal\/([^"']+)["']/g, 'from "./$1"');
  fixed = fixed.replace(/import\s+["']\.\.\/universal\/([^"']+)["']/g, 'import "./$1"');

  // Fix relative imports from ../spawn/ to ./spawn/
  fixed = fixed.replace(/from\s+["']\.\.\/spawn\/([^"']+)["']/g, 'from "./spawn/$1"');
  fixed = fixed.replace(/import\s+["']\.\.\/spawn\/([^"']+)["']/g, 'import "./spawn/$1"');

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
