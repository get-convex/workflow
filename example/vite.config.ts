import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const exampleDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const rootDir = resolve(exampleDir, "..");
  const env = loadEnv(mode, rootDir, "");
  return {
    envDir: rootDir,
    define: {
      "import.meta.env.VITE_CONVEX_URL": JSON.stringify(
        env.VITE_CONVEX_URL ?? env.CONVEX_URL ?? "",
      ),
    },
  };
});
