# OpenKei

OpenKei is a VS Code extension for working with [OpenCode](https://opencode.ai) directly inside your editor.

![OpenKei VS Code Extension](packages/vscode/extension.jpg)

## What it does

- Chat beside your code inside VS Code
- Add files and selected code to the composer quickly
- Run Agent Manager workflows in a dedicated panel
- Open sessions in editor tabs
- Use OpenCode without leaving your workspace

## Install

### Marketplace

Search for **OpenKei** in the VS Code Extensions marketplace.

### Local VSIX

```bash
bun install
bun run vscode:build
cd packages/vscode && bunx vsce package --no-dependencies
code --install-extension openkei-*.vsix
```

## Requirements

- VS Code 1.85+
- [OpenCode CLI](https://opencode.ai) installed and available in PATH, or configured via `openkei.opencodeBinary`

## Development

Run the extension in an Extension Development Host:

```bash
bun install
bun run vscode:dev
```

Optional overrides:

```bash
OPENCHAMBER_VSCODE_BIN=cursor bun run vscode:dev
OPENCHAMBER_VSCODE_DEV_WORKSPACE=/path/to/workspace bun run vscode:dev
bun run vscode:dev /path/to/workspace
```

## Useful workflows

- Select code and press `Cmd+L` on macOS / `Ctrl+L` on Windows/Linux to insert a range mention into the chat composer
- Use the explorer context menu to attach files to chat
- Open the sidebar and start a new session without leaving the editor

## License

MIT
