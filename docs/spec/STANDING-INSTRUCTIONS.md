# Cabinet Diagnostics Platform

This repository builds the Mashura cabinet diagnostics platform. The specification lives in docs/spec and is the source of truth. Read docs/spec/00-README.md, docs/spec/01-architecture.md and docs/spec/02-security-model.md before any work, then the spec files for the part you are building.

Rules that never bend:

- The agent runs only operations in its fixed catalog. Never add a shell, eval, script runner or any generic run-a-command path.
- Released platform file delivery uses approved software library packages, verified by hash, signature and trusted publisher on the cabinet itself. The [dev-only SSH transport](02-security-model.md#development-ssh-transport) follows the cabinet’s OpenSSH policy.
- The agent's network process never runs with administrator rights. Privileged actions go only through the broker, which never opens a network connection.
- External programs are launched by full path with argument arrays, never through a shell or a composed command string.
- Every input is validated against its JSON Schema in the contracts folder before any other code touches it.
- Every permission check happens on the server or the agent. The console may hide buttons, but that is never the protection.
- Never put secrets, keys or credentials in the repository, in logs, or in code.
- The platform never connects to the cabinet application's database, and never reads the Windows Security log.
- Symptom rules never use regular expressions.
- Do not add dependencies without saying why. Prefer the standard library.

How to work:

- Build only the milestone you were asked for. Do not start the next one.
- If the spec does not answer something, stop and ask rather than guessing, and note the question in docs/spec/09-open-decisions.md.
- Write tests alongside the code, including tests that feed malformed and hostile input.
- At the end, report what was built, what was tested, and anything that differs from the spec, with the reason.
