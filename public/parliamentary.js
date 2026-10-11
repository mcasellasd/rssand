(() => {
  const list = document.getElementById('initiative-list');
  const status = document.getElementById('initiative-status');
  const notice = document.getElementById('initiative-notice');
  const errorBox = document.getElementById('initiative-error');
  const search = document.getElementById('initiative-search');
  const typeSelect = document.getElementById('initiative-type');
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
  function render() {
    const term = search.value.trim().toLocaleLowerCase('ca');
    const selectedType = typeSelect.value;
    const filtered = initiatives.filter(item =>
      (!term || (item.title + ' ' + item.latestAction).toLocaleLowerCase('ca').includes(term)) &&
      (selectedType === 'all' || item.category === selectedType)
    );
    if (!filtered.length) {
      list.innerHTML = '<div class="initiative-empty glass-card">No hi ha iniciatives que coincideixin amb aquests filtres.</div>';
      return;
    }
    list.innerHTML = filtered.map(item => {
      const docs = (item.documents || []).map(document =>
        '<li><a href="' + safeUrl(document.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(document.title) + '</a></li>'
      ).join('');
      const docsHtml = docs ? '<details class="initiative-documents"><summary>' + item.documents.length + ' document(s)</summary><ul>' + docs + '</ul></details>' : '';
      return '<article class="initiative-card glass-card">' +
        '<div class="initiative-card-top"><span class="initiative-kind">' + escapeHtml(item.type) + '</span><time class="initiative-date">' + escapeHtml(displayDate(item.date)) + '</time></div>' +
        '<h3>' + escapeHtml(item.title) + '</h3><span class="initiative-stage">' + escapeHtml(item.stage) + '</span>' +
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
      const types = [...new Set(initiatives.map(item => item.category).filter(Boolean))];
      const previousType = typeSelect.value;
      typeSelect.innerHTML = '<option value="all">Tots els tipus</option>' + types.map(type => '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + '</option>').join('');
      typeSelect.value = types.includes(previousType) ? previousType : 'all';
      const updated = new Date(data.updatedAt);
      const updatedText = Number.isNaN(updated.getTime()) ? '' : ' · l’' + updated.toLocaleString('ca-AD');
      status.textContent = initiatives.length + ' iniciatives · dades consultades' + updatedText + (data.cached ? ' · memòria cau' : '');
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
  search.addEventListener('input', render);
  typeSelect.addEventListener('change', render);
  refreshButton.addEventListener('click', () => load(true));
  load(false);
})();
