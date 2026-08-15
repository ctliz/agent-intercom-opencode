import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url);

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")) as Record<string, any>;
}

test("published package contains exactly the intended protected-provider source and artifact", () => {
  const packageManifest = manifest();
  const providerRules = packageManifest.files.filter((path: string) => path.replace(/^!/, "").startsWith("provider/"));

  assert.deepEqual(providerRules, [
    "provider/protected-service.ts",
    "provider/provider.mjs",
    "!provider/entry.ts",
  ]);
  assert.ok(packageManifest.files.includes("!scripts/build-protected-provider.mjs"));
  assert.equal(providerRules.some((path: string) => path.includes("*")), false);
  assert.ok(existsSync(new URL("provider/protected-service.ts", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/provider.mjs", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/entry.ts", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/protected-service.test.ts", repositoryRoot)));
});

test("published package ships the canonical protocol-v4 re-export", () => {
  const packageManifest = manifest();
  assert.ok(packageManifest.files.includes("protocol-v4/**/*.ts"), "package.json files must include protocol-v4/**/*.ts");
  assert.ok(packageManifest.files.includes("!protocol-v4/**/*.test.ts"), "package.json files must exclude protocol-v4 tests");
  assert.ok(existsSync(new URL("protocol-v4/contract.ts", repositoryRoot)), "protocol-v4/contract.ts must exist");
  assert.ok(existsSync(new URL("protocol-v4/contract.test.ts", repositoryRoot)), "protocol-v4/contract.test.ts must exist");
  const contract = readFileSync(new URL("protocol-v4/contract.ts", repositoryRoot), "utf8");
  assert.match(contract, /@ctliz\/agent-intercom-core\/protocol-v4/);
  assert.match(contract, /parseIntercomScopeId/);
  assert.match(contract, /sameIntercomScope/);
});

test("package declares protocol-v4 dependency on Core and has zero runtime dependencies", () => {
  const packageManifest = manifest();
  assert.equal(packageManifest.dependencies, undefined, "package.json must have no runtime dependencies");
  const coreDep = packageManifest.peerDependencies?.["@ctliz/agent-intercom-core"];
  assert.equal(coreDep, "0.2.0", "@ctliz/agent-intercom-core peer dependency must be 0.2.0");
  assert.equal(packageManifest.devDependencies?.["@opencode-ai/plugin"], "1.18.18");
});

test("package includes all third-party notices and license files for self-contained runtime", () => {
  const packageManifest = manifest();
  assert.ok(packageManifest.files.includes("THIRD_PARTY_NOTICES.md"));
  assert.ok(packageManifest.files.includes("licenses/**/*"));
  assert.ok(existsSync(new URL("licenses/MIT-pi-intercom.txt", repositoryRoot)));
  assert.ok(existsSync(new URL("licenses/MIT-opencode-ai-plugin.txt", repositoryRoot)));
  assert.ok(existsSync(new URL("licenses/MIT-zod.txt", repositoryRoot)));

  const opencodeLicense = readFileSync(new URL("licenses/MIT-opencode-ai-plugin.txt", repositoryRoot), "utf8");
  assert.match(opencodeLicense, /Copyright \(c\) 2025 opencode/, "opencode MIT license must have exact upstream holder 'opencode'");
  assert.doesNotMatch(opencodeLicense, /OpenCode AI/, "opencode MIT license must not synthesize holder 'OpenCode AI'");

  const zodLicense = readFileSync(new URL("licenses/MIT-zod.txt", repositoryRoot), "utf8");
  assert.match(zodLicense, /Copyright \(c\) 2025 Colin McDonnell/);

  const notices = readFileSync(new URL("THIRD_PARTY_NOTICES.md", repositoryRoot), "utf8");
  assert.match(notices, /## pi-intercom/);
  assert.match(notices, /## @opencode-ai\/plugin/);
  assert.match(notices, /https:\/\/github\.com\/anomalyco\/opencode/, "THIRD_PARTY_NOTICES must link to upstream anomalyco/opencode");
  assert.doesNotMatch(notices, /github\.com\/opencode-ai\/plugin/, "THIRD_PARTY_NOTICES must not link to nonexistent opencode-ai/plugin repo");
  assert.match(notices, /1\.18\.18/);
  assert.match(notices, /## zod/);
  assert.match(notices, /4\.1\.8/);
});

test("protected provider is neither an export, plugin, executable, nor ordinary build entry", () => {
  const packageManifest = manifest();
  const ordinaryBuild = readFileSync(new URL("scripts/build.mjs", repositoryRoot), "utf8");

  assert.equal(packageManifest.main, "dist/plugin.mjs");
  assert.deepEqual(packageManifest.exports, {
    ".": "./dist/plugin.mjs",
    "./tui": "./dist/tui.mjs",
  });
  assert.equal(packageManifest.bin, undefined);
  assert.equal(Object.values(packageManifest.exports).includes("./provider/provider.mjs"), false);
  assert.doesNotMatch(ordinaryBuild, /protected-provider|provider\/provider\.mjs|provider\/entry\.ts/);
  assert.deepEqual(Array.from(ordinaryBuild.matchAll(/entryPoints: \["([^"]+)"\]/g), (match) => match[1]), [
    "opencode/plugin-entry.ts",
    "opencode/tui.ts",
    "broker/broker.ts",
  ]);
  assert.equal(packageManifest.scripts.build, "node scripts/build.mjs");
  assert.equal(packageManifest.scripts.prepare, "npm run build");
  assert.equal(packageManifest.scripts.prepack, "npm run build:protected-provider");
});

test("ordinary builds retain the shared Core externalizer and exactly three dist bundles", () => {
  const ordinaryBuild = readFileSync(new URL("scripts/build.mjs", repositoryRoot), "utf8");
  const coreExternalizer = readFileSync(new URL("scripts/core-external.mjs", repositoryRoot), "utf8");

  assert.match(ordinaryBuild, /import \{ externalizeCorePlugin \} from "\.\/core-external\.mjs"/);
  assert.match(ordinaryBuild, /plugins: \[externalizeCorePlugin\]/);
  assert.deepEqual(Array.from(ordinaryBuild.matchAll(/outfile: "dist\/([^"]+)"/g), (match) => match[1]), [
    "plugin.mjs",
    "tui.mjs",
    "broker.mjs",
  ]);
  assert.match(coreExternalizer, /export const CORE_PACKAGE = "@ctliz\/agent-intercom-core"/);
  assert.match(coreExternalizer, /\^@ctliz\\\/agent-intercom-core\(\?:\\\/.*\)\?\$/);
  assert.match(coreExternalizer, /external: true/);
  assert.doesNotMatch(coreExternalizer, /protected-provider|provider\/provider\.mjs|provider\/entry\.ts/);
});

test("shipped plugin bundle is built from entry shim and enforces default-only production export surface", () => {
  assert.ok(existsSync(new URL("opencode/plugin-entry.ts", repositoryRoot)), "opencode/plugin-entry.ts must exist");
  const entryShim = readFileSync(new URL("opencode/plugin-entry.ts", repositoryRoot), "utf8");
  assert.match(entryShim, /export\s+\{\s*default\s*\}\s+from\s+["']\.\/plugin\.ts["']/);

  const pluginBundle = readFileSync(new URL("dist/plugin.mjs", repositoryRoot), "utf8");
  const exportMatches = Array.from(pluginBundle.matchAll(/export\s*\{([^}]+)\}/g), (m) => m[1].trim());
  assert.ok(exportMatches.length > 0, "dist/plugin.mjs must contain export statement");
  for (const exportClause of exportMatches) {
    const exportedItems = exportClause.split(",").map((item) => item.trim()).filter(Boolean);
    for (const item of exportedItems) {
      assert.match(item, /(?:^|\s)as\s+default$|^default$/, `dist/plugin.mjs must only export default, found: ${item}`);
    }
  }
});
