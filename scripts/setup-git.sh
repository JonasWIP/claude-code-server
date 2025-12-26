#!/bin/bash
# Git Setup Helper Script
# Run this inside the container to configure Git interactively

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo "==========================================="
echo "  Git Configuration Helper"
echo "==========================================="
echo ""

# Check current configuration
echo -e "${BLUE}Current Git Configuration:${NC}"
echo "  user.name:  $(git config --global user.name 2>/dev/null || echo 'Not set')"
echo "  user.email: $(git config --global user.email 2>/dev/null || echo 'Not set')"
echo ""

# Set user name if not already set
if [ -z "$(git config --global user.name)" ]; then
    if [ -n "$GIT_USER_NAME" ]; then
        git config --global user.name "$GIT_USER_NAME"
        echo -e "${GREEN}Set user.name from environment: $GIT_USER_NAME${NC}"
    else
        echo -n "Enter your Git username: "
        read -r username
        if [ -n "$username" ]; then
            git config --global user.name "$username"
            echo -e "${GREEN}Set user.name: $username${NC}"
        fi
    fi
fi

# Set user email if not already set
if [ -z "$(git config --global user.email)" ]; then
    if [ -n "$GIT_USER_EMAIL" ]; then
        git config --global user.email "$GIT_USER_EMAIL"
        echo -e "${GREEN}Set user.email from environment: $GIT_USER_EMAIL${NC}"
    else
        echo -n "Enter your Git email: "
        read -r email
        if [ -n "$email" ]; then
            git config --global user.email "$email"
            echo -e "${GREEN}Set user.email: $email${NC}"
        fi
    fi
fi

# Additional Git settings
echo ""
echo -e "${BLUE}Applying recommended Git settings...${NC}"

git config --global init.defaultBranch main
git config --global pull.rebase false
git config --global core.autocrlf input
git config --global core.editor vim
git config --global push.autoSetupRemote true
git config --global fetch.prune true

echo -e "${GREEN}Git configuration complete!${NC}"
echo ""

# Show final configuration
echo -e "${BLUE}Final Git Configuration:${NC}"
git config --global --list | grep -E "^user\.|^core\.|^init\.|^pull\.|^push\.|^fetch\." | sort

# Check SSH setup
echo ""
echo -e "${BLUE}SSH Key Status:${NC}"
if [ -f "$HOME/.ssh/id_ed25519" ]; then
    echo -e "  ${GREEN}ED25519 key found${NC}"
    ssh-keygen -lf "$HOME/.ssh/id_ed25519.pub" 2>/dev/null || true
elif [ -f "$HOME/.ssh/id_rsa" ]; then
    echo -e "  ${GREEN}RSA key found${NC}"
    ssh-keygen -lf "$HOME/.ssh/id_rsa.pub" 2>/dev/null || true
else
    echo -e "  ${YELLOW}No SSH keys found${NC}"
    echo ""
    echo "  To use SSH with GitHub, mount your SSH keys:"
    echo "  1. Copy your SSH keys to ./config/ssh/"
    echo "  2. Restart the container"
fi

# Check GitHub CLI
echo ""
echo -e "${BLUE}GitHub CLI Status:${NC}"
if command -v gh &> /dev/null; then
    if gh auth status &> /dev/null; then
        echo -e "  ${GREEN}GitHub CLI authenticated${NC}"
        gh auth status 2>&1 | head -3
    else
        echo -e "  ${YELLOW}GitHub CLI not authenticated${NC}"
        if [ -n "$GITHUB_TOKEN" ]; then
            echo "  Attempting to authenticate..."
            echo "$GITHUB_TOKEN" | gh auth login --with-token && \
                echo -e "  ${GREEN}Authentication successful${NC}" || \
                echo -e "  ${RED}Authentication failed${NC}"
        else
            echo "  Set GITHUB_TOKEN environment variable to authenticate"
        fi
    fi
else
    echo -e "  ${RED}GitHub CLI not installed${NC}"
fi

echo ""
echo "==========================================="
