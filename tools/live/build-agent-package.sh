#!/usr/bin/env bash
# Builds the Windows Agent package to copy to a cabinet PC or lab laptop.
#
# Output (default ~/cabinet-agent-package):
#   cabinet-agent.zip          self-contained win-x64 Agent (no .NET needed on Windows)
#   Install-CabinetAgent.ps1   installer to run on the Windows machine
#   Uninstall-CabinetAgent.ps1 removes the service (keeps or deletes files)
#   SHA256SUMS                 digests; pass the zip's to the installer
#
# The package holds no secrets. The agent key is typed on the Windows machine
# during install.
#
# Usage: tools/live/build-agent-package.sh [output-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$HOME/cabinet-agent-package}"
command -v dotnet >/dev/null || { echo "The .NET 8 SDK is required." >&2; exit 1; }
command -v zip >/dev/null || command -v python3 >/dev/null || { echo "zip or python3 is required." >&2; exit 1; }

COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
  echo "Note: the working tree has uncommitted changes; the package records commit $COMMIT plus local edits."
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
echo "Publishing the Windows Agent (Release, win-x64, self-contained)…"
dotnet publish "$ROOT/src/CabinetPlatform.Agent/CabinetPlatform.Agent.csproj" \
  -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -m:1 \
  -o "$STAGE/agent" -nologo -v quiet
# Development settings never ship.
rm -f "$STAGE/agent/appsettings.Development.json"
printf '{\n  "sourceCommit": "%s",\n  "builtUtc": "%s"\n}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/agent/package-info.json"

mkdir -p "$OUT"
rm -f "$OUT/cabinet-agent.zip"
if command -v zip >/dev/null; then
  (cd "$STAGE/agent" && zip -qr "$OUT/cabinet-agent.zip" .)
else
  python3 -c 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])' "$OUT/cabinet-agent" "$STAGE/agent"
fi
cp "$ROOT/tools/live/Install-CabinetAgent.ps1" "$ROOT/tools/live/Uninstall-CabinetAgent.ps1" "$OUT/"
(cd "$OUT" && sha256sum cabinet-agent.zip Install-CabinetAgent.ps1 Uninstall-CabinetAgent.ps1 > SHA256SUMS)

ZIPSUM="$(cut -d' ' -f1 < <(grep cabinet-agent.zip "$OUT/SHA256SUMS"))"
cat <<EOF

Agent package ready in $OUT
  $(ls -1 "$OUT" | tr '\n' ' ')
  Source commit: $COMMIT

Copy the folder to the Windows machine, then in an *elevated* PowerShell:

  cd <folder>
  Unblock-File .\\Install-CabinetAgent.ps1, .\\Uninstall-CabinetAgent.ps1
  powershell -ExecutionPolicy Bypass -File .\\Install-CabinetAgent.ps1 \`
    -ServerUrl https://<your-server-address> -ExpectedSha256 $ZIPSUM

EOF
