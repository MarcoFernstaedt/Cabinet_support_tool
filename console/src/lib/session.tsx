import { createContext, useContext } from "react";

export type Role = "tier1" | "tier2" | "admin";
export interface Me { id: string; username: string; name: string; role: Role; totpEnabled: boolean; tourCompleted: boolean; }

export const SessionContext = createContext<{ me: Me; refresh: () => Promise<void>; signOut: () => Promise<void> } | null>(null);
export const useSession = () => {
  const s = useContext(SessionContext);
  if (!s) throw new Error("no session");
  return s;
};

const RANK: Record<Role, number> = { tier1: 1, tier2: 2, admin: 3 };
/** For showing or hiding controls only; the server checks the role again on every request. */
export const atLeast = (me: Me, role: Role): boolean => RANK[me.role] >= RANK[role];
export const roleName = (r: Role): string => ({ tier1: "Tier 1", tier2: "Tier 2", admin: "Admin" })[r];
