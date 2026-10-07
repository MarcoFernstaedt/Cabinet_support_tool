// One confirmation for any admin action: ask() opens the authenticator dialog for that exact
// action and target; the action runs with the token, and a refusal shows in the dialog.
import { useState, type ReactNode } from "react";
import { StepUpDialog } from "./ui";

interface Request { action: string; target: string; description: ReactNode; run: (token: string) => Promise<void>; }

export function useStepUp() {
  const [req, setReq] = useState<Request | null>(null);
  const dialog = (
    <StepUpDialog open={req !== null} action={req?.action ?? ""} target={req?.target ?? ""} description={req?.description} onClose={() => setReq(null)}
      onToken={async token => { if (req) await req.run(token); }} />
  );
  return { ask: (action: string, target: string, description: ReactNode, run: (token: string) => Promise<void>) => setReq({ action, target, description, run }), dialog };
}
