#!/usr/bin/env bash
# Put the locally-extracted browser libraries on the dynamic linker path.
#
# Usage:  source scripts/browser-env.sh
#
# The devcontainer has no root, so Chromium's shared libraries live in .playwright-deps/
# rather than /usr/lib. Both /lib and /usr/lib variants are needed because Debian's
# usrmerge is not in effect here and the .deb payloads split across both trees.

_DEPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/.playwright-deps"
export LD_LIBRARY_PATH="$_DEPS_ROOT/usr/lib/x86_64-linux-gnu:$_DEPS_ROOT/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
unset _DEPS_ROOT