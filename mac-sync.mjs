#!/usr/bin/env node
/**
 * Mac-local, focus-free profile synchronizer for GPM Login profiles opened
 * with a Chrome remote-debugging port.
 *
 * Default test topology:
 *   G007 (39207) = master
 *   G008 (39208), G009 (39209) = followers
 *
 * No packages are required: Node 22+ includes fetch and WebSocket.
 */

const DEFAULTS = {
  master: 39207,
  targets: [39208, 39209],
};

function usage() {
  console.log(`
Usage:
  node mac-sync.mjs [--master PORT] [--targets PORT,PORT]

Examples:
  node mac-sync.mjs
  node mac-sync.mjs --master 39207 --targets 39208,39209

The master browser must be open. Each follower receives input in whichever
tab is currently visible. Press Ctrl+C to stop; it does not close any GPM profile.
`);
}

function parseArgs(argv) {
  const config = { ...DEFAULTS, targets: [...DEFAULTS.targets] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--master') {
      config.master = Number(argv[++i]);
      continue;
    }
    if (arg === '--targets') {
      config.targets = String(argv[++i] ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(config.master) || config.master < 1) {
    throw new Error('--master must be a valid TCP port');
  }
  if (!config.targets.length || config.targets.some((port) => !Number.isInteger(port) || port < 1)) {
    throw new Error('--targets must contain one or more valid TCP ports');
  }
  if (config.targets.includes(config.master)) {
    throw new Error('The master port cannot also be a follower port');
  }
  return config;
}

class CdpClient {
  constructor(name, websocketUrl) {
    this.name = name;
    this.websocketUrl = websocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.websocketUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.name}: CDP connection timed out`)), 5_000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.name}: cannot connect to CDP`));
      }, { once: true });
      ws.addEventListener('message', (event) => this.#onMessage(event));
      ws.addEventListener('close', () => this.#onClose());
    });
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${this.name}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {});
  }

  #onClose() {
    for (const { reject } of this.pending.values()) reject(new Error(`${this.name}: CDP connection closed`));
    this.pending.clear();
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${this.name}: CDP is not connected`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* best effort */ }
  }
}

async function getPageEndpoints(port) {
  const base = `http://127.0.0.1:${port}`;
  let response;
  try {
    response = await fetch(`${base}/json/list`);
  } catch (error) {
    throw new Error(`Port ${port} is unreachable: ${error.message}`);
  }
  if (!response.ok) throw new Error(`Port ${port} returned HTTP ${response.status}`);
  return (await response.json()).filter(
    (item) => item.type === 'page' && !item.url.startsWith('devtools://') && item.webSocketDebuggerUrl,
  ).map((page) => ({ port, url: page.url, websocketUrl: page.webSocketDebuggerUrl }));
}

async function getPageEndpoint(port) {
  const pages = await getPageEndpoints(port);
  // A GPM browser can have multiple tabs. Select the tab that Chrome reports
  // as visible (the same "current tab" concept used by GPM Sync Action), not
  // merely the first target returned by /json/list.
  const inspected = await Promise.all(pages.map(async (candidate) => {
    const probe = new CdpClient(`probe:${port}`, candidate.websocketUrl);
    try {
      await probe.connect();
      const state = await evaluate(probe, '() => ({ visibility: document.visibilityState, focused: document.hasFocus() })', null);
      return { candidate, score: state?.visibility === 'visible' ? (state.focused ? 2 : 1) : 0 };
    } catch {
      return { candidate, score: -1 };
    } finally {
      probe.close();
    }
  }));
  const page = inspected.sort((a, b) => b.score - a.score)[0]?.candidate;
  if (!page?.websocketUrl) throw new Error(`Port ${port} has no controllable page target`);
  return page;
}

async function evaluate(client, functionSource, argument) {
  const expression = `(${functionSource})(${JSON.stringify(argument)})`;
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(`${client.name}: page evaluation failed`);
  return result.result?.value;
}

class VisibleFollower {
  constructor(port) {
    this.port = port;
    this.client = null;
    this.websocketUrl = null;
    this.resolvedAt = 0;
  }

  async refresh() {
    // A short cache prevents high-frequency wheel/drag events from piling up
    // behind repeated CDP tab probes. A human tab switch still resolves before
    // the next normal interaction.
    if (this.client && Date.now() - this.resolvedAt < 100) return;
    const endpoint = await getPageEndpoint(this.port);
    this.resolvedAt = Date.now();
    if (this.client && endpoint.websocketUrl === this.websocketUrl) return;
    this.client?.close();
    this.client = new CdpClient(`follower:${this.port}`, endpoint.websocketUrl);
    await this.client.connect();
    this.websocketUrl = endpoint.websocketUrl;
  }

  async apply(event) {
    await this.refresh();
    return applyEvent(this.client, event);
  }

  close() { this.client?.close(); }
}

const masterListener = String.raw`
() => {
  const listenerVersion = 4;
  if (window.__gpmMacSyncListenerVersion === listenerVersion) return 'already-installed';
  window.__gpmMacSyncListenerVersion = listenerVersion;

  const q = (value) => CSS.escape(String(value));
  function selectorFor(element) {
    if (!(element instanceof Element)) return null;
    if (element.id) return '#' + q(element.id);
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label']) {
      const value = element.getAttribute(attr);
      if (value && document.querySelectorAll('[' + attr + '="' + q(value) + '"]').length === 1) {
        return '[' + attr + '="' + q(value) + '"]';
      }
    }
    const path = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const siblings = Array.from(node.parentElement?.children || []).filter((s) => s.tagName === node.tagName);
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      path.unshift(part);
      const candidate = path.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      node = node.parentElement;
    }
    return path.join(' > ');
  }
  function emit(event) {
    // Each master tab has this listener so it survives tab changes, but only
    // the tab Chrome currently presents to the operator may control followers.
    if (document.visibilityState !== 'visible') return;
    try { window.gpmMacSyncEmit(JSON.stringify({ ...event, href: location.href, listenerVersion })); } catch (_) {}
  }
  function editable(element) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element?.isContentEditable;
  }
  const pendingInputs = new WeakMap();
  function flushInput(element) {
    const entry = pendingInputs.get(element);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingInputs.delete(element);
    emit({ type: 'set-value', selector: selectorFor(element), value: entry.value, tag: element.tagName.toLowerCase() });
  }
  function modifiers(event) {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  }
  function mousePayload(event, action) {
    return {
      type: 'mouse', action, x: event.clientX, y: event.clientY,
      button: event.button, buttons: event.buttons,
      clickCount: event.detail || 1, modifiers: modifiers(event),
    };
  }
  let pendingMove = null;
  let moveTimer = null;
  function flushMove() {
    if (!pendingMove) return;
    emit(pendingMove);
    pendingMove = null;
    clearTimeout(moveTimer);
    moveTimer = null;
  }
  document.addEventListener('mousemove', (event) => {
    // Hover movement has no page action. Keep drag movement, but coalesce it
    // so it cannot delay the corresponding mouse-up behind a long queue.
    if (!event.buttons) return;
    pendingMove = mousePayload(event, 'move');
    if (!moveTimer) moveTimer = setTimeout(flushMove, 16);
  }, true);
  document.addEventListener('mousedown', (event) => {
    flushMove();
    emit(mousePayload(event, 'down'));
  }, true);
  document.addEventListener('mouseup', (event) => {
    flushMove();
    emit(mousePayload(event, 'up'));
  }, true);
  document.addEventListener('input', (event) => {
    const element = event.target;
    if (!editable(element)) return;
    const value = element.isContentEditable ? element.textContent : element.value;
    const previous = pendingInputs.get(element);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => flushInput(element), 250);
    pendingInputs.set(element, { value, timer });
  }, true);
  document.addEventListener('change', (event) => {
    const element = event.target;
    if (!editable(element)) return;
    const hadPendingInput = pendingInputs.has(element);
    flushInput(element);
    if (hadPendingInput) return;
    const value = element.isContentEditable ? element.textContent : element.value;
    emit({ type: 'set-value', selector: selectorFor(element), value, tag: element.tagName.toLowerCase() });
  }, true);
  document.addEventListener('keydown', (event) => {
    const text = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? event.key : '';
    emit({ type: 'key', action: 'down', key: event.key, code: event.code, text, modifiers: modifiers(event), repeat: event.repeat });
  }, true);
  document.addEventListener('keyup', (event) => {
    emit({ type: 'key', action: 'up', key: event.key, code: event.code, modifiers: modifiers(event) });
  }, true);
  window.addEventListener('wheel', (event) => {
    emit({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY, clientX: event.clientX, clientY: event.clientY, modifiers: modifiers(event) });
  }, { capture: true, passive: true });
  return 'installed';
}`;

async function applyMouse(client, event) {
  const type = event.action === 'down' ? 'mousePressed' : event.action === 'up' ? 'mouseReleased' : 'mouseMoved';
  const button = event.action === 'move' ? 'none' : (['left', 'middle', 'right', 'back', 'forward'][event.button] ?? 'none');
  await client.call('Input.dispatchMouseEvent', {
    type, x: event.x, y: event.y, button,
    buttons: event.buttons, clickCount: event.clickCount,
    modifiers: event.modifiers,
  });
  return { ok: true };
}

async function applyValue(client, event) {
  return evaluate(client, String.raw`(payload) => {
    const element = document.querySelector(payload.selector);
    if (!element) return { ok: false, reason: 'selector-not-found' };
    element.focus();
    const value = payload.value ?? '';
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(
        element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        'value'
      );
      descriptor?.set?.call(element, value);
    } else if (element instanceof HTMLSelectElement) {
      element.value = value;
    } else if (element.isContentEditable) {
      element.textContent = value;
    } else {
      return { ok: false, reason: 'element-not-editable' };
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }`, event);
}

async function applyWheel(client, event) {
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: event.clientX ?? 100,
    y: event.clientY ?? 100,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
  });
  return { ok: true };
}

async function applyKey(client, event) {
  const base = { key: event.key, code: event.code, modifiers: event.modifiers, autoRepeat: event.repeat };
  if (event.action === 'up') {
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return { ok: true };
  }
  await client.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (event.text) await client.call('Input.dispatchKeyEvent', { type: 'char', ...base, text: event.text, unmodifiedText: event.text });
  return { ok: true };
}

async function applyEvent(client, event) {
  if (event.type === 'mouse') return applyMouse(client, event);
  if (event.type === 'set-value') return applyValue(client, event);
  if (event.type === 'key') return applyKey(client, event);
  if (event.type === 'wheel') return applyWheel(client, event);
  return { ok: false, reason: `unsupported-event:${event.type}` };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const masterEndpoint = await getPageEndpoint(config.master);
  const master = new CdpClient(`master:${config.master}`, masterEndpoint.websocketUrl);
  const targets = config.targets.map((port) => new VisibleFollower(port));

  await Promise.all([master.connect(), ...targets.map((target) => target.refresh())]);

  // Node's built-in WebSocket client does not always keep the event loop alive.
  // Keep this agent resident until the operator explicitly stops it.
  const keepAlive = setInterval(() => {}, 60_000);
  let eventChain = Promise.resolve();
  const queueEvent = (event) => {
    eventChain = eventChain.then(async () => {
      const label = event.type === 'set-value' ? `${event.type}(${String(event.value ?? '').length} chars)` : event.type === 'mouse' ? `mouse:${event.action}` : event.type;
      const results = await Promise.allSettled(targets.map((target) => target.apply(event)));
      const report = results.map((result, index) => {
        if (result.status === 'rejected') return `${config.targets[index]}:error`;
        return `${config.targets[index]}:${result.value.ok ? 'ok' : result.value.reason}`;
      });
      console.log(`[${new Date().toLocaleTimeString()}] ${label} → ${report.join(', ')}`);
    }).catch((error) => console.error(`Sync error: ${error.message}`));
  };

  const masterSessions = new Map();
  const installMaster = async (client) => {
    await client.call('Runtime.enable');
    await client.call('Page.enable');
    await client.call('Runtime.addBinding', { name: 'gpmMacSyncEmit' });
    await client.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${masterListener})()` });
    await evaluate(client, masterListener, null);
    client.on('Runtime.bindingCalled', (message) => {
      if (message.name !== 'gpmMacSyncEmit') return;
      let event;
      try { event = JSON.parse(message.payload); } catch { return; }
      // Ignore callbacks left by older listener versions in a page that was
      // already open when this process restarted.
      if (event.listenerVersion !== 4) return;
      queueEvent(event);
    });
  };
  await installMaster(master);
  masterSessions.set(masterEndpoint.websocketUrl, master);

  console.log(`Mac Sync ready. Master=${config.master}; followers=${config.targets.join(',')}; URL matching is disabled.`);
  console.log(`Visible master page: ${masterEndpoint.url}`);
  console.log('Listeners are installed in every master tab. Ctrl+C stops sync.');

  let polling = false;
  const tabMonitor = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const pages = await getPageEndpoints(config.master);
      for (const endpoint of pages) {
        if (masterSessions.has(endpoint.websocketUrl)) continue;
        const client = new CdpClient(`master:${config.master}`, endpoint.websocketUrl);
        await client.connect();
        await installMaster(client);
        masterSessions.set(endpoint.websocketUrl, client);
      }
      // URLs and tab switches remain local. This monitor only installs the
      // input listener on master tabs opened after the script starts.
    } catch { /* retain existing sessions; a later poll can recover */ }
    polling = false;
  }, 500);

  const shutdown = () => {
    console.log('\nStopping Mac Sync. GPM profiles stay open.');
    clearInterval(keepAlive);
    clearInterval(tabMonitor);
    masterSessions.forEach((client) => client.close());
    targets.forEach((target) => target.close());
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`Mac Sync could not start: ${error.message}`);
  process.exit(1);
});
