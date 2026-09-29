const state = { profiles: [], sessions: new Map(), selected: new Set(), masterId: null, config: null, syncRunning: false, uiMirrorRunning: false };
const $ = (selector) => document.querySelector(selector);
const display = () => ({ left: screen.availLeft ?? 0, top: screen.availTop ?? 0, width: screen.availWidth, height: screen.availHeight });

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Yêu cầu không thành công.');
  return data;
}
function selectedIds() { return [...state.selected]; }
function notice(message) { $('#noticeText').textContent = message; $('#notice').showModal(); }
function withBusy(button, task) { return async () => { button.disabled = true; try { await task(); } catch (error) { notice(error.message); } finally { button.disabled = false; } }; }
function layout() { const count = state.selected.size; const columns = count <= 8 ? 4 : 5; return { count, columns, width: Math.floor(display().width / columns), height: Math.floor(display().height / 2) }; }
function updateDisplay() { const d = display(); $('#displayInfo').textContent = `Màn hình khả dụng: ${d.width} × ${d.height}px`; }
function renderLayout() {
  const { count, columns, width, height } = layout(); const preview = $('#layoutPreview'); preview.classList.toggle('ten', columns === 5); preview.replaceChildren();
  for (let i = 0; i < columns * 2; i += 1) { const cell = document.createElement('div'); cell.className = `layout-tile ${i >= count ? 'empty' : ''}`; cell.textContent = i < count ? String(i + 1) : ''; preview.append(cell); }
  $('#layoutText').textContent = count ? `${columns} cột × 2 hàng · mỗi profile ${width} × ${height}px` : 'Chọn profile để xem bố cục.';
}
function renderProfiles() {
  const list = $('#profileList'); list.replaceChildren(); const query = $('#search').value.trim().toLowerCase();
  const items = state.profiles.filter((profile) => !query || profile.name.toLowerCase().includes(query) || profile.id.toLowerCase().includes(query));
  for (const profile of items) {
    const active = state.sessions.get(profile.id); const row = document.createElement('div'); row.className = `profile-row ${state.selected.has(profile.id) ? 'selected' : ''}`; row.tabIndex = 0; row.setAttribute('role', 'checkbox'); row.setAttribute('aria-checked', String(state.selected.has(profile.id)));
    const mark = document.createElement('span'); mark.className = 'selection-mark'; mark.textContent = '✓';
    const changeSelection = (selected) => {
      if (selected && !state.selected.has(profile.id) && state.selected.size >= 10) { notice('Hiện chỉ support tối đa 10 profile cùng lúc để mirror hiệu quả.'); return; }
      selected ? state.selected.add(profile.id) : state.selected.delete(profile.id);
      if (state.masterId === profile.id && !selected) state.masterId = null;
      renderProfiles(); renderLayout();
    };
    row.addEventListener('click', (event) => {
      if (event.target.closest('.master-cell')) return;
      changeSelection(!state.selected.has(profile.id));
    });
    row.addEventListener('keydown', (event) => { if (event.target.closest('.master-cell')) return; if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); changeSelection(!state.selected.has(profile.id)); } });
    const text = document.createElement('span'); text.innerHTML = `<span class="profile-name">${escapeHtml(profile.name)}</span><span class="profile-id">${escapeHtml(profile.id)}</span>`;
    const masterCell = document.createElement('label'); masterCell.className = 'master-cell'; masterCell.title = 'Chọn profile này làm Master';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'master'; radio.checked = state.masterId === profile.id; radio.setAttribute('aria-label', `Chọn ${profile.name} làm Master`);
    radio.addEventListener('change', () => { if (!state.selected.has(profile.id)) state.selected.add(profile.id); state.masterId = profile.id; renderProfiles(); renderLayout(); }); masterCell.append(radio);
    const meta = document.createElement('span'); meta.className = 'profile-meta';
    if (active) { const status = document.createElement('span'); status.className = 'profile-state'; status.textContent = `Open · ${active.port}`; meta.append(status); }
    row.append(mark, text, masterCell, meta); list.append(row);
  }
  $('#profileCount').textContent = `${items.length} profile`; $('#selectedCount').textContent = `${state.selected.size} đã chọn`; $('#selectAll').checked = Boolean(items.length) && items.every((profile) => state.selected.has(profile.id));
}
function escapeHtml(value) { const span = document.createElement('span'); span.textContent = value; return span.innerHTML; }
function setSyncStatus() { const status = $('#syncStatus'); status.classList.toggle('running', state.syncRunning); status.lastChild.textContent = state.syncRunning ? ' Sync running' : ' Sync stopped'; $('#syncButton').textContent = state.syncRunning ? 'Stop sync' : 'Sync'; }
function setUiMirrorStatus() { $('#uiMirrorButton').classList.toggle('active', state.uiMirrorRunning); $('#uiMirrorButton').textContent = state.uiMirrorRunning ? 'Stop Chrome UI Sync' : 'Sync Chrome UI'; }
async function loadStatus() { const data = await api('/api/status'); state.config = data.config; state.sessions = new Map(data.sessions.map((item) => [item.id, item])); state.syncRunning = data.syncRunning; state.uiMirrorRunning = data.uiMirrorRunning; $('#gpmBase').value = data.config.gpmBase; $('#macSyncPath').value = data.config.macSyncPath; setSyncStatus(); setUiMirrorStatus(); }
async function loadProfiles() { const data = await api(`/api/profiles?search=${encodeURIComponent('')}`); state.profiles = data.profiles; state.sessions = new Map(data.sessions.map((item) => [item.id, item])); renderProfiles(); renderLayout(); }
function appendLog(event) { const log = $('#log'); if (log.textContent === 'Waiting for sync…') log.textContent = ''; log.textContent += `[${event.at}] ${event.line}\n`; log.scrollTop = log.scrollHeight; }

$('#saveConfig').addEventListener('click', withBusy($('#saveConfig'), async () => { const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ gpmBase: $('#gpmBase').value, macSyncPath: $('#macSyncPath').value }) }); state.config = data.config; notice('Đã lưu cấu hình cho phiên chạy này.'); }));
$('#reloadProfiles').addEventListener('click', withBusy($('#reloadProfiles'), loadProfiles));
$('#search').addEventListener('input', renderProfiles);
$('#selectAll').addEventListener('change', (event) => { const visible = state.profiles.filter((profile) => !$('#search').value.trim() || profile.name.toLowerCase().includes($('#search').value.trim().toLowerCase())); const union = new Set([...state.selected, ...visible.map((profile) => profile.id)]); if (event.target.checked && union.size > 10) return notice('Hiện chỉ support tối đa 10 profile cùng lúc để mirror hiệu quả.'); visible.forEach((profile) => event.target.checked ? state.selected.add(profile.id) : state.selected.delete(profile.id)); if (!state.selected.has(state.masterId)) state.masterId = null; renderProfiles(); renderLayout(); });
$('#startButton').addEventListener('click', withBusy($('#startButton'), async () => { const ids = selectedIds(); const data = await api('/api/start', { method: 'POST', body: JSON.stringify({ profileIds: ids, windowScale: $('#windowScale').value, verticalOrigin: $('#verticalOrigin').value, display: display() }) }); state.sessions = new Map(data.sessions.map((item) => [item.id, item])); renderProfiles(); notice(`Đã mở ${data.sessions.length} profile.`); }));
$('#closeButton').addEventListener('click', withBusy($('#closeButton'), async () => { const data = await api('/api/close', { method: 'POST', body: JSON.stringify({ profileIds: selectedIds() }) }); state.sessions = new Map(data.sessions.map((item) => [item.id, item])); state.syncRunning = false; setSyncStatus(); renderProfiles(); }));
$('#syncButton').addEventListener('click', withBusy($('#syncButton'), async () => { if (state.syncRunning) { await api('/api/stop-sync', { method: 'POST', body: '{}' }); state.syncRunning = false; setSyncStatus(); return; } const ids = selectedIds(); if (ids.length < 2) throw new Error('Chọn ít nhất hai profile để Sync.'); if (!state.masterId) throw new Error('Chọn một profile làm Master.'); await api('/api/sync', { method: 'POST', body: JSON.stringify({ profileIds: ids, masterId: state.masterId }) }); state.syncRunning = true; setSyncStatus(); }));
$('#uiMirrorButton').addEventListener('click', withBusy($('#uiMirrorButton'), async () => { if (state.uiMirrorRunning) { await api('/api/stop-ui-mirror', { method: 'POST', body: '{}' }); state.uiMirrorRunning = false; setUiMirrorStatus(); return; } const ids = selectedIds(); if (ids.length < 2) throw new Error('Chọn ít nhất hai profile để Sync Chrome UI.'); if (!state.masterId) throw new Error('Chọn một profile làm Master.'); await api('/api/start-ui-mirror', { method: 'POST', body: JSON.stringify({ profileIds: ids, masterId: state.masterId }) }); state.uiMirrorRunning = true; setUiMirrorStatus(); }));
$('#noticeClose').addEventListener('click', () => $('#notice').close());
new EventSource('/api/logs').onmessage = (message) => appendLog(JSON.parse(message.data));
window.addEventListener('resize', () => { updateDisplay(); renderLayout(); });

updateDisplay(); Promise.all([loadStatus(), loadProfiles()]).catch((error) => notice(error.message));
setInterval(() => { loadStatus().catch(() => {}); }, 2000);
