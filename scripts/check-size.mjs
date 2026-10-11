// Fails CI if the full bundle grows past the 10 kB (min+gzip) budget.
import { readFileSync } from "node:fs";
const BUDGET = 10 * 1024;
const sizes = JSON.parse(readFileSync("dist/size.json", "utf8"));
const full = sizes["mcp-lite-browser.min.js"].gzip;
console.log(`mcp-lite-browser.min.js: ${full} B min+gzip (budget ${BUDGET} B)`);
if (full > BUDGET) { console.error("Size budget exceeded"); process.exit(1); }
