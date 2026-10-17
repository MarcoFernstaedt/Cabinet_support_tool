#!/usr/bin/env bash
# Rewrites every `uses: owner/repo@tag` in .github/workflows to the full commit SHA the tag points at, keeping the tag as a comment,
# so the workflow runs exactly the code that was reviewed. A tag can be moved by whoever controls the action's repository; a commit cannot.
# Run it where github.com is reachable, review the diff, and commit it. Dependabot (see .github/dependabot.yml) then proposes SHA updates.
set -euo pipefail
cd "$(dirname "$0")/.."
for file in .github/workflows/*.yml; do
  grep -oE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]+)?@[A-Za-z0-9_.-]+( |$)' "$file" | sort -u | while read -r _ ref; do
    ref="${ref% }"; action="${ref%@*}"; tag="${ref#*@}"
    case "$tag" in [0-9a-f]*) [ "${#tag}" -eq 40 ] && continue ;; esac
    repo="https://github.com/$(echo "$action" | cut -d/ -f1-2).git"
    # An annotated tag lists the commit it points at on the "^{}" line; a lightweight tag lists it directly.
    sha="$(git ls-remote "$repo" "refs/tags/$tag" "refs/tags/$tag^{}" | awk '{print $1}' | tail -1)"
    [ -n "$sha" ] || { echo "no tag $tag in $repo" >&2; exit 1; }
    sed -i "s|uses: ${action}@${tag}\$|uses: ${action}@${sha} # ${tag}|; s|uses: ${action}@${tag} |uses: ${action}@${sha} # ${tag} |" "$file"
    echo "$file: $action@$tag -> $sha"
  done
done
