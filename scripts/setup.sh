#!/usr/bin/env bash
# Cursor Notebook Bridge — macOS / Linux setup script.
#
# Checks for and installs all prerequisites:
#   • Git
#   • Node.js (v18+)
#   • pnpm
#   • Python (3.9+)
#   • uv
#
# Then runs: pnpm install && pnpm build
#
# Usage (from the repo root):
#   bash scripts/setup.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
RESET='\033[0m'

header()  { echo -e "\n${CYAN}─────────────────────────────────────────${RESET}"; echo -e "${CYAN}  $1${RESET}"; echo -e "${CYAN}─────────────────────────────────────────${RESET}"; }
ok()      { echo -e "${GREEN}  ✓  $1${RESET}"; }
warn()    { echo -e "${YELLOW}  ⚠  $1${RESET}"; }
fail()    { echo -e "${RED}  ✗  $1${RESET}"; }
info()    { echo -e "${GRAY}  →  $1${RESET}"; }

command_exists() { command -v "$1" &>/dev/null; }

IS_MAC=false
IS_LINUX=false
[[ "$OSTYPE" == "darwin"* ]] && IS_MAC=true || IS_LINUX=true

# ---------------------------------------------------------------------------
# 1. Git
# ---------------------------------------------------------------------------

header "1 / 5  Git"

if command_exists git; then
    ok "git found: $(git --version)"
else
    warn "git not found"
    if $IS_MAC; then
        info "Installing git via Homebrew..."
        if command_exists brew; then
            brew install git
        else
            fail "Homebrew not found. Install from https://brew.sh then re-run."
            exit 1
        fi
    elif $IS_LINUX; then
        info "Installing git via apt/yum..."
        if command_exists apt-get; then
            sudo apt-get update -qq && sudo apt-get install -y git
        elif command_exists yum; then
            sudo yum install -y git
        elif command_exists dnf; then
            sudo dnf install -y git
        else
            fail "Could not detect package manager. Install git manually and re-run."
            exit 1
        fi
    fi
    command_exists git && ok "git installed: $(git --version)" || { fail "git install failed."; exit 1; }
fi

# ---------------------------------------------------------------------------
# 2. Node.js (v18+)
# ---------------------------------------------------------------------------

header "2 / 5  Node.js (v18+)"

NODE_OK=false
if command_exists node; then
    NODE_MAJOR=$(node --version | sed 's/v\([0-9]*\).*/\1/')
    if [[ "$NODE_MAJOR" -ge 18 ]]; then
        ok "node found: $(node --version)"
        NODE_OK=true
    else
        warn "node $(node --version) is too old (need v18+)"
    fi
fi

if ! $NODE_OK; then
    info "Installing Node.js LTS..."
    if $IS_MAC && command_exists brew; then
        brew install node@20
        brew link --overwrite node@20
    elif $IS_LINUX; then
        # Use NodeSource setup for the LTS channel
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
    command_exists node && ok "node installed: $(node --version)" || { fail "Node.js install failed. Visit https://nodejs.org"; exit 1; }
fi

# ---------------------------------------------------------------------------
# 3. pnpm
# ---------------------------------------------------------------------------

header "3 / 5  pnpm"

if command_exists pnpm; then
    ok "pnpm found: $(pnpm --version)"
else
    info "Installing pnpm via npm..."
    npm install -g pnpm
    command_exists pnpm && ok "pnpm installed: $(pnpm --version)" || { fail "pnpm install failed. Try: npm install -g pnpm"; exit 1; }
fi

# ---------------------------------------------------------------------------
# 4. Python (3.9+)
# ---------------------------------------------------------------------------

header "4 / 5  Python (3.9+)"

PYTHON_CMD=""
for cmd in python3 python; do
    if command_exists "$cmd"; then
        PYVER=$($cmd --version 2>&1 | grep -oP '\d+\.\d+' | head -1)
        PYMAJ=$(echo "$PYVER" | cut -d. -f1)
        PYMIN=$(echo "$PYVER" | cut -d. -f2)
        if [[ "$PYMAJ" -ge 3 && "$PYMIN" -ge 9 ]]; then
            PYTHON_CMD="$cmd"
            ok "Python found: $($cmd --version) (via '$cmd')"
            break
        fi
    fi
done

if [[ -z "$PYTHON_CMD" ]]; then
    warn "Python 3.9+ not found"
    if $IS_MAC && command_exists brew; then
        brew install python@3.12
        PYTHON_CMD="python3"
    elif $IS_LINUX && command_exists apt-get; then
        sudo apt-get install -y python3 python3-pip
        PYTHON_CMD="python3"
    else
        fail "Please install Python 3.9+ from https://www.python.org and re-run."
        exit 1
    fi
    ok "Python installed: $($PYTHON_CMD --version)"
fi

# ---------------------------------------------------------------------------
# 5. uv
# ---------------------------------------------------------------------------

header "5 / 5  uv"

if command_exists uvx; then
    ok "uv found: $(uv --version 2>&1)"
else
    info "Installing uv via pip..."
    "$PYTHON_CMD" -m pip install uv --quiet

    # Refresh PATH to pick up the newly installed uv/uvx
    UV_BIN=$("$PYTHON_CMD" -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>/dev/null || true)
    if [[ -n "$UV_BIN" && -d "$UV_BIN" ]]; then
        export PATH="$PATH:$UV_BIN"
    fi

    # Alternative: check the uv default install path
    if ! command_exists uvx && [[ -f "$HOME/.local/bin/uvx" ]]; then
        export PATH="$PATH:$HOME/.local/bin"
    fi

    command_exists uvx && ok "uv installed: $(uv --version)" || { fail "uv install failed. Try: pip install uv"; exit 1; }
fi

# ---------------------------------------------------------------------------
# Install dependencies and build
# ---------------------------------------------------------------------------

header "Installing dependencies"
info "Running pnpm install..."
pnpm install

header "Building all packages"
info "Running pnpm build..."
pnpm build

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

header "Setup complete"
ok "git    : $(git --version)"
ok "node   : $(node --version)"
ok "pnpm   : $(pnpm --version)"
ok "python : $($PYTHON_CMD --version)"
ok "uv     : $(uv --version 2>&1)"
echo ""
echo -e "${GREEN}  All prerequisites are installed and packages are built.${RESET}"
echo -e "${YELLOW}  Press F5 in Cursor to launch the Extension Development Host.${RESET}"
echo ""
