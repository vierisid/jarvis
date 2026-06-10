#!/usr/bin/env bash
set -euo pipefail

# ── J.A.R.V.I.S. Installer ──────────────────────────────────────────
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/vierisid/jarvis/main/install.sh | bash
#
# What this does:
#   1. Detects your OS (macOS / Linux / WSL)
#   2. Installs Bun if not already installed
#   3. Clones the repo & installs dependencies
#   4. Links the `jarvis` command globally
#
# ─────────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/vierisid/jarvis.git"
INSTALL_DIR="$HOME/.jarvis/daemon"
TRACKING_URL="https://getjarvis.dev/api/install"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

print_banner() {
  echo -e "${CYAN}"
  echo "     ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗"
  echo "     ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝"
  echo "     ██║███████║██████╔╝██║   ██║██║███████╗"
  echo "██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║"
  echo "╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║"
  echo " ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝"
  echo -e "${RESET}"
  echo -e "${DIM}  Just A Rather Very Intelligent System${RESET}"
  echo ""
}

info() { echo -e "  ${CYAN}○${RESET} $1"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
err()  { echo -e "  ${RED}✗${RESET} $1"; }

# ── Detect OS ────────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)
      if grep -qi "microsoft\|wsl" /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows-native" ;;
    *) echo "unknown" ;;
  esac
}

# ── Package install helper (handles sudo vs root) ────────────────────

pkg_install() {
  local packages=("$@")
  if command -v apt-get &> /dev/null; then
    if [ "$(id -u)" -eq 0 ]; then
      apt-get update -qq && apt-get install -y -qq "${packages[@]}" >/dev/null 2>&1
    else
      sudo apt-get update -qq && sudo apt-get install -y -qq "${packages[@]}" >/dev/null 2>&1
    fi
  elif command -v yum &> /dev/null; then
    if [ "$(id -u)" -eq 0 ]; then
      yum install -y -q "${packages[@]}" >/dev/null 2>&1
    else
      sudo yum install -y -q "${packages[@]}" >/dev/null 2>&1
    fi
  elif command -v pacman &> /dev/null; then
    if [ "$(id -u)" -eq 0 ]; then
      pacman -Sy --noconfirm "${packages[@]}" >/dev/null 2>&1
    else
      sudo pacman -Sy --noconfirm "${packages[@]}" >/dev/null 2>&1
    fi
  elif command -v apk &> /dev/null; then
    if [ "$(id -u)" -eq 0 ]; then
      apk add --quiet "${packages[@]}" >/dev/null 2>&1
    else
      sudo apk add --quiet "${packages[@]}" >/dev/null 2>&1
    fi
  elif command -v brew &> /dev/null; then
    brew install "${packages[@]}" 2>/dev/null
  else
    return 1
  fi
}

# ── Ensure libc development headers (needed by Bun cc() at runtime) ──

ensure_libc_headers() {
  # Bun's embedded TinyCC compiles src/daemon/flock.c at runtime and needs
  # system headers like <sys/file.h> and <errno.h>. Fresh server images
  # often ship without them.

  # Quick probe: if sys/file.h already resolves, we're done.
  if [ -f /usr/include/sys/file.h ] || [ -f /usr/include/x86_64-linux-gnu/sys/file.h ] || [ -f /usr/include/aarch64-linux-gnu/sys/file.h ]; then
    return 0
  fi

  local pkg=""
  local pkg_label=""
  if command -v apt-get &> /dev/null; then
    pkg="libc6-dev"
    pkg_label="libc6-dev"
  elif command -v dnf &> /dev/null; then
    pkg="glibc-headers"
    pkg_label="glibc-headers"
  elif command -v yum &> /dev/null; then
    pkg="glibc-headers"
    pkg_label="glibc-headers"
  elif command -v apk &> /dev/null; then
    pkg="musl-dev"
    pkg_label="musl-dev"
  elif command -v pacman &> /dev/null; then
    # Arch ships headers with glibc by default; nothing to do.
    return 0
  else
    warn "Unknown package manager - cannot auto-install libc headers."
    warn "If 'jarvis' fails with \"sys/file.h not found\", install your distro's libc dev headers."
    return 0
  fi

  info "Installing libc dev headers (${pkg_label})..."
  if pkg_install "$pkg"; then
    ok "${pkg_label} installed"
  else
    err "Failed to install ${pkg_label} automatically."
    err "Please install it manually and re-run the installer:"
    err "  e.g. sudo apt-get install ${pkg_label}"
    exit 1
  fi
}

# ── Ensure PATH includes bun global bin ──────────────────────────────

ensure_bun_path() {
  local bun_bin="$HOME/.bun/bin"
  if [[ ":$PATH:" != *":$bun_bin:"* ]]; then
    export PATH="$bun_bin:$PATH"
  fi
}

PATH_ADDED_PROFILE=""

add_path_to_shell() {
  local bun_bin="$HOME/.bun/bin"
  local shell_name
  shell_name=$(basename "$SHELL")
  local profile

  case "$shell_name" in
    zsh)  profile="$HOME/.zshrc" ;;
    bash) profile="$HOME/.bashrc" ;;
    fish) profile="$HOME/.config/fish/config.fish" ;;
    *)    profile="$HOME/.profile" ;;
  esac

  # Ensure parent directory exists (e.g. ~/.config/fish/)
  mkdir -p "$(dirname "$profile")"

  if ! grep -q "\.bun/bin" "$profile" 2>/dev/null; then
    if [ "$shell_name" = "fish" ]; then
      echo "" >> "$profile"
      echo "# Bun global bin (added by JARVIS installer)" >> "$profile"
      echo "set -gx PATH \$HOME/.bun/bin \$PATH" >> "$profile"
    else
      echo "" >> "$profile"
      echo "# Bun global bin (added by JARVIS installer)" >> "$profile"
      echo "export PATH=\"\$HOME/.bun/bin:\$PATH\"" >> "$profile"
    fi
    info "Added bun bin to ${profile}"
    PATH_ADDED_PROFILE="$profile"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
  print_banner

  OS=$(detect_os)
  echo -e "${BOLD}Detected OS:${RESET} ${OS}"
  echo ""

  if [ "$OS" = "unknown" ]; then
    err "Unsupported operating system. JARVIS supports macOS, Linux, and WSL."
    exit 1
  fi

  if [ "$OS" = "windows-native" ]; then
    err "Native Windows installs are not supported for the JARVIS daemon."
    err "Use WSL2 for the Bun install, or run JARVIS with Docker on Windows."
    err "The Windows sidecar is still supported separately."
    exit 1
  fi

  # ── Step 0: Check prerequisites (curl) ──────────────────────────

  if ! command -v curl &> /dev/null; then
    info "curl not found. Installing..."
    if pkg_install curl; then
      ok "curl installed"
    else
      err "curl is required but could not be installed automatically."
      err "Please install curl manually and re-run the installer."
      exit 1
    fi
  fi

  if ! command -v make &> /dev/null; then
    info "make not found. Installing..."
    if pkg_install make; then
      ok "make installed"
    else
      err "make is required but could not be installed automatically."
      err "Please install make manually and re-run the installer."
      exit 1
    fi
  fi

  # ── Step 0.5: Ensure libc dev headers on Linux/WSL ──────────────

  if [ "$OS" = "linux" ] || [ "$OS" = "wsl" ]; then
    ensure_libc_headers
  fi

  # ── Step 1: Check / Install Bun ──────────────────────────────────

  echo -e "${CYAN}[1/3]${RESET} ${BOLD}Checking Bun runtime...${RESET}"

  if command -v bun &> /dev/null; then
    BUN_VERSION=$(bun --version)
    ok "Bun v${BUN_VERSION} is installed"
  else
    # Bun's installer requires unzip — ensure it's available
    if ! command -v unzip &> /dev/null; then
      info "Installing unzip (required by Bun)..."
      if pkg_install unzip; then
        ok "unzip installed"
      else
        err "unzip is required but could not be installed automatically."
        err "Please install unzip manually and re-run the installer."
        exit 1
      fi
    fi

    info "Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash

    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if command -v bun &> /dev/null; then
      ok "Bun installed successfully (v$(bun --version))"
    else
      err "Failed to install Bun. Please install manually: https://bun.sh"
      exit 1
    fi
  fi

  echo ""

  # ── Step 2: Clone / Update repo ─────────────────────────────────

  echo -e "${CYAN}[2/3]${RESET} ${BOLD}Downloading J.A.R.V.I.S...${RESET}"

  if ! command -v git &> /dev/null; then
    info "git not found. Installing..."
    if pkg_install git; then
      ok "git installed"
    else
      err "git is required but could not be installed automatically."
      err "Please install git manually and re-run the installer."
      exit 1
    fi
  fi

  # Resolve the latest release tag from the remote (no full clone needed).
  # Shallow clones don't fetch tags, so we ask the remote directly and pick
  # the highest version with a version-aware sort.
  info "Resolving latest release tag..."
  LATEST_TAG=$(git ls-remote --tags --refs "$REPO_URL" 2>/dev/null \
    | awk -F/ '{print $NF}' \
    | grep -E '^v[0-9]+(\.[0-9]+)*$' \
    | sort -V \
    | tail -n1)

  if [ -z "$LATEST_TAG" ]; then
    err "Could not resolve a release tag from $REPO_URL"
    err "Check your internet connection and try again."
    exit 1
  fi
  ok "Latest release: ${LATEST_TAG}"

  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Existing installation found. Updating to ${LATEST_TAG}..."
    git -C "$INSTALL_DIR" checkout -- . 2>/dev/null || true
    if git -C "$INSTALL_DIR" fetch --depth 1 origin "refs/tags/${LATEST_TAG}:refs/tags/${LATEST_TAG}" 2>/dev/null \
       && git -C "$INSTALL_DIR" checkout -q "$LATEST_TAG" 2>/dev/null; then
      ok "Updated to ${LATEST_TAG}"
    else
      warn "Could not update in place. Re-cloning..."
      rm -rf "$INSTALL_DIR"
      git clone --depth 1 --branch "$LATEST_TAG" "$REPO_URL" "$INSTALL_DIR" || {
        err "Failed to clone repository. Check your internet connection."
        exit 1
      }
      ok "Installed ${LATEST_TAG}"
    fi
  else
    if [ -d "$INSTALL_DIR" ]; then
      rm -rf "$INSTALL_DIR"
    fi
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 --branch "$LATEST_TAG" "$REPO_URL" "$INSTALL_DIR" || {
      err "Failed to clone repository. Check your internet connection."
      exit 1
    }
    ok "Downloaded JARVIS ${LATEST_TAG}"
  fi

  echo ""

  # ── Step 3: Install dependencies & link ─────────────────────────

  echo -e "${CYAN}[3/3]${RESET} ${BOLD}Installing dependencies...${RESET}"

  cd "$INSTALL_DIR" || {
    err "Failed to enter install directory: $INSTALL_DIR"
    exit 1
  }

  if ! bun install --frozen-lockfile 2>/dev/null && ! bun install; then
    err "Failed to install dependencies. Try running: cd $INSTALL_DIR && bun install"
    exit 1
  fi
  ok "Dependencies installed"

  # Stamp install-method marker so `jarvis update` / `jarvis uninstall` know
  # this is a script install (git clone) and dispatch to `git pull` / `rm -rf`
  # rather than `bun uninstall -g` or docker instructions.
  printf '{"method":"script","installedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$INSTALL_DIR/.install-method"

  # Create shell wrapper directly (avoids bun link registry lookups)
  rm -f "$HOME/.bun/bin/jarvis" 2>/dev/null || true
  local bun_bin="$HOME/.bun/bin"
  mkdir -p "$bun_bin"
  printf '#!/usr/bin/env bash\nexec bun "%s/bin/jarvis.ts" "$@"\n' "$INSTALL_DIR" > "$bun_bin/jarvis"
  chmod +x "$bun_bin/jarvis"

  ensure_bun_path
  add_path_to_shell

  if command -v jarvis &> /dev/null; then
    ok "jarvis command is available"
  else
    warn "jarvis installed but not in PATH yet. Restart your terminal or run:"
    echo -e "    ${DIM}export PATH=\"\$HOME/.bun/bin:\$PATH\"${RESET}"
  fi

  echo ""

  # ── Track install (silent, non-blocking) ─────────────────────

  BUN_VER=$(bun --version 2>/dev/null || echo "unknown")
  curl -sS -X POST "$TRACKING_URL" \
    -H "Content-Type: application/json" \
    -d "{\"os\":\"$OS\",\"bun_version\":\"$BUN_VER\"}" \
    --connect-timeout 2 --max-time 3 &>/dev/null &

  # ── Done ─────────────────────────────────────────────────────────

  echo ""
  echo -e "${GREEN}${BOLD}✓ J.A.R.V.I.S. installed successfully!${RESET}"
  echo ""

  if [ -n "$PATH_ADDED_PROFILE" ]; then
    echo -e "  ${YELLOW}!${RESET} ${BOLD}Your PATH was updated.${RESET} Reload your shell first:"
    echo -e "    ${CYAN}source ${PATH_ADDED_PROFILE}${RESET}   ${DIM}# or restart your terminal${RESET}"
    echo ""
  fi

  echo -e "  Start the daemon and finish setup in your browser:"
  echo -e "    ${CYAN}jarvis start${RESET}"
  echo -e "    ${DIM}→ http://localhost:3142 (dashboard guides you through LLM, voice, and profile)${RESET}"
}

main "$@"
