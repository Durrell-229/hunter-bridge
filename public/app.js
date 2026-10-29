let state = null;
let token = sessionStorage.getItem('hunter-admin-token') || '';
let currentTab = 'overview';
let eventSource = null;
let toastTimer = null;
let mcpEditing = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const fmt = (value) => new Intl.NumberFormat('fr-FR').format(Number(value) || 0);
const fmtMs = (value) => (value == null ? '—' : `${fmt(Math.round(value))} ms`);
const fmtDate = (value) => (value ? new Date(value).toLocaleTimeString('fr-FR') : '—');
const fmtUptime = (seconds) => {
  const s = Number(seconds) || 0;
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};

function showToast(message, kind = '') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${kind}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  let payload = null;
  const text = await res.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (res.status === 401) {
    showLogin();
    throw new Error('Jeton administrateur requis');
  }
  if (!res.ok) {
    throw new Error(payload?.error?.message || payload?.message || `HTTP ${res.status}`);
  }
  return payload;
}

function showLogin() {
  $('#login-modal').hidden = false;
  setTimeout(() => $('#login-token')?.focus(), 30);
}

async function loadState() {
  try {
    const next = await api('/api/admin/state');
    state = next;
    $('#login-modal').hidden = true;
    renderHeader();
    renderTab(currentTab, true);
    connectEvents();
  } catch (error) {
    if (!String(error.message).includes('Jeton')) showToast(error.message, 'error');
  }
}

function connectEvents() {
  if (eventSource) eventSource.close();
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  eventSource = new EventSource(`/api/events${query}`);
  eventSource.onmessage = (event) => {
    try {
      const next = JSON.parse(event.data);
      if (next?.providers) applyState(next);
    } catch {
      // ignore
    }
  };
  eventSource.onerror = () => {
    $('#service-state').textContent = 'hors ligne';
    $('#service-state').className = 'pill bad';
  };
}

function applyState(next) {
  state = next;
  renderHeader();
  if (currentTab === 'overview') renderOverview();
  if (currentTab === 'logs') renderLogs();
}

function renderHeader() {
  if (!state) return;
  $('#subtitle').textContent = `v${state.version} · ${state.providers.length} fournisseurs · ${fmtUptime(state.uptimeSeconds)}`;
  const ready = state.providers.filter((provider) => provider.status.state === 'ready').length;
  const configured = state.providers.filter((provider) => provider.keyConfigured).length;
  const el = $('#service-state');
  el.textContent = `${ready}/${configured} prêts`;
  el.className = `pill ${ready ? 'ok' : configured ? 'warn' : 'bad'}`;

  const select = $('#active-profile');
  select.innerHTML = Object.entries(state.routing.profiles || {})
    .map(([id, profile]) => `<option value="${esc(id)}">${esc(profile.label || id)}</option>`)
    .join('');
  select.value = state.activeProfile;
  const routingActive = $('#routing-active');
  if (routingActive) {
    routingActive.innerHTML = select.innerHTML;
    routingActive.value = state.activeProfile;
  }
}

function renderTab(tab, force = false) {
  currentTab = tab;
  $$('#tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  $$('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  });
  if (!state) return;
  if (tab === 'overview') renderOverview();
  if (tab === 'providers' || force) renderProviders();
  if (tab === 'routing' || force) renderRouting();
  if (tab === 'mcp' || force) renderMcp();
  if (tab === 'plugins' || force) renderPlugins();
  if (tab === 'logs') renderLogs();
}

function renderOverview() {
  const m = state.metrics;
  const cards = [
    ['Requêtes', fmt(m.requests), `${fmt(m.active)} en cours`],
    ['Erreurs', fmt(m.errors), `${fmt(m.completed)} terminées`],
    ['Tokens entrée', fmt(m.inputTokens), 'estimation / upstream'],
    ['Tokens sortie', fmt(m.outputTokens), 'cumul session'],
    ['Fallbacks', fmt(m.fallbacks), 'changements de modèle'],
    ['Uptime', fmtUptime(m.uptimeSeconds), 'process local'],
  ];
  $('#overview-cards').innerHTML = cards
    .map(
      ([label, value, hint]) =>
        `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`,
    )
    .join('');

  const configured = state.providers.filter((provider) => provider.keyConfigured).length;
  $('#provider-summary').textContent = `${configured} clé(s) configurée(s)`;
  $('#overview-providers').innerHTML = state.providers
    .map((provider) => providerCard(provider, true))
    .join('');

  const decision = state.lastDecision;
  $('#last-decision').innerHTML = decision
    ? `<div class="kv"><span>Profil</span><strong>${esc(decision.profile)}</strong></div>
       <div class="kv"><span>Raison</span><span class="muted">${esc(decision.reason)}</span></div>
       <div class="kv"><span>Entrée</span><span>${fmt(decision.inputTokens)} tokens</span></div>
       <div class="muted small">Chaîne :</div>
       ${(decision.candidates || []).map((target) => `<div class="target">${esc(target)}</div>`).join('') || '<div class="muted">Aucune cible disponible.</div>'}
       ${
         decision.skipped?.length
           ? `<div class="muted small">Écartés : ${esc(decision.skipped.slice(0, 4).join(' · '))}</div>`
           : ''
       }`
    : '<div class="muted">Aucune requête routée depuis le démarrage.</div>';

  $('#overview-recent').innerHTML = recentTable(state.recent);
}

function providerCard(provider, compact = false) {
  const status = provider.status?.state || 'unknown';
  const label =
    status === 'ready'
      ? 'prêt'
      : status === 'error'
        ? 'erreur'
        : status === 'cooldown'
          ? 'cooldown'
          : status === 'disabled'
            ? 'désactivé'
            : 'non testé';
  const stats = provider.stats || {};
  const key = provider.keyConfigured
    ? `<span class="good">clé configurée</span>`
    : `<span class="bad">clé absente</span>`;
  const models = compact
    ? ''
    : `<div class="models">${(provider.models || [])
        .map(
          (model) =>
            `<div class="model-row"><code>${esc(model.id)}</code><span class="muted">${fmt(model.context)} ctx</span></div>`,
        )
        .join('')}</div>`;
  const actions = compact
    ? ''
    : `<div class="actions">
        <button class="secondary small" data-provider-action="test" data-provider="${esc(provider.id)}">Tester</button>
        <button class="secondary small" data-provider-action="refresh" data-provider="${esc(provider.id)}">Découvrir les modèles</button>
        <button class="secondary small" data-provider-action="key" data-provider="${esc(provider.id)}">${provider.keyConfigured ? 'Remplacer la clé' : 'Ajouter une clé'}</button>
      </div>`;
  return `<div class="provider-card">
    <div class="top">
      <h3><span class="status-dot ${esc(status)}"></span>${esc(provider.label)}</h3>
      <label class="inline"><input type="checkbox" class="provider-enabled" data-provider="${esc(provider.id)}" ${provider.enabled ? 'checked' : ''}/> actif</label>
    </div>
    <div class="meta">${esc(provider.id)} · ${esc(label)} · ${key}</div>
    <div class="meta">${esc(provider.baseUrl || '—')}</div>
    <div class="stats">
      <span>${fmt(stats.attempts)} essais</span>
      <span>${fmt(stats.errors)} erreurs</span>
      <span>${fmtMs(stats.latencyCount ? stats.latencyTotal / stats.latencyCount : null)}</span>
      <span>${(provider.models || []).length} modèles</span>
    </div>
    ${provider.status?.lastError ? `<div class="meta bad">${esc(provider.status.lastError)}</div>` : ''}
    ${models}
    ${actions}
  </div>`;
}

function renderProviders() {
  $('#providers-list').innerHTML = state.providers.map((provider) => providerCard(provider)).join('');
}

function renderRouting() {
  const profiles = Object.entries(state.routing.profiles || {});
  $('#profiles-list').innerHTML = profiles
    .map(([id, profile]) => {
      const chain = Array.isArray(profile.chain) ? profile.chain.join('\n') : '';
      const keywords = Array.isArray(profile.keywords) ? profile.keywords.join(', ') : '';
      return `<div class="profile-card" data-profile-card="${esc(id)}">
        <div class="head"><h3>${esc(profile.label || id)} <span class="muted small">${esc(id)}</span></h3>
        <span class="muted small">${id === state.activeProfile ? 'actif' : ''}</span></div>
        <div class="grid">
          <label>Chaîne de modèles<textarea name="chain" rows="4" placeholder="fournisseur/modèle">${esc(chain)}</textarea></label>
          <label>Mots-clés du classifieur<input name="keywords" value="${esc(keywords)}" /></label>
          <label>Consigne du harnais<textarea name="suffix" rows="3">${esc(profile.suffix || '')}</textarea></label>
        </div>
        <div class="row" style="margin-top:10px"><button class="small" data-profile-save="${esc(id)}">Enregistrer ${esc(id)}</button></div>
      </div>`;
    })
    .join('');
}

function renderMcp() {
  const servers = state.mcp?.servers || [];
  $('#mcp-list').innerHTML = servers.length
    ? servers
        .map(
          (server) => `<div class="mcp-card">
            <div class="top"><h3>${esc(server.name)}</h3>
              <div class="row">
                <button class="secondary small" data-mcp-edit="${esc(server.name)}">Modifier</button>
                <button class="danger small" data-mcp-delete="${esc(server.name)}">Supprimer</button>
              </div>
            </div>
            <div class="meta">${esc(server.type)} · ${server.enabled ? 'actif' : 'désactivé'} · ${esc(server.description || '')}</div>
            <div class="meta">${esc(server.type === 'stdio' ? `${server.command || ''} ${(server.args || []).join(' ')}` : server.url || '')}</div>
          </div>`,
        )
        .join('')
    : '<div class="muted">Aucun serveur MCP. Ajoute-en un ci-dessous.</div>';
}

function renderPlugins() {
  const paths = state.plugins?.paths || [];
  const scanned = state.plugins?.scanned || [];
  $('#plugins-list').innerHTML = paths.length
    ? scanned
        .map(
          (plugin) => `<div class="plugin-card">
            <div class="top"><h3>${esc(plugin.name)}</h3>
              <button class="danger small" data-plugin-delete="${esc(plugin.path)}">Retirer</button></div>
            <div class="meta">${esc(plugin.path)}</div>
            <div class="meta ${plugin.valid ? 'good' : 'bad'}">${plugin.valid ? `valide${plugin.version ? ` · v${esc(plugin.version)}` : ''}` : esc(plugin.error || 'invalide')}</div>
          </div>`,
        )
        .join('')
    : '<div class="muted">Aucun plugin. Ajoute un dossier contenant .claude-plugin/plugin.json.</div>';
}

function recentTable(rows) {
  if (!rows?.length) return '<div class="muted">Aucune requête.</div>';
  return `<table><thead><tr><th>Heure</th><th>Profil</th><th>Modèle</th><th>État</th><th>Latence</th><th>Tokens</th></tr></thead><tbody>
    ${rows
      .map(
        (row) => `<tr>
          <td>${fmtDate(row.startedAt)}</td>
          <td>${esc(row.profile || '—')}</td>
          <td><code>${esc(row.providerId ? `${row.providerId}/${row.modelId}` : '—')}</code></td>
          <td class="${row.status === 'error' ? 'bad' : 'good'}">${esc(row.status)}${row.attempts?.length > 1 ? ` · ${row.attempts.length} essais` : ''}</td>
          <td>${fmtMs(row.latencyMs)}</td>
          <td>${fmt(row.inputTokens)} / ${fmt(row.outputTokens)}</td>
        </tr>`,
      )
      .join('')}
  </tbody></table>`;
}

function renderLogs() {
  $('#logs-table').innerHTML = recentTable(state.recent);
}

async function setActiveProfile(profile) {
  try {
    state = await api('/api/admin/routing', {
      method: 'PATCH',
      body: JSON.stringify({ activeProfile: profile }),
    });
    renderHeader();
    renderTab(currentTab, true);
    showToast(`Profil actif : ${profile}`, 'ok');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function providerAction(action, providerId) {
  const provider = state.providers.find((entry) => entry.id === providerId);
  if (!provider) return;
  if (action === 'key') {
    const key = window.prompt(`Nouvelle clé pour ${provider.label} (${provider.apiKeyEnv}). Laisse vide pour effacer.`);
    if (key === null) return;
    try {
      await api(`/api/admin/providers/${encodeURIComponent(providerId)}/key`, {
        method: 'PUT',
        body: JSON.stringify({ key }),
      });
      await loadState();
      showToast(key ? 'Clé enregistrée dans .env' : 'Clé effacée', 'ok');
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }
  try {
    const result = await api(`/api/admin/providers/${encodeURIComponent(providerId)}/${action}`, {
      method: 'POST',
      body: '{}',
    });
    if (result.ok) showToast(`Test OK · ${fmtMs(result.latencyMs)} · ${result.models ?? ''} modèles`, 'ok');
    else showToast(result.error || 'Test échoué', 'error');
    await loadState();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function bindEvents() {
  $('#tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (button) renderTab(button.dataset.tab);
  });

  $('#refresh-btn').addEventListener('click', () => loadState());

  $('#active-profile').addEventListener('change', (event) => setActiveProfile(event.target.value));
  $('#routing-active-save').addEventListener('click', () => {
    const value = $('#routing-active').value;
    if (value) setActiveProfile(value);
  });

  document.addEventListener('change', (event) => {
    const input = event.target.closest('.provider-enabled');
    if (!input) return;
    api(`/api/admin/providers/${encodeURIComponent(input.dataset.provider)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: input.checked }),
    })
      .then(() => loadState())
      .catch((error) => showToast(error.message, 'error'));
  });

  $('#providers-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-provider-action]');
    if (!button) return;
    providerAction(button.dataset.providerAction, button.dataset.provider);
  });

  $('#profiles-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-profile-save]');
    if (!button) return;
    const id = button.dataset.profileSave;
    const card = button.closest('[data-profile-card]');
    const chain = card.querySelector('[name="chain"]').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const keywords = card.querySelector('[name="keywords"]').value.split(',').map((entry) => entry.trim()).filter(Boolean);
    const suffix = card.querySelector('[name="suffix"]').value;
    try {
      state = await api('/api/admin/routing', {
        method: 'PATCH',
        body: JSON.stringify({ profiles: { [id]: { chain, keywords, suffix } } }),
      });
      renderTab('routing', true);
      showToast(`Profil ${id} enregistré`, 'ok');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  $('#mcp-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const type = data.get('type');
    const server = {
      name: String(data.get('name') || '').trim(),
      type,
      description: String(data.get('description') || ''),
      enabled: Boolean(data.get('enabled')),
    };
    try {
      if (type === 'stdio') {
        server.command = String(data.get('command') || '');
        server.args = String(data.get('args') || '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
        server.env = parseJsonObject(String(data.get('env') || ''), 'Env');
      } else {
        server.url = String(data.get('url') || '');
        server.headers = parseJsonObject(String(data.get('headers') || ''), 'Headers');
      }
      state = await api(`/api/admin/mcp/${encodeURIComponent(server.name)}`, {
        method: 'PUT',
        body: JSON.stringify(server),
      });
      mcpEditing = null;
      resetMcpForm();
      renderTab('mcp', true);
      showToast(`MCP ${server.name} enregistré`, 'ok');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  $('#mcp-reset').addEventListener('click', () => {
    mcpEditing = null;
    resetMcpForm();
  });

  $('#mcp-list').addEventListener('click', async (event) => {
    const edit = event.target.closest('button[data-mcp-edit]');
    if (edit) {
      const server = (state.mcp.servers || []).find((entry) => entry.name === edit.dataset.mcpEdit);
      if (server) fillMcpForm(server);
      return;
    }
    const del = event.target.closest('button[data-mcp-delete]');
    if (!del) return;
    if (!window.confirm(`Supprimer le serveur MCP ${del.dataset.mcpDelete} ?`)) return;
    try {
      state = await api(`/api/admin/mcp/${encodeURIComponent(del.dataset.mcpDelete)}`, { method: 'DELETE' });
      renderTab('mcp', true);
      showToast('Serveur MCP supprimé', 'ok');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  $('#mcp-export').addEventListener('click', async () => {
    try {
      const headers = token ? { authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/admin/mcp/export', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'mcp.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  $('#plugin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector('[name="path"]');
    const path = input.value.trim();
    if (!path) return;
    try {
      const paths = [...new Set([...(state.plugins.paths || []), path])];
      state = await api('/api/admin/plugins', {
        method: 'PUT',
        body: JSON.stringify({ paths }),
      });
      input.value = '';
      renderTab('plugins', true);
      showToast('Plugin ajouté', 'ok');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  $('#plugins-list').addEventListener('click', async (event) => {
    const del = event.target.closest('button[data-plugin-delete]');
    if (!del) return;
    try {
      const paths = (state.plugins.paths || []).filter((path) => path !== del.dataset.pluginDelete);
      state = await api('/api/admin/plugins', {
        method: 'PUT',
        body: JSON.stringify({ paths }),
      });
      renderTab('plugins', true);
      showToast('Plugin retiré', 'ok');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  $('#login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    token = $('#login-token').value.trim();
    sessionStorage.setItem('hunter-admin-token', token);
    loadState();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state) loadState();
  });
}

function parseJsonObject(text, label) {
  if (!text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet JSON.`);
  }
  return value;
}

function resetMcpForm() {
  const form = $('#mcp-form');
  form.reset();
  form.querySelector('[name="enabled"]').checked = true;
  form.querySelector('[name="type"]').value = 'stdio';
  $('#mcp-form-title').textContent = 'Ajouter un serveur MCP';
  updateMcpFields();
}

function fillMcpForm(server) {
  const form = $('#mcp-form');
  mcpEditing = server.name;
  form.querySelector('[name="name"]').value = server.name;
  form.querySelector('[name="type"]').value = server.type;
  form.querySelector('[name="description"]').value = server.description || '';
  form.querySelector('[name="enabled"]').checked = server.enabled;
  form.querySelector('[name="command"]').value = server.command || '';
  form.querySelector('[name="args"]').value = (server.args || []).join('\n');
  form.querySelector('[name="url"]').value = server.url || '';
  form.querySelector('[name="env"]').value = server.env ? JSON.stringify(server.env, null, 2) : '';
  form.querySelector('[name="headers"]').value = server.headers ? JSON.stringify(server.headers, null, 2) : '';
  $('#mcp-form-title').textContent = `Modifier ${server.name}`;
  updateMcpFields();
}

function updateMcpFields() {
  const type = $('#mcp-form [name="type"]').value;
  $$('.stdio-only').forEach((el) => (el.style.display = type === 'stdio' ? '' : 'none'));
  $$('.http-only').forEach((el) => (el.style.display = type === 'stdio' ? 'none' : ''));
  $$('#mcp-form input[name="command"], #mcp-form input[name="url"]').forEach((input) => {
    input.required = input.name === (type === 'stdio' ? 'command' : 'url');
  });
}

bindEvents();
$('#mcp-form [name="type"]').addEventListener('change', updateMcpFields);
updateMcpFields();
loadState();
setInterval(() => {
  if (state && !document.hidden) renderHeader();
}, 10000);
