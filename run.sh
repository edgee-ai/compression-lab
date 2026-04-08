#!/usr/bin/env bash
set -euo pipefail

# Usage check
if [[ $# -ne 2 ]] || [[ ! "$1" =~ ^(claude|codex)$ ]] || [[ ! "$2" =~ ^(normal|edgee|rtk)$ ]]; then
  echo "Usage: $0 <claude|codex> <normal|edgee|rtk>"
  exit 1
fi

AGENT="$1"
SCENARIO="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env
ENV_FILE="$SCRIPT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi
echo "[1/8] Loading .env..."
# shellcheck source=.env
source "$ENV_FILE"

# Generate random dir to put everything in
RANDOM_NAME="$(openssl rand -hex 4)"
SRC_DIR="$SCRIPT_DIR/cli"
DEST_DIR="$SCRIPT_DIR/_$AGENT-$SCENARIO-$RANDOM_NAME"
if [[ ! -d "$SRC_DIR" ]]; then
  echo "Error: Source directory $SRC_DIR not found"
  exit 1
fi

echo "[2/8] Creating destination directory $DEST_DIR"
mkdir -p "$DEST_DIR"

echo "[3/8] Copying cli/ -> $DEST_DIR/cli"
cp -r "$SRC_DIR" "$DEST_DIR/"
mkdir -p "$DEST_DIR/cli/.edgee"
cp "$SCRIPT_DIR/.edgee/credentials.toml" "$DEST_DIR/cli/.edgee/credentials.toml"

# cd into new directory
echo "[4/8] Changing into $DEST_DIR/cli"
cd "$DEST_DIR/cli"

# Agent/scenario config setup
if [[ "$AGENT" == "claude" ]]; then
  # Set isolated Claude config dir (used by claude sessions)
  echo "[5/8] Setting CLAUDE_CONFIG_DIR"
  CLAUDE_CONFIG_DIR="$DEST_DIR/.claude"
  mkdir -p "$CLAUDE_CONFIG_DIR"
  export CLAUDE_CONFIG_DIR

  # Copy claude-pro-usage.json
  echo "[6/8] Copying config/$AGENT-pro-usage.json -> $DEST_DIR/$AGENT-pro-usage.json"
  cp "$SCRIPT_DIR/config/$AGENT-pro-usage.json" "$DEST_DIR/$AGENT-pro-usage.json"
  
  if [[ "$SCENARIO" == "rtk" ]]; then
    echo "[7/8] Copying config/rtk/* -> $DEST_DIR/"
    cp "$SCRIPT_DIR/config/rtk/.claude/settings.json" "$CLAUDE_CONFIG_DIR/settings.json"
    sed -i '' "s|{SCRIPT_DIR}|${SCRIPT_DIR}|g" "$CLAUDE_CONFIG_DIR/settings.json"
    cp "$SCRIPT_DIR/config/rtk/.claude/RTK.md" "$CLAUDE_CONFIG_DIR/RTK.md"
    cp "$SCRIPT_DIR/config/rtk/CLAUDE.md" "$CLAUDE_CONFIG_DIR/CLAUDE.md"
  elif [[ "$SCENARIO" == "edgee" ]]; then
    echo "[7/8] Copying config/edgee/* -> $DEST_DIR/"
    cp "$SCRIPT_DIR/config/edgee/.claude/settings.json" "$CLAUDE_CONFIG_DIR/settings.json"
  else
    echo "[7/8] Copying config/normal/* -> $DEST_DIR/"
    cp "$SCRIPT_DIR/config/normal/.claude/settings.json" "$CLAUDE_CONFIG_DIR/settings.json"
  fi

  # Launch
  LOG_FILE="$DEST_DIR/session.log"
  echo "[8/8] Launching Claude (log: $LOG_FILE)..."
  claude plugin marketplace add https://github.com/anthropics/claude-plugins-official
  claude plugin install rust-analyzer-lsp@claude-plugins-official
  exec edgee -p $SCENARIO launch claude --dangerously-skip-permissions --debug --debug-file "$LOG_FILE"

else
  echo "[5/8] Setting up CODEX_HOME config for $AGENT/$SCENARIO"
  CODEX_HOME="$DEST_DIR/.codex"
  mkdir -p "$CODEX_HOME"
  export CODEX_HOME

  echo "[6/8] Copying config/codex/config.toml -> $CODEX_HOME/config.toml"
  touch "$CODEX_HOME/config.toml"
  
  echo "[7/8] Codex login"
  codex login
  
  echo "[8/8] Launching Codex..."
  exec edgee -p $SCENARIO launch codex --yolo 
fi
