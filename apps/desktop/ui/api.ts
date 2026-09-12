// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 api.ts                                                            │
// │  Module: navigator.web.api                                            │
// │  Role: Browser-safe Navigator API adapter boundary.                   │
// │                                                                      │
// │  模块职责：浏览器安全的 Navigator API 适配器边界                       │
// └─────────────────────────────────────────────────────────────────────┘

export interface NavigatorApi {
  baseUrl: string;
  probe(): Promise<{ available: boolean; detail: string }>;
}

function normaliseBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function createNavigatorApi(baseUrl = window.location.origin): NavigatorApi {
  const normalisedBaseUrl = normaliseBaseUrl(baseUrl);

  return {
    baseUrl: normalisedBaseUrl,
    async probe(): Promise<{ available: boolean; detail: string }> {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 1500);
      try {
        const response = await fetch(`${normalisedBaseUrl}/openapi.json`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        return response.ok
          ? { available: true, detail: `Navigator API connected at ${normalisedBaseUrl}.` }
          : { available: false, detail: `Navigator API returned HTTP ${response.status}.` };
      } catch {
        return {
          available: false,
          detail: 'WebUI is ready. Start the Navigator persistence API to connect this browser.',
        };
      } finally {
        window.clearTimeout(timeout);
      }
    },
  };
}
