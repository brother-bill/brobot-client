#!/usr/bin/env bash
# Publishes a built brobot-client as a GitHub Release on
# brother-bill/brobot-client. Every installed brobot finds it within four hours
# (or at its next start) and offers it to the streamer.
#
#     apps/brobot-client/scripts/publish-release.sh <run-id> "What changed, in a sentence or two."
#
# <run-id> is a successful run of singularity's "Build brobot-client installer"
# (build-brobot-client.yml); `gh run list --workflow build-brobot-client.yml -L 3`
# lists them. The notes are what the streamer reads in the update window.
#
# It uses your own `gh` login (it needs write access to brobot-client) rather
# than a CI token: a release reaches the streamer's PC, so a person cuts it.
#
# Refuses to publish a version that is already released (bump "version" in
# apps/brobot-client/package.json first), or a build without the update
# manifest (one from before the updater existed).
set -euo pipefail

SINGULARITY=brother-bill/singularity
CLIENT=brother-bill/brobot-client

run_id=${1:-}
notes=${2:-}
if [ -z "$run_id" ] || [ -z "$notes" ]; then
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

conclusion=$(gh run view "$run_id" -R "$SINGULARITY" --json conclusion -q .conclusion)
if [ "$conclusion" != "success" ]; then
    echo "publish-release: run $run_id concluded '$conclusion', not success." >&2
    exit 1
fi

gh run download "$run_id" -R "$SINGULARITY" -D "$work"
manifest=$(find "$work" -name brobot-update.json -print -quit)
if [ -z "$manifest" ]; then
    echo "publish-release: run $run_id has no brobot-update.json (built before the updater?)." >&2
    exit 1
fi
dir=$(dirname "$manifest")

version=$(node -p "require('$dir/brobot-update.json').version")
client_sha=$(cat "$dir/client-sha.txt")
tag="v$version"

if gh release view "$tag" -R "$CLIENT" >/dev/null 2>&1; then
    echo "publish-release: $tag is already released. Bump the version in apps/brobot-client/package.json and build again." >&2
    exit 1
fi

# The manifest's hash must be of the installer being uploaded.
expected=$(node -p "require('$dir/brobot-update.json').installer.sha512")
actual=$(openssl dgst -sha512 -binary "$dir/brobot-setup-$version.exe" | base64 -w0)
if [ "$expected" != "$actual" ]; then
    echo "publish-release: brobot-setup-$version.exe does not match brobot-update.json." >&2
    exit 1
fi

gh release create "$tag" -R "$CLIENT" \
    --target "$client_sha" \
    --title "brobot $version" \
    --notes "$notes" \
    "$dir/brobot-setup-$version.exe" \
    "$dir/brobot-portable-$version.exe" \
    "$dir/brobot-update.json"

echo "publish-release: brobot $version is out. Installed copies offer it within four hours, or at their next start."
