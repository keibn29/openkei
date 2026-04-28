# OpenKei VS Code Extension

OpenKei brings [OpenCode](https://opencode.ai) into VS Code with a focused editor-native workflow.

![OpenKei VS Code Extension](./extension.jpg)

## Features

- Chat directly beside your code
- Open sessions in editor tabs
- Run Agent Manager comparisons in parallel
- Add selected code or files into the composer quickly
- Keep the extension UI aligned with your current VS Code workflow

## Commands

| Command | Description |
|---------|-------------|
| `OpenKei: Focus Chat` | Focus the chat panel |
| `OpenKei: New Session` | Start a new chat session |
| `OpenKei: Open Sidebar` | Open the OpenKei sidebar |
| `OpenKei: Open Agent Manager` | Launch parallel multi-model runs |
| `OpenKei: Open Session in Editor` | Open current or new session in an editor tab |
| `OpenKei: Settings` | Open extension settings |
| `OpenKei: Restart API Connection` | Restart the OpenCode API process |
| `OpenKei: Show OpenCode Status` | Show debug and runtime status info |

## Shortcuts

- `Cmd+L` on macOS / `Ctrl+L` on Windows/Linux: insert the current selection into the chat composer as a file-range mention

## Editor context menu

Select code in the editor, right-click, and use the **OpenKei** submenu:

- Add to Context
- Explain
- Improve Code

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `openkei.apiUrl` | _(empty)_ | URL of an external OpenCode API server. Leave empty to auto-start a local instance. |
| `openkei.opencodeBinary` | _(empty)_ | Absolute path to the `opencode` CLI binary if PATH lookup fails. |

## Requirements

- VS Code 1.85+
- [OpenCode CLI](https://opencode.ai) installed and available in PATH, or configured via `openkei.opencodeBinary`

## Development

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

To package locally:

```bash
bun run --cwd packages/vscode build
cd packages/vscode && bunx vsce package --no-dependencies
```

## License

MIT
