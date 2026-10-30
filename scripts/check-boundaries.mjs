// CI guard: packages/core is the engine and stays free of apps, billing and servers.
// Fails if any file in packages/core imports from apps/*, another Dropisode package, or a
// hosting/billing library.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../packages/core", import.meta.url).pathname;
const banned = [/(^|\/)apps\//, /^@reel\/(?!core$)/, /^(stripe|pg|kysely|hono|@hono\/|nodemailer|arctic|aws4fetch)(\/|$)/];
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) check(full);
  }
}

function check(file) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(
    /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (banned.some((b) => b.test(spec)) || (spec.startsWith(".") && /\/apps\//.test(join(file, "..", spec))))
      problems.push(`${file.slice(root.length + 1)} imports "${spec}"`);
  }
}

walk(root);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (banned.some((b) => b.test(dep))) problems.push(`package.json depends on "${dep}"`);
}
if (problems.length) {
  console.error(`packages/core must not depend on apps, billing or servers:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("Boundaries OK: packages/core imports no apps, billing or server code.");
