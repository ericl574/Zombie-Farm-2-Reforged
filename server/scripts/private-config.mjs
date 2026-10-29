import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const privateConfigPath = join(root, "server/wrangler.private.toml");
export const privateFrontendPath = join(root, ".env.private.local");
const require = createRequire(import.meta.url);

/** Use the TOML parser shipped with the pinned Wrangler, without contacting Cloudflare. */
export function readToml(file) {
  // An explicit path also prevents Wrangler's generated-config redirect lookup.
  return require("wrangler").experimental_readRawConfig({ config: file }).rawConfig;
}

export function originalIdentifiers() {
  const source = readToml(join(root, "server/wrangler.toml"));
  const environments = [source, ...Object.values(source.env ?? {})];
  return {
    names: environments.map((env) => env.name),
    databases: environments.flatMap((env) => env.d1_databases ?? []),
    googleIds: environments.map((env) => env.vars?.GOOGLE_CLIENT_ID),
  };
}

export function forbiddenReference(value) {
  return /zombiefarmreforged\.com|zombiefarm\.workers\.dev/i.test(String(value));
}

const placeholder = (value) => !value || /REQUIRED_|YOUR_|PLACEHOLDER|\.invalid(?:[/:]|$)/i.test(String(value));
const originError = (value) => {
  try {
    const url = new URL(value);
    return url.protocol !== "https:" || url.origin !== value || url.username || url.password || forbiddenReference(value);
  } catch { return true; }
};

/** Identity blockers are separate from structural errors: only local Worker dry
 * runs may proceed with missing identities. Remote actions always require both. */
export function inspectPrivateConfig(config, original = originalIdentifiers()) {
  const errors = [];
  const blockers = [];
  const allowed = new Set(["name", "account_id", "main", "compatibility_date", "compatibility_flags",
    "workers_dev", "d1_databases", "vars", "observability", "unsafe", "triggers"]);
  if (Object.keys(config).some((key) => !allowed.has(key))) errors.push("Private config contains unsupported sections (including environments/routes/build hooks).");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.name ?? "") || original.names.includes(config.name)) errors.push("Use a distinct private Worker name.");
  if (!/^[a-f0-9]{32}$/i.test(config.account_id ?? "") || /^0+$/.test(config.account_id ?? "")) blockers.push("Provide your Cloudflare account_id (32 hex characters).");
  if (config.main !== "src/index.ts" || config.compatibility_date !== "2024-12-01" ||
      JSON.stringify(config.compatibility_flags) !== '["nodejs_compat"]' || config.workers_dev !== true) errors.push("Preserve the private entrypoint, compatibility settings and workers_dev=true.");
  const db = config.d1_databases?.[0];
  if (config.d1_databases?.length !== 1 || db?.binding !== "DB" || db?.migrations_dir !== "migrations") errors.push("Exactly one DB binding with migrations_dir=migrations is required.");
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(db?.database_name ?? "") || original.databases.some((old) => old.database_name === db?.database_name)) errors.push("Use a distinct private D1 database_name.");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(db?.database_id ?? "") || /^0[-0]*$/.test(db?.database_id ?? "")) blockers.push("Provide the UUID of your own D1 database.");
  if (original.databases.some((old) => old.database_id.toLowerCase() === db?.database_id?.toLowerCase())) errors.push("An upstream D1 database UUID is forbidden.");
  if (db && Object.keys(db).some((key) => !["binding", "database_name", "database_id", "migrations_dir"].includes(key))) errors.push("Unexpected private D1 options.");
  const gameplay = { DEV_AUTH: "0", GROWTH_TIME_CONTROL: "1", MIN_PROTOCOL_VERSION: "3", MUTATIONS_DISABLED: "0",
    BLACK_MARKET_ENABLED: "1", PVP_ENABLED: "1", PVP_DEFENSE_MODE: "formation", WRITER_LEASE_MODE: "enforce" };
  for (const [key, value] of Object.entries(gameplay)) {
    if (config.vars?.[key] !== value) errors.push(`Private ${key} must remain ${value}.`);
  }
  if (Object.keys(config.vars ?? {}).some((key) => ![...Object.keys(gameplay), "GOOGLE_CLIENT_ID", "ALLOWED_ORIGIN"].includes(key))) errors.push("Unexpected Worker variables; secrets and timer overrides do not belong in private vars.");
  if (placeholder(config.vars?.GOOGLE_CLIENT_ID) || !/^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(config.vars?.GOOGLE_CLIENT_ID ?? "")) blockers.push("Provide your Google OAuth Web client ID.");
  if (original.googleIds.includes(config.vars?.GOOGLE_CLIENT_ID)) errors.push("The upstream Google OAuth client ID is forbidden.");
  if (placeholder(config.vars?.ALLOWED_ORIGIN)) blockers.push("Provide your exact private frontend HTTPS origin in ALLOWED_ORIGIN.");
  else if (originError(config.vars?.ALLOWED_ORIGIN)) errors.push("ALLOWED_ORIGIN must be a private HTTPS origin with no path/trailing slash.");
  if (forbiddenReference(JSON.stringify(config))) errors.push("An upstream domain/Worker hostname is forbidden.");
  const bindings = config.unsafe?.bindings ?? [];
  if (Object.keys(config.unsafe ?? {}).some((key) => key !== "bindings") || bindings.length !== 3) errors.push("Keep only the three private rate-limit bindings.");
  for (const [name, limit] of [["RL_AUTH", 60], ["RL_WRITE", 120], ["RL_READ", 300]]) {
    const binding = bindings.find((item) => item.name === name);
    if (binding?.type !== "ratelimit" || binding.simple?.limit !== limit || binding.simple?.period !== 60 || !/^[1-9]\d*$/.test(binding.namespace_id ?? "")) errors.push(`Preserve the ${name} rate limiter.`);
  }
  if (new Set(bindings.map((item) => item.namespace_id)).size !== 3) errors.push("Rate-limit namespace IDs must be distinct.");
  if (JSON.stringify(config.triggers) !== '{"crons":["17 3 * * *"]}') errors.push("Preserve the daily cleanup schedule.");
  if (config.observability?.enabled !== true || config.observability?.head_sampling_rate !== 1) errors.push("Preserve the existing observability settings.");
  return { errors, blockers };
}

export function inspectPrivateFrontend(frontend, config, original = originalIdentifiers()) {
  const errors = [];
  const allowed = ["VITE_API_URL", "VITE_GOOGLE_CLIENT_ID", "PRIVATE_PAGES_PROJECT", "PRIVATE_FRONTEND_ORIGIN"];
  if (Object.keys(frontend).some((key) => !allowed.includes(key))) errors.push("Private frontend file may contain only the four public settings from .env.private.example.");
  for (const key of allowed) if (placeholder(frontend[key])) errors.push(`Provide ${key} in .env.private.local.`);
  if (!placeholder(frontend.VITE_API_URL)) {
    if (originError(frontend.VITE_API_URL)) errors.push("VITE_API_URL must be your private HTTPS API origin with no path/trailing slash.");
    else if (new URL(frontend.VITE_API_URL).hostname.endsWith(".workers.dev") &&
      !new URL(frontend.VITE_API_URL).hostname.startsWith(`${config.name}.`)) errors.push("The workers.dev URL must match the private Worker name.");
  }
  if (frontend.VITE_GOOGLE_CLIENT_ID !== config.vars?.GOOGLE_CLIENT_ID || original.googleIds.includes(frontend.VITE_GOOGLE_CLIENT_ID)) errors.push("Frontend and private Worker must use the same, own Google Web client ID.");
  if (frontend.PRIVATE_FRONTEND_ORIGIN !== config.vars?.ALLOWED_ORIGIN || originError(frontend.PRIVATE_FRONTEND_ORIGIN)) errors.push("PRIVATE_FRONTEND_ORIGIN must exactly match private ALLOWED_ORIGIN.");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(frontend.PRIVATE_PAGES_PROJECT ?? "") || ["zombiefarm", "zombiefarmreforged", "zombiefarm-staging-client"].includes(frontend.PRIVATE_PAGES_PROJECT)) errors.push("Provide a distinct private Pages project name.");
  if (forbiddenReference(JSON.stringify(frontend))) errors.push("An upstream hostname is forbidden in private frontend settings.");
  return errors;
}

export function loadPrivateSettings() {
  const config = readToml(privateConfigPath);
  const { errors, blockers } = inspectPrivateConfig(config);
  let frontend;
  try { frontend = parseEnv(readFileSync(privateFrontendPath, "utf8")); }
  catch { blockers.push("Create .env.private.local from .env.private.example and fill its four public settings."); }
  const failures = [...errors, ...blockers, ...(frontend ? inspectPrivateFrontend(frontend, config) : [])];
  if (failures.length) throw new Error([...new Set(failures)].join("\n"));
  return { config, frontend };
}

/** Scan all emitted text (including source maps and the service worker), not just
 * the main JS. Binary art/audio does not carry executable API configuration. */
export function auditPrivateBuild(directory, frontend) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isSymbolicLink()) throw new Error("Private upload must not contain symlinks.");
      else files.push(file);
    }
  };
  visit(directory);
  if (files.some((file) => /(?:^|[/\\])(?:CNAME|_worker\.js|_redirects|_routes\.json)$/.test(file))) throw new Error("Private upload contains a domain/route/Worker override file.");
  for (const file of files.filter((file) => /\.(?:html|js|mjs|css|json|map|webmanifest|txt)$/i.test(file))) {
    if (forbiddenReference(readFileSync(file, "utf8"))) throw new Error(`Upstream host reference in private build: ${file}`);
  }
  const html = readFileSync(join(directory, "index.html"), "utf8");
  const api = frontend.VITE_API_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`connect-src 'self' data: https://accounts\\.google\\.com ${api}(?:;|\")`).test(html)) throw new Error("Private CSP does not restrict API connections to the configured private Worker.");
  const scripts = files.filter((file) => /\.js$/.test(file)).map((file) => readFileSync(file, "utf8")).join("\n");
  if (!scripts.includes(frontend.VITE_API_URL) || !scripts.includes(frontend.VITE_GOOGLE_CLIENT_ID)) throw new Error("Private bundle is missing the configured API URL or OAuth client ID.");
  return files.length;
}
