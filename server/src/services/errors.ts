/** A refusal the API reports with a fixed code. The message is for logs; clients see only the code. */
export class Refused extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
