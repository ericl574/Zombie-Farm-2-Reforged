import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  root, privateConfigPath, readToml, inspectPrivateConfig, loadPrivateSettings, auditPrivateBuild,
} from "./private-config.mjs";

const wrangler = join(root, "server/node_modules/wrangler/bin/wrangler.js");
const configArgs = ["--config", privateConfigPath, "--env", ""];
const output = join(root, "dist-private");
const secretsFile = join(root, "server/.secrets/private-worker.env");
const [action, ...flags] = process.argv.slice(2);
const remote = action === "deploy-worker" || action === "deploy-frontend";

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env } });
  if (result.error) throw new Error(`Could not start local tool: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Local/deployment command failed (exit ${result.status ?? result.signal}).`);
}

function build(frontend) {
  // A failed build must not leave an earlier private bundle available for upload.
  rmSync(output, { recursive: true, force: true });
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit"]);
  run(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.private.config.ts", "--mode", "private"]);
  console.log(`Private build isolation verified (${auditPrivateBuild(output, frontend)} files).`);
}

function requireSecret() {
  let values;
  try { values = parseEnv(readFileSync(secretsFile, "utf8")); }
  catch { throw new Error("Provide server/.secrets/private-worker.env containing only SESSION_SECRET (never paste the secret into chat)."); }
  if (Object.keys(values).length !== 1 || !values.SESSION_SECRET || values.SESSION_SECRET.length < 32 ||
      /REQUIRED|change.?me|dev-only|placeholder/i.test(values.SESSION_SECRET)) {
    throw new Error("The private secret file must contain only a fresh, random SESSION_SECRET of at least 32 characters.");
  }
}

try {
  if (!["check", "plan", "dry-run", "build", "deploy-worker", "deploy-frontend"].includes(action) ||
      flags.some((flag) => flag !== "--execute") || (!remote && flags.length)) {
    throw new Error("Use a documented private npm command. Only remote commands accept --execute; arbitrary Wrangler arguments are forbidden.");
  }
  if (remote && (flags.length !== 1 || flags[0] !== "--execute")) {
    throw new Error("No action taken. Remote deployment requires explicit user approval, then this command's --execute flag. Use private:plan to review targets.");
  }
  if (action === "dry-run") {
    const config = readToml(privateConfigPath);
    const { errors, blockers } = inspectPrivateConfig(config);
    if (errors.length) throw new Error(errors.join("\n"));
    const dir = join(root, "server/.wrangler/private-dry-run");
    mkdirSync(dir, { recursive: true });
    console.log("LOCAL ONLY: compile the private Worker; no upload, secrets, resource provisioning or database initialization.");
    run(process.execPath, [wrangler, "deploy", ...configArgs, "--dry-run", "--outdir", dir], {
      // Placeholders are allowed ONLY for this non-uploading command.
      CLOUDFLARE_ACCOUNT_ID: config.account_id,
      WRANGLER_LOG_PATH: join(dir, "wrangler.log"),
    });
    if (blockers.length) console.log(`Worker compiled; deployment remains BLOCKED:\n- ${blockers.join("\n- ")}\nRun private:check to check frontend settings too.`);
  } else {
    const { config, frontend } = loadPrivateSettings();
    if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id) {
      throw new Error("Shell CLOUDFLARE_ACCOUNT_ID differs from the private config; no action taken.");
    }
    if (action === "check") console.log("Private configuration passes local isolation checks. Account/resource ownership and provisioning still need verification before deployment.");
    if (action === "plan") console.log(JSON.stringify({
      accountId: config.account_id, worker: config.name, database: config.d1_databases[0],
      api: frontend.VITE_API_URL, frontend: frontend.PRIVATE_FRONTEND_ORIGIN, pagesProject: frontend.PRIVATE_PAGES_PROJECT,
      secretFile: "server/.secrets/private-worker.env (SESSION_SECRET only; required for Worker deployment)",
      workerCommand: ["wrangler", "deploy", ...configArgs, "--secrets-file", secretsFile],
      pagesCommand: ["wrangler", "pages", "deploy", output, "--project-name", frontend.PRIVATE_PAGES_PROJECT, "--branch", "main"],
      note: "Plan only. No network requests or remote mutations were performed.",
    }, null, 2));
    if (action === "build" || action === "deploy-frontend") build(frontend);
    if (action === "deploy-worker") {
      requireSecret();
      for (const script of ["migrations:check", "catalogs:check", "typecheck", "test", "test:integration"]) {
        run("npm", ["--prefix", "server", "run", script]);
      }
      // Recheck fixed inputs after tests before uploading anything.
      const current = loadPrivateSettings();
      if (JSON.stringify(current) !== JSON.stringify({ config, frontend })) throw new Error("Private settings changed during checks; review the plan again.");
      requireSecret();
      run(process.execPath, [wrangler, "deploy", ...configArgs, "--secrets-file", secretsFile], { CLOUDFLARE_ACCOUNT_ID: config.account_id });
    }
    if (action === "deploy-frontend") {
      const current = loadPrivateSettings();
      if (JSON.stringify(current) !== JSON.stringify({ config, frontend })) throw new Error("Private settings changed during build; review the plan again.");
      // Pages commands do not support --config. Pin their account explicitly and
      // run at the root, outside the server's original Wrangler project.
      run(process.execPath, [wrangler, "pages", "deploy", output, "--project-name", frontend.PRIVATE_PAGES_PROJECT, "--branch", "main"],
        { CLOUDFLARE_ACCOUNT_ID: config.account_id });
    }
  }
} catch (error) {
  console.error(`Private deployment blocked:\n${error.message}`);
  process.exitCode = 1;
}
