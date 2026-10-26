// Generates TypeScript types for the server and console from the JSON Schemas.
// The schemas are the source of truth; never edit generated/ts by hand.
//   node scripts/generate-ts.mjs          write generated/ts/contracts.d.ts (types only)
//   node scripts/generate-ts.mjs --check  fail if the committed file is stale
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { BASE_ID, SCHEMA_DIR, readCatalog, readSchemas } from "../load.mjs";

const OUT = join(SCHEMA_DIR, "..", "generated", "ts", "contracts.d.ts");
const pascal = s => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join("");

// Resolve every $ref to the reserved schema host from local files, so
// generation never touches the network.
// Conditional rules (if/then/else, e.g. "port is required for tcp") cannot be
// expressed as static types. They are removed for type generation only; Ajv
// still enforces them at runtime.
function staticShape(node) {
  if (Array.isArray(node)) return node.map(staticShape).filter(n => !(n && typeof n === "object" && !Array.isArray(n) && Object.keys(n).length === 0));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "if" || k === "then" || k === "else" || k === "not") continue;
    out[k] = staticShape(v);
  }
  if (Array.isArray(out.allOf) && out.allOf.length === 0) delete out.allOf;
  return out;
}
const localResolver = {
  order: 1,
  canRead: file => file.url.startsWith(BASE_ID),
  read: file => JSON.stringify(staticShape(JSON.parse(readFileSync(join(SCHEMA_DIR, file.url.slice(BASE_ID.length).split("#")[0]), "utf8")))),
};

export async function generate() {
  const catalog = readCatalog();
  const targets = [];
  // Shared object definitions become named types first, so every operation
  // and envelope refers to the same type instead of an inline copy.
  const common = JSON.parse(readFileSync(join(SCHEMA_DIR, "common.schema.json"), "utf8"));
  for (const [def, schema] of Object.entries(common.$defs))
    if ((schema.type === "object" || schema.type === "array") && def !== "emptyParams") targets.push([pascal(def), `${BASE_ID}common.schema.json#/$defs/${def}`]);
  for (const { file } of readSchemas()) {
    if (file.startsWith("envelopes/")) targets.push([pascal(file.slice(10, -12)), BASE_ID + file]);
    if (file.startsWith("console/")) targets.push([pascal(file.slice(8, -12)), BASE_ID + file]);
    // The release files and the signed approved lists the server checks on upload (the agent checks both again with its own keys).
    if (["agent/upgrade-manifest.schema.json", "agent/upgrade-signature.schema.json", "agent/upgrade-keys.schema.json",
      "agent/approved-list.schema.json", "agent/approved-list-signature.schema.json", "agent/approved-list-keys.schema.json"].includes(file))
      targets.push([pascal(file.slice(6, -12)), BASE_ID + file]);
  }
  for (const op of catalog.operations) {
    for (const def of ["params", "output"])
      targets.push([`${pascal(op.name)}${pascal(def)}`, `${BASE_ID}operations/${op.name}.schema.json#/$defs/${def}`]);
  }
  const parts = [
    "/* eslint-disable */",
    "// GENERATED from contracts/schemas by contracts/scripts/generate-ts.mjs. Do not edit.",
    "// Types only. Validate data at runtime with the schemas (contracts/load.mjs); these types",
    "// describe data that has already passed validation.",
    "",
  ];
  for (const [name, id] of targets) {
    const ts = await compile({ $ref: id }, name, {
      bannerComment: "",
      cwd: SCHEMA_DIR,
      declareExternallyReferenced: false,
      additionalProperties: false,
      strictIndexSignatures: true,
      unknownAny: true,
      format: true,
      maxItems: -1,
      $refOptions: { resolve: { mashura: localResolver, http: false, https: false, file: false } },
    });
    parts.push(ts.trim(), "");
  }
  // The catalog as typed constants, so the server and console share one list.
  parts.push(
    "export type OperationKind = \"read\" | \"write\";",
    "export interface CatalogEntry {",
    "  name: OperationName;",
    "  kind: OperationKind;",
    "  minimumRole: \"tier1\" | \"tier2\" | \"admin\";",
    "  confirm: \"none\" | \"click\" | \"code\";",
    "  expirySeconds: number;",
    "  rateClass: \"read\" | \"write\" | \"network_test\";",
    "  safetyNet?: boolean;",
    "}",
    `export type OperationName = ${catalog.operations.map(o => JSON.stringify(o.name)).join(" | ")};`,
    "",
    "/** A command whose params are typed for its operation. */",
    "export type TypedCommand<O extends OperationName = OperationName> = O extends OperationName",
    "  ? Omit<Command, \"operation\" | \"params\"> & { operation: O; params: OperationTypes[O][\"params\"] }",
    "  : never;",
    "",
    "/** Parameter and output types for each operation, keyed by operation name. */",
    "export interface OperationTypes {",
    ...catalog.operations.map(o => `  ${JSON.stringify(o.name)}: { params: ${pascal(o.name)}Params; output: ${pascal(o.name)}Output };`),
    "}",
    "",
  );
  return parts.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = await generate();
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(OUT, "utf8"); } catch { /* missing */ }
    if (current !== text) { console.error("generated/ts/contracts.d.ts is stale. Run: npm run generate"); process.exit(1); }
    console.log("generated types are up to date");
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
