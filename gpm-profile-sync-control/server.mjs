#!/usr/bin/env node
/** Local control panel for GPM Login profiles and mac-sync.mjs. Node 22+. */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(here, 'public');
const maxProfiles = 10;
const config = {
  gpmBase: process.env.GPM_API_BASE ?? 'http://127.0.0.1:9495/api/v1',
  macSyncPath: process.env.MAC_SYNC_PATH ?? join(here, '..', 'mac-sync.mjs'),
  tabUrlSyncPath: process.env.TAB_URL_SYNC_PATH ?? join(here, '..', 'tab-url-sync.mjs'),
  chromeUiSyncPath: process.env.CHROME_UI_SYNC_PATH ?? join(here, '..', 'chrome-ui-sync.m'),
  port: Number(process.env.SYNC_CONTROL_PORT ?? 8788),
};
const sessions = new Map(); // profile id -> { id, name, port, position, size, scale }
const logClients = new Set();
let syncProcess = null;
let uiMirrorProcess = null;
let tabUrlSyncProcess = null;

function writeJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('Request body is too large'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON body')); }
    });
    request.on('error', reject);
  });
}

function normaliseGpmBase(value) {
  const url = new URL(String(value));
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('GPM API must be a localhost URL');
  return url.href.replace(/\/$/, '');
}

function gpmUrl(path, params = {}) {
  const url = new URL(`${config.gpmBase}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function gpmGet(path, params) {
  let response;
  try { response = await fetch(gpmUrl(path, params)); } catch (error) {
    throw new Error(`Không kết nối được GPM Local API (${error.message})`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) throw new Error(payload.message || `GPM API returned HTTP ${response.status}`);
  return payload.data;
}

function layoutFor(count, display, verticalOrigin = 'top') {
  if (!Number.isInteger(count) || count < 1 || count > maxProfiles) throw new Error(`Hiện chỉ support tối đa ${maxProfiles} profile cùng lúc để mirror hiệu quả.`);
  const columns = count <= 8 ? 4 : 5;
  const width = Math.floor(display.width / columns);
  const height = Math.floor(display.height / 2);
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    return {
      x: display.left + (index % columns) * width,
      y: verticalOrigin === 'bottom' ? display.top + display.height - (row + 1) * height : display.top + row * height,
      width,
      height,
    };
  });
}

function validateDisplay(value) {
  const display = {
    left: Number(value?.left ?? 0), top: Number(value?.top ?? 0),
    width: Math.floor(Number(value?.width)), height: Math.floor(Number(value?.height)),
  };
  if (!Number.isFinite(display.left) || !Number.isFinite(display.top) || display.width < 400 || display.height < 300) {
    throw new Error('Không đọc được kích thước màn hình khả dụng. Hãy tải lại app rồi thử lại.');
  }
  return display;
}

function broadcastLog(line, kind = 'info') {
  const payload = `data: ${JSON.stringify({ line, kind, at: new Date().toLocaleTimeString() })}\n\n`;
  for (const client of logClients) client.write(payload);
}

function sessionView() {
  return [...sessions.values()];
}

function stopSync() {
  if (!syncProcess) return false;
  syncProcess.kill('SIGTERM');
  syncProcess = null;
  broadcastLog('Sync stopped.', 'info');
  return true;
}

function stopUiMirror() {
  if (!uiMirrorProcess) return false;
  uiMirrorProcess.kill('SIGTERM');
  uiMirrorProcess = null;
  broadcastLog('Chrome UI Sync stopped.', 'info');
  return true;
}

function stopTabUrlSync() {
  if (!tabUrlSyncProcess) return false;
  tabUrlSyncProcess.kill('SIGTERM');
  tabUrlSyncProcess = null;
  broadcastLog('Tab & URL Sync stopped.', 'info');
  return true;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with code ${code}`)));
  });
}

async function ensureUiMirrorBinary() {
  const source = config.chromeUiSyncPath;
  if (!existsSync(source)) throw new Error(`Không tìm thấy chrome-ui-sync.m: ${source}`);
  const buildDir = join(dirname(source), '.build');
  const binary = join(buildDir, 'chrome-ui-sync');
  const [sourceInfo, binaryInfo] = await Promise.all([stat(source), stat(binary).catch(() => null)]);
  if (!binaryInfo || binaryInfo.mtimeMs < sourceInfo.mtimeMs) {
    await mkdir(buildDir, { recursive: true });
    broadcastLog('Đang build Chrome UI Sync helper…', 'info');
    await runCommand('/usr/bin/xcrun', ['clang', '-fno-objc-arc', '-fmodules-cache-path=/private/tmp/gpm-sync-modules', '-framework', 'Cocoa', '-framework', 'ApplicationServices', source, '-o', binary]);
  }
  return binary;
}

async function startUiMirror(masterId, followerIds) {
  if (uiMirrorProcess) throw new Error('Chrome UI Sync đang chạy. Hãy dừng trước khi khởi động lại.');
  const master = sessions.get(masterId);
  const followers = followerIds.map((id) => sessions.get(id));
  if (!master) throw new Error('Master chưa được mở từ app này.');
  if (followers.length < 1 || followers.some((profile) => !profile)) throw new Error('Cần ít nhất một listener đã được mở từ app này.');
  const binary = await ensureUiMirrorBinary();
  const spec = (profile) => ({ id: profile.id, name: profile.name, x: profile.position.x, y: profile.position.y, width: profile.size.width, height: profile.size.height });
  const child = spawn(binary, ['--config', JSON.stringify({ master: spec(master), followers: followers.map(spec) })], { stdio: ['ignore', 'pipe', 'pipe'] });
  uiMirrorProcess = child;
  broadcastLog(`Chrome UI Sync started: ${master.name} → ${followers.map((profile) => profile.name).join(', ')}.`, 'success');
  child.stdout.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => broadcastLog(line)));
  child.stderr.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => broadcastLog(line, 'error')));
  child.once('exit', (code, signal) => {
    if (uiMirrorProcess === child) uiMirrorProcess = null;
    broadcastLog(`Chrome UI Sync exited (${signal || `code ${code}`}).`, code === 0 ? 'info' : 'error');
  });
}

function startSync(masterId, followerIds) {
  if (syncProcess) throw new Error('Sync đang chạy. Hãy dừng trước khi khởi động lại.');
  const master = sessions.get(masterId);
  const followers = followerIds.map((id) => sessions.get(id));
  if (!master) throw new Error('Master chưa được mở từ app này.');
  if (followers.length < 1 || followers.some((profile) => !profile)) throw new Error('Cần ít nhất một follower đã được mở từ app này.');
  if (!existsSync(config.macSyncPath)) throw new Error(`Không tìm thấy mac-sync.mjs: ${config.macSyncPath}`);

  const ports = followers.map((profile) => profile.port);
  const child = spawn(process.execPath, [config.macSyncPath, '--master', String(master.port), '--targets', ports.join(',')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  syncProcess = child;
  broadcastLog(`Sync started: master ${master.name} (${master.port}) → ${followers.map((p) => `${p.name} (${p.port})`).join(', ')}.`, 'success');
  child.stdout.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => broadcastLog(line)));
  child.stderr.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => broadcastLog(line, 'error')));
  child.once('exit', (code, signal) => {
    if (syncProcess === child) syncProcess = null;
    broadcastLog(`Sync exited (${signal || `code ${code}`}).`, code === 0 ? 'info' : 'error');
  });
}

function startTabUrlSync(masterId, followerIds) {
  if (tabUrlSyncProcess) throw new Error('Tab & URL Sync đang chạy. Hãy dừng trước khi khởi động lại.');
  const master = sessions.get(masterId);
  const followers = followerIds.map((id) => sessions.get(id));
  if (!master) throw new Error('Master chưa được mở từ app này.');
  if (followers.length < 1 || followers.some((profile) => !profile)) throw new Error('Cần ít nhất một follower đã được mở từ app này.');
  if (!existsSync(config.tabUrlSyncPath)) throw new Error(`Không tìm thấy tab-url-sync.mjs: ${config.tabUrlSyncPath}`);

  const ports = followers.map((profile) => profile.port);
  const child = spawn(process.execPath, [config.tabUrlSyncPath, '--master', String(master.port), '--targets', ports.join(',')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tabUrlSyncProcess = child;
  broadcastLog(`Tab & URL Sync started: ${master.name} (${master.port}) → ${followers.map((profile) => `${profile.name} (${profile.port})`).join(', ')}.`, 'success');
  child.stdout.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => broadcastLog(line)));
  child.stderr.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => broadcastLog(line, 'error')));
  child.once('exit', (code, signal) => {
    if (tabUrlSyncProcess === child) tabUrlSyncProcess = null;
    broadcastLog(`Tab & URL Sync exited (${signal || `code ${code}`}).`, code === 0 ? 'info' : 'error');
  });
}

async function listProfiles(search) {
  const profiles = [];
  let page = 1;
  while (true) {
    const result = await gpmGet('/profiles', { page, page_size: 100, search, sort: 2 });
    const items = Array.isArray(result) ? result : result?.data ?? [];
    profiles.push(...items);
    const lastPage = Number(result?.last_page ?? 1);
    if (page >= lastPage) break;
    page += 1;
  }
  return profiles.map((profile) => ({ id: profile.id, name: profile.name || profile.id, groupId: profile.group_id ?? null }));
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/status') {
    return writeJson(response, 200, { config, sessions: sessionView(), syncRunning: Boolean(syncProcess), uiMirrorRunning: Boolean(uiMirrorProcess), tabUrlSyncRunning: Boolean(tabUrlSyncProcess), maxProfiles });
  }
  if (request.method === 'GET' && url.pathname === '/api/profiles') {
    const profiles = await listProfiles(url.searchParams.get('search') ?? '');
    return writeJson(response, 200, { profiles, sessions: sessionView() });
  }
  if (request.method === 'GET' && url.pathname === '/api/logs') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(': connected\n\n');
    logClients.add(response);
    request.on('close', () => logClients.delete(response));
    return;
  }
  if (request.method !== 'POST') return writeJson(response, 405, { error: 'Method not allowed' });
  const body = await readBody(request);
  if (url.pathname === '/api/config') {
    config.gpmBase = normaliseGpmBase(body.gpmBase ?? config.gpmBase);
    if (body.macSyncPath) config.macSyncPath = String(body.macSyncPath);
    return writeJson(response, 200, { config });
  }
  if (url.pathname === '/api/start') {
    const ids = [...new Set(body.profileIds ?? [])];
    if (!ids.length) throw new Error('Hãy chọn ít nhất một profile.');
    const display = validateDisplay(body.display);
    const scale = Number(body.windowScale);
    if (!Number.isFinite(scale) || scale <= 0 || scale > 2) throw new Error('Window scale không hợp lệ.');
    const verticalOrigin = body.verticalOrigin === 'bottom' ? 'bottom' : 'top';
    const layout = layoutFor(ids.length, display, verticalOrigin);
    const opened = [];
    for (const [index, id] of ids.entries()) {
      if (sessions.has(id)) { opened.push(sessions.get(id)); continue; }
      const position = layout[index];
      const result = await gpmGet(`/profiles/start/${encodeURIComponent(id)}`, {
        remote_debugging_port: 0,
        window_scale: scale,
        window_pos: `${position.x},${position.y}`,
        window_size: `${position.width},${position.height}`,
      });
      const port = Number(result?.remote_debugging_port);
      if (!Number.isInteger(port) || port < 1) throw new Error(`GPM không trả remote_debugging_port cho profile ${id}.`);
      const record = { id, name: result?.addition_info?.profile_name || id, port, position, size: { width: position.width, height: position.height }, scale };
      sessions.set(id, record);
      opened.push(record);
      broadcastLog(`Started ${record.name} on CDP port ${port}.`, 'success');
    }
    return writeJson(response, 200, { sessions: opened, layout });
  }
  if (url.pathname === '/api/close') {
    const ids = [...new Set(body.profileIds ?? [])];
    if (!ids.length) throw new Error('Hãy chọn profile cần đóng.');
    if (ids.some((id) => sessions.has(id))) { stopSync(); stopUiMirror(); stopTabUrlSync(); }
    const closed = [];
    for (const id of ids) {
      if (!sessions.has(id)) continue;
      await gpmGet(`/profiles/stop/${encodeURIComponent(id)}`);
      const profile = sessions.get(id);
      sessions.delete(id);
      closed.push(id);
      broadcastLog(`Closed ${profile.name}.`, 'info');
    }
    return writeJson(response, 200, { closed, sessions: sessionView() });
  }
  if (url.pathname === '/api/sync') {
    const selected = [...new Set(body.profileIds ?? [])];
    const masterId = body.masterId;
    if (!selected.includes(masterId)) throw new Error('Chọn một profile đã chọn làm master.');
    startSync(masterId, selected.filter((id) => id !== masterId));
    return writeJson(response, 200, { syncRunning: true });
  }
  if (url.pathname === '/api/stop-sync') {
    return writeJson(response, 200, { stopped: stopSync() });
  }
  if (url.pathname === '/api/start-ui-mirror') {
    const selected = [...new Set(body.profileIds ?? [])];
    const masterId = body.masterId;
    if (!selected.includes(masterId)) throw new Error('Chọn một profile đã chọn làm Master.');
    await startUiMirror(masterId, selected.filter((id) => id !== masterId));
    return writeJson(response, 200, { uiMirrorRunning: true });
  }
  if (url.pathname === '/api/stop-ui-mirror') {
    return writeJson(response, 200, { stopped: stopUiMirror() });
  }
  if (url.pathname === '/api/start-tab-url-sync') {
    const selected = [...new Set(body.profileIds ?? [])];
    const masterId = body.masterId;
    if (!selected.includes(masterId)) throw new Error('Chọn một profile đã chọn làm Master.');
    startTabUrlSync(masterId, selected.filter((id) => id !== masterId));
    return writeJson(response, 200, { tabUrlSyncRunning: true });
  }
  if (url.pathname === '/api/stop-tab-url-sync') {
    return writeJson(response, 200, { stopped: stopTabUrlSync() });
  }
  return writeJson(response, 404, { error: 'Not found' });
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
async function serveStatic(response, pathname) {
  const safePath = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([.][.][/\\])+/, '');
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || !(await stat(filePath)).isFile()) return writeJson(response, 404, { error: 'Not found' });
  response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    return await serveStatic(response, url.pathname);
  } catch (error) {
    return writeJson(response, 400, { error: error.message || 'Unexpected error' });
  }
});

server.listen(config.port, '127.0.0.1', () => console.log(`GPM Profile Sync Control: http://127.0.0.1:${config.port}`));
process.on('SIGINT', () => { stopSync(); stopUiMirror(); stopTabUrlSync(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { stopSync(); stopUiMirror(); stopTabUrlSync(); server.close(() => process.exit(0)); });
