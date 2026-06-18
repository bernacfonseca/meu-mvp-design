// ============================================================
// ACERVO — app logic
// ============================================================
import {
  addItem, updateItem, deleteItem, getAllItems,
  getProfile, saveProfile, exportAll, importAll, clearAll,
} from './db.js';

const LARGE_FILE_WARNING_BYTES = 25 * 1024 * 1024; // 25MB

// ---------------- state ----------------
let items = [];
let profileCache = null;
let currentGrouping = 'month';
let composerMode = 'file';
let pendingFile = null;
let pendingTags = [];
let pendingAvatarFile = null;
let searchSelectedTags = new Set();

// ---------------- helpers ----------------

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now();
}

function el(sel) { return document.querySelector(sel); }
function els(sel) { return Array.from(document.querySelectorAll(sel)); }

let toastTimer = null;
function showToast(msg) {
  const t = el('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

function hostnameFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function kindFromMime(mime) {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function kindGlyph(kind) {
  return { image: '◧', audio: '♪', video: '▶', document: '▣', link: '⤴', text: '¶' }[kind] || '◇';
}

function shortDate(ts) {
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

// ============================================================
// NAV / ROUTING
// ============================================================

function setupNav() {
  els('.nav-link').forEach(btn => {
    btn.addEventListener('click', () => goToRoute(btn.dataset.route));
  });
}

function goToRoute(route) {
  els('.nav-link').forEach(b => b.classList.toggle('is-active', b.dataset.route === route));
  els('.screen').forEach(s => s.classList.toggle('is-active', s.dataset.screen === route));
  if (route === 'profile') renderProfileScreen();
  if (route === 'search') renderSearchScreen();
}

// ============================================================
// COMPOSER
// ============================================================

function setupComposer() {
  els('.composer-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      composerMode = tab.dataset.mode;
      els('.composer-tab').forEach(t => t.classList.toggle('is-active', t === tab));
      els('.composer-pane').forEach(p => p.classList.toggle('is-active', p.dataset.pane === composerMode));
      hideComposerError();
      updateSubmitEnabled();
    });
  });

  const dropzone = el('#dropzone');
  const fileInput = el('#file-input');

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setPendingFile(fileInput.files[0]);
  });

  ['dragover', 'dragenter'].forEach(evt =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); })
  );
  ['dragleave', 'dragend', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, () => dropzone.classList.remove('is-dragover'))
  );
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) setPendingFile(file);
  });

  el('#link-input').addEventListener('input', updateSubmitEnabled);
  el('#text-body-input').addEventListener('input', updateSubmitEnabled);

  setupTagInput(el('#tag-input'), el('#tag-input-shell'), pendingTags, updateSubmitEnabled);

  el('#submit-entry').addEventListener('click', handleSubmitEntry);
}

function setPendingFile(file) {
  pendingFile = file;
  renderFilePreview();
  updateSubmitEnabled();
}

function renderFilePreview() {
  const box = el('#file-preview');
  if (!pendingFile) { box.hidden = true; box.innerHTML = ''; return; }

  const kind = kindFromMime(pendingFile.type);
  const big = pendingFile.size > LARGE_FILE_WARNING_BYTES;
  let thumbHtml = `<span style="font-family:var(--display);font-style:italic;font-size:20px;color:var(--accent);">${kindGlyph(kind)}</span>`;
  if (kind === 'image') {
    const url = URL.createObjectURL(pendingFile);
    thumbHtml = `<img src="${url}" alt="">`;
  }
  box.innerHTML = `
    ${thumbHtml}
    <span class="fp-name">${escapeHtml(pendingFile.name)} · ${(pendingFile.size / (1024 * 1024)).toFixed(1)}MB</span>
    <button type="button" class="fp-remove">remover</button>
  `;
  box.hidden = false;
  box.querySelector('.fp-remove').addEventListener('click', () => {
    pendingFile = null;
    el('#file-input').value = '';
    renderFilePreview();
    updateSubmitEnabled();
  });

  if (big) {
    showComposerError('Esse arquivo é grande para ficar salvo só no navegador — considere usar a aba "Link" para vídeos/áudios pesados. Você ainda pode adicionar assim se preferir.');
  } else {
    hideComposerError();
  }
}

function showComposerError(msg) {
  const e = el('#composer-error');
  e.textContent = msg;
  e.hidden = false;
}
function hideComposerError() {
  el('#composer-error').hidden = true;
}

// ---- tag input (shared between composer and search) ----

function setupTagInput(inputEl, shellEl, tagsArray, onChange) {
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const raw = inputEl.value.trim().replace(/,$/, '');
      if (raw) addTagToArray(raw, tagsArray, shellEl, inputEl, onChange);
      inputEl.value = '';
    } else if (e.key === 'Backspace' && inputEl.value === '' && tagsArray.length) {
      tagsArray.pop();
      renderTagChips(tagsArray, shellEl, inputEl, onChange);
      if (onChange) onChange();
    }
  });
}

function addTagToArray(raw, tagsArray, shellEl, inputEl, onChange) {
  const clean = raw.toLowerCase();
  if (!tagsArray.some(t => t.toLowerCase() === clean) && clean) {
    tagsArray.push(raw);
    renderTagChips(tagsArray, shellEl, inputEl, onChange);
    if (onChange) onChange();
  }
}

function renderTagChips(tagsArray, shellEl, inputEl, onChange) {
  shellEl.querySelectorAll('.tag-chip').forEach(c => c.remove());
  tagsArray.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `${escapeHtml(tag)} <button type="button" aria-label="remover">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      tagsArray.splice(i, 1);
      renderTagChips(tagsArray, shellEl, inputEl, onChange);
      if (onChange) onChange();
    });
    shellEl.insertBefore(chip, inputEl);
  });
}

function updateSubmitEnabled() {
  const btn = el('#submit-entry');
  let ok = false;
  if (composerMode === 'file') ok = !!pendingFile;
  if (composerMode === 'link') ok = isValidUrl(el('#link-input').value.trim());
  if (composerMode === 'text') ok = el('#text-body-input').value.trim().length > 0;
  btn.disabled = !ok;
}

function isValidUrl(str) {
  if (!str) return false;
  try { new URL(str); return true; } catch { return false; }
}

async function handleSubmitEntry() {
  hideComposerError();
  const tags = [...pendingTags];
  const id = uuid();
  const createdAt = Date.now();
  let item = null;

  try {
    if (composerMode === 'file') {
      if (!pendingFile) return;
      const kind = kindFromMime(pendingFile.type);
      item = {
        id, createdAt, tags, kind,
        title: pendingFile.name,
        blob: pendingFile,
        mimeType: pendingFile.type,
        fileName: pendingFile.name,
      };
    } else if (composerMode === 'link') {
      const url = el('#link-input').value.trim();
      if (!isValidUrl(url)) return;
      const title = el('#link-title-input').value.trim() || hostnameFromUrl(url);
      item = { id, createdAt, tags, kind: 'link', title, url };
    } else if (composerMode === 'text') {
      const body = el('#text-body-input').value.trim();
      if (!body) return;
      const title = el('#text-title-input').value.trim() || 'Sem título';
      item = { id, createdAt, tags, kind: 'text', title, body };
    }

    await addItem(item);
    items.unshift(item);
    resetComposer();
    showToast('Adicionado ao acervo');
    renderTimelineScreen();
  } catch (err) {
    showComposerError('Não foi possível salvar este item: ' + err.message);
  }
}

function resetComposer() {
  pendingFile = null;
  pendingTags = [];
  el('#file-input').value = '';
  el('#link-input').value = '';
  el('#link-title-input').value = '';
  el('#text-title-input').value = '';
  el('#text-body-input').value = '';
  renderFilePreview();
  renderTagChips(pendingTags, el('#tag-input-shell'), el('#tag-input'), updateSubmitEnabled);
  updateSubmitEnabled();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ============================================================
// TIMELINE GROUPING + RENDER
// ============================================================

function setupTimelineControls() {
  els('#grouping-control .segmented-opt').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentGrouping = btn.dataset.group;
      els('#grouping-control .segmented-opt').forEach(b => b.classList.toggle('is-active', b === btn));
      await saveProfile({ defaultGrouping: currentGrouping });
      if (profileCache) profileCache.defaultGrouping = currentGrouping;
      renderTimelineScreen();
    });
  });
}

function applyGroupingButtonsState() {
  els('#grouping-control .segmented-opt').forEach(b =>
    b.classList.toggle('is-active', b.dataset.group === currentGrouping)
  );
}

function startOfWeekMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  return d;
}

function groupKeyAndLabel(ts, grouping) {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = d.getMonth();

  if (grouping === 'year') {
    return { key: `${year}`, label: `${year}`, sort: new Date(year, 0, 1).getTime() };
  }
  if (grouping === 'semester') {
    const sem = month < 6 ? 1 : 2;
    return {
      key: `${year}-S${sem}`,
      label: `${year} · ${sem}º semestre`,
      sort: new Date(year, sem === 1 ? 0 : 6, 1).getTime(),
    };
  }
  if (grouping === 'week') {
    const start = startOfWeekMonday(d);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    const fmt = (x) => x.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    return {
      key: `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`,
      label: `Semana de ${fmt(start)} a ${fmt(end)}`,
      sort: start.getTime(),
    };
  }
  if (grouping === 'day') {
    return {
      key: `${year}-${month}-${d.getDate()}`,
      label: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }),
      sort: new Date(year, month, d.getDate()).getTime(),
    };
  }
  // month (default)
  return {
    key: `${year}-${month}`,
    label: d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
    sort: new Date(year, month, 1).getTime(),
  };
}

function groupItems(list, grouping) {
  const map = new Map();
  list.forEach(item => {
    const { key, label, sort } = groupKeyAndLabel(item.createdAt, grouping);
    if (!map.has(key)) map.set(key, { label, sort, items: [] });
    map.get(key).items.push(item);
  });
  return Array.from(map.values()).sort((a, b) => b.sort - a.sort);
}

function buildMediaHtml(item) {
  if (item.kind === 'image' && item.blob) {
    const url = URL.createObjectURL(item.blob);
    return `<div class="spec-media"><img src="${url}" alt=""></div>`;
  }
  if (item.kind === 'text') {
    return `<div class="spec-media"><div class="spec-text-preview">${escapeHtml((item.body || '').slice(0, 220))}</div></div>`;
  }
  return `<div class="spec-media is-glyph">${kindGlyph(item.kind)}</div>`;
}

function buildCardHtml(item) {
  const visibleTags = item.tags.slice(0, 3);
  const extra = item.tags.length > 3 ? `+${item.tags.length - 3}` : '';
  return `
    <article class="spec-card" data-id="${item.id}">
      ${buildMediaHtml(item)}
      <div class="spec-label">
        <h3 class="spec-title">${escapeHtml(item.title || 'Sem título')}</h3>
        <div class="spec-meta">
          <div class="spec-tags">
            ${visibleTags.map(t => `<span class="spec-tag">#${escapeHtml(t)}</span>`).join('')}
            ${extra ? `<span class="spec-tag">${extra}</span>` : ''}
          </div>
          <span class="spec-date">${shortDate(item.createdAt)}</span>
        </div>
      </div>
    </article>
  `;
}

function attachCardClickHandlers(root) {
  root.querySelectorAll('.spec-card').forEach(card => {
    card.addEventListener('click', () => {
      const item = items.find(i => i.id === card.dataset.id);
      if (item) openModal(item);
    });
  });
}

function renderGroupsInto(rootEl, emptyEl, list, grouping, emptyTitle, emptySub) {
  if (!list.length) {
    rootEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.hidden = false;
      const t = emptyEl.querySelector('.empty-title');
      const s = emptyEl.querySelector('.empty-sub');
      if (t && emptyTitle) t.textContent = emptyTitle;
      if (s && emptySub) s.textContent = emptySub;
    }
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  const groups = groupItems(list, grouping);
  rootEl.innerHTML = groups.map(g => `
    <div class="timeline-group">
      <div class="timeline-group-label">
        <span>${escapeHtml(g.label)}</span>
        <span class="timeline-group-count">${g.items.length} ${g.items.length === 1 ? 'item' : 'itens'}</span>
      </div>
      <div class="card-grid">
        ${g.items.map(buildCardHtml).join('')}
      </div>
    </div>
  `).join('');
  attachCardClickHandlers(rootEl);
}

function renderTimelineScreen() {
  el('#item-count').textContent = items.length ? `${items.length} ${items.length === 1 ? 'item' : 'itens'} no total` : '';
  renderGroupsInto(
    el('#timeline-root'), el('#timeline-empty'), items, currentGrouping,
    'O acervo está vazio', 'Anexe uma imagem, cole um link ou escreva um texto acima para começar.'
  );
}

// ============================================================
// SEARCH
// ============================================================

function setupSearch() {
  const input = el('#search-tag-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const raw = input.value.trim();
      if (raw) {
        const match = allTags().find(t => t.toLowerCase() === raw.toLowerCase());
        toggleSearchTag(match || raw);
        input.value = '';
      }
    }
  });
}

function allTags() {
  const set = new Set();
  items.forEach(i => i.tags.forEach(t => set.add(t)));
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function toggleSearchTag(tag) {
  const key = tag.toLowerCase();
  const existing = Array.from(searchSelectedTags).find(t => t.toLowerCase() === key);
  if (existing) searchSelectedTags.delete(existing);
  else searchSelectedTags.add(tag);
  renderSearchScreen();
}

function renderSearchScreen() {
  const tags = allTags();
  const sugBox = el('#tag-suggestions');
  if (!tags.length) {
    sugBox.innerHTML = `<span class="spec-date">Nenhuma tag cadastrada ainda.</span>`;
  } else {
    sugBox.innerHTML = tags.map(t => {
      const selected = Array.from(searchSelectedTags).some(s => s.toLowerCase() === t.toLowerCase());
      return `<button type="button" class="tag-chip is-selectable ${selected ? 'is-selected' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`;
    }).join('');
    sugBox.querySelectorAll('[data-tag]').forEach(btn => {
      btn.addEventListener('click', () => toggleSearchTag(btn.dataset.tag));
    });
  }

  const resultsRoot = el('#search-results-root');
  const emptyEl = el('#search-empty');

  if (searchSelectedTags.size === 0) {
    resultsRoot.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.querySelector('.empty-title').textContent = 'Escolha uma ou mais tags';
    emptyEl.querySelector('.empty-sub').textContent = 'Os itens que contiverem todas as tags selecionadas aparecem aqui.';
    return;
  }

  const selectedLower = Array.from(searchSelectedTags).map(t => t.toLowerCase());
  const matches = items.filter(item => {
    const itemTagsLower = item.tags.map(t => t.toLowerCase());
    return selectedLower.every(t => itemTagsLower.includes(t));
  });

  if (!matches.length) {
    resultsRoot.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.querySelector('.empty-title').textContent = 'Nenhum item encontrado';
    emptyEl.querySelector('.empty-sub').textContent = 'Tente remover alguma tag da busca.';
    return;
  }

  emptyEl.hidden = true;
  resultsRoot.innerHTML = `<div class="card-grid">${matches.map(buildCardHtml).join('')}</div>`;
  attachCardClickHandlers(resultsRoot);
}

// ============================================================
// MODAL
// ============================================================

function setupModal() {
  el('#modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

function closeModal() {
  el('#modal-overlay').hidden = true;
  el('#modal').innerHTML = '';
}

function buildModalMediaHtml(item) {
  if (item.kind === 'image' && item.blob) {
    const url = URL.createObjectURL(item.blob);
    return `<div class="modal-media"><img src="${url}" alt=""></div>`;
  }
  if (item.kind === 'video' && item.blob) {
    const url = URL.createObjectURL(item.blob);
    return `<div class="modal-media"><video src="${url}" controls></video></div>`;
  }
  if (item.kind === 'audio' && item.blob) {
    const url = URL.createObjectURL(item.blob);
    return `<div class="modal-media"><audio src="${url}" controls></audio></div>`;
  }
  if (item.kind === 'document' && item.blob) {
    const url = URL.createObjectURL(item.blob);
    return `<div class="modal-media" style="padding:24px;text-align:center;">
      <p style="color:var(--ink-dim);margin-bottom:12px;">${escapeHtml(item.fileName || 'documento')}</p>
      <a class="btn btn-secondary" href="${url}" download="${escapeHtml(item.fileName || 'arquivo')}">Baixar arquivo</a>
    </div>`;
  }
  if (item.kind === 'link') {
    return `<div class="modal-media" style="padding:24px;">
      <a class="modal-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.url)}</a>
    </div>`;
  }
  if (item.kind === 'text') {
    return `<div class="modal-text-body">${escapeHtml(item.body || '')}</div>`;
  }
  return '';
}

function openModal(item) {
  const modal = el('#modal');
  const localTags = [...item.tags];

  modal.innerHTML = `
    <div class="modal-meta-row">
      <span class="modal-date">${new Date(item.createdAt).toLocaleString('pt-BR')}</span>
      <button class="modal-close" id="modal-close-btn" aria-label="fechar">×</button>
    </div>
    <h2 class="modal-title">${escapeHtml(item.title || 'Sem título')}</h2>
    <div id="modal-media-slot"></div>
    <div class="tag-input-wrap" style="margin-bottom:16px;">
      <span class="field-label">Tags</span>
      <div class="tag-input" id="modal-tag-shell">
        <input type="text" id="modal-tag-input" placeholder="adicionar tag e pressionar Enter">
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger" id="modal-delete-btn">Excluir item</button>
      <button class="btn btn-secondary" id="modal-close-btn-2">Fechar</button>
    </div>
  `;

  el('#modal-media-slot').innerHTML = buildModalMediaHtml(item);
  renderTagChips(localTags, el('#modal-tag-shell'), el('#modal-tag-input'), async () => {
    item.tags = localTags;
    await updateItem(item.id, { tags: localTags });
    renderTimelineScreen();
  });
  setupTagInput(el('#modal-tag-input'), el('#modal-tag-shell'), localTags, async () => {
    item.tags = localTags;
    await updateItem(item.id, { tags: localTags });
    renderTimelineScreen();
  });

  el('#modal-close-btn').addEventListener('click', closeModal);
  el('#modal-close-btn-2').addEventListener('click', closeModal);
  el('#modal-delete-btn').addEventListener('click', async () => {
    if (!confirm('Excluir este item do acervo? Essa ação não pode ser desfeita.')) return;
    await deleteItem(item.id);
    items = items.filter(i => i.id !== item.id);
    closeModal();
    renderTimelineScreen();
    showToast('Item excluído');
  });

  el('#modal-overlay').hidden = false;
}

// ============================================================
// PROFILE
// ============================================================

function setupProfile() {
  el('#avatar-upload').querySelector('input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAvatarFile = file;
    const url = URL.createObjectURL(file);
    const img = el('#avatar-img');
    img.src = url;
    img.hidden = false;
    el('#avatar-placeholder').hidden = true;
    await saveProfile({ avatarBlob: file });
    profileCache = await getProfile();
    showToast('Avatar atualizado');
  });

  el('#save-profile').addEventListener('click', async () => {
    const name = el('#profile-name').value.trim();
    const bio = el('#profile-bio').value.trim();
    await saveProfile({ name, bio });
    profileCache = await getProfile();
    showToast('Perfil salvo');
  });

  el('#default-grouping').addEventListener('change', async (e) => {
    currentGrouping = e.target.value;
    await saveProfile({ defaultGrouping: currentGrouping });
    applyGroupingButtonsState();
    renderTimelineScreen();
  });

  el('#export-data').addEventListener('click', async () => {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `acervo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Backup exportado');
  });

  el('#import-data-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Importar este backup? Itens com o mesmo ID serão substituídos.')) {
      e.target.value = '';
      return;
    }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await importAll(data);
      items = await getAllItems();
      profileCache = await getProfile();
      renderTimelineScreen();
      renderProfileScreen();
      showToast('Backup importado');
    } catch (err) {
      showToast('Erro ao importar: ' + err.message);
    }
    e.target.value = '';
  });

  el('#clear-data').addEventListener('click', async () => {
    if (!confirm('Isso vai apagar TODOS os itens e o perfil deste navegador. Exportou um backup recentemente? Esta ação não pode ser desfeita.')) return;
    await clearAll();
    items = [];
    profileCache = await getProfile();
    renderTimelineScreen();
    renderProfileScreen();
    showToast('Dados removidos');
  });
}

function renderProfileScreen() {
  if (!profileCache) return;
  el('#profile-name').value = profileCache.name || '';
  el('#profile-bio').value = profileCache.bio || '';
  el('#default-grouping').value = profileCache.defaultGrouping || 'month';

  const img = el('#avatar-img');
  const placeholder = el('#avatar-placeholder');
  if (profileCache.avatarBlob instanceof Blob) {
    const url = URL.createObjectURL(profileCache.avatarBlob);
    img.src = url;
    img.hidden = false;
    placeholder.hidden = true;
  } else {
    img.hidden = true;
    placeholder.hidden = false;
  }

  renderStats();
}

function renderStats() {
  const byKind = { image: 0, audio: 0, video: 0, text: 0, link: 0, document: 0 };
  items.forEach(i => { if (byKind[i.kind] !== undefined) byKind[i.kind]++; });
  const tagCount = allTags().length;

  const stats = [
    ['Itens no total', items.length],
    ['Tags únicas', tagCount],
    ['Imagens', byKind.image],
    ['Textos', byKind.text],
    ['Áudios', byKind.audio],
    ['Vídeos', byKind.video],
    ['Links', byKind.link],
    ['Documentos', byKind.document],
  ];

  el('#stats-grid').innerHTML = stats.map(([label, num]) => `
    <div class="stat">
      <div class="stat-num">${num}</div>
      <div class="stat-label">${label}</div>
    </div>
  `).join('');
}

// ============================================================
// INIT
// ============================================================

async function init() {
  items = await getAllItems();
  profileCache = await getProfile();
  currentGrouping = profileCache.defaultGrouping || 'month';

  setupNav();
  setupComposer();
  setupTimelineControls();
  setupSearch();
  setupModal();
  setupProfile();

  applyGroupingButtonsState();
  renderTimelineScreen();
}

init();
