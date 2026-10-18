// Console queries that read across the whole fleet (rule preview, audit search, evidence export, drives at risk): one at a time per
// person and kind, each stopped in the database after its time limit, as the fleet search already is. On the console's own pool, so
// even a crowd of these can never take the connections the agents need.
import { limited, QueryTimeout, type Queryable } from "../db/db.js";
import { Refused } from "../services/errors.js";

export class HeavyQuery {
  private readonly running = new Set<string>();
  constructor(private readonly what: string, private readonly limitMs: number) {}

  /** Runs fn for this person with a time-limited database; a second request while the first runs is refused (429). */
  async run<T>(userId: string, db: Queryable, fn: (db: Queryable) => Promise<T>): Promise<T> {
    if (this.running.has(userId)) throw new Refused("rate_limited", 429, `your previous ${this.what} is still running`);
    this.running.add(userId);
    try {
      return await fn(limited(db, this.limitMs));
    } catch (e) {
      if (e instanceof QueryTimeout)
        throw new Refused("query_too_slow", 503, `the ${this.what} took longer than ${Math.round(this.limitMs / 1000)} seconds and was stopped; narrow it down`);
      throw e;
    } finally {
      this.running.delete(userId);
    }
  }
}

export const HEAVY_LIMIT_MS = 15_000;
