// Finds PowerShell 7 for the installer-script tests. Before, only three fixed paths were tried, so a pwsh installed anywhere else
// (under the home folder, say) silently skipped the tests that run the scripts. The result is always a full path, which the tests
// launch with an argument array: nothing goes through a shell.
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const FIXED_PWSH_PATHS = ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/microsoft/powershell/7/pwsh"] as const;

const isFile = (p: string) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };

/**
 * PWSH if it names a file by full path, else the first `pwsh` (or `pwsh.exe`) in a full-path PATH folder, else a fixed install
 * path; undefined when there is none. Relative PATH entries are skipped, so the current folder can never supply the program.
 */
export function findPwsh(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isFile): string | undefined {
  const named = env.PWSH?.trim();
  if (named && isAbsolute(named) && exists(named)) return named;
  const names = process.platform === "win32" ? ["pwsh.exe"] : ["pwsh"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const n of names) { const p = join(dir, n); if (exists(p)) return p; }
  }
  return FIXED_PWSH_PATHS.find(p => exists(p));
}
