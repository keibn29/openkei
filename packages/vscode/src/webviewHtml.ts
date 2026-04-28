import * as vscode from 'vscode';
import { getThemeKindName } from './theme';
import type { ConnectionStatus } from './opencode';

export type PanelType = 'chat' | 'agentManager';

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  workspaceFolder: string;
  initialStatus: ConnectionStatus;
  cliAvailable: boolean;
  panelType?: PanelType;
  initialSessionId?: string;
  viewMode?: 'sidebar' | 'editor';
  devServerUrl?: string | null;
}

const asCspToken = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toOrigin = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const uniqueTokens = (values: Array<string | null | undefined>): string => {
  return Array.from(new Set(values.map(asCspToken).filter((value): value is string => Boolean(value)))).join(' ');
};

export function getWebviewHtml(options: WebviewHtmlOptions): string {
  const {
    webview,
    extensionUri,
    workspaceFolder,
    initialStatus,
    cliAvailable,
    panelType = 'chat',
    initialSessionId,
    viewMode = 'sidebar',
    devServerUrl,
  } = options;

  const scriptPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.js');
  const scriptUri = webview.asWebviewUri(scriptPath);
  const appIconPath = vscode.Uri.joinPath(extensionUri, 'assets', 'app-icon.png');
  const appIconUri = webview.asWebviewUri(appIconPath);
  const normalizedDevServerUrl = asCspToken(devServerUrl)?.replace(/\/$/, '') ?? null;
  const devServerOrigin = toOrigin(normalizedDevServerUrl);
  const styleSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", devServerOrigin]);
  const scriptSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", "'unsafe-eval'", devServerOrigin]);
  const connectSrc = uniqueTokens(['*', 'ws:', 'wss:', 'http:', 'https:', devServerOrigin]);
  const imgSrc = uniqueTokens([webview.cspSource, 'data:', 'https:', devServerOrigin]);
  const fontSrc = uniqueTokens([webview.cspSource, 'data:', devServerOrigin]);

  const themeKind = getThemeKindName(vscode.window.activeColorTheme.kind);

  // Use VS Code CSS variables for proper theme integration
  // These variables are automatically provided by VS Code to webviews
  // 
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src ${scriptSrc}; connect-src ${connectSrc}; img-src ${imgSrc}; font-src ${fontSrc};">
  <style>
    html, body, #root { height: 100%; width: 100%; margin: 0; padding: 0; }
    body { 
      overflow: hidden; 
      background: var(--vscode-editor-background, var(--vscode-sideBar-background)); 
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      color: var(--vscode-foreground);
    }
    
    /* Initial loading screen styles - uses VS Code theme variables */
    #initial-loading {
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      z-index: 9999;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      transition: opacity 0.3s ease-out;
    }
    #initial-loading.fade-out {
      opacity: 0;
      pointer-events: none;
    }
    #initial-loading .brand-icon {
      width: 70px;
      height: 70px;
      object-fit: contain;
      border-radius: 18px;
    }
    #initial-loading .status-text {
      font-size: 13px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      text-align: center;
    }
    #initial-loading .error-text {
      font-size: 12px;
      color: var(--vscode-errorForeground, #f48771);
      text-align: center;
      max-width: 280px;
    }
  </style>
  <title>OpenKei</title>
</head>
<body>
  <!-- Initial loading screen with OpenKei icon -->
  <div id="initial-loading">
    <img class="brand-icon" src="${appIconUri}" alt="OpenKei logo" />
    <div class="status-text" id="loading-status">
      ${initialStatus === 'connecting' ? 'Starting OpenCode API…' : initialStatus === 'connected' ? 'Initializing…' : 'Connecting…'}
    </div>
    ${!cliAvailable ? `<div class="error-text">OpenCode CLI not found. Please install it first.</div>` : ''}
  </div>
  
  <div id="root"></div>
  <script>
    // Polyfill process for Node.js modules running in browser
    window.process = window.process || { env: { NODE_ENV: 'production' }, platform: '', version: '', browser: true };

    window.__VSCODE_CONFIG__ = {
      workspaceFolder: "${workspaceFolder.replace(/\\/g, '\\\\')}",
      theme: "${themeKind}",
      connectionStatus: "${initialStatus}",
      cliAvailable: ${cliAvailable},
      panelType: "${panelType}",
      viewMode: "${viewMode}",
      brandIcon: "${appIconUri}",
      initialSessionId: ${initialSessionId ? `"${initialSessionId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : 'null'},
    };
    window.__OPENCHAMBER_HOME__ = "${workspaceFolder.replace(/\\/g, '\\\\')}";
    
    // Handle connection status updates to update loading screen
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg && msg.type === 'connectionStatus') {
        var statusEl = document.getElementById('loading-status');
        if (statusEl) {
          if (msg.status === 'connecting') {
            statusEl.textContent = 'Starting OpenCode API…';
            statusEl.classList.remove('error-text');
          } else if (msg.status === 'connected') {
            statusEl.textContent = 'Connected!';
            statusEl.classList.remove('error-text');
          } else if (msg.status === 'error') {
            statusEl.textContent = msg.error || 'Connection error';
            statusEl.classList.add('error-text');
          } else {
            statusEl.textContent = 'Reconnecting…';
            statusEl.classList.remove('error-text');
          }
        }
      }
    });
  </script>
  <script type="module">
    const prodEntryUrl = ${JSON.stringify(scriptUri.toString())};
    const devServerUrl = ${normalizedDevServerUrl ? JSON.stringify(normalizedDevServerUrl) : 'null'};

    const loadProductionBundle = () => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = prodEntryUrl;
      document.body.appendChild(script);
    };

    if (!devServerUrl) {
      loadProductionBundle();
    } else {
      const baseUrl = devServerUrl;

      const statusEl = document.getElementById('loading-status');
      const setStatus = (text) => {
        if (statusEl) {
          statusEl.textContent = text;
        }
      };

      const retryDelayMs = 500;
      let attempt = 0;

      const waitForRootMount = (timeoutMs) => {
        const root = document.getElementById('root');
        if (!root) {
          return Promise.resolve(false);
        }

        if (root.childNodes.length > 0) {
          return Promise.resolve(true);
        }

        return new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (root.childNodes.length > 0) {
              observer.disconnect();
              clearTimeout(timer);
              resolve(true);
            }
          });

          observer.observe(root, { childList: true, subtree: true });
          const timer = window.setTimeout(() => {
            observer.disconnect();
            resolve(root.childNodes.length > 0);
          }, timeoutMs);
        });
      };

      const tryLoadDevBundle = () => {
        const viteClientUrl = baseUrl + '/@vite/client';
        const reactRefreshUrl = baseUrl + '/@react-refresh';
        const devEntryUrl = baseUrl + '/main.tsx';
        const hostLabel = (() => {
          try {
            return new URL(baseUrl).host;
          } catch {
            return baseUrl;
          }
        })();

        setStatus('Starting webview dev server (' + hostLabel + ')...');

        Promise.resolve()
          .then(() => import(viteClientUrl))
          .then(() => import(reactRefreshUrl))
          .then((mod) => {
            const runtime = mod && mod.default ? mod.default : null;
            if (runtime && typeof runtime.injectIntoGlobalHook === 'function') {
              runtime.injectIntoGlobalHook(window);
              window.$RefreshReg$ = () => {};
              window.$RefreshSig$ = () => (type) => type;
              window.__vite_plugin_react_preamble_installed__ = true;
            }
          })
          .then(() => import(devEntryUrl))
          .then(() => waitForRootMount(4000))
          .then((mounted) => {
            if (!mounted) {
              throw new Error('Dev bundle loaded but app did not mount');
            }
          })
          .catch((error) => {
            attempt += 1;
            console.warn('[OpenKei] VS Code webview dev bundle unavailable, retrying...', error);
            setStatus('Waiting for webview dev server (' + hostLabel + ')... attempt ' + attempt);
            window.setTimeout(() => {
              tryLoadDevBundle();
            }, retryDelayMs);
          });
      };

      tryLoadDevBundle();
    }
  </script>
</body>
</html>`;
}
