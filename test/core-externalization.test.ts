import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CORE_PACKAGE,
  isCoreImport,
} from "../scripts/core-external.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundles = ["plugin.mjs", "tui.mjs", "broker.mjs"] as const;
const exactCoreDevGit = "0.2.0";

function extractExternalImports(source: string): string[] {
  const importLines = source.split("\n").filter(line => line.trim().startsWith("import "));
  const specifiers: string[] = [];
  for (const line of importLines) {
    const match = line.match(/\bfrom\s+["']([^"']+)["']/) || line.match(/\bimport\s+["']([^"']+)["']/);
    if (match) specifiers.push(match[1]);
  }
  return specifiers;
}

test("Core source matcher covers the package root and every subpath only", () => {
  assert.equal(isCoreImport(CORE_PACKAGE), true);
  assert.equal(isCoreImport(`${CORE_PACKAGE}/boss`), true);
  assert.equal(isCoreImport(`${CORE_PACKAGE}/boss/policy`), true);
  assert.equal(isCoreImport(`${CORE_PACKAGE}/future/nested/export`), true);
  assert.equal(isCoreImport(`${CORE_PACKAGE}-lookalike`), false);
  assert.equal(isCoreImport("@ctliz/agent-intercom"), false);
  // The retired namespace must never be treated as Core, root or subpath.
  assert.equal(isCoreImport("@dataforxyz/agent-intercom-core"), false);
  assert.equal(isCoreImport("@dataforxyz/agent-intercom-core/boss"), false);

  const buildSource = readFileSync(join(root, "scripts/build.mjs"), "utf8");
  assert.match(buildSource, /plugins: \[externalizeCorePlugin\]/);
  assert.doesNotMatch(buildSource, /external:\s*\[.*@opencode-ai/);
});

test("every dist bundle retains Core imports without embedding a second copy", () => {
  for (const bundle of bundles) {
    const source = readFileSync(join(root, "dist", bundle), "utf8");
    const imports = extractExternalImports(source);
    const coreSpecifiers = imports.filter(s => s.startsWith("@ctliz/agent-intercom-core"));
    assert.ok(coreSpecifiers.length > 0, `${bundle} must retain at least one external Core import`);
    assert.ok(coreSpecifiers.every(isCoreImport), `${bundle} contains an invalid Core import`);
    assert.doesNotMatch(
      source,
      /node_modules\/@ctliz\/agent-intercom-core\//,
      `${bundle} must not embed Core implementation modules`,
    );
  }
});

test("every dist bundle contains only Node built-ins and Core imports, with zero non-Core bare runtime imports", () => {
  const nodeBuiltins = new Set([
    ...builtinModules,
    ...builtinModules.map(m => `node:${m}`),
    "node:fs/promises",
  ]);

  for (const bundle of bundles) {
    const source = readFileSync(join(root, "dist", bundle), "utf8");
    const imports = extractExternalImports(source);
    for (const specifier of imports) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (nodeBuiltins.has(specifier)) continue;
      assert.ok(
        isCoreImport(specifier),
        `${bundle} has prohibited bare runtime import: "${specifier}" (only Core and Node built-ins are permitted)`,
      );
    }

    // Prohibit dynamic or non-bundled imports of SDK/schema dependencies
    assert.doesNotMatch(source, /from\s+["']@opencode-ai\//);
    assert.doesNotMatch(source, /from\s+["']@ai-sdk\//);
    assert.doesNotMatch(source, /from\s+["']effect(?:\/|["'])/);
    assert.doesNotMatch(source, /from\s+["']zod(?:\/|["'])/);
  }
});

test("package manifest has zero runtime dependencies and requires Core 0.2.0 as peer dependency", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as Record<string, any>;

  // Zero runtime dependencies
  assert.equal(manifest.dependencies, undefined, "package.json must have no runtime dependencies");
  assert.equal(lock.packages?.[""]?.dependencies, undefined, "package-lock.json root must have no dependencies");

  // Exact Core peer and dev dependencies
  assert.equal(manifest.peerDependencies?.[CORE_PACKAGE], "0.2.0");
  assert.equal(manifest.devDependencies?.[CORE_PACKAGE], exactCoreDevGit);
  assert.equal(manifest.devDependencies?.["@opencode-ai/plugin"], "1.18.18");

  assert.equal(lock.packages?.[""]?.peerDependencies?.[CORE_PACKAGE], "0.2.0");
  assert.equal(lock.packages?.[""]?.devDependencies?.[CORE_PACKAGE], exactCoreDevGit);
  assert.equal(lock.packages?.[""]?.devDependencies?.["@opencode-ai/plugin"], "1.18.18");

  assert.ok(manifest.files?.includes("dist/**/*"));
  assert.ok(manifest.files?.includes("opencode/**/*.ts"));
  assert.ok(manifest.files?.includes("broker/**/*.ts"));
  assert.ok(manifest.files?.includes("THIRD_PARTY_NOTICES.md"));
  assert.ok(manifest.files?.includes("licenses/**/*"));
});

test("shipped TUI resolves against an explicitly supplied Core package offline", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opencode-intercom-offline-core-"));
  try {
    const modules = join(fixture, "node_modules");
    const adapterDir = join(modules, "@ctliz", "agent-intercom-opencode");
    const coreDir = join(modules, "@ctliz", "agent-intercom-core");
    mkdirSync(adapterDir, { recursive: true });
    cpSync(join(root, "package.json"), join(adapterDir, "package.json"));
    cpSync(join(root, "dist"), join(adapterDir, "dist"), { recursive: true });
    cpSync(join(root, "node_modules", ...CORE_PACKAGE.split("/")), coreDir, { recursive: true });

    const entrypoint = pathToFileURL(join(adapterDir, "dist", "tui.mjs")).href;
    const loaded = await import(`${entrypoint}?offline-explicit-core=${Date.now()}`);
    assert.equal(loaded.default?.id, "opencode-intercom");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("shipped plugin resolves offline with ONLY Core (no OpenCode SDK/zod in node_modules) and exposes default-only callable factory", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opencode-intercom-offline-self-contained-"));
  try {
    const modules = join(fixture, "node_modules");
    const adapterDir = join(modules, "@ctliz", "agent-intercom-opencode");
    const coreDir = join(modules, "@ctliz", "agent-intercom-core");
    mkdirSync(adapterDir, { recursive: true });
    cpSync(join(root, "package.json"), join(adapterDir, "package.json"));
    cpSync(join(root, "dist"), join(adapterDir, "dist"), { recursive: true });
    // ONLY Core is copied into node_modules. No @opencode-ai, no zod, no effect, no @ai-sdk.
    cpSync(join(root, "node_modules", ...CORE_PACKAGE.split("/")), coreDir, { recursive: true });

    assert.equal(existsSync(join(modules, "@opencode-ai")), false, "@opencode-ai must not exist in node_modules");
    assert.equal(existsSync(join(modules, "zod")), false, "zod must not exist in node_modules");
    assert.equal(existsSync(join(modules, "effect")), false, "effect must not exist in node_modules");
    assert.equal(existsSync(join(modules, "@ai-sdk")), false, "@ai-sdk must not exist in node_modules");

    const entrypoint = pathToFileURL(join(adapterDir, "dist", "plugin.mjs")).href;
    const loaded = await import(`${entrypoint}?offline-self-contained=${Date.now()}`);

    // Exact export surface assertion: exactly one export named "default", and it must be a function
    assert.deepEqual(Object.keys(loaded), ["default"]);
    assert.equal(typeof loaded.default, "function");

    // OpenCode 1.18.18 loader-parity check: iterate every export and ensure callable
    for (const [exportName, exportValue] of Object.entries(loaded)) {
      assert.equal(typeof exportValue, "function", `Plugin export "${exportName}" must be a function`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
