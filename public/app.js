const $ = (id) => document.getElementById(id);
let state = null;

const SETTING_FIELDS = [
  { key: 'poll_interval_sec', label: 'Frequence de detection (s)', type: 'number', min: 30, hint: 'Lecture authentifiee : limites par compte, plus par IP.' },
  { key: 'delay_min_sec', label: 'Delai minimum avant RT (s)', type: 'number', min: 0 },
  { key: 'delay_max_sec', label: 'Delai maximum avant RT (s)', type: 'number', min: 0, hint: 'Un delai aleatoire dans cette plage est tire pour chaque RT.' },
  { key: 'stagger_sec', label: 'Ecart entre amplificateurs (s)', type: 'number', min: 0, hint: 'Evite que tous les comptes retweetent en meme temps.' },
  { key: 'max_rt_per_hour', label: 'RT max par compte / heure', type: 'number', min: 0, hint: '0 = illimite (fortement deconseille).' },
  { key: 'max_age_min', label: 'Age max du post (min)', type: 'number', min: 0, hint: 'Au-dela, le post est ignore.' },
  { key: 'session_check_hours', label: 'Verifier les sessions (h)', type: 'number', min: 0, hint: '0 = jamais. Detecte les sessions expirees en amont.' },
  { key: 'headless', label: 'Navigateur invisible', type: 'bool', hint: 'Non = les fenetres Chromium s’affichent. Utile pour diagnostiquer.' },
  { key: 'user_tweets_query_id', label: 'ID de requete UserTweets', type: 'text', hint: 'Lecture des timelines. Recuperable dans l’onglet Reseau.' },
  { key: 'user_by_screen_name_query_id', label: 'ID de requete UserByScreenName', type: 'text', hint: 'Resolution pseudo → identifiant, une seule fois par compte.' },
  { key: 'skip_replies', label: 'Ignorer les reponses', type: 'bool' },
  { key: 'skip_retweets', label: 'Ignorer les retweets', type: 'bool' },
  { key: 'require_keywords', label: 'Mots-cles requis', type: 'text', hint: 'Separes par des virgules. Vide = tous les posts.' },
  { key: 'exclude_keywords', label: 'Mots-cles exclus', type: 'text', hint: 'Un post contenant l’un d’eux est ignore.' },
];

const ROLE_LABELS = { source: 'Se fait RT', amplifier: 'Retweete', both: 'Les deux' };

// Compte dont le formulaire d'import est ouvert : le rafraichissement auto est
// suspendu tant qu'il l'est, sinon les champs saisis seraient effaces.
let importOpen = null;
let proxyOpen = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ts) {
  if (!ts) return 'jamais';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  return `il y a ${Math.round(s / 3600)} h`;
}

function inFuture(ts) {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'imminent';
  if (s < 60) return `dans ${s} s`;
  if (s < 3600) return `dans ${Math.round(s / 60)} min`;
  return `dans ${Math.round(s / 3600)} h`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    $('login').classList.remove('hidden');
    $('app').classList.add('hidden');
    throw new Error('auth');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ rendu

function renderStats() {
  const { accounts, counts } = state;
  const ready = accounts.filter((a) => a.enabled && a.role !== 'source' && a.session_ok && !a.needs_attention).length;
  const cards = [
    { label: 'Comptes a RT', value: accounts.filter((a) => a.enabled && a.role !== 'amplifier').length },
    { label: 'Sessions pretes', value: ready },
    { label: 'En attente', value: counts.pending || 0 },
    { label: 'RT effectues', value: counts.done || 0 },
    { label: 'Echecs', value: counts.failed || 0 },
  ];
  $('stats').innerHTML = cards
    .map((c) => `<div class="stat"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`)
    .join('');
}

/** Etat de session, affiche uniquement dans la colonne des amplificateurs. */
function sessionBadge(a) {
  const proxy = a.proxy_host
    ? `<span class="badge ok">proxy ${esc(a.proxy_host)}</span>`
    : '<span class="badge">IP locale</span>';
  if (a.needs_attention) return `<span class="badge bad">Compte verrouille par X</span>${proxy}`;
  if (a.session_ok) {
    return `<span class="badge ok">Session active</span>${proxy}<span class="sub">verifiee ${ago(a.session_checked_at)}</span>`;
  }
  return `<span class="badge bad">Aucune session</span>${proxy}`;
}

function accountCard(a, column) {
  const err = a.last_error ? `<div class="err">${esc(a.last_error)}</div>` : '';

  const info = column === 'source'
    ? `<div class="sub">Derniere detection : ${ago(a.last_polled_at)}</div>`
    : `<div class="session">${sessionBadge(a)}</div>
       <div class="sub">${a.rt_last_hour} RT cette heure &middot; ${a.rt_done} au total</div>`;

  const sessionActions = column === 'source' ? '' : `
    <button class="btn small primary" data-action="import" data-id="${a.id}">
      ${a.session_ok ? 'Reimporter' : 'Importer une session'}
    </button>
    <button class="btn small" data-action="proxy" data-id="${a.id}">
      ${a.proxy_host ? 'Changer le proxy' : 'Definir un proxy'}
    </button>
    ${a.needs_attention ? `<button class="btn small" data-action="resolve" data-id="${a.id}">J'ai regle</button>` : ''}`;

  const proxyForm = proxyOpen === a.id && column !== 'source' ? `
    <form class="import-form" data-proxy-id="${a.id}">
      <p class="hint">
        Proxy utilise par le VA qui gere <strong>@${esc(a.username)}</strong>, pour sortir par la meme IP.
        Format : <code>http://utilisateur:motdepasse@hote:port</code>. Laissez vide pour retirer le proxy.
        <br>Il s'applique <strong>a la lecture comme au retweet</strong>. SOCKS non pris en charge.
      </p>
      <input name="proxy_url" placeholder="http://user:pass@hote:port" autocomplete="off" spellcheck="false">
      <div class="import-row">
        <button class="btn primary small" type="submit">Enregistrer</button>
        <button class="btn small" type="button" data-action="cancel-proxy">Annuler</button>
        <span class="import-status"></span>
      </div>
      <p class="error" data-proxy-error></p>
    </form>` : '';

  const importForm = importOpen === a.id && column !== 'source' ? `
    <form class="import-form" data-id="${a.id}">
      <p class="hint">
        Connectez-vous a <strong>@${esc(a.username)}</strong> dans votre navigateur habituel, puis sur x.com :
        <strong>F12 &rarr; Application &rarr; Cookies &rarr; https://x.com</strong>.
        Copiez les valeurs des cookies <code>auth_token</code> et <code>ct0</code>.
        <br><strong>Verifiez bien que c'est le compte @${esc(a.username)} qui est connecte</strong> —
        le compte reellement relie est celui de ces cookies.
      </p>
      <input name="auth_token" placeholder="auth_token" autocomplete="off" spellcheck="false" required>
      <input name="ct0" placeholder="ct0" autocomplete="off" spellcheck="false" required>
      <div class="import-row">
        <button class="btn primary small" type="submit">Importer et verifier</button>
        <button class="btn small" type="button" data-action="cancel-import">Annuler</button>
        <span class="import-status"></span>
      </div>
      <p class="error" data-import-error></p>
    </form>` : '';

  return `<div class="account ${a.enabled ? '' : 'disabled'}">
    <div class="who">
      <div class="handle">@${esc(a.username)}</div>
      ${info}
    </div>
    <select data-action="role" data-id="${a.id}">
      ${Object.entries(ROLE_LABELS)
        .map(([v, l]) => `<option value="${v}" ${a.role === v ? 'selected' : ''}>${l}</option>`)
        .join('')}
    </select>
    ${sessionActions}
    <button class="btn small" data-action="toggle" data-id="${a.id}" data-enabled="${a.enabled}">
      ${a.enabled ? 'Desactiver' : 'Activer'}
    </button>
    <button class="btn small danger" data-action="remove" data-id="${a.id}" data-username="${esc(a.username)}">Retirer</button>
    ${err}${importForm}${proxyForm}
  </div>`;
}

function renderAccounts() {
  const sources = state.accounts.filter((a) => a.role === 'source' || a.role === 'both');
  const amps = state.accounts.filter((a) => a.role === 'amplifier' || a.role === 'both');

  $('list-sources').innerHTML = sources.length
    ? sources.map((a) => accountCard(a, 'source')).join('')
    : '<div class="empty">Ajoutez les comptes dont les posts doivent etre relayes.</div>';

  $('list-amplifiers').innerHTML = amps.length
    ? amps.map((a) => accountCard(a, 'amplifier')).join('')
    : '<div class="empty">Ajoutez les comptes qui doivent retweeter, puis connectez leur session.</div>';
}

function renderSettings() {
  $('settings').innerHTML = SETTING_FIELDS.map((f) => {
    const value = state.settings[f.key] ?? '';
    const hint = f.hint ? `<div class="hint">${f.hint}</div>` : '';
    const input =
      f.type === 'bool'
        ? `<select data-setting="${f.key}"><option value="1" ${value === '1' ? 'selected' : ''}>Oui</option><option value="0" ${value === '0' ? 'selected' : ''}>Non</option></select>`
        : `<input data-setting="${f.key}" type="${f.type}" ${f.min !== undefined ? `min="${f.min}"` : ''} value="${esc(value)}">`;
    return `<div class="field"><label>${f.label}</label>${input}${hint}</div>`;
  }).join('');
}

function renderJobs() {
  if (!state.jobs.length) {
    $('jobs').innerHTML = '<div class="empty">Rien pour l’instant.</div>';
    return;
  }
  const rows = state.jobs
    .map((j) => {
      const when = j.status === 'pending' ? inFuture(j.run_at) : ago(j.updated_at);
      const cancel = j.status === 'pending'
        ? `<button class="btn small" data-action="cancel-job" data-id="${j.id}">Annuler</button>`
        : '';
      const err = j.error ? `<div class="muted">${esc(j.error)}</div>` : '';
      return `<tr>
        <td><span class="tag ${j.status}">${j.status}</span></td>
        <td>@${esc(j.amplifier_username || '?')}</td>
        <td>&larr; @${esc(j.author_username || '?')}</td>
        <td><a href="https://x.com/i/status/${esc(j.tweet_id)}" target="_blank" rel="noopener">post</a></td>
        <td>${when}${err}</td>
        <td>${cancel}</td>
      </tr>`;
    })
    .join('');
  $('jobs').innerHTML = `<table><thead><tr><th>Etat</th><th>Retweete par</th><th>Source</th><th>Post</th><th>Quand</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderLogs() {
  $('logs').innerHTML = state.logs.length
    ? state.logs
        .map((l) => `<div class="${l.level}"><time>${new Date(l.ts).toLocaleTimeString('fr-FR')}</time>${esc(l.message)}</div>`)
        .join('')
    : '<div class="empty">Journal vide.</div>';
}

/** Rend lisible la regulation du quota de detection. */
function renderDetection() {
  const d = state.detection;
  const box = $('detection-note');
  if (!d || !d.sourceCount) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const min = (s) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);
  const paused = d.pausedUntil
    ? ` <span class="warn-text">Lecture en pause, reprise dans ${Math.ceil((d.pausedUntil - Date.now()) / 60_000)} min.</span>`
    : '';
  const readers = d.readerCount
    ? `${d.readerCount} session(s) de lecture`
    : `<span class="warn-text">aucune session de lecture — importez des cookies</span>`;

  box.innerHTML = `${d.sourceCount} compte(s) source &middot; verification toutes les
    <strong>${min(d.effectiveIntervalSec)}</strong> par compte &middot; ${readers}.${paused}`;
}

function renderStatus() {
  const paused = state.settings.paused === '1';
  const pill = $('status-pill');
  pill.textContent = paused ? 'En pause' : 'Actif';
  pill.className = `pill ${paused ? 'off' : 'on'}`;
  $('btn-pause').textContent = paused ? 'Reprendre' : 'Mettre en pause';
}

function render() {
  $('app').classList.remove('hidden');
  $('login').classList.add('hidden');
  renderStatus();
  renderDetection();
  renderStats();
  renderAccounts();
  renderJobs();
  renderLogs();
}

let settingsDirty = false;

async function refresh({ force = false } = {}) {
  if ((importOpen || proxyOpen) && !force) return; // ne pas effacer une saisie en cours
  try {
    state = await api('/api/state');
    render();
    if (!settingsDirty) renderSettings();
  } catch (err) {
    if (err.message !== 'auth') console.error(err);
  }
}

// ------------------------------------------------------------ interactions

document.querySelectorAll('.add-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = form.dataset.role;
    const input = form.querySelector('input');
    const errorBox = document.querySelector(`[data-error="${role}"]`);
    errorBox.textContent = '';
    try {
      await api('/api/accounts', { method: 'POST', body: { handle: input.value, role } });
      input.value = '';
      refresh();
    } catch (err) {
      errorBox.textContent = err.message;
    }
  });
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.setting) { settingsDirty = true; return; }
  if (el.dataset.action === 'role') {
    await api(`/api/accounts/${el.dataset.id}`, { method: 'PATCH', body: { role: el.value } });
    refresh();
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'import') {
    importOpen = id;
    proxyOpen = null;
    render();
    return;
  }
  if (action === 'proxy') {
    proxyOpen = id;
    importOpen = null;
    render();
    return;
  }
  if (action === 'cancel-import' || action === 'cancel-proxy') {
    importOpen = null;
    proxyOpen = null;
    refresh({ force: true });
    return;
  }

  if (action === 'toggle') {
    await api(`/api/accounts/${id}`, { method: 'PATCH', body: { enabled: btn.dataset.enabled !== '1' } });
  } else if (action === 'remove') {
    if (!confirm(`Retirer @${btn.dataset.username} ? Sa session enregistree sera supprimee.`)) return;
    await api(`/api/accounts/${id}`, { method: 'DELETE' });
  } else if (action === 'resolve') {
    await api(`/api/accounts/${id}/resolve`, { method: 'POST' });
  } else if (action === 'cancel-job') {
    await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
  }
  refresh();
});

// Formulaire de proxy, cree dynamiquement : ecoute deleguee.
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-proxy-id]');
  if (!form) return;
  e.preventDefault();

  const errorBox = form.querySelector('[data-proxy-error]');
  const status = form.querySelector('.import-status');
  const submit = form.querySelector('button[type="submit"]');
  errorBox.textContent = '';
  status.textContent = 'Enregistrement...';
  submit.disabled = true;

  try {
    await api(`/api/accounts/${form.dataset.proxyId}/proxy`, {
      method: 'PUT',
      body: { proxy_url: form.querySelector('[name="proxy_url"]').value.trim() },
    });
    proxyOpen = null;
    refresh({ force: true });
  } catch (err) {
    errorBox.textContent = err.message;
    status.textContent = '';
    submit.disabled = false;
  }
});

// Le formulaire d'import est cree dynamiquement : ecoute deleguee.
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('.import-form:not([data-proxy-id])');
  if (!form) return;
  e.preventDefault();

  const errorBox = form.querySelector('[data-import-error]');
  const status = form.querySelector('.import-status');
  const submit = form.querySelector('button[type="submit"]');
  errorBox.textContent = '';
  status.textContent = 'Verification aupres de X...';
  submit.disabled = true;

  try {
    await api(`/api/accounts/${form.dataset.id}/session`, {
      method: 'POST',
      body: {
        auth_token: form.querySelector('[name="auth_token"]').value.trim(),
        ct0: form.querySelector('[name="ct0"]').value.trim(),
      },
    });
    importOpen = null;
    refresh({ force: true });
  } catch (err) {
    errorBox.textContent = err.message;
    status.textContent = '';
    submit.disabled = false;
  }
});

$('btn-save-settings').addEventListener('click', async () => {
  const body = {};
  document.querySelectorAll('[data-setting]').forEach((el) => { body[el.dataset.setting] = el.value; });
  const { settings } = await api('/api/settings', { method: 'PUT', body });
  state.settings = settings;
  settingsDirty = false;
  renderSettings();
  $('settings-saved').classList.remove('hidden');
  setTimeout(() => $('settings-saved').classList.add('hidden'), 2500);
});

$('btn-pause').addEventListener('click', async () => {
  const paused = state.settings.paused === '1' ? '0' : '1';
  const { settings } = await api('/api/settings', { method: 'PUT', body: { paused } });
  state.settings = settings;
  renderStatus();
});

$('btn-poll').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Verification...';
  try { await api('/api/poll', { method: 'POST' }); } finally {
    e.target.disabled = false;
    e.target.textContent = 'Verifier maintenant';
    refresh();
  }
});

$('btn-clear-jobs').addEventListener('click', async () => {
  if (!confirm("Supprimer l'historique des retweets termines ?")) return;
  await api('/api/jobs/clear', { method: 'POST' });
  refresh();
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('login-password').value }),
  });
  if (res.ok) refresh();
  else $('login-error').textContent = 'Mot de passe incorrect.';
});

refresh();
setInterval(refresh, 5000);
