#!/usr/bin/env bash
# setup.sh — bootstrap the full dev environment for ai-assistant
set -e

GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; RESET="\033[0m"
info()  { echo -e "${GREEN}[setup]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET} $*"; }
error() { echo -e "${RED}[error]${RESET} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Detect OS/distro ───────────────────────────────────────────────────────
detect_distro() {
  if   [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${ID:-unknown}"
  elif [ -f /etc/redhat-release ]; then
    echo "rhel"
  elif [ -f /etc/fedora-release ]; then
    echo "fedora"
  else
    echo "unknown"
  fi
}

DISTRO="$(detect_distro)"
info "Detected distro: ${DISTRO}"

# ── 1. Rust ────────────────────────────────────────────────────────────────
if ! command -v cargo &>/dev/null; then
  info "Installing Rust toolchain via rustup…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
  # Make sure cargo is on PATH for the rest of this script
  export PATH="$HOME/.cargo/bin:$PATH"
else
  info "Rust $(rustc --version) already installed"
fi

# Ensure stable toolchain is active
rustup default stable &>/dev/null || true

# ── 2. System deps ─────────────────────────────────────────────────────────
if [[ "$(uname)" == "Linux" ]]; then
  info "Installing system libraries for Tauri (distro: ${DISTRO})…"

  # ── Debian / Ubuntu / Mint ──────────────────────────────────────────
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y \
      libwebkit2gtk-4.0-dev \
      libwebkit2gtk-4.1-dev \
      libssl-dev \
      libgtk-3-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libsoup2.4-dev \
      xdotool \
      scrot \
      pkg-config \
      build-essential \
      curl \
      wget \
      file \
      libxdo-dev 2>/dev/null || true

  # ── Fedora (dnf) ─────────────────────────────────────────────────────
  elif command -v dnf &>/dev/null; then
    info "Using dnf (Fedora/RHEL/CentOS Stream)…"

    # Enable RPM Fusion free repo for broader package coverage if not present
    if ! rpm -q rpmfusion-free-release &>/dev/null; then
      warn "RPM Fusion not detected — some optional packages may be unavailable"
      warn "To enable: sudo dnf install https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-\$(rpm -E %fedora).noarch.rpm"
    fi

    sudo dnf install -y \
      webkit2gtk4.0-devel \
      openssl-devel \
      gtk3-devel \
      libayatana-appindicator-gtk3-devel \
      librsvg2-devel \
      libsoup-devel \
      libsoup2-devel \
      curl \
      wget \
      file \
      xdotool \
      scrot \
      pkg-config \
      gcc \
      gcc-c++ \
      make \
      libxdo-devel 2>/dev/null || \
    # Fallback: older webkit2gtk package name on RHEL 8/9
    sudo dnf install -y \
      webkit2gtk3-devel \
      openssl-devel \
      gtk3-devel \
      librsvg2-devel \
      libsoup-devel \
      curl \
      wget \
      file \
      pkg-config \
      gcc \
      gcc-c++ \
      make 2>/dev/null || true

    # libappindicator fallback name on some Fedora versions
    sudo dnf install -y libappindicator-gtk3-devel 2>/dev/null || true

  # ── RHEL / CentOS / AlmaLinux / Rocky ───────────────────────────────
  elif command -v yum &>/dev/null; then
    info "Using yum (RHEL/CentOS)…"

    # Enable EPEL if not present
    if ! rpm -q epel-release &>/dev/null; then
      warn "EPEL not detected — trying to install it…"
      sudo yum install -y epel-release 2>/dev/null || \
        warn "Could not install EPEL. Some packages may be missing."
    fi

    sudo yum install -y \
      webkit2gtk3-devel \
      openssl-devel \
      gtk3-devel \
      librsvg2-devel \
      libsoup-devel \
      curl \
      wget \
      file \
      pkg-config \
      gcc \
      gcc-c++ \
      make 2>/dev/null || true

  # ── openSUSE (zypper) ────────────────────────────────────────────────
  elif command -v zypper &>/dev/null; then
    info "Using zypper (openSUSE)…"
    sudo zypper install -y --no-recommends \
      webkit2gtk3-devel \
      libopenssl-devel \
      gtk3-devel \
      librsvg-devel \
      libsoup-devel \
      xdotool \
      scrot \
      pkg-config \
      gcc \
      gcc-c++ \
      make 2>/dev/null || true

  # ── Arch / Manjaro (pacman) ──────────────────────────────────────────
  elif command -v pacman &>/dev/null; then
    info "Using pacman (Arch/Manjaro)…"
    sudo pacman -S --noconfirm --needed \
      webkit2gtk \
      base-devel \
      openssl \
      libsoup \
      gtk3 \
      librsvg \
      xdotool \
      scrot \
      pkg-config 2>/dev/null || true

  else
    warn "Unsupported package manager — install Tauri system deps manually."
    warn "See: https://tauri.app/v1/guides/getting-started/prerequisites"
  fi

  # ── Verify critical libs are available ──────────────────────────────
  info "Verifying pkg-config can find required libraries…"
  MISSING_LIBS=()

  for lib in \
    "webkit2gtk-4.0 | webkit2gtk-4.1" \
    "gtk+-3.0" \
    "openssl"
  do
    # Try each alternative name (pipe-separated)
    found=false
    IFS='|' read -ra ALTS <<< "$lib"
    for alt in "${ALTS[@]}"; do
      alt="$(echo -e "${alt}" | tr -d '[:space:]')"
      if pkg-config --exists "$alt" 2>/dev/null; then
        found=true
        break
      fi
    done
    if ! $found; then
      MISSING_LIBS+=("$lib")
    fi
  done

  if [ ${#MISSING_LIBS[@]} -gt 0 ]; then
    warn "The following libraries were NOT found via pkg-config:"
    for lib in "${MISSING_LIBS[@]}"; do
      warn "  • $lib"
    done
    warn "The Rust build may fail. Try installing them manually."
  else
    info "All critical libraries found ✓"
  fi
fi   # end Linux block

# ── 3. Node.js check ───────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  warn "Node.js not found. Installing via NodeSource (LTS)…"

  case "$DISTRO" in
    fedora|rhel|centos|almalinux|rocky)
      # NodeSource RPM setup
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
      if command -v dnf &>/dev/null; then
        sudo dnf install -y nodejs
      else
        sudo yum install -y nodejs
      fi
      ;;
    ubuntu|debian|linuxmint|pop)
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    *)
      warn "Cannot auto-install Node.js for distro '${DISTRO}'."
      warn "Please install Node.js 18+ manually: https://nodejs.org"
      ;;
  esac
fi

NODE_VERSION="$(node --version 2>/dev/null || echo 'missing')"
info "Node.js: ${NODE_VERSION}"

if ! command -v npm &>/dev/null; then
  error "npm not found even after Node.js install. Aborting."
fi

# ── 4. Tauri CLI ───────────────────────────────────────────────────────────
if ! cargo tauri --version &>/dev/null 2>&1; then
  info "Installing @tauri-apps/cli via npm (local)…"
  # It will be installed with npm install below; just a heads-up
fi

# ── 5. Node deps ───────────────────────────────────────────────────────────
info "Installing Node dependencies…"
npm install

# ── 5b. Fedora 41+ webkit2gtk-4.0 compat shims ────────────────────────────
# Tauri v1 (wry 0.24) requires webkit2gtk-4.0 pkg-config files.
# Fedora 41+ ships only webkit2gtk-4.1; we install compatibility shims.
if command -v dnf &>/dev/null; then
  SHIMS_DIR="$SCRIPT_DIR/src-tauri/.pkg-shims"
  PKG_SYSTEM_DIR="/usr/lib64/pkgconfig"

  if [ -d "$SHIMS_DIR" ] && ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    info "Installing webkit2gtk-4.0→4.1 compat shims to ${PKG_SYSTEM_DIR}…"
    if sudo cp "$SHIMS_DIR"/*.pc "$PKG_SYSTEM_DIR/" 2>/dev/null; then
      info "Shims installed ✓"
    else
      warn "sudo required to install shims — trying without (in-project PKG_CONFIG_PATH will be used)"
      warn "PKG_CONFIG_PATH will be set via package.json scripts. If builds fail, run:"
      warn "  sudo cp ${SHIMS_DIR}/*.pc ${PKG_SYSTEM_DIR}/"
    fi
  elif pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    info "webkit2gtk-4.0 already visible to pkg-config ✓"
  fi
fi

# ── 6. Placeholder icon ────────────────────────────────────────────────────
if [ ! -f "src-tauri/icons/icon.png" ]; then
  mkdir -p src-tauri/icons
  # 1×1 pixel transparent PNG (base64)
  printf '%s' \
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" \
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" \
    | base64 -d > src-tauri/icons/icon.png
  info "Placeholder icon created"
  warn "Replace src-tauri/icons/icon.png with a real 512×512 PNG before shipping."
fi

# ── 7. .cargo/config.toml — speed up Linux builds ─────────────────────────
mkdir -p .cargo
if [ ! -f ".cargo/config.toml" ]; then
  info "Writing .cargo/config.toml (linker optimisations)…"
  cat > .cargo/config.toml << 'EOF'
[build]
# Use mold linker if available (much faster on Linux)
# Install: sudo dnf install mold   OR   sudo apt install mold
# linker = "clang"

[target.x86_64-unknown-linux-gnu]
# Uncomment after: sudo dnf install mold
# rustflags = ["-C", "link-arg=-fuse-ld=mold"]

[net]
git-fetch-with-cli = true
EOF
fi

# Offer to install mold linker for faster rebuilds
if [[ "$(uname)" == "Linux" ]] && ! command -v mold &>/dev/null; then
  warn "Optional: install 'mold' linker for 3-5× faster Rust link times:"
  if command -v dnf &>/dev/null; then
    warn "  sudo dnf install mold"
  elif command -v apt-get &>/dev/null; then
    warn "  sudo apt install mold"
  fi
fi

# ── 8. Summary ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║        AI Assistant — Setup Complete ✓           ║${RESET}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Distro detected : ${DISTRO}"
echo "  Rust             : $(rustc --version 2>/dev/null || echo 'not found')"
echo "  Node.js          : $(node --version 2>/dev/null  || echo 'not found')"
echo "  npm              : $(npm --version  2>/dev/null  || echo 'not found')"
echo ""
echo "  ▶  Start dev server    npm run tauri dev"
echo "  ▶  Run Rust tests      cd tests-standalone && cargo test"
echo "  ▶  Build release       npm run tauri build"
echo ""
if command -v dnf &>/dev/null; then
  # Show webkit hint only if neither variant is found via pkg-config
  if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null && \
     ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    echo -e "${YELLOW}  Fedora tip: webkit2gtk not found, run:${RESET}"
    echo "    sudo dnf install webkit2gtk4.1-devel"
    echo ""
  fi
fi