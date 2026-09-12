// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 main.ts                                                           │
// │  Module: navigator.web.main                                           │
// │  Role: Browser-only WebUI entry point, independent from native hosts.  │
// │                                                                      │
// │  模块职责：仅浏览器 WebUI 入口，与 native host 解耦                    │
// └─────────────────────────────────────────────────────────────────────┘

import './style.css';
import { createNavigatorApi } from './api';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Navigator WebUI root is missing');

const apiUrl = new URLSearchParams(window.location.search).get('api') ?? window.location.origin;
const api = createNavigatorApi(apiUrl);

root.innerHTML = `
  <section class="shell-card">
    <div class="brand-mark" aria-hidden="true">C</div>
    <p class="eyebrow">CYRENE / NAVIGATOR WEB</p>
    <h1>Navigator is open in your browser</h1>
    <p class="status" id="status">Checking the Navigator API…</p>
    <p class="detail" id="detail">The UI is a standalone web package. Native clients use the same API boundary.</p>
    <div class="actions">
      <a id="api-link" href="#" target="_blank" rel="noreferrer">Open API documentation</a>
      <button id="retry" type="button">Check again</button>
    </div>
    <div class="progress" aria-hidden="true"><span></span></div>
  </section>
`;

const statusElement = document.querySelector<HTMLElement>('#status');
const detailElement = document.querySelector<HTMLElement>('#detail');
const apiLink = document.querySelector<HTMLAnchorElement>('#api-link');
const retryButton = document.querySelector<HTMLButtonElement>('#retry');

if (apiLink) apiLink.href = `${api.baseUrl}/docs`;

async function refresh(): Promise<void> {
  if (statusElement) statusElement.textContent = 'Checking the Navigator API…';
  const result = await api.probe();
  if (statusElement) statusElement.textContent = result.available ? 'Navigator API connected' : 'WebUI ready';
  if (detailElement) detailElement.textContent = result.detail;
}

retryButton?.addEventListener('click', () => void refresh());
void refresh();
