// One confirmation for any admin action: ask() opens the authenticator dialog for that exact
// action and target; the action runs with the token, and a refusal shows in the dialog. When the
// action sends parameters, ask() is given the same body (without the token): the code confirms
// exactly those parameters, and the server refuses the token for any others.
import { useState, type ReactNode } from "react";
import { StepUpDialog } from "./ui";

interface Request { action: string; target: string; description: ReactNode; run: (token: string) => Promise<void>; params?: Record<string, unknown> | undefined }

/** The parameters a step-up confirms: the request body without the token. An empty body binds nothing. */
export const bodyParams = (body: Record<string, unknown>): Record<string, unknown> | undefined => {
  const { stepUpToken: _token, ...rest } = body;
  return Object.keys(rest).length ? rest : undefined;
};

export function useStepUp() {
  const [req, setReq] = useState<Request | null>(null);
  const dialog = (
    <StepUpDialog open={req !== null} action={req?.action ?? ""} target={req?.target ?? ""} description={req?.description} onClose={() => setReq(null)}
      params={req?.params} onToken={async token => { if (req) await req.run(token); }} />
  );
  return {
    ask: (action: string, target: string, description: ReactNode, run: (token: string) => Promise<void>, params?: Record<string, unknown>) =>
      setReq({ action, target, description, run, params: params && bodyParams(params) }),
    dialog,
  };
}
