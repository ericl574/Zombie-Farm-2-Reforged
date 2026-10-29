import { resolve } from "node:path";
import { defineConfig } from "vite";
import baseConfig from "./vite.config";
import { loadPrivateSettings, root } from "./server/scripts/private-config.mjs";
import { privateViteConfig } from "./tools/private-vite.mjs";

export default defineConfig(async (environment) => {
  const { frontend } = loadPrivateSettings();
  const base = await baseConfig({ ...environment, mode: "private" });
  return privateViteConfig(base, frontend, resolve(root, "dist-private"));
});
