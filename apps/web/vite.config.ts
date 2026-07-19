import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoData = resolve(__dirname, "../../data");

/** Serves the repo's /data JSON in dev and copies it into dist/data at build:
 *  the site only ever fetches committed, versioned files (P7). */
function repoDataPlugin(): Plugin {
  return {
    name: "repo-data",
    configureServer(server) {
      server.middlewares.use("/data", (req, res, next) => {
        const file = join(repoData, (req.url ?? "/").replace(/^\//, "").split("?")[0] ?? "");
        if (existsSync(file) && file.startsWith(repoData)) {
          res.setHeader("content-type", "application/json");
          import("node:fs").then((fs) => fs.createReadStream(file).pipe(res));
          return;
        }
        next();
      });
    },
    closeBundle() {
      const out = resolve(__dirname, "dist/data");
      if (!existsSync(repoData)) return;
      mkdirSync(out, { recursive: true });
      for (const f of readdirSync(repoData)) {
        // Datasets only, build caches (prices.json, tokens.json) are never
        // fetched by the site and would add megabytes of dead weight.
        if (f.endsWith(".v1.json")) copyFileSync(join(repoData, f), join(out, f));
      }
    },
  };
}

export default defineConfig({
  // Pages sets VITE_BASE_PATH=/<repo>/; a later Vercel move is a config flip (§9)
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react(), repoDataPlugin()],
  build: { target: "es2022" },
  worker: { format: "es" },
});
