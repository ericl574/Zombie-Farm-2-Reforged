import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, loadConfigFromFile } from "vite";
import { root, auditPrivateBuild } from "../server/scripts/private-config.mjs";
import { privateViteConfig } from "./private-vite.mjs";

// Build only. Synthetic targets cannot be uploaded by the guarded deploy commands,
// and no real settings, account IDs, resources or secret files are substituted.
const frontend = {
  VITE_API_URL: "https://private-preflight.example.invalid",
  VITE_GOOGLE_CLIENT_ID: "123456789012-privatepreflight.apps.googleusercontent.com",
};
const outDir = mkdtempSync(join(tmpdir(), "zf-private-build-preflight-"));
try {
  // Deliberately hostile ambient variables prove both JS and CSP stay private.
  process.env.VITE_API_URL = "https://zombiefarm-server.zombiefarm.workers.dev";
  process.env.VITE_GOOGLE_CLIENT_ID = "upstream-ambient-must-not-be-used";
  const base = await loadConfigFromFile({ command: "build", mode: "private" }, join(root, "vite.config.ts"));
  if (!base) throw new Error("Could not load the base Vite config.");
  await build({ ...privateViteConfig(base.config, frontend, outDir), configFile: false, root, mode: "private" });
  console.log(`LOCAL SYNTHETIC PREFLIGHT PASSED: ${auditPrivateBuild(outDir, frontend)} files; private JS/CSP, no upstream hosts, no CNAME. No upload was performed.`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
