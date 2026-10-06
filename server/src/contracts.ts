// Runtime validation against the shared JSON Schema contracts.
// Every agent and console input passes through one of these validators before
// any other code touches it (docs/spec/STANDING-INSTRUCTIONS.md).
import { createAjv, readCatalog, ref } from "@mashura/cabinet-contracts/load";
import type {
  CatalogEntry,
  Command,
  CommandsResponse,
  EnrollRequest,
  EnrollResponse,
  EnrollStatus,
  Event,
  EventBatch,
  Heartbeat,
  OperationName,
  OperationTypes,
  RenewRequest,
  RenewResponse,
  Result,
  ServerAck,
} from "@mashura/cabinet-contracts/types";

export type * from "@mashura/cabinet-contracts/types";

/** One validation problem: where it is and what rule failed. Never the submitted value. */
export interface ContractIssue {
  path: string;
  rule: string;
}

export class ContractError extends Error {
  readonly schema: string;
  readonly issues: readonly ContractIssue[];
  constructor(schema: string, issues: readonly ContractIssue[]) {
    super(`Input does not match ${schema}`);
    this.name = "ContractError";
    this.schema = schema;
    this.issues = issues;
  }
}

const ajv = createAjv();

export interface Validator<T> {
  /** Type guard: true when data matches the schema. */
  is(data: unknown): data is T;
  /** Returns the data typed, or throws ContractError. */
  parse(data: unknown): T;
}

function validator<T>(name: string, id: string): Validator<T> {
  const check = ajv.getSchema(id);
  if (!check) throw new Error(`Contract schema not found: ${id}`);
  return {
    is: (data: unknown): data is T => check(data) === true,
    parse(data: unknown): T {
      if (check(data) === true) return data as T;
      // Report locations and failed keywords only. Values could be secrets
      // (bootstrap tokens) or hostile payloads, so they are never echoed.
      const issues = (check.errors ?? []).slice(0, 20).map(e => ({ path: e.instancePath || "/", rule: e.keyword }));
      throw new ContractError(name, issues);
    },
  };
}

const envelope = (file: string) => ref(`envelopes/${file}.schema.json`);

export const envelopes = {
  command: validator<Command>("command", envelope("command")),
  result: validator<Result>("result", envelope("result")),
  event: validator<Event>("event", envelope("event")),
  eventBatch: validator<EventBatch>("event-batch", envelope("event-batch")),
  heartbeat: validator<Heartbeat>("heartbeat", envelope("heartbeat")),
  serverAck: validator<ServerAck>("server-ack", envelope("server-ack")),
  commandsResponse: validator<CommandsResponse>("commands-response", envelope("commands-response")),
  enrollRequest: validator<EnrollRequest>("enroll-request", envelope("enroll-request")),
  enrollResponse: validator<EnrollResponse>("enroll-response", envelope("enroll-response")),
  enrollStatus: validator<EnrollStatus>("enroll-status", envelope("enroll-status")),
  renewRequest: validator<RenewRequest>("renew-request", envelope("renew-request")),
  renewResponse: validator<RenewResponse>("renew-response", envelope("renew-response")),
} as const;

/** The compiled-in operation catalog, keyed by name. */
export const catalog: ReadonlyMap<OperationName, CatalogEntry> = new Map(
  readCatalog().operations.map(entry => [entry.name, entry]),
);

export function isOperationName(value: unknown): value is OperationName {
  return typeof value === "string" && catalog.has(value as OperationName);
}

type OperationValidators = {
  [O in OperationName]: { params: Validator<OperationTypes[O]["params"]>; output: Validator<OperationTypes[O]["output"]> };
};

export const operations = Object.fromEntries(
  [...catalog.keys()].map(name => [
    name,
    {
      params: validator(`${name} params`, ref(`operations/${name}.schema.json`, "params")),
      output: validator(`${name} output`, ref(`operations/${name}.schema.json`, "output")),
    },
  ]),
) as OperationValidators;
