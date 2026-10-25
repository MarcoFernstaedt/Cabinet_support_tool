// The three roles and their order (docs/spec/02-security-model.md control 7). Kept in a module that imports nothing, so a service
// that only needs the ranks (the approved-applications list, the file-facts paths) does not pull in the command path.
export const ROLE_RANK = { tier1: 1, tier2: 2, admin: 3 } as const;
export type Role = keyof typeof ROLE_RANK;
