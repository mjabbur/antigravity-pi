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

# Validate HOME is absolute path
if [[ "$HOME" != /* ]]; then
  echo "Error: HOME environment variable must be an absolute path (got '$HOME')." >&2
  exit 1
fi

# Validate AGY_PI_HOME if set
if [ -n "${AGY_PI_HOME:-}" ] && [[ "$AGY_PI_HOME" != /* ]]; then
  echo "Error: AGY_PI_HOME environment variable must be an absolute path (got '$AGY_PI_HOME')." >&2
  exit 1
fi

AGY_PI_REF="${AGY_PI_REF:-main}"
if [[ "$AGY_PI_REF" == -* ]]; then
  echo "Error: AGY_PI_REF must not start with '-' (got '$AGY_PI_REF')." >&2
  exit 1
fi
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agy-pi"
MANIFEST_FILE="$STATE_DIR/install.env"

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

  # Read manifest safely without sourcing/executing arbitrary shell code
  MANIFEST_CLI=""
  MANIFEST_PLUGIN=""
  if [ -f "$MANIFEST_FILE" ] && [ ! -L "$MANIFEST_FILE" ]; then
    while IFS='=' read -r key value; do
      value="${value%\"}"
      value="${value#\"}"
      case "$key" in
        CLI_TARGET) MANIFEST_CLI="$value" ;;
        PLUGIN_TARGET) MANIFEST_PLUGIN="$value" ;;
      esac
    done < "$MANIFEST_FILE"
  fi

  # Uninstall CLI target: only if it is a symlink pointing to */dist/src/cli.js or matches manifest CLI_TARGET
  TARGET_TO_CHECK="${CLI_TARGET:-$MANIFEST_CLI}"
  if [ -n "$TARGET_TO_CHECK" ] && [ -L "$TARGET_TO_CHECK" ]; then
    LINK_DEST="$(readlink "$TARGET_TO_CHECK" || true)"
    if [[ "$LINK_DEST" == */dist/src/cli.js ]] || [ "$TARGET_TO_CHECK" = "$MANIFEST_CLI" ]; then
      rm -f "$TARGET_TO_CHECK"
      log_info "Removed $TARGET_TO_CHECK"
    else
      log_error "Refusing to remove symlink $TARGET_TO_CHECK as its target ($LINK_DEST) does not match agy-pi cli signature."
    fi
  elif [ -e "${CLI_TARGET}" ] && [ ! -L "${CLI_TARGET}" ]; then
    log_error "Refusing to remove ${CLI_TARGET} because it is not a symlink."
  fi

  # Uninstall Plugin target: only if it is a symlink (never rm -rf a real directory!)
  PLUGIN_TARGET_TO_CHECK="${PLUGIN_TARGET:-$MANIFEST_PLUGIN}"
  if [ -n "$PLUGIN_TARGET_TO_CHECK" ] && [ -L "$PLUGIN_TARGET_TO_CHECK" ]; then
    rm -f "$PLUGIN_TARGET_TO_CHECK"
    log_info "Removed plugin symlink $PLUGIN_TARGET_TO_CHECK"
  elif [ -e "${PLUGIN_TARGET_TO_CHECK}" ] && [ ! -L "${PLUGIN_TARGET_TO_CHECK}" ]; then
    log_error "Refusing to remove $PLUGIN_TARGET_TO_CHECK because it is a real directory (not a symlink). Please remove manually if desired."
  fi

  if [ -f "$MANIFEST_FILE" ]; then
    rm -f "$MANIFEST_FILE"
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
  if ! command -v git >/dev/null 2>&1; then
    log_error "git is required for standalone installation but is not installed."
    exit 1
  fi

  log_info "Standalone installation: cloning or updating repository (ref: $AGY_PI_REF)..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch origin
    if git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/remotes/origin/$AGY_PI_REF"; then
      git -C "$INSTALL_DIR" checkout -- "$AGY_PI_REF" 2>/dev/null || git -C "$INSTALL_DIR" checkout "$AGY_PI_REF"
      git -C "$INSTALL_DIR" pull --ff-only origin "$AGY_PI_REF"
    else
      git -C "$INSTALL_DIR" checkout "$AGY_PI_REF"
    fi
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
    git -C "$INSTALL_DIR" checkout "$AGY_PI_REF"
  fi
  SRC_DIR="$INSTALL_DIR"
fi

# Build in target directory
log_info "Installing dependencies and building in $SRC_DIR..."
cd "$SRC_DIR"

if [ -f "package-lock.json" ]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi
npm run build

# Create bin, plugins, and state directories with private permissions (umask 077)
(
  umask 077
  mkdir -p "$BIN_DIR"
  mkdir -p "$PLUGINS_DIR"
  mkdir -p "$STATE_DIR"
)

# Write ownership manifest
(
  umask 077
  cat > "$MANIFEST_FILE" <<EOF
CLI_TARGET="$CLI_TARGET"
PLUGIN_TARGET="$PLUGIN_TARGET"
SRC_DIR="$SRC_DIR"
EOF
)

# Symlinks
CLI_SRC="$SRC_DIR/dist/src/cli.js"
chmod +x "$CLI_SRC"

if [ -d "$CLI_TARGET" ]; then
  log_error "CLI target $CLI_TARGET exists and is a directory. Aborting."
  exit 1
fi

# Portable safe link replacement for CLI
TMP_CLI_TARGET="${CLI_TARGET}.tmp.$$"
ln -sfn -- "$CLI_SRC" "$TMP_CLI_TARGET"
mv -f "$TMP_CLI_TARGET" "$CLI_TARGET"
log_info "Created symlink: $CLI_TARGET -> $CLI_SRC"

# If standalone or local not in plugins dir, link plugin
if [ "$SRC_DIR" != "$PLUGIN_TARGET" ]; then
  if [ -d "$PLUGIN_TARGET" ] && [ ! -L "$PLUGIN_TARGET" ]; then
    log_error "Plugin target $PLUGIN_TARGET exists as a real directory (not a symlink) and is not \$SRC_DIR. Please inspect and remove it manually before installing."
    exit 1
  fi
  rm -f "$PLUGIN_TARGET"
  ln -sfn -- "$SRC_DIR" "$PLUGIN_TARGET"
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
