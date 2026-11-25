#!/bin/sh
# Installs llmpick: downloads the release executable for this machine, checks
# its SHA-256, and puts it in ~/.local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/haowjy/llmpick/main/install.sh | sh
#
# LLMPICK_INSTALL_DIR  where to put it (default ~/.local/bin)
# LLMPICK_VERSION      a release tag such as v0.1.0 (default: the latest)
set -eu

repo="haowjy/llmpick"
dir="${LLMPICK_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "llmpick install: $1" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || fail "llmpick runs on Linux with systemd only."
case "$(uname -m)" in
  x86_64 | amd64) asset="llmpick-linux-x64" ;;
  aarch64 | arm64) asset="llmpick-linux-arm64" ;;
  *) fail "no release for $(uname -m) processors." ;;
esac
command -v curl >/dev/null || fail "curl is required."
command -v sha256sum >/dev/null || fail "sha256sum is required."

if [ -n "${LLMPICK_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/$LLMPICK_VERSION"
else
  base="https://github.com/$repo/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset..."
curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "could not download $base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download the checksums."
(cd "$tmp" && grep " $asset\$" SHA256SUMS | sha256sum -c - >/dev/null) || fail "the download does not match its checksum."

mkdir -p "$dir"
install -m 755 "$tmp/$asset" "$dir/llmpick"
echo "Installed llmpick $("$dir/llmpick" --version) to $dir/llmpick"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "$dir is not on your PATH. Add it, or run $dir/llmpick directly." ;;
esac
echo "Next: run 'llmpick init' to write a starter profiles file, then edit it."
