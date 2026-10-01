#!/usr/bin/env bash
# Builds the Windows installer and the portable exe on Linux: no Windows
# machine, no root, no container. `pnpm run dist` is the same build on Windows.
#
#   pnpm --filter @singularity/brobot-client run dist:linux
#   -> release/brobot-setup-<version>.exe, release/brobot-portable-<version>.exe
#
# electron-builder packages every Windows target on Linux except for one step.
# It builds the NSIS installer, then runs it once in BUILD_UNINSTALLER mode so
# that it writes its own uninstaller, and running a Windows exe needs Wine. The
# exe's icon and version info are edited in JavaScript, and the portable target
# needs no Wine at all.
#
# The Wine here is a pinned, checksummed, relocatable build, unpacked once under
# the user's cache (~800 MB), so nothing is installed system-wide. Two things
# about it are deliberate:
#   - WoW64. The NSIS stub is a 32-bit exe, and a classic 64-bit Wine runs it
#     only with 32-bit host libraries ("/lib/ld-linux.so.2: could not open"),
#     which a CI host does not have.
#   - Not electron-builder's own `toolsets.wine: "1.0.1"`. Its Linux bundle in
#     electron-builder 26.15.3 ships no x86_64-windows DLLs and fails with
#     "failed to load .../ntdll.dll error c0000135". When a later
#     electron-builder fixes that, it can replace the download below.
set -euo pipefail

WINE_VERSION=11.18
WINE_NAME="wine-${WINE_VERSION}-amd64-wow64"
WINE_SHA256=f899879b8c37e0b20adca19d147cf77436f3f1a37bf16d08d27fa7137a52b9ba
WINE_URL="https://github.com/Kron4ek/Wine-Builds/releases/download/${WINE_VERSION}/${WINE_NAME}.tar.xz"

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
    echo "dist-linux: needs x86_64 Linux, this is $(uname -s) $(uname -m). On Windows, run 'pnpm run dist'." >&2
    exit 1
fi

cache_root="${BROBOT_WINE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/brobot-client}"
wine_dir="$cache_root/$WINE_NAME"

# The marker is written last, so an interrupted unpack is redone, not trusted.
if [ "$(cat "$wine_dir/.sha256" 2>/dev/null)" != "$WINE_SHA256" ]; then
    mkdir -p "$cache_root"
    tmp=$(mktemp -d "$cache_root/.download.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    echo "dist-linux: downloading $WINE_NAME"
    curl -fsSL --retry 3 -o "$tmp/wine.tar.xz" "$WINE_URL"
    echo "$WINE_SHA256  $tmp/wine.tar.xz" | sha256sum --check --quiet -
    tar -xJf "$tmp/wine.tar.xz" -C "$tmp"
    rm -rf "$wine_dir"
    mv "$tmp/$WINE_NAME" "$wine_dir"
    # electron-builder uses <toolset>/wine-home as WINEPREFIX, and refuses a
    # toolset directory without one.
    mkdir -p "$wine_dir/wine-home"
    echo "$WINE_SHA256" > "$wine_dir/.sha256"
fi

cd "$(dirname "$0")/.."
export ELECTRON_BUILDER_WINE_TOOLSET_DIR="$wine_dir"
pnpm run build
pnpm exec electron-builder --win --publish never
