import { useCallback, useState } from "react";
import { describeError } from "./api";

/**
 * One thing a person does that can fail: saving a setting, approving a fix. Run it through `run` and the page gets the
 * state every such form needs (busy, the server's refusal in plain words, and whether it worked) without repeating it.
 */
export function useAction() {
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setProblem(null); setSaved(false); setBusy(true);
    try { await action(); setSaved(true); return true; }
    catch (e) { setProblem(describeError(e)); return false; }
    finally { setBusy(false); }
  }, []);
  const clear = useCallback(() => { setProblem(null); setSaved(false); }, []);
  return { run, problem, saved, busy, clear };
}
