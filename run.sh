#!/usr/bin/env bash
set -euo pipefail

# Usage check
if [[ $# -ne 1 ]] || [[ ! "$1" =~ ^(normal|edgee|rtk)$ ]]; then
  echo "Usage: $0 <normal|edgee|rtk>"
  exit 1
fi

SESSION="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env
ENV_FILE="$SCRIPT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi
echo "[1/9] Loading .env..."
# shellcheck source=.env
source "$ENV_FILE"

# Select token
echo "[2/9] Selecting token for session: $SESSION"
case "$SESSION" in
  normal)   TOKEN="${EDGEE_API_TOKEN_NORMAL}" ;;
  edgee)    TOKEN="${EDGEE_API_TOKEN_EDGEE}" ;;
  rtk)      TOKEN="${EDGEE_API_TOKEN_RTK}" ;;
esac

if [[ -z "${TOKEN:-}" ]]; then
  echo "Error: Token for session '$SESSION' is empty. Check your .env file."
  exit 1
fi

# Generate random dir to put everything in
RANDOM_NAME="$(openssl rand -hex 4)"
SRC_DIR="$SCRIPT_DIR/cli"
DEST_DIR="$SCRIPT_DIR/_$SESSION-$RANDOM_NAME"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Error: Source directory $SRC_DIR not found"
  exit 1
fi

echo "[3/9] Creating destination directory $DEST_DIR"
mkdir -p "$DEST_DIR"

# Set isolated Claude config dir
CLAUDE_CONFIG_DIR="$DEST_DIR/.claude"
echo "[4/9] Setting CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Export env vars
export ANTHROPIC_BASE_URL="https://api.edgee.ai"
export ANTHROPIC_CUSTOM_HEADERS="x-edgee-api-key:${TOKEN}"
export CLAUDE_CONFIG_DIR

echo "      ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
echo "      ANTHROPIC_CUSTOM_HEADERS=x-edgee-api-key:***"

echo "[5/9] Copying cli/ -> $DEST_DIR/cli"
cp -r "$SRC_DIR" "$DEST_DIR/"

# Copy claude-pro-usage.json
echo "[6/9] Copying claude-pro-usage.json -> $DEST_DIR/config/claude-pro-usage.json"
cp "$SCRIPT_DIR/config/claude-pro-usage.json" "$DEST_DIR/claude-pro-usage.json"

# cd into new directory
echo "[7/9] Changing into $DEST_DIR"
cd "$DEST_DIR/cli"

# Claude config setup
if [[ "$SESSION" == "rtk" ]]; then
  echo "[8/9] Copying config/rtk/* -> $DEST_DIR/"
  cp "$SCRIPT_DIR/config/rtk/.claude/settings.json" "$CLAUDE_CONFIG_DIR/settings.json"
  sed -i '' "s|{SCRIPT_DIR}|${SCRIPT_DIR}|g" "$CLAUDE_CONFIG_DIR/settings.json"
  cp "$SCRIPT_DIR/config/rtk/.claude/RTK.md" "$CLAUDE_CONFIG_DIR/RTK.md"
  cp "$SCRIPT_DIR/config/rtk/CLAUDE.md" "$CLAUDE_CONFIG_DIR/CLAUDE.md"
elif [[ "$SESSION" == "edgee" ]]; then
  echo "[8/9] Copying config/edgee/* -> $DEST_DIR/"
  cp "$SCRIPT_DIR/config/edgee/.claude/settings.json" "$CLAUDE_CONFIG_DIR/settings.json"
else
  echo "[8/9] Copying config/normal/* -> $DEST_DIR/"
  cp "$SCRIPT_DIR/config/normal/.claude/settings.json" "$CLAUDE_CONFIG_DIR/settings.json"
fi

# Launch Claude
LOG_FILE="$DEST_DIR/claude.log"
echo "[9/9] Launching Claude (log: $LOG_FILE)..."
claude plugin marketplace add https://github.com/anthropics/claude-plugins-official
claude plugin install rust-analyzer-lsp@claude-plugins-official
exec claude --dangerously-skip-permissions --debug --debug-file "$LOG_FILE"
