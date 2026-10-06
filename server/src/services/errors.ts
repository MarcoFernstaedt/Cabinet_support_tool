/** A refusal the API reports with a fixed code. The message is for logs; clients see only the code, and any extra fields given here. */
export class Refused extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly extra?: Record<string, unknown>) { super(message); }
}
