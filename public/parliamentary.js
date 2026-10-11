(() => {
  const list = document.getElementById('initiative-list');
  const status = document.getElementById('initiative-status');
  const notice = document.getElementById('initiative-notice');
  const errorBox = document.getElementById('initiative-error');
  const search = document.getElementById('initiative-search');
  const stageSelect = document.getElementById('initiative-stage');
  const typeSelect = document.getElementById('initiative-type');
  const periodSelect = document.getElementById('initiative-period');
  const sortSelect = document.getElementById('initiative-sort');
  const clearButton = document.getElementById('initiative-clear');
  const refreshButton = document.getElementById('initiative-refresh');
  const themeButton = document.getElementById('btn-theme-toggle');
  let initiatives = [];

  function applyTheme(isLight) {
    document.body.classList.toggle('light-mode', isLight);
    if (!themeButton) return;
    themeButton.innerHTML = isLight ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    themeButton.setAttribute('aria-label', isLight ? 'Activa el mode fosc' : 'Activa el mode clar');
    themeButton.title = isLight ? 'Activa el mode fosc' : 'Activa el mode clar';
  }

  applyTheme(localStorage.getItem('theme') === 'light');
  themeButton?.addEventListener('click', () => {
    const isLight = !document.body.classList.contains('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    applyTheme(isLight);
  });

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'seu.consellgeneral.ad' ? url.href : '#';
    } catch (_) { return '#'; }
  }
  function displayDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? match[3] + '/' + match[2] + '/' + match[1] : (value || 'Data no identificada');
  }
  function stageClass(stage) {
    const normalized = String(stage || '').toLocaleLowerCase('ca');
    if (/aprovada|desestimada|closa|retirada/.test(normalized)) return 'is-final';
    if (/esmen|informe|comissió|comissio|pròrroga|prorroga/.test(normalized)) return 'is-review';
    if (/pendent|admesa|presentada|tràmit|tramit/.test(normalized)) return 'is-active';
    return 'is-neutral';
  }
  function render() {
    const term = search.value.trim().toLocaleLowerCase('ca');
    const selectedStage = stageSelect.value;
    const selectedType = typeSelect.value;
    const periodDays = Number(periodSelect.value) || 0;
    const cutoff = periodDays ? new Date(Date.now() - periodDays * 86400000).toISOString().slice(0, 10) : '';
    const filtered = initiatives.filter(item => {
      const searchable = [item.title, item.latestAction, item.category, item.type, item.stage].join(' ').toLocaleLowerCase('ca');
      return (!term || searchable.includes(term)) &&
        (selectedStage === 'all' || item.stage === selectedStage) &&
        (selectedType === 'all' || item.category === selectedType) &&
        (!cutoff || (item.date && item.date >= cutoff));
    }).sort((a, b) => {
      if (sortSelect.value === 'title') return a.title.localeCompare(b.title, 'ca');
      const byDate = (a.date || '').localeCompare(b.date || '');
      return sortSelect.value === 'oldest' ? byDate : -byDate;
    });
    status.textContent = (filtered.length === initiatives.length
      ? initiatives.length + ' iniciatives'
      : filtered.length + ' de ' + initiatives.length + ' iniciatives') + (status.dataset.updated || '');
    if (!filtered.length) {
      list.innerHTML = '<div class="initiative-empty glass-card"><i class="fa-solid fa-filter-circle-xmark"></i><strong>Cap resultat amb aquests filtres</strong><span>Canvia la cerca o neteja els filtres per tornar a veure totes les iniciatives.</span></div>';
      return;
    }
    list.innerHTML = filtered.map(item => {
      const docs = (item.documents || []).map(document =>
        '<li><a href="' + safeUrl(document.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(document.title) + '</a></li>'
      ).join('');
      const docsHtml = docs ? '<details class="initiative-documents"><summary>' + item.documents.length + ' document(s)</summary><ul>' + docs + '</ul></details>' : '';
      return '<article class="initiative-card glass-card">' +
        '<div class="initiative-card-top"><span class="initiative-kind">' + escapeHtml(item.type) + '</span><time class="initiative-date">' + escapeHtml(displayDate(item.date)) + '</time></div>' +
        '<h3>' + escapeHtml(item.title) + '</h3><span class="initiative-stage ' + stageClass(item.stage) + '">' + escapeHtml(item.stage) + '</span>' +
        '<p class="initiative-action">' + escapeHtml(item.latestAction) + '</p>' +
        '<div class="initiative-card-bottom"><a href="' + safeUrl(item.url) + '" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> Fitxa oficial</a>' + docsHtml + '</div></article>';
    }).join('');
  }
  async function load(refresh) {
    refreshButton.disabled = true;
    refreshButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Consultant…';
    errorBox.classList.add('hide');
    notice.classList.add('hide');
    status.textContent = 'Consultant les publicacions del Consell General…';
    try {
      const response = await fetch('/api/parliamentary-tracking' + (refresh ? '?refresh=true' : ''));
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'No s’han pogut carregar les publicacions.');
      initiatives = data.initiatives || [];
      const types = [...new Set(initiatives.map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ca'));
      const stages = [...new Set(initiatives.map(item => item.stage).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ca'));
      const previousType = typeSelect.value;
      const previousStage = stageSelect.value;
      typeSelect.innerHTML = '<option value="all">Totes les categories · ' + initiatives.length + '</option>' + types.map(type => {
        const count = initiatives.filter(item => item.category === type).length;
        return '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + ' · ' + count + '</option>';
      }).join('');
      typeSelect.value = types.includes(previousType) ? previousType : 'all';
      stageSelect.innerHTML = '<option value="all">Tots els estats · ' + initiatives.length + '</option>' + stages.map(stage => {
        const count = initiatives.filter(item => item.stage === stage).length;
        return '<option value="' + escapeHtml(stage) + '">' + escapeHtml(stage) + ' · ' + count + '</option>';
      }).join('');
      stageSelect.value = stages.includes(previousStage) ? previousStage : 'all';
      const updated = new Date(data.updatedAt);
      const updatedText = Number.isNaN(updated.getTime()) ? '' : ' · l’' + updated.toLocaleString('ca-AD');
      status.dataset.updated = updatedText + (data.cached ? ' · memòria cau' : '');
      if (data.partial) {
        const incomplete = (data.categoriesChecked || []).filter(category => !category.available || !category.complete);
        const labels = incomplete.map(category => category.label).join(', ');
        notice.textContent = 'La consulta no s’ha pogut completar per a totes les categories' + (labels ? ' (' + labels + ')' : '') + '. La llista pot ser parcial; consulta el registre oficial.';
        notice.classList.remove('hide');
      }
      render();
    } catch (error) {
      initiatives = [];
      list.innerHTML = '';
      status.textContent = 'No s’han pogut carregar les iniciatives.';
      errorBox.innerHTML = escapeHtml(error.message) + ' <a href="https://seu.consellgeneral.ad/normativaMilloradaAnunciPublic/categories?tipusId=11" target="_blank" rel="noopener noreferrer">Obre el registre oficial</a>.';
      errorBox.classList.remove('hide');
    } finally {
      refreshButton.disabled = false;
      refreshButton.innerHTML = '<i class="fa-solid fa-rotate"></i> Actualitza';
    }
  }
  [search, stageSelect, typeSelect, periodSelect, sortSelect].forEach(control => {
    control.addEventListener(control === search ? 'input' : 'change', render);
  });
  clearButton.addEventListener('click', () => {
    search.value = '';
    stageSelect.value = 'all';
    typeSelect.value = 'all';
    periodSelect.value = 'all';
    sortSelect.value = 'newest';
    render();
  });
  search.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      search.focus();
    }
  });
  refreshButton.addEventListener('click', () => load(true));
  load(false);
})();
