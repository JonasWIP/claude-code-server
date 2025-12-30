#!/bin/bash
set -e

# Claude Code Task Runner
# Clones/updates a repository and runs Claude Code with a specific task

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

WORKSPACE="/home/claude/workspace"
LOG_DIR="/home/claude/workspace/.logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# ===========================================
# Usage Information
# ===========================================
usage() {
    cat << EOF
Claude Code Task Runner

USAGE:
    $(basename "$0") [OPTIONS]

OPTIONS:
    -r, --repo URL          Git repository URL (required)
    -t, --task TASK         Task description for Claude Code (required)
    -b, --branch BRANCH     Branch name to checkout/create (default: main)
    -p, --path PATH         Subdirectory to work in (optional)
    -c, --create-branch     Create new branch if it doesn't exist
    -m, --model MODEL       Claude model to use (optional)
    -d, --dry-run           Show what would be done without executing
    -v, --verbose           Enable verbose output
    -h, --help              Show this help message

EXAMPLES:
    # Clone repo and run task on main branch
    $(basename "$0") --repo git@github.com:user/repo.git \\
                     --task "Fix the login bug in auth.js"

    # Create a new feature branch
    $(basename "$0") --repo git@github.com:user/repo.git \\
                     --task "Implement user dashboard" \\
                     --branch feature/dashboard \\
                     --create-branch

    # Work in a specific subdirectory
    $(basename "$0") --repo git@github.com:user/repo.git \\
                     --task "Update API documentation" \\
                     --path docs/api

ENVIRONMENT:
    ANTHROPIC_API_KEY       Required for Claude Code
    GITHUB_TOKEN            Optional, for private repos with HTTPS
    GIT_USER_NAME           Git commit author name
    GIT_USER_EMAIL          Git commit author email

EOF
    exit 0
}

# ===========================================
# Logging Functions
# ===========================================
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
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

log_task() {
    echo -e "${CYAN}[TASK]${NC} $1"
}

# ===========================================
# Parse Arguments
# ===========================================
REPO_URL=""
TASK=""
BRANCH="main"
SUBPATH=""
CREATE_BRANCH=false
MODEL=""
DRY_RUN=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--repo)
            REPO_URL="$2"
            shift 2
            ;;
        -t|--task)
            TASK="$2"
            shift 2
            ;;
        -b|--branch)
            BRANCH="$2"
            shift 2
            ;;
        -p|--path)
            SUBPATH="$2"
            shift 2
            ;;
        -c|--create-branch)
            CREATE_BRANCH=true
            shift
            ;;
        -m|--model)
            MODEL="$2"
            shift 2
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# ===========================================
# Validate Arguments
# ===========================================
if [ -z "$REPO_URL" ]; then
    log_error "Repository URL is required (--repo)"
    exit 1
fi

if [ -z "$TASK" ]; then
    log_error "Task description is required (--task)"
    exit 1
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then
    log_error "ANTHROPIC_API_KEY environment variable is not set"
    exit 1
fi

# ===========================================
# Extract Repository Name
# ===========================================
get_repo_name() {
    local url="$1"
    # Handle both SSH and HTTPS URLs
    basename "$url" .git | tr '[:upper:]' '[:lower:]'
}

REPO_NAME=$(get_repo_name "$REPO_URL")
REPO_DIR="$WORKSPACE/$REPO_NAME"

# ===========================================
# Setup Logging
# ===========================================
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${REPO_NAME}_${TIMESTAMP}.log"

# Tee output to both console and log file
exec > >(tee -a "$LOG_FILE") 2>&1

# ===========================================
# Main Task Execution
# ===========================================
main() {
    echo ""
    echo "==========================================="
    echo "  Claude Code Task Runner"
    echo "  $(date)"
    echo "==========================================="
    echo ""
    echo "Configuration:"
    echo "  Repository: $REPO_URL"
    echo "  Branch:     $BRANCH"
    echo "  Task:       $TASK"
    [ -n "$SUBPATH" ] && echo "  Subpath:    $SUBPATH"
    [ -n "$MODEL" ] && echo "  Model:      $MODEL"
    echo "  Log file:   $LOG_FILE"
    echo ""

    if [ "$DRY_RUN" = true ]; then
        log_warn "DRY RUN MODE - No changes will be made"
        echo ""
    fi

    # Step 1: Clone or update repository
    log_info "Step 1: Preparing repository..."

    if [ -d "$REPO_DIR/.git" ]; then
        log_info "Repository exists, updating..."

        if [ "$DRY_RUN" = false ]; then
            cd "$REPO_DIR"
            git fetch --all --prune

            # Check for uncommitted changes
            if ! git diff-index --quiet HEAD -- 2>/dev/null; then
                log_warn "Uncommitted changes detected, stashing..."
                git stash push -m "Auto-stash before task: $TIMESTAMP"
            fi
        fi

        log_success "Repository updated"
    else
        log_info "Cloning repository..."

        if [ "$DRY_RUN" = false ]; then
            git clone "$REPO_URL" "$REPO_DIR"
            cd "$REPO_DIR"
        fi

        log_success "Repository cloned to $REPO_DIR"
    fi

    # Step 2: Checkout branch
    log_info "Step 2: Checking out branch '$BRANCH'..."

    if [ "$DRY_RUN" = false ]; then
        cd "$REPO_DIR"

        if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
            # Branch exists locally
            git checkout "$BRANCH"
            git pull origin "$BRANCH" 2>/dev/null || true
            log_success "Checked out existing branch: $BRANCH"
        elif git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
            # Branch exists on remote
            git checkout -b "$BRANCH" "origin/$BRANCH"
            log_success "Checked out remote branch: $BRANCH"
        elif [ "$CREATE_BRANCH" = true ]; then
            # Create new branch
            git checkout -b "$BRANCH"
            log_success "Created new branch: $BRANCH"
        else
            log_error "Branch '$BRANCH' does not exist. Use --create-branch to create it."
            exit 1
        fi
    fi

    # Step 3: Navigate to subpath if specified
    WORK_DIR="$REPO_DIR"
    if [ -n "$SUBPATH" ]; then
        WORK_DIR="$REPO_DIR/$SUBPATH"
        if [ ! -d "$WORK_DIR" ]; then
            log_error "Subpath '$SUBPATH' does not exist in repository"
            exit 1
        fi
        log_info "Working directory: $WORK_DIR"
    fi

    # Step 4: Run Claude Code
    log_info "Step 3: Starting Claude Code..."
    log_task "Task: $TASK"
    echo ""
    echo "-------------------------------------------"
    echo ""

    if [ "$DRY_RUN" = false ]; then
        cd "$WORK_DIR"

        # Build Claude command
        CLAUDE_CMD="claude"
        if [ -n "$MODEL" ]; then
            CLAUDE_CMD="$CLAUDE_CMD --model $MODEL"
        fi

        # Run Claude with the task as a prompt and capture output
        # Using --print to output the conversation
        CLAUDE_OUTPUT=$(echo "$TASK" | $CLAUDE_CMD --print 2>&1)
        CLAUDE_EXIT_CODE=$?

        echo "$CLAUDE_OUTPUT"
        echo ""
        echo "-------------------------------------------"
        echo ""

        # Check for quota exhaustion in output
        if echo "$CLAUDE_OUTPUT" | grep -qi -E "(credit|quota|billing|exceeded|insufficient|rate.limit)"; then
            log_error "QUOTA EXHAUSTED: Anthropic API credits may be depleted"
            log_error "Please check your Anthropic account billing and add credits"
            exit 100  # Special exit code for quota exhaustion
        fi

        if [ $CLAUDE_EXIT_CODE -eq 0 ]; then
            log_success "Claude Code task completed successfully"
        else
            log_error "Claude Code exited with code: $CLAUDE_EXIT_CODE"
        fi
    else
        log_info "[DRY RUN] Would run: claude in $WORK_DIR"
        log_info "[DRY RUN] With task: $TASK"
        CLAUDE_EXIT_CODE=0
    fi

    # Step 5: Summary
    echo ""
    echo "==========================================="
    echo "  Task Summary"
    echo "==========================================="
    echo ""
    echo "  Repository: $REPO_NAME"
    echo "  Branch:     $BRANCH"
    echo "  Exit Code:  $CLAUDE_EXIT_CODE"
    echo "  Log File:   $LOG_FILE"
    echo ""

    # Show git status
    if [ "$DRY_RUN" = false ]; then
        cd "$REPO_DIR"
        if ! git diff-index --quiet HEAD -- 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then
            log_info "Changes made by Claude:"
            git status --short
            echo ""
            log_info "To commit changes:"
            echo "  cd $REPO_DIR && git add -A && git commit -m 'Your message'"
            echo ""
            log_info "To push changes:"
            echo "  cd $REPO_DIR && git push origin $BRANCH"
        else
            log_info "No changes were made to the repository"
        fi
    fi

    echo "==========================================="
    exit $CLAUDE_EXIT_CODE
}

main
