// Records each migration's sha256 in server/migrations/checksums.json, in the form migrate.ts
// computes it (the file's text). Run it after adding a migration. It refuses to rewrite a hash that
// is already recorded: that is what the immutability test guards, and a change to an applied
// migration stops every existing deployment from starting (D151).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const manifest = join(dir, "checksums.json");
const files = readdirSync(dir).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
const now = Object.fromEntries(files.map(f => [f.slice(0, -4), createHash("sha256").update(readFileSync(join(dir, f), "utf8")).digest("hex")]));

if (existsSync(manifest)) {
  const then = JSON.parse(readFileSync(manifest, "utf8"));
  const changed = Object.keys(now).filter(v => then[v] !== undefined && then[v] !== now[v]);
  const gone = Object.keys(then).filter(v => now[v] === undefined);
  if (changed.length > 0 || gone.length > 0) {
    console.error(`refusing to rewrite the record of ${[...changed, ...gone].join(", ")}: an applied migration never changes and is never deleted`);
    process.exit(1);
  }
}

writeFileSync(manifest, JSON.stringify(now, null, 2) + "\n");
console.log(`${files.length} migrations recorded`);