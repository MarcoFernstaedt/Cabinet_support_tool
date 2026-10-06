// Loads every contract schema from disk into one Ajv instance.
// Used by the contract tests and by the server, so both validate with exactly
// the same schemas and the same options.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "schemas");
export const BASE_ID = "https://schemas.mashura.example/cabinet-diagnostics/v1/";

/** Every *.schema.json file under schemas/, as { file, id, schema }. */
export function readSchemas(dir = SCHEMA_DIR, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readSchemas(path, `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".schema.json")) {
      const schema = JSON.parse(readFileSync(path, "utf8"));
      const file = `${prefix}${entry.name}`;
      if (schema.$id !== BASE_ID + file) throw new Error(`${file}: $id must be ${BASE_ID + file}`);
      out.push({ file, id: schema.$id, schema });
    }
  }
  return out;
}

/** The operation catalog (schemas/operations/catalog.json). */
export function readCatalog() {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, "operations", "catalog.json"), "utf8"));
}

/**
 * An Ajv instance with every schema registered.
 * strict mode rejects unknown keywords and ambiguous schemas, so a typo in a
 * schema fails loudly instead of silently allowing anything.
 */
export function createAjv() {
  // strictRequired is off only because conditional rules ("port is required
  // when method is tcp") list properties defined in the parent schema.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: false, validateFormats: false });
  for (const { schema } of readSchemas()) ajv.addSchema(schema);
  return ajv;
}

/** Ajv reference for one definition, e.g. ref("operations/files.list.schema.json", "params"). */
export const ref = (file, def) => `${BASE_ID}${file}${def ? `#/$defs/${def}` : ""}`;
