import type { ErrorObject, SchemaObject } from "ajv";
import type { CatalogEntry } from "./generated/ts/contracts.js";

/** A compiled validator: call it, then read errors when it returns false. */
export interface CompiledValidator {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

/** The Ajv instance holding every contract schema (only what callers use). */
export interface ContractAjv {
  getSchema(id: string): CompiledValidator | undefined;
  addSchema(schema: SchemaObject): unknown;
}

export declare const SCHEMA_DIR: string;
export declare const BASE_ID: string;
export declare function readSchemas(dir?: string, prefix?: string): { file: string; id: string; schema: Record<string, unknown> }[];
export declare function readCatalog(): { version: number; operations: CatalogEntry[] };
export declare function createAjv(): ContractAjv;
export declare function ref(file: string, def?: "params" | "output"): string;
