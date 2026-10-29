import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { root, privateConfigPath, readToml, inspectPrivateConfig, inspectPrivateFrontend,
  originalIdentifiers, auditPrivateBuild } from "../scripts/private-config.mjs";

const original = originalIdentifiers();
const template = readToml(privateConfigPath);
// Synthetic identifiers only: these are never used in a remote command.
const frontend = {
  VITE_API_URL: "https://eric-zf-api.private-preflight.workers.dev",
  VITE_GOOGLE_CLIENT_ID: "123456789012-privatepreflight.apps.googleusercontent.com",
  PRIVATE_PAGES_PROJECT: "private-preflight-farm",
  PRIVATE_FRONTEND_ORIGIN: "https://private-preflight-farm.pages.dev",
};
const validConfig = () => ({
  ...structuredClone(template), account_id: "11111111111111111111111111111111",
  d1_databases: [{ ...template.d1_databases[0], database_id: "11111111-1111-4111-8111-111111111111" }],
  vars: { ...template.vars, GOOGLE_CLIENT_ID: frontend.VITE_GOOGLE_CLIENT_ID, ALLOWED_ORIGIN: frontend.PRIVATE_FRONTEND_ORIGIN },
});
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("private deployment isolation", () => {
  it("blocks missing deployment identities independently of the owner's setup progress", () => {
    const config = validConfig();
    config.account_id = "REQUIRED_CLOUDFLARE_ACCOUNT_ID";
    config.d1_databases[0].database_id = "REQUIRED_PRIVATE_D1_UUID";
    config.vars.GOOGLE_CLIENT_ID = "REQUIRED_GOOGLE_WEB_CLIENT_ID";
    config.vars.ALLOWED_ORIGIN = "https://REQUIRED_PRIVATE_FRONTEND.invalid";
    const result = inspectPrivateConfig(config, original);
    expect(result.errors).toEqual([]);
    expect(result.blockers).toHaveLength(4);
  });

  it("accepts matching private settings and preserves all current gameplay defaults", () => {
    const config = validConfig();
    expect(inspectPrivateConfig(config, original)).toEqual({ errors: [], blockers: [] });
    expect(inspectPrivateFrontend(frontend, config, original)).toEqual([]);
    const production = readToml(join(root, "server/wrangler.toml")).env.production;
    expect(config.vars).toEqual({ ...production.vars, GOOGLE_CLIENT_ID: frontend.VITE_GOOGLE_CLIENT_ID,
      ALLOWED_ORIGIN: frontend.PRIVATE_FRONTEND_ORIGIN, GROWTH_TIME_CONTROL: "1" });
    expect(config.triggers).toEqual(production.triggers);
  });

  it.each(original.databases)("rejects an upstream database UUID ($database_name)", (db) => {
    const config = validConfig();
    config.d1_databases[0].database_id = db.database_id;
    expect(inspectPrivateConfig(config, original).errors.join(" ")).toContain("upstream D1");
    config.d1_databases[0].database_id = db.database_id.toUpperCase();
    expect(inspectPrivateConfig(config, original).errors.join(" ")).toContain("upstream D1");
  });

  it.each(original.names)("rejects upstream Worker %s", (name) => {
    expect(inspectPrivateConfig({ ...validConfig(), name }, original).errors).not.toEqual([]);
  });

  it.each([
    (c) => { c.env = { production: {} }; },
    (c) => { c.routes = ["zombiefarmreforged.com/*"]; },
    (c) => { c.build = { command: "unexpected" }; },
    (c) => { c.d1_databases[0].database_name = "zombiefarm"; },
    (c) => { c.vars.DEV_AUTH = "1"; },
    (c) => { c.vars.GROWTH_TIME_CONTROL = "0"; },
    (c) => { c.vars.RAID_COOLDOWN_MS = "1"; },
    (c) => { c.vars.SESSION_SECRET = "must-not-be-in-public-config"; },
    (c) => { c.vars.GOOGLE_CLIENT_ID = original.googleIds[0]; },
    (c) => { c.vars.ALLOWED_ORIGIN = "https://zombiefarmreforged.com"; },
    (c) => { c.vars.ALLOWED_ORIGIN = frontend.PRIVATE_FRONTEND_ORIGIN + "/"; },
  ])("rejects unsafe worker target/settings case %#", (mutate) => {
    const config = validConfig();
    mutate(config);
    expect(inspectPrivateConfig(config, original).errors).not.toEqual([]);
  });

  it.each([
    { VITE_API_URL: "https://zombiefarm-server.zombiefarm.workers.dev" },
    { VITE_API_URL: "https://zombiefarm-server-staging.zombiefarm.workers.dev" },
    { VITE_API_URL: "https://other-worker.private-preflight.workers.dev" },
    { VITE_API_URL: frontend.VITE_API_URL + "/api" },
    { VITE_GOOGLE_CLIENT_ID: original.googleIds[0] },
    { VITE_GOOGLE_CLIENT_ID: "different-client.apps.googleusercontent.com" },
    { PRIVATE_FRONTEND_ORIGIN: "https://other.pages.dev" },
    { SESSION_SECRET: "must-not-be-in-frontend" },
  ])("rejects unsafe or mismatched frontend settings %#", (override) => {
    expect(inspectPrivateFrontend({ ...frontend, ...override }, validConfig(), original)).not.toEqual([]);
  });

  it("blocks remote actions before reading credentials or spawning Wrangler without explicit execution", () => {
    for (const action of ["deploy-worker", "deploy-frontend"]) {
      const result = spawnSync(process.execPath, [join(root, "server/scripts/private-deploy.mjs"), action], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--execute");
      expect(result.stdout).not.toContain("wrangler");
    }
  });

  it("does not accept arbitrary CLI flags that could redirect a private action", () => {
    const result = spawnSync(process.execPath, [join(root, "server/scripts/private-deploy.mjs"), "dry-run", "--env", "production"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("arbitrary Wrangler arguments are forbidden");
  });

  function buildFixture() {
    const dir = mkdtempSync(join(tmpdir(), "zf-private-audit-"));
    directories.push(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' data: https://accounts.google.com ${frontend.VITE_API_URL};">`);
    writeFileSync(join(dir, "assets/main.js"), `const api=${JSON.stringify(frontend.VITE_API_URL)}, client=${JSON.stringify(frontend.VITE_GOOGLE_CLIENT_ID)};`);
    return dir;
  }

  it("audits source maps and service workers as well as the visible frontend bundle", () => {
    const dir = buildFixture();
    expect(auditPrivateBuild(dir, frontend)).toBe(2);
    for (const file of ["assets/main.js.map", "sw.js"]) {
      writeFileSync(join(dir, file), '"https://zombiefarm-server.zombiefarm.workers.dev"');
      expect(() => auditPrivateBuild(dir, frontend)).toThrow("Upstream host reference");
      rmSync(join(dir, file));
    }
  });

  it.each(["CNAME", "_worker.js", "_redirects", "_routes.json"])("rejects private upload override file %s", (file) => {
    const dir = buildFixture();
    writeFileSync(join(dir, file), "unexpected");
    expect(() => auditPrivateBuild(dir, frontend)).toThrow("override file");
  });

  it("rejects an incorrect CSP even when the JS points at the private API", () => {
    const dir = buildFixture();
    const html = readFileSync(join(dir, "index.html"), "utf8").replace(frontend.VITE_API_URL, "https://other.example.com");
    writeFileSync(join(dir, "index.html"), html);
    expect(() => auditPrivateBuild(dir, frontend)).toThrow("Private CSP");
  });
});
