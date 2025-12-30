#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ===========================================
# 1. Setup SSH Directory
# ===========================================
setup_ssh() {
    log_info "Setting up SSH configuration..."

    # Create .ssh directory if it doesn't exist (should be mounted)
    if [ ! -d "$HOME/.ssh" ]; then
        mkdir -p "$HOME/.ssh"
    fi

    # Check if SSH keys are present
    if [ -f "$HOME/.ssh/id_rsa" ] || [ -f "$HOME/.ssh/id_ed25519" ]; then
        log_success "SSH keys found"

        # Copy keys to writable location if mounted read-only
        if [ ! -w "$HOME/.ssh" ]; then
            log_info "SSH directory is read-only, creating writable copy..."
            cp -r "$HOME/.ssh" /tmp/.ssh-copy
            export HOME_SSH_BACKUP="$HOME/.ssh"
            # We'll use the original location but create known_hosts elsewhere
        fi
    else
        log_warn "No SSH keys found in $HOME/.ssh"
        log_warn "Mount your SSH keys to use Git over SSH"
    fi

    # Add GitHub to known_hosts (use /tmp if .ssh is read-only)
    KNOWN_HOSTS_FILE="$HOME/.ssh/known_hosts"
    if [ ! -w "$HOME/.ssh" ]; then
        mkdir -p /tmp/.ssh
        KNOWN_HOSTS_FILE="/tmp/.ssh/known_hosts"
        export GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=$KNOWN_HOSTS_FILE"
    fi

    if [ ! -f "$KNOWN_HOSTS_FILE" ] || ! grep -q "github.com" "$KNOWN_HOSTS_FILE" 2>/dev/null; then
        log_info "Adding GitHub to known_hosts..."
        ssh-keyscan -t ed25519,rsa github.com >> "$KNOWN_HOSTS_FILE" 2>/dev/null
        ssh-keyscan -t ed25519,rsa gitlab.com >> "$KNOWN_HOSTS_FILE" 2>/dev/null
        ssh-keyscan -t ed25519,rsa bitbucket.org >> "$KNOWN_HOSTS_FILE" 2>/dev/null
        log_success "Added common Git hosts to known_hosts"
    fi
}

# ===========================================
# 2. Configure Git
# ===========================================
setup_git() {
    log_info "Configuring Git..."

    # Set Git user name
    if [ -n "$GIT_USER_NAME" ]; then
        git config --global user.name "$GIT_USER_NAME"
        log_success "Git user.name set to: $GIT_USER_NAME"
    else
        log_warn "GIT_USER_NAME not set - commits may fail"
    fi

    # Set Git email
    if [ -n "$GIT_USER_EMAIL" ]; then
        git config --global user.email "$GIT_USER_EMAIL"
        log_success "Git user.email set to: $GIT_USER_EMAIL"
    else
        log_warn "GIT_USER_EMAIL not set - commits may fail"
    fi

    # Set default branch
    git config --global init.defaultBranch "${GIT_DEFAULT_BRANCH:-main}"

    # Additional Git settings
    git config --global pull.rebase false
    git config --global core.autocrlf input
    git config --global core.editor "vim"
    git config --global credential.helper cache

    log_success "Git configuration complete"
}

# ===========================================
# 3. Setup GitHub CLI
# ===========================================
setup_gh() {
    log_info "Checking GitHub CLI configuration..."

    if [ -n "$GITHUB_TOKEN" ]; then
        # Authenticate gh CLI with token
        echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null && \
            log_success "GitHub CLI authenticated" || \
            log_warn "GitHub CLI authentication failed"
    else
        log_warn "GITHUB_TOKEN not set - gh CLI won't be authenticated"
    fi
}

# ===========================================
# 4. Verify Claude Code
# ===========================================
verify_claude() {
    log_info "Verifying Claude Code installation..."

    if command -v claude &> /dev/null; then
        CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
        log_success "Claude Code CLI installed: $CLAUDE_VERSION"
    else
        log_error "Claude Code CLI not found!"
        return 1
    fi

    # Check API key
    if [ -n "$ANTHROPIC_API_KEY" ]; then
        log_success "ANTHROPIC_API_KEY is set"
    else
        log_error "ANTHROPIC_API_KEY not set - Claude Code won't work!"
        return 1
    fi
}

# ===========================================
# 5. Print Status
# ===========================================
print_status() {
    echo ""
    echo "==========================================="
    echo "  Claude Code Server - Ready"
    echo "==========================================="
    echo ""
    echo "Environment:"
    echo "  - Node.js: $(node --version)"
    echo "  - Python: $(python3 --version 2>&1 | cut -d' ' -f2)"
    echo "  - Java: $(java --version 2>&1 | head -1)"
    echo "  - Git: $(git --version | cut -d' ' -f3)"
    echo "  - Claude Code: $(claude --version 2>/dev/null || echo 'N/A')"
    echo ""
    echo "Workspace: /home/claude/workspace"
    echo "API Port:  ${API_PORT:-3100}"
    echo ""
    echo "API Endpoints:"
    echo "  POST /task        - Start new task"
    echo "  GET  /task/:id    - Get task status"
    echo "  GET  /tasks       - List all tasks"
    echo "  GET  /health      - Health check"
    echo ""
    echo "==========================================="
}

# ===========================================
# Main Entrypoint
# ===========================================
main() {
    log_info "Starting Claude Code Server..."

    # Source optional Supabase config (for JonasHub auth)
    if [ -f "$HOME/.claude/supabase.env" ]; then
        log_info "Loading Supabase configuration..."
        source "$HOME/.claude/supabase.env"
        log_success "Supabase configuration loaded"
    fi

    # Run setup steps
    setup_ssh
    setup_git
    setup_gh
    verify_claude

    print_status

    # Handle command argument
    case "${1:-api}" in
        api)
            log_info "Starting API server on port ${API_PORT:-3100}..."
            exec node /scripts/api-server.js
            ;;
        idle)
            log_info "Container running in idle mode. Use 'docker exec' to run commands."
            # Keep container running
            exec tail -f /dev/null
            ;;
        bash|sh)
            exec /bin/bash
            ;;
        claude)
            shift
            exec claude "$@"
            ;;
        task)
            shift
            exec /scripts/run-task.sh "$@"
            ;;
        *)
            # Run custom command
            exec "$@"
            ;;
    esac
}

main "$@"
