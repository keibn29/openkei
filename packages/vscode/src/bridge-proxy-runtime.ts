import type { BridgeContext, BridgeResponse } from './bridge';
import { waitForApiUrl } from './opencode-ready';

/**
 * Windows-only: VS Code normalizes workspace paths to forward slashes, but OpenCode
 * on Windows stores session directories with backslashes. For GET session requests
 * with a `directory` query param containing forward slashes, also try the backslash
 * form and merge deduplicated JSON array results.
 *
 * Only activates for the exact `/session` endpoint (not `/session/:id/...`).
 * `URLSearchParams.get()` already decodes the value, so no manual decoding needed.
 * Returns clean JSON headers (no stale upstream content-* headers) on merge.
 *
 * Returns a BridgeResponse if handled, or null to fall through to normal fetch.
 */
async function tryWindowsSessionDirectoryMerge(
  normalizedPath: string,
  normalizedMethod: string,
  requestHeaders: Record<string, string>,
  base: string,
  id: string,
  type: string,
): Promise<BridgeResponse | null> {
  if (
    process.platform !== 'win32' ||
    normalizedMethod !== 'GET'
  ) {
    return null;
  }

  // Exact match: `/session` or `/session?...` only — not `/session/:id/...`
  const isExactSession =
    normalizedPath === '/session' || normalizedPath.startsWith('/session?');
  if (!isExactSession) return null;

  const queryStart = normalizedPath.indexOf('?');
  if (queryStart === -1) return null;

  const basePath = normalizedPath.slice(0, queryStart);
  const params = new URLSearchParams(normalizedPath.slice(queryStart + 1));
  const dirValue = params.get('directory');
  if (!dirValue || !dirValue.includes('/')) return null;

  // URLSearchParams.get() returns decoded form; replace slashes in-place.
  // URLSearchParams.set() takes raw value; toString() will re-encode.
  const backslashDir = dirValue.replace(/\//g, '\\');
  if (backslashDir === dirValue) return null;

  params.set('directory', backslashDir);
  const altQuery = params.toString();
  const altPath = altQuery ? `${basePath}?${altQuery}` : basePath;
  const altUrl = new URL(altPath.replace(/^\/+/, ''), base).toString();
  const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();

  try {
    const [primaryRes, altRes] = await Promise.all([
      fetch(targetUrl, { method: 'GET', headers: requestHeaders }).catch(() => null),
      fetch(altUrl, { method: 'GET', headers: requestHeaders }).catch(() => null),
    ]);

    if (!primaryRes?.ok && !altRes?.ok) return null;

    const parseJson = async (res: Response | null) => {
      if (!res?.ok) return null;
      try {
        const buf = await res.arrayBuffer();
        return JSON.parse(Buffer.from(buf).toString('utf8'));
      } catch { return null; }
    };

    const [primaryData, altData] = await Promise.all([
      parseJson(primaryRes),
      parseJson(altRes),
    ]);

    if (!Array.isArray(primaryData) && !Array.isArray(altData)) return null;

    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const arr of [primaryData, altData]) {
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const sid = item?.id;
          if (typeof sid === 'string' && !seen.has(sid)) {
            seen.add(sid);
            merged.push(item);
          }
        }
      }
    }

    const status = primaryRes?.ok ? primaryRes.status : (altRes?.status ?? 200);

    return {
      id, type, success: true,
      data: {
        status,
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(JSON.stringify(merged)).toString('base64'),
      },
    };
  } catch {
    return null;
  }
}

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ApiProxyRequestPayload = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

type ApiSessionMessageRequestPayload = {
  path?: string;
  headers?: Record<string, string>;
  bodyText?: string;
};

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

type ProxyRuntimeDeps = {
  tryHandleLocalFsProxy: (method: string, requestPath: string) => Promise<ApiProxyResponsePayload | null>;
  buildUnavailableApiResponse: () => ApiProxyResponsePayload;
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => Record<string, string>;
  collectHeaders: (headers: Headers) => Record<string, string>;
  base64EncodeUtf8: (text: string) => string;
};

export async function handleProxyBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ProxyRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:proxy': {
      const { method, path: requestPath, headers, bodyBase64 } = (payload || {}) as ApiProxyRequestPayload;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
            : `/${requestPath.trim()}`
          : '/';

      const localFsResponse = await deps.tryHandleLocalFsProxy(normalizedMethod, normalizedPath);
      if (localFsResponse) {
        return { id, type, success: true, data: localFsResponse };
      }

      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };

      if (normalizedPath === '/event' || normalizedPath === '/global/event') {
        if (!requestHeaders.Accept) {
          requestHeaders.Accept = 'text/event-stream';
        }
        requestHeaders['Cache-Control'] = requestHeaders['Cache-Control'] || 'no-cache';
        requestHeaders.Connection = requestHeaders.Connection || 'keep-alive';
      }

      // Windows: try alternate directory path form for session GET queries
      const windowsMerged = await tryWindowsSessionDirectoryMerge(
        normalizedPath, normalizedMethod, requestHeaders, base, id, type
      );
      if (windowsMerged) return windowsMerged;

      try {
        const response = await fetch(targetUrl, {
          method: normalizedMethod,
          headers: requestHeaders,
          body:
            typeof bodyBase64 === 'string' && bodyBase64.length > 0 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
              ? Buffer.from(bodyBase64, 'base64')
              : undefined,
        });

        const arrayBuffer = await response.arrayBuffer();
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
          bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
        };

        return { id, type, success: true, data };
      } catch (error) {
        const body = JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to reach OpenCode API',
        });
        const data: ApiProxyResponsePayload = {
          status: 502,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }
    }

    case 'api:session:message': {
      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const { path: requestPath, headers, bodyText } = (payload || {}) as ApiSessionMessageRequestPayload;
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
            : `/${requestPath.trim()}`
          : '/';

      if (!/^\/session\/[^/]+\/message(?:\?.*)?$/.test(normalizedPath)) {
        const body = JSON.stringify({ error: 'Invalid session message proxy path' });
        const data: ApiProxyResponsePayload = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };

      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: typeof bodyText === 'string' ? bodyText : '',
          signal: AbortSignal.timeout(45000),
        });

        const arrayBuffer = await response.arrayBuffer();
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
          bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
        };

        return { id, type, success: true, data };
      } catch (error) {
        const isTimeout =
          error instanceof Error &&
          ((error as Error & { name?: string }).name === 'TimeoutError' ||
            (error as Error & { name?: string }).name === 'AbortError');
        const body = JSON.stringify({
          error: isTimeout ? 'OpenCode message forward timed out' : error instanceof Error ? error.message : 'OpenCode message forward failed',
        });
        const data: ApiProxyResponsePayload = {
          status: isTimeout ? 504 : 503,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }
    }

    default:
      return null;
  }
}
