// Build: tsc (ESM + .d.ts) → dist/, esbuild single-file bundles for <script type="module"> / CDN use,
// and a size report (min + gzip) written to badges/size.json (shields.io endpoint format) and dist/size.json.
import { execSync } from "node:child_process";
import { build } from "esbuild";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

rmSync("dist", { recursive: true, force: true });
execSync("npx tsc -p .", { stdio: "inherit" });

const bundles = {
  "mcp-lite-browser.min.js": "src/index.ts",
  "client.min.js": "src/client.ts",
  "bridge.min.js": "src/bridge.ts",
};
const sizes = {};
for (const [out, entry] of Object.entries(bundles)) {
  await build({ entryPoints: [entry], bundle: true, minify: true, format: "esm", target: "es2020", outfile: `dist/${out}`, legalComments: "none",
    banner: { js: "/*! mcp-lite-browser v" + JSON.parse(readFileSync("package.json", "utf8")).version + " | MIT | github.com/ducvuathuduc/mcp-lite-browser */" } });
  const buf = readFileSync(`dist/${out}`);
  sizes[out] = { min: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
}
writeFileSync("dist/size.json", JSON.stringify(sizes, null, 2) + "\n");
const full = sizes["mcp-lite-browser.min.js"].gzip;
mkdirSync("badges", { recursive: true });
writeFileSync("badges/size.json", JSON.stringify({ schemaVersion: 1, label: "min+gzip", message: (full / 1024).toFixed(1) + " kB", color: full <= 10240 ? "2ea44f" : "e05d44" }) + "\n");
for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(26)} ${String(v.min).padStart(6)} B min  ${String(v.gzip).padStart(5)} B gzip`);
