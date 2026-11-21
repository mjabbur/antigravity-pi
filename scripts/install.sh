#!/usr/bin/env bash
set -euo pipefail

# agy-pi installation / uninstallation script
# Supports local clone detection or standalone curl | bash install.

REPO_URL="https://github.com/mjabbur/antigravity-pi.git"
INSTALL_DIR="${AGY_PI_HOME:-$HOME/.local/share/antigravity-pi}"
BIN_DIR="$HOME/.local/bin"
PLUGINS_DIR="$HOME/.gemini/config/plugins"
PLUGIN_TARGET="$PLUGINS_DIR/agy-pi"
CLI_TARGET="$BIN_DIR/agy-pi"

log_info() {
  echo "$1"
}

log_error() {
  echo "Error: $1" >&2
}

# Check node version
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    log_error "Node.js is required but not installed. Please install Node.js >= 22.19.0."
    exit 1
  fi

  NODE_VERSION=$(node -v | sed 's/^v//')
  if ! node -e '
    const [maj, min, pat] = process.versions.node.split(".").map(Number);
    const ok = maj > 22 || (maj === 22 && (min > 19 || (min === 19 && pat >= 0)));
    process.exit(ok ? 0 : 1);
  '; then
    log_error "Node.js version $NODE_VERSION is installed, but version >= 22.19.0 is required."
    exit 1
  fi
}

uninstall() {
  log_info "Uninstalling agy-pi..."

  if [ -L "$CLI_TARGET" ] || [ -f "$CLI_TARGET" ]; then
    rm -f "$CLI_TARGET"
    log_info "Removed $CLI_TARGET"
  fi

  if [ -L "$PLUGIN_TARGET" ]; then
    rm -f "$PLUGIN_TARGET"
    log_info "Removed plugin symlink $PLUGIN_TARGET"
  elif [ -d "$PLUGIN_TARGET" ] && [ -f "$PLUGIN_TARGET/plugin.json" ]; then
    rm -rf "$PLUGIN_TARGET"
    log_info "Removed plugin directory $PLUGIN_TARGET"
  fi

  log_info "Uninstallation complete. User sessions and ~/.pi were preserved."
  exit 0
}

# Parse arguments
if [ "${1:-}" = "--uninstall" ]; then
  uninstall
fi

check_node

# Determine if running inside a local clone (safe under `curl | bash` with `set -u`)
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SRC_DIR=""
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  PARENT_DIR="$(dirname "$SCRIPT_DIR")"
  if [ -f "$PARENT_DIR/package.json" ] && [ -f "$PARENT_DIR/plugin.json" ]; then
    SRC_DIR="$PARENT_DIR"
    log_info "Detected local repository clone at $SRC_DIR"
  fi
fi

if [ -z "$SRC_DIR" ]; then
  log_info "Standalone installation: cloning or updating repository..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" pull --ff-only
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  SRC_DIR="$INSTALL_DIR"
fi

# Build in target directory
log_info "Installing dependencies and building in $SRC_DIR..."
cd "$SRC_DIR"
npm install --ignore-scripts
npm run build

# Create bin and plugins directories
mkdir -p "$BIN_DIR"
mkdir -p "$PLUGINS_DIR"

# Symlinks
CLI_SRC="$SRC_DIR/dist/src/cli.js"
chmod +x "$CLI_SRC"

ln -sf "$CLI_SRC" "$CLI_TARGET"
log_info "Created symlink: $CLI_TARGET -> $CLI_SRC"

# If standalone or local not in plugins dir, link plugin
if [ "$SRC_DIR" != "$PLUGIN_TARGET" ]; then
  rm -rf "$PLUGIN_TARGET"
  ln -s "$SRC_DIR" "$PLUGIN_TARGET"
  log_info "Created plugin symlink: $PLUGIN_TARGET -> $SRC_DIR"
fi

# Summary and PATH check
log_info "agy-pi successfully installed!"

PATH_OK=false
IFS=':' read -ra ADDR <<< "$PATH"
for i in "${ADDR[@]}"; do
  if [ "$i" = "$BIN_DIR" ]; then
    PATH_OK=true
    break
  fi
done

if [ "$PATH_OK" = false ]; then
  echo ""
  echo "WARNING: $BIN_DIR is not currently in your \$PATH."
  echo "Add it to your shell profile (e.g., ~/.bashrc or ~/.zshrc):"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "Verify your installation with:"
echo "  agy-pi models"
