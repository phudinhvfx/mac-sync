#!/usr/bin/env node
/**
 * Mirrors the selected Chrome tab and committed URL from one GPM profile to
 * follower profiles through their remote-debugging ports. Unlike the AX
 * Chrome UI helper, this never moves focus or sends OS-level input.
 *
 * It deliberately syncs an omnibox URL only after Chrome commits navigation
 * (for example, when the operator presses Enter). Live omnibox text is not
 * exposed through CDP and remains out of scope.
 */

function usage() {
  console.log(`Usage: node tab-url-sync.mjs --master PORT --targets PORT,PORT`);
}

function parseArgs(argv) {
  const config = { master: null, targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    if (arg === '--master') { config.master = Number(argv[++index]); continue; }
    if (arg === '--targets') {
      config.targets = String(argv[++index] ?? '').split(',').filter(Boolean).map(Number);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(config.master) || config.master < 1) throw new Error('--master must be a valid TCP port');
  if (!config.targets.length || config.targets.some((port) => !Number.isInteger(port) || port < 1)) throw new Error('--targets must contain one or more valid TCP ports');
  if (config.targets.includes(config.master)) throw new Error('The master port cannot also be a follower port');
  return config;
}

class CdpClient {
  constructor(name, websocketUrl) {
    this.name = name;
    this.websocketUrl = websocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.websocketUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.name}: CDP connection timed out`)), 5_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${this.name}: cannot connect to CDP`)); }, { once: true });
      ws.addEventListener('message', (event) => this.#onMessage(event));
      ws.addEventListener('close', () => this.#onClose());
    });
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`${this.name}: ${message.error.message}`));
    else pending.resolve(message.result ?? {});
  }

  #onClose() {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(`${this.name}: CDP connection closed`)); }
    this.pending.clear();
  }

  call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${this.name}: CDP is not connected`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} timed out`));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws?.close(); } catch { /* best effort */ } }
}

async function fetchJson(port, path) {
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}${path}`); } catch (error) { throw new Error(`Port ${port} is unreachable: ${error.message}`); }
  if (!response.ok) throw new Error(`Port ${port} returned HTTP ${response.status}`);
  return response.json();
}

async function getPages(port) {
  const entries = await fetchJson(port, '/json/list');
  return entries.filter((entry) => entry.type === 'page' && !entry.url.startsWith('devtools://') && entry.id && entry.webSocketDebuggerUrl)
    .map((entry) => ({ id: entry.id, url: entry.url, websocketUrl: entry.webSocketDebuggerUrl }));
}

async function getBrowserWebSocket(port) {
  const version = await fetchJson(port, '/json/version');
  if (!version.webSocketDebuggerUrl) throw new Error(`Port ${port} has no browser CDP endpoint`);
  return version.webSocketDebuggerUrl;
}

async function activePage(pages, port) {
  const inspected = await Promise.all(pages.map(async (page) => {
    const probe = new CdpClient(`probe:${port}`, page.websocketUrl);
    try {
      await probe.connect();
      const result = await probe.call('Runtime.evaluate', { expression: '({ visibility: document.visibilityState, focused: document.hasFocus() })', returnByValue: true });
      const state = result.result?.value;
      return { page, score: state?.visibility === 'visible' ? (state.focused ? 2 : 1) : 0 };
    } catch { return { page, score: -1 }; } finally { probe.close(); }
  }));
  return inspected.sort((left, right) => right.score - left.score)[0]?.page;
}

function canNavigate(url) {
  try {
    return new Set(['http:', 'https:', 'file:', 'chrome-extension:']).has(new URL(url).protocol);
  } catch { return false; }
}

class Follower {
  constructor(port) {
    this.port = port;
    this.browser = null;
    this.browserWebSocket = null;
    this.tabMap = new Map(); // master target id -> follower target id
  }

  async connect() {
    const websocketUrl = await getBrowserWebSocket(this.port);
    if (this.browser && this.browserWebSocket === websocketUrl) return;
    this.browser?.close();
    this.browser = new CdpClient(`follower:${this.port}:browser`, websocketUrl);
    await this.browser.connect();
    this.browserWebSocket = websocketUrl;
  }

  reconcile(masterPages, followerPages) {
    const masterIds = new Set(masterPages.map((page) => page.id));
    const followerIds = new Set(followerPages.map((page) => page.id));
    const next = new Map();
    const usedFollowers = new Set();
    for (const [masterId, followerId] of this.tabMap) {
      if (masterIds.has(masterId) && followerIds.has(followerId)) { next.set(masterId, followerId); usedFollowers.add(followerId); }
    }
    const followerById = new Map(followerPages.map((page) => [page.id, page]));
    const unpairedFollowers = () => followerPages.filter((page) => !usedFollowers.has(page.id));
    for (const master of masterPages.filter((page) => !next.has(page.id))) {
      // Match the same URL first. This keeps the logical tab pairing stable
      // after a URL changes in a tab already mapped above.
      const match = unpairedFollowers().find((follower) => follower.url === master.url) ?? unpairedFollowers()[0];
      if (!match) continue;
      next.set(master.id, match.id);
      usedFollowers.add(match.id);
    }
    this.tabMap = next;
    return followerById;
  }

  async sync(masterPages, masterActive) {
    await this.connect();
    const pages = await getPages(this.port);
    const pagesById = this.reconcile(masterPages, pages);
    const followerId = this.tabMap.get(masterActive.id);
    const followerPage = pagesById.get(followerId);
    if (!followerPage) return { ok: false, reason: 'no-matching-tab' };

    await this.browser.call('Target.activateTarget', { targetId: followerPage.id });
    if (followerPage.url === masterActive.url) return { ok: true, action: 'selected' };
    if (!canNavigate(masterActive.url)) return { ok: true, action: 'selected; URL skipped (unsupported scheme)' };

    const pageClient = new CdpClient(`follower:${this.port}:tab`, followerPage.websocketUrl);
    try {
      await pageClient.connect();
      await pageClient.call('Page.navigate', { url: masterActive.url });
      return { ok: true, action: 'selected + navigated' };
    } finally { pageClient.close(); }
  }

  close() { this.browser?.close(); }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const followers = config.targets.map((port) => new Follower(port));
  await Promise.all(followers.map((follower) => follower.connect()));

  console.log(`Tab & URL Sync ready. Master=${config.master}; followers=${config.targets.join(', ')}.`);
  console.log('Mirrors active tab and committed URL only; omnibox text before Enter is intentionally not synced.');

  let previous = null;
  let lastAttempt = null;
  let retryPending = false;
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const masterPages = await getPages(config.master);
      const masterActive = await activePage(masterPages, config.master);
      if (!masterActive) return;
      const sourceChanged = previous?.id !== masterActive.id || previous?.url !== masterActive.url;
      if (!sourceChanged && !retryPending) return;
      const sameAsLastAttempt = lastAttempt?.id === masterActive.id && lastAttempt.url === masterActive.url;
      if (sameAsLastAttempt && Date.now() - lastAttempt.at < 1_000) return;
      const kind = previous?.id === masterActive.id ? 'URL committed' : 'Tab selected';
      lastAttempt = { id: masterActive.id, url: masterActive.url, at: Date.now() };
      const results = await Promise.allSettled(followers.map((follower) => follower.sync(masterPages, masterActive)));
      const report = results.map((result, index) => result.status === 'fulfilled'
        ? `${config.targets[index]}:${result.value.ok ? result.value.action : result.value.reason}`
        : `${config.targets[index]}:error`).join(', ');
      console.log(`[${new Date().toLocaleTimeString()}] ${kind} (${masterActive.url}) → ${report}`);
      if (results.every((result) => result.status === 'fulfilled' && result.value.ok)) {
        previous = { id: masterActive.id, url: masterActive.url };
        retryPending = false;
      } else retryPending = true;
    } catch (error) {
      console.error(`Tab & URL Sync error: ${error.message}`);
    } finally { polling = false; }
  };

  await poll();
  const timer = setInterval(poll, 300);
  const shutdown = () => {
    clearInterval(timer);
    followers.forEach((follower) => follower.close());
    console.log('Tab & URL Sync stopped. GPM profiles stay open.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`Tab & URL Sync could not start: ${error.message}`);
  process.exit(1);
});
