#!/usr/bin/env bash
# Install the shared libraries headless Chromium needs into a LOCAL prefix, without root.
#
# The devcontainer runs as the unprivileged `node` user with no sudo, so
# `npx playwright install-deps` (which shells out to apt-get) cannot run. Instead we
# download the .deb packages straight from the Debian archive and extract them into
# .playwright-deps/, then point LD_LIBRARY_PATH at it.
#
# Idempotent: safe to re-run. Skips packages already extracted.
set -euo pipefail

PREFIX="${PREFIX:-$(cd "$(dirname "$0")/.." && pwd)/.playwright-deps}"
WORK="${WORK:-${TMPDIR:-/tmp}/pw-debs}"
SUITE="bookworm"

mkdir -p "$PREFIX" "$WORK"

# package name -> pool path fragment. Pool paths encode the source version, so we resolve
# them from the Packages index rather than guessing.
PACKAGES=(
  "libnspr4" "libnss3" "libatk1.0-0" "libatk-bridge2.0-0" "libatspi2.0-0"
  "libxcomposite1" "libxdamage1" "libxfixes3" "libxrandr2" "libxkbcommon0"
  "libasound2" "libdbus-1-3" "libgbm1" "libxshmfence1" "libxext6"
  "libxrender1" "libxtst6" "libcups2" "libpango-1.0-0" "libcairo2"
  "libwayland-client0" "libwayland-server0" "libexpat1" "libxcb1" "libx11-6"
  "libxau6" "libxdmcp6" "libbsd0" "libmd0" "libdrm2" "libglib2.0-0" "libxi6"
)

echo "Resolving package pool paths for Debian $SUITE..."
INDEX="$WORK/Packages"
if [[ ! -f "$INDEX" ]]; then
  curl -fsSL "https://deb.debian.org/debian/dists/$SUITE/main/binary-amd64/Packages.gz" \
    | gzip -dc > "$INDEX"
fi

resolve() {
  # Emit the Filename: field for a given package name.
  awk -v pkg="$1" '
    /^Package: /   { current = $2 }
    /^Filename: /  { if (current == pkg) { print $2; exit } }
  ' "$INDEX"
}

for pkg in "${PACKAGES[@]}"; do
  path="$(resolve "$pkg" || true)"
  if [[ -z "$path" ]]; then
    echo "  ! $pkg: not found in index, skipping"
    continue
  fi

  deb="$WORK/$(basename "$path")"
  if [[ ! -f "$deb" ]]; then
    curl -fsSL "https://deb.debian.org/debian/$path" -o "$deb"
  fi
  dpkg-deb -x "$deb" "$PREFIX"
  echo "  + $pkg"
done

echo
echo "Libraries installed into $PREFIX"
# Some packages install to /lib and some to /usr/lib; Debian merges them at boot via
# usrmerge, which we do not have here, so both must be on the path explicitly.
echo "Run the e2e suite with:"
echo "  source scripts/browser-env.sh && npx playwright test"