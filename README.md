# VSwriter

VSwriter is a writing environment built on the open-source [VSCodium](https://github.com/VSCodium/vscodium) editor. It keeps the writer in charge of the draft: readings sit beside the page, the tool asks questions before anything is written, and every suggested change waits for the writer to accept or deny it.

This repository is a prototype. It accompanies an essay for POLISCI 3390F (The Politics of Artificial Intelligence) and is still changing.

- **Status:** VSwriter Studio extension v0.3.0, macOS only.
- **What is here:** the extension (`extensions/writer-studio`), the settings and branding that turn VSCodium into VSwriter (`writer-product.json`, `patches/user/writer-ide.patch`), and a macOS installer (`install-macos.sh`).
- **What is not here yet:** a prebuilt, branded VSwriter app. The installer below runs the extension inside stock VSCodium with VSwriter's settings.

## What it does

- **Interview workflow.** Sets up the files for an interview-first draft: the tool asks one question at a time, the writer answers in their own words, and the draft is assembled from those answers.
- **Readings beside the draft.** Opens course readings and PDFs in a split pane, with a built-in PDF reader.
- **Reading bookmarks.** Marks passages in the readings that match what the writer said in the interview.
- **Paragraph skeletons, argument outline and paragraph lens.** Shows word, source and quotation counts above each paragraph.
- **Citation lookup.** Jumps from a citation in the draft to the passage in the reading.
- **Linter.** Flags markers of AI-sounding text as you type, with quick fixes.
- **Research browser.** Opens a browser beside the draft and captures web pages into the sources folder.
- **Straighten, Nudge and the reading companion.** Optional AI helpers. Each one proposes, and the writer accepts, denies or replies. Quotations a model proposes are checked word for word against the reading before the writer sees them.

## Install (macOS)

### What you need

- A Mac running a current version of macOS.
- [Homebrew](https://brew.sh), or VSCodium already installed in `/Applications`.
- An internet connection for the install.
- Optional, for the AI helpers only: the [Claude Code](https://claude.com/claude-code) command-line tool, signed in. The reading companion also uses a TypeSafe API key stored in the macOS Keychain under the name `TYPESAFE_API_KEY`. Everything else works without either.

### Option 1: one command

```sh
curl -fsSL https://raw.githubusercontent.com/mistakes5/writer-ide/vswriter/install-macos.sh | zsh
```

The script installs VSCodium if it is missing, installs the extension into its own folders so any existing VSCodium or VS Code setup is untouched, writes writer-first settings, and creates `~/Applications/VSwriter.command`. Double-click that file to open VSwriter.

Read the script first if you prefer: [`install-macos.sh`](install-macos.sh).

### Option 2: paste this into your coding agent

If you use Claude Code or another agent that can run terminal commands, paste this prompt:

```text
Set up VSwriter on this Mac. It is a writing environment built on VSCodium:
https://github.com/mistakes5/writer-ide (branch: vswriter).

1. Download install-macos.sh from that branch, read it, and tell me in two
   sentences what it will change on my machine before you run it.
2. Run it with zsh. If Homebrew is missing, stop and tell me how to install it.
3. Confirm the extension "writer-ide.writer-studio" shows up in the list the
   script prints at the end.
4. Ask me which folder holds my course readings (PDF, .md or .txt). Add that
   path to "writerStudio.readingsDirs" in
   ~/Library/Application Support/VSwriter/User/settings.json.
5. Ask me which folder my essay lives in, then open it with
   ~/Applications/VSwriter.command "<that folder>".
6. Tell me to press Cmd+Shift+P and run "VSwriter: Set Up Interview Files",
   and explain in plain language what the interview workflow will ask of me.

Do not change any other settings, and do not install anything else.
```

### First steps

1. Open VSwriter and open the folder your essay will live in.
2. Press `Cmd+Shift+P` and run **VSwriter: Set Up Interview Files**.
3. Add your readings folder under Settings, `writerStudio.readingsDirs`.
4. Open a reading beside the draft with **VSwriter: Open Reading Beside Draft** or **Open PDF Beside Draft**.

### Uninstall

```sh
rm -rf ~/.vswriter "$HOME/Library/Application Support/VSwriter" ~/Applications/VSwriter.command
brew uninstall --cask vscodium   # only if you do not use VSCodium for anything else
```

## Build the extension yourself

The extension has no runtime dependencies. With [Bun](https://bun.sh) installed:

```sh
cd extensions/writer-studio
bun build src/extension.ts --outfile dist/extension.js --target node --format cjs --external vscode
bunx @vscode/vsce package --no-dependencies --allow-missing-repository -o vswriter-studio.vsix
zsh ../../install-macos.sh vswriter-studio.vsix
```

## The branded app

`writer-product.json` and `patches/user/writer-ide.patch` rename VSCodium to VSwriter, set the writer-first defaults and replace the icons. Building the full app follows the upstream VSCodium instructions in [`docs/howto-build.md`](docs/howto-build.md). No prebuilt binary is published yet.

## Credits and licence

VSwriter is a fork of [VSCodium](https://github.com/VSCodium/vscodium), which builds on Microsoft's open-source VS Code. The PDF reader bundles Mozilla's [PDF.js](https://github.com/mozilla/pdf.js). Licences are in [`LICENSE`](LICENSE) and `extensions/writer-studio/media/vendor/`. The extension code was written with AI coding tools.
