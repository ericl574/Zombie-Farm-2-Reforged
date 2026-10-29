import { rmSync } from "node:fs";
import { resolve } from "node:path";

/** Shared by the real private build and the offline synthetic preflight. Target
 * validation lives in loadPrivateSettings before this factory is used for upload. */
export function privateViteConfig(base, frontend, outDir) {
  return {
    ...base,
    envDir: false,
    envPrefix: "PRIVATE_BUILD_NO_AUTO_ENV_",
    define: {
      ...base.define,
      "import.meta.env.VITE_API_URL": JSON.stringify(frontend.VITE_API_URL),
      "import.meta.env.VITE_GOOGLE_CLIENT_ID": JSON.stringify(frontend.VITE_GOOGLE_CLIENT_ID),
    },
    build: { ...base.build, outDir },
    plugins: [...(base.plugins ?? []), {
      name: "private-deployment-isolation",
      enforce: "post",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          return html.replace(/connect-src[^;\"]*/, `connect-src 'self' data: https://accounts.google.com ${frontend.VITE_API_URL}`);
        },
      },
      closeBundle() {
        // public/CNAME belongs to the existing GitHub Pages deployment only.
        rmSync(resolve(outDir, "CNAME"), { force: true });
      },
    }],
  };
}
