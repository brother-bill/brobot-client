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
#
# Once the release is up it tells the fleet board: POST /webhooks/deployed
# {app: brobot-client, sha: <the released brobot-client commit>}, which stamps
# the app's last deploy and finishes the merged tickets that commit contains.
# The x-deploy-token is DEPLOY_CALLBACK_TOKEN, read with your own `op` login
# (FLEET_DEPLOY_TOKEN_REF overrides the reference, FLEET_API_URL the API) and
# handed to curl on stdin, never in argv. Best-effort: the release is already
# out, so a failed stamp prints a warning and the command to send by hand,
# and the script still exits 0.
set -euo pipefail

SINGULARITY=brother-bill/singularity
CLIENT=brother-bill/brobot-client
FLEET_APP=brobot-client
FLEET_API_URL=${FLEET_API_URL:-https://tahatime.com/api}
FLEET_DEPLOY_TOKEN_REF=${FLEET_DEPLOY_TOKEN_REF:-op://ci-deploy/DEPLOY_CALLBACK_TOKEN/credential}

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

# Tells the fleet board brobot-client shipped at <sha>. 0 when it answered 2xx;
# otherwise says why on stderr, 1. Never exits the script.
stamp_fleet() { # <sha>
    local sha=$1 token code payload
    if ! command -v op >/dev/null 2>&1; then
        echo "publish-release: warning: 1Password CLI (op) is not installed." >&2
        return 1
    fi
    if ! token=$(op read --no-newline "$FLEET_DEPLOY_TOKEN_REF" 2>"$work/op-errors") || [ -z "$token" ]; then
        echo "publish-release: warning: op read $FLEET_DEPLOY_TOKEN_REF failed: $(head -c 300 "$work/op-errors" | tr -d '\r\n')" >&2
        return 1
    fi
    payload=$(printf '{"app":"%s","sha":"%s"}' "$FLEET_APP" "$sha")
    code=$(printf 'header = "x-deploy-token: %s"\n' "$token" |
        curl --config - -sS -o "$work/stamp-response" -w '%{http_code}' \
            --retry 3 --retry-delay 5 --retry-all-errors \
            --connect-timeout 10 --max-time 30 \
            -X POST "$FLEET_API_URL/webhooks/deployed" \
            -H 'content-type: application/json' \
            -d "$payload" 2>"$work/curl-errors") || code=000
    case "$code" in
        2*)
            echo "publish-release: fleet stamped $FLEET_APP at ${sha:0:7}: $(head -c 300 "$work/stamp-response" | tr -d '\r\n')"
            return 0
            ;;
    esac
    echo "publish-release: warning: fleet deploy callback failed: HTTP $code: $(cat "$work/stamp-response" "$work/curl-errors" 2>/dev/null | head -c 300 | tr -d '\r\n')" >&2
    return 1
}

if ! stamp_fleet "$client_sha"; then
    echo "publish-release: warning: the release is out, but the fleet board was NOT told. Stamp it by hand:" >&2
    echo "    op read $FLEET_DEPLOY_TOKEN_REF | sed 's/^/header = \"x-deploy-token: /; s/\$/\"/' | curl --config - -X POST $FLEET_API_URL/webhooks/deployed -H 'content-type: application/json' -d '{\"app\":\"$FLEET_APP\",\"sha\":\"$client_sha\"}'" >&2
fi
