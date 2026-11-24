#!/bin/zsh
# VSwriter installer for macOS.
#
# What it does:
#   1. Installs VSCodium with Homebrew if it is not already in /Applications.
#   2. Installs the VSwriter Studio extension into its own folders, so an
#      existing VSCodium or VS Code setup is left alone.
#   3. Writes writer-first settings (only if none exist yet).
#   4. Creates ~/Applications/VSwriter.command, which opens VSwriter.
#
# Usage:
#   zsh install-macos.sh                 # downloads the latest released extension
#   zsh install-macos.sh path/to.vsix    # installs a local build of the extension
#
# Uninstall: see the README.

set -euo pipefail

REPO="mistakes5/writer-ide"
APP="/Applications/VSCodium.app"
BIN="$APP/Contents/Resources/app/bin/codium"
DATA="$HOME/Library/Application Support/VSwriter"
EXT="$HOME/.vswriter/extensions"
LAUNCHER="$HOME/Applications/VSwriter.command"

say() { print -- "==> $*"; }

[[ "$(uname -s)" == "Darwin" ]] || { print -- "VSwriter's installer supports macOS only."; exit 1; }

# 1. VSCodium
if [[ ! -x "$BIN" ]]; then
  if command -v brew >/dev/null 2>&1; then
    say "Installing VSCodium with Homebrew"
    brew install --cask vscodium
  else
    print -- "VSCodium is not installed and Homebrew was not found."
    print -- "Install Homebrew from https://brew.sh or VSCodium from https://vscodium.com, then run this again."
    exit 1
  fi
fi
[[ -x "$BIN" ]] || { print -- "VSCodium was not found at $APP after install."; exit 1; }

# 2. Extension
VSIX="${1:-}"
TMP=""
if [[ -z "$VSIX" ]]; then
  TMP="$(mktemp -d)"
  VSIX="$TMP/vswriter-studio.vsix"
  say "Downloading the VSwriter Studio extension"
  curl -fsSL -o "$VSIX" "https://github.com/$REPO/releases/latest/download/vswriter-studio.vsix"
fi
[[ -f "$VSIX" ]] || { print -- "Extension file not found: $VSIX"; exit 1; }

mkdir -p "$DATA/User" "$EXT" "$HOME/Applications"
say "Installing the extension"
"$BIN" --user-data-dir "$DATA" --extensions-dir "$EXT" --install-extension "$VSIX" --force
[[ -n "$TMP" ]] && rm -rf "$TMP"

# 3. Settings (never overwrite an existing file)
SETTINGS="$DATA/User/settings.json"
if [[ ! -f "$SETTINGS" ]]; then
  say "Writing writer-first settings"
  cat > "$SETTINGS" <<'JSON'
{
  "workbench.colorTheme": "VSwriter Paper",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.editor.empty.hint": "hidden",
  "breadcrumbs.enabled": false,
  "files.defaultLanguage": "markdown",
  "files.autoSave": "afterDelay",
  "editor.wordWrap": "on",
  "editor.lineNumbers": "off",
  "editor.glyphMargin": false,
  "editor.folding": false,
  "editor.minimap.enabled": false,
  "editor.stickyScroll.enabled": false,
  "editor.renderLineHighlight": "none",
  "editor.guides.indentation": false,
  "editor.occurrencesHighlight": "off",
  "editor.selectionHighlight": false,
  "editor.quickSuggestions": { "other": "off", "comments": "off", "strings": "off" },
  "editor.wordBasedSuggestions": "off",
  "editor.suggestOnTriggerCharacters": false,
  "editor.fontFamily": "\"Iowan Old Style\", Charter, Georgia, serif",
  "editor.fontSize": 17,
  "editor.lineHeight": 1.7,
  "editor.padding.top": 32,
  "editor.cursorBlinking": "smooth",
  "extensions.ignoreRecommendations": true,
  "chat.disableAIFeatures": true,
  "telemetry.telemetryLevel": "off",
  "writerStudio.readingsDirs": []
}
JSON
else
  say "Keeping your existing settings at $SETTINGS"
fi

# 4. Launcher
cat > "$LAUNCHER" <<EOF
#!/bin/zsh
exec open -n -a "$APP" --args --user-data-dir "$DATA" --extensions-dir "$EXT" "\$@"
EOF
chmod +x "$LAUNCHER"

say "Installed. Extensions in this profile:"
"$BIN" --user-data-dir "$DATA" --extensions-dir "$EXT" --list-extensions --show-versions || true

cat <<EOF

VSwriter is ready.
  Open it:      double-click $LAUNCHER
  First steps:  open a folder for your essay, then press Cmd+Shift+P and run
                "VSwriter: Set Up Interview Files".
  Readings:     put the folder that holds your readings in
                writerStudio.readingsDirs (Settings, search for "readings").
EOF
