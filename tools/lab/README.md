# HP demo renewal launcher

`cabinet_renewal_interactive_hp.py` preserves the exact lab launcher used for the HP demo. The supported renewal implementation is `../office_renewal_operator.py`; it owns masked sign-in, explicit identity confirmation, saved renewal decisions, retry handling and contact verification.

This launcher is specific to the existing HP lab. It depends on the `hp-edge` SSH alias, the protected read-only identity probe on that machine, and the absolute operator and decision paths declared in the script. It is not a standalone installer or part of the distributed kit. Do not copy its paths to a different device or remove the referenced files while this lab still uses them. Preserve an existing decision file when retrying an uncertain renewal; do not generate a new decision to hide an ambiguous result.

The launcher contains no credentials or saved decisions. Those stay outside Git. Its `--check` reads prerequisites without signing in or issuing a renewal. The existing VPS entrypoint remains `/home/marco/tmp/cabinet-renewal-interactive.py`.

## Operator experience

Keep prompts direct and professional: identify the target, explain what will change, state what is retained for audit, require explicit confirmation and report the verified outcome. Mask passwords and never include secrets in logs. Distinguish a locally saved decision from a confirmed server audit entry; the grant journal and SQL audit are not one atomic transaction. See `../../docs/demo-credential-renewal.md` for the supported flow and exact retry rules.
