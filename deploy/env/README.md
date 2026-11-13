# Environment files

Copy lab.env.example or production.env.example to lab.env or production.env in this directory, using umask 077 and chmod 600. Real *.env files anywhere under deploy/ are ignored; examples remain tracked. Keep files owned by the operator or root and never paste their contents into tickets.

All template values are empty placeholders. Fill operator choices and remove optional empty assignments to use Compose defaults. Generate secrets independently on the destination using setup.sh's method: 32 random alphanumeric characters with Aa1 appended for each SQL password, and openssl rand -base64 32 for CONSOLE_SECRET_KEY. APP_DB_PASSWORD must contain 24–128 alphanumeric characters. Write generated output directly into the protected real file. Preserve existing secrets during a move, especially CONSOLE_SECRET_KEY.

From the repository root, select an environment explicitly:

    docker compose --project-directory deploy -f deploy/compose.yaml --env-file deploy/env/lab.env up -d --build

If required, add -f deploy/compose.override.yaml before --env-file. Explicit -f does not automatically include the override. The project remains named cabinet: these files do not isolate two stacks on one Docker host.

setup.sh always uses deploy/.env and does not accept alternate env paths. PUBLIC_IP, CONSOLE_DOMAIN, ADMIN_USERNAME and ADMIN_NAME are bootstrap inputs: export them when invoking setup.sh; putting them in a Compose env file does not pass them to setup.sh. Do not use setup.sh for migration: it changes firewall rules and may create an Admin. backup.sh also uses deploy/.env. On the destination keep the selected real configuration as root-owned mode-600 deploy/.env as the canonical file for that workflow. Never source an env file as shell code.

The production template documents configuration; the existing image still uses a development CA and unsigned agents. Filling the template does not provide a production PKI or signing pipeline. See ../README.md and ../PORTABILITY.md.
