document.addEventListener('DOMContentLoaded', () => {
    // STATE MANAGERS
    let allNewsItems = [];
    let currentTab = 'all';
    let searchQuery = '';
    let currentPracticeArea = 'all';
    let isLegalFilterStrict = true;

    // DOM ELEMENTS
    const feedSkeletons = document.getElementById('feed-skeletons');
    const feedGrid = document.getElementById('feed-grid');
    const feedEmpty = document.getElementById('feed-empty');
    
    const searchInput = document.getElementById('search-input');
    const searchClearBtn = document.getElementById('search-clear-btn');
    const practiceAreaSelect = document.getElementById('practice-area-select');
    const cgFilterToggle = document.getElementById('cg-filter-toggle');
    const bopaAlert = document.getElementById('bopa-alert');
    const cacheStatus = document.getElementById('cache-status');
    const sourceStatusBtn = document.getElementById('btn-source-status');
    const sourceStatusPanel = document.getElementById('source-status-panel');
    const sourceStatusSummary = document.getElementById('source-status-summary');
    const sourceStatusGrid = document.getElementById('source-status-grid');
    
    const refreshBtn = document.getElementById('btn-refresh');
    const resetFiltersBtn = document.getElementById('btn-reset-filters');
    const tabs = document.querySelectorAll('.tab-btn');

    // AI SUMMARY DOM ELEMENTS
    const btnAiSummary = document.getElementById('btn-ai-summary');
    const aiLoading = document.getElementById('ai-loading');
    const aiError = document.getElementById('ai-error');
    const aiErrorText = document.getElementById('ai-error-text');
    const aiSummaryContent = document.getElementById('ai-summary-content');
    const aiExecSummary = document.getElementById('ai-exec-summary');
    const aiKeyPoints = document.getElementById('ai-key-points');
    const aiSectors = document.getElementById('ai-sectors');
    const aiSummaryDate = document.getElementById('ai-summary-date');
    const aiSummaryMethod = document.getElementById('ai-summary-method');

    // NEWSLETTER DOM ELEMENTS
    const btnGenerateNewsletter = document.getElementById('btn-generate-newsletter');
    const newsletterSection = document.getElementById('newsletter-section');
    const newsletterLoading = document.getElementById('newsletter-loading');
    const newsletterError = document.getElementById('newsletter-error');
    const newsletterErrorText = document.getElementById('newsletter-error-text');
    const newsletterContent = document.getElementById('newsletter-content');
    const newsletterIframePreview = document.getElementById('newsletter-iframe-preview');
    
    const btnCopyHtml = document.getElementById('btn-copy-html');
    const btnCopyText = document.getElementById('btn-copy-text');
    const btnDownloadHtml = document.getElementById('btn-download-html');
    const copyToast = document.getElementById('copy-toast');

    let newsletterHtml = '';
    let newsletterText = '';



    // BRAND BADGES CLASS RESOLVER
    const sourceClassMap = {
        'consell_noticies': 'badge-consell',
        'tramitacio': 'badge-iniciatives',
        'apda': 'badge-apda',
        'govern': 'badge-govern',
        'andorra_ue': 'badge-ue',
        'afa': 'badge-afa',
        'bopa': 'badge-bopa'
    };

    const sourceIcons = {
        'consell_noticies': 'fa-landmark',
        'tramitacio': 'fa-file-signature',
        'apda': 'fa-shield-halved',
        'govern': 'fa-building-columns',
        'andorra_ue': 'fa-globe-europe',
        'afa': 'fa-coins',
        'bopa': 'fa-scroll'
    };

    // FORMAT DATE (YYYY-MM-DD -> DD/MM/YYYY)
    function formatDateDisplay(dateStr) {
        if (!dateStr) return '';
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        return dateStr;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function safeExternalUrl(value) {
        try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
        } catch (error) {
            return '#';
        }
    }

    // FETCH NEWS DATA FROM SERVER
    async function loadNewsFeed(bypassCache = false) {
        showLoadingState();
        try {
            const url = bypassCache ? '/api/news?refresh=true' : '/api/news';
            const response = await fetch(url);
            if (!response.ok) throw new Error(`El servidor ha retornat un codi d'error: ${response.status}`);
            
            const data = await response.json();
            allNewsItems = data.items || [];
            populatePracticeAreas();
            
            // Update cache status badge
            updateCacheBadge(data.cached, data.timestamp);
            updateSourceStatus(data.sources || []);
            
            // Apply filtering and render
            applyFiltersAndRender();
        } catch (error) {
            console.error('Error carregant les notícies:', error);
            showErrorState(error.message);
        }
    }

    function populatePracticeAreas() {
        const previousValue = currentPracticeArea;
        const areas = [...new Set(allNewsItems
            .map(item => item.practiceArea)
            .filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'ca'));

        practiceAreaSelect.innerHTML = '<option value="all">Totes les àrees de pràctica</option>';
        areas.forEach(area => {
            const option = document.createElement('option');
            option.value = area;
            option.textContent = area;
            practiceAreaSelect.appendChild(option);
        });
        practiceAreaSelect.value = areas.includes(previousValue) ? previousValue : 'all';
        currentPracticeArea = practiceAreaSelect.value;
    }

    function updateSourceStatus(sources) {
        const healthy = sources.filter(source => source.status === 'ok').length;
        const total = sources.length;
        const hasIncidents = sources.some(source => source.status !== 'ok');

        sourceStatusBtn.className = `source-status-btn ${hasIncidents ? 'degraded' : 'healthy'}`;
        sourceStatusBtn.innerHTML = hasIncidents
            ? `<i class="fa-solid fa-triangle-exclamation"></i> Fonts ${healthy}/${total}`
            : `<i class="fa-solid fa-circle-check"></i> Fonts ${healthy}/${total}`;
        sourceStatusSummary.textContent = hasIncidents
            ? `${healthy} de ${total} fonts disponibles`
            : `${total} fonts oficials disponibles`;

        sourceStatusGrid.innerHTML = '';
        sources.forEach(source => {
            const item = document.createElement('a');
            item.className = `source-status-item status-${source.status}`;
            item.href = safeExternalUrl(source.url);
            item.target = '_blank';
            item.rel = 'noopener noreferrer';
            const statusText = source.status === 'ok'
                ? `${source.itemsCount} publicacions`
                : source.status === 'warning' ? 'Sense resultats' : 'No disponible';
            const latestText = source.latestItemDate
                ? `Darrera publicació: ${formatDateDisplay(source.latestItemDate)}`
                : 'Sense data recent';
            item.innerHTML = `
                <span class="source-status-icon"><i class="fa-solid ${source.status === 'ok' ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i></span>
                <span>
                    <strong>${escapeHtml(source.name)}</strong>
                    <small>${escapeHtml(statusText)} · ${escapeHtml(latestText)}</small>
                </span>
                <i class="fa-solid fa-arrow-up-right-from-square source-status-link-icon"></i>
            `;
            sourceStatusGrid.appendChild(item);
        });
    }

    // UPDATE THE CACHE BADGE STATUS
    function updateCacheBadge(isCached, timestampStr) {
        const time = new Date(timestampStr);
        const timeText = time.toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' });
        
        cacheStatus.className = 'cache-badge'; // reset
        if (isCached) {
            cacheStatus.classList.add('cached');
            cacheStatus.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> Cached: ${timeText}`;
        } else {
            cacheStatus.classList.add('fresh');
            cacheStatus.innerHTML = `<i class="fa-solid fa-bolt"></i> Actualitzat: ${timeText}`;
        }
    }

    // SHOW/HIDE SKELETON LOADERS
    function showLoadingState() {
        feedGrid.classList.add('hide');
        feedEmpty.classList.add('hide');
        feedSkeletons.classList.remove('hide');
        refreshBtn.disabled = true;
        refreshBtn.querySelector('i').classList.add('spin');
    }

    function hideLoadingState() {
        feedSkeletons.classList.add('hide');
        refreshBtn.disabled = false;
        refreshBtn.querySelector('i').classList.remove('spin');
    }

    // SHOW ERROR MESSAGE IN EMPTY STATE
    function showErrorState(message) {
        hideLoadingState();
        feedGrid.classList.add('hide');
        feedEmpty.classList.remove('hide');
        feedEmpty.querySelector('h2').textContent = "Error al connectar";
        feedEmpty.querySelector('p').textContent = message || "No s'han pogut carregar les dades de les notícies. Comprova que el servidor local estigui executant-se.";
    }

    // FILTER & RENDER LOOP
    function applyFiltersAndRender() {
        hideLoadingState();
        
        // Handle Newsletter Tab specifically
        const controlPanel = document.querySelector('.control-panel');
        if (currentTab === 'newsletter') {
            feedGrid.classList.add('hide');
            feedSkeletons.classList.add('hide');
            feedEmpty.classList.add('hide');
            bopaAlert.classList.add('hide');
            document.getElementById('ai-summary-container').classList.add('hide');
            newsletterSection.classList.remove('hide');
            if (controlPanel) controlPanel.classList.add('hide');
            
            // Auto-load newsletter if not loaded yet
            if (!newsletterHtml) {
                loadNewsletter();
            }
            return;
        } else {
            newsletterSection.classList.add('hide');
            document.getElementById('ai-summary-container').classList.remove('hide');
            if (controlPanel) controlPanel.classList.remove('hide');
        }
        
        // Filter by tab
        let filtered = allNewsItems;
        if (currentTab === 'tramitacio') {
            const legislativeProcessKeywords = [
                'projecte de llei', 'proposició de llei', 'proposta de reglament',
                'tràmit parlamentari', 'tramitació', 'modificació del codi',
                'aprova la modificació', 'aprovat el projecte', 'futura llei'
            ];
            filtered = filtered.filter(item => {
                const text = `${item.title || ''} ${item.category || ''}`.toLowerCase();
                return legislativeProcessKeywords.some(keyword => text.includes(keyword));
            });
        } else if (currentTab !== 'all') {
            filtered = filtered.filter(item => item.sourceId === currentTab);
        }

        // Default professional view: omit institutional or informative items
        // without a concrete legal or regulatory signal.
        if (isLegalFilterStrict) {
            filtered = filtered.filter(item => {
                return item.isLegislative !== false && item.legalRelevance !== 'low';
            });
        }

        if (currentPracticeArea !== 'all') {
            filtered = filtered.filter(item => item.practiceArea === currentPracticeArea);
        }

        // Filter by Search Query
        if (searchQuery.trim() !== '') {
            const query = searchQuery.toLowerCase().trim();
            filtered = filtered.filter(item => 
                (item.title && item.title.toLowerCase().includes(query)) ||
                (item.snippet && item.snippet.toLowerCase().includes(query)) ||
                (item.source && item.source.toLowerCase().includes(query)) ||
                (item.category && item.category.toLowerCase().includes(query)) ||
                (item.documentType && item.documentType.toLowerCase().includes(query)) ||
                (item.practiceArea && item.practiceArea.toLowerCase().includes(query))
            );
        }

        // Toggle BOPA Alert Banner Visibility
        if (currentTab === 'bopa') {
            bopaAlert.classList.remove('hide');
        } else {
            bopaAlert.classList.add('hide');
        }

        // Render cards
        if (filtered.length === 0) {
            feedGrid.classList.add('hide');
            feedEmpty.classList.remove('hide');
            // reset title/text to default empty
            feedEmpty.querySelector('h2').textContent = "No s'han trobat notícies";
            feedEmpty.querySelector('p').textContent = "No hi ha elements que coincideixin amb els filtres actius o la cerca especificada.";
        } else {
            feedEmpty.classList.add('hide');
            feedGrid.innerHTML = '';
            
            filtered.forEach(item => {
                const card = createNewsCard(item);
                feedGrid.appendChild(card);
            });
            
            feedGrid.classList.remove('hide');
        }
    }

    // CREATE CARD DOM ELEMENT
    function createNewsCard(item) {
        const card = document.createElement('article');
        card.className = 'glass-card news-card';
        
        // Source specific badge classes
        const badgeClass = sourceClassMap[item.sourceId] || 'badge-govern';
        const sourceIcon = sourceIcons[item.sourceId] || 'fa-newspaper';
        const sourceName = item.source || 'Font oficial';
        const safeLink = safeExternalUrl(item.link);
        const relevanceLabel = item.legalRelevance === 'high' ? 'Impacte jurídic alt' : 'Seguiment';
        const relevanceClass = item.legalRelevance === 'high' ? 'relevance-high' : 'relevance-medium';
        const entryIntoForceHtml = item.entryIntoForce ? `
            <div class="entry-into-force">
                <i class="fa-solid fa-calendar-check"></i>
                <span><strong>Entrada en vigor:</strong> ${escapeHtml(item.entryIntoForce)}</span>
            </div>
        ` : '';

        const displayDate = formatDateDisplay(item.date);

        let bopaIndicatorHtml = '';
        if (item.officialDocument) {
            bopaIndicatorHtml = `
                <div class="official-document-indicator">
                    <i class="fa-solid fa-circle-check"></i> Document oficial
                </div>
            `;
        }

        card.innerHTML = `
            <div>
                <div class="card-header-meta">
                    <span class="source-badge ${badgeClass}">
                        <i class="fa-solid ${sourceIcon}"></i> ${escapeHtml(sourceName)}
                    </span>
                    <span class="news-date">
                        <i class="fa-regular fa-calendar"></i> ${displayDate}
                    </span>
                </div>
                
                <h3 class="news-title">
                    <a href="${safeLink}" target="_blank" rel="noopener noreferrer" title="Obrir la font oficial">${escapeHtml(item.title)}</a>
                </h3>
                
                ${bopaIndicatorHtml}
                ${entryIntoForceHtml}
                
                <p class="news-snippet">${escapeHtml(item.snippet || "Sense descripció disponible. Obriu la font oficial per consultar el contingut complet.")}</p>
            </div>
            
            <div class="card-footer">
                <div class="card-tags">
                    <span class="category-tag">
                        <i class="fa-solid fa-file-lines"></i> ${escapeHtml(item.documentType || "Actualitat oficial")}
                    </span>
                    <span class="practice-area-tag"><i class="fa-solid fa-briefcase"></i> ${escapeHtml(item.practiceArea || "General")}</span>
                    <span class="relevance-tag ${relevanceClass}">${relevanceLabel}</span>
                </div>
                
                <div class="card-actions">
                    <button class="btn-action-text btn-expand" title="Ampliar descripció">
                        <i class="fa-solid fa-circle-chevron-down"></i> Ampliar
                    </button>
                    <a href="${safeLink}" target="_blank" rel="noopener noreferrer" class="btn-action-link" title="Consultar la font oficial">
                        Font oficial <i class="fa-solid fa-arrow-up-right-from-square"></i>
                    </a>
                </div>
            </div>
        `;

        // Expand/Collapse event listener
        const expandBtn = card.querySelector('.btn-expand');
        const snippet = card.querySelector('.news-snippet');
        expandBtn.addEventListener('click', () => {
            snippet.classList.toggle('expanded');
            if (snippet.classList.contains('expanded')) {
                expandBtn.innerHTML = `<i class="fa-solid fa-circle-chevron-up"></i> Reduir`;
            } else {
                expandBtn.innerHTML = `<i class="fa-solid fa-circle-chevron-down"></i> Ampliar`;
            }
        });

        return card;
    }

    // EVENT LISTENERS

    // Refresh Feed button
    refreshBtn.addEventListener('click', () => {
        loadNewsFeed(true);
    });

    sourceStatusBtn.addEventListener('click', () => {
        const willOpen = sourceStatusPanel.classList.contains('hide');
        sourceStatusPanel.classList.toggle('hide');
        sourceStatusBtn.setAttribute('aria-expanded', String(willOpen));
    });

    // Reset filters empty state button
    resetFiltersBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchQuery = '';
        searchClearBtn.style.display = 'none';
        currentPracticeArea = 'all';
        practiceAreaSelect.value = 'all';
        isLegalFilterStrict = true;
        cgFilterToggle.checked = true;
        currentTab = 'all';
        tabs.forEach(t => {
            if (t.getAttribute('data-tab') === 'all') {
                t.classList.add('active');
            } else {
                t.classList.remove('active');
            }
        });
        applyFiltersAndRender();
    });

    // Search input
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        if (searchQuery.length > 0) {
            searchClearBtn.style.display = 'block';
        } else {
            searchClearBtn.style.display = 'none';
        }
        applyFiltersAndRender();
    });

    // Clear search button
    searchClearBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchQuery = '';
        searchClearBtn.style.display = 'none';
        applyFiltersAndRender();
    });

    // CG filter toggle slider
    cgFilterToggle.addEventListener('change', (e) => {
        isLegalFilterStrict = e.target.checked;
        applyFiltersAndRender();
    });

    practiceAreaSelect.addEventListener('change', (e) => {
        currentPracticeArea = e.target.value;
        applyFiltersAndRender();
    });

    // Navigation Tabs clicks
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTab = tab.getAttribute('data-tab');
            applyFiltersAndRender();
        });
    });

    // FETCH AI SUMMARY
    async function loadAiSummary() {
        btnAiSummary.disabled = true;
        btnAiSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Resumint...`;
        aiLoading.classList.remove('hide');
        aiSummaryContent.classList.add('hide');
        aiError.classList.add('hide');

        try {
            const response = await fetch('/api/news/summary');
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || `Error del servidor: ${response.status}`);
            }

            const data = await response.json();
            
            // Render Exec Summary
            aiExecSummary.textContent = data.resumExecutiu;

            // Render Key Points
            aiKeyPoints.innerHTML = '';
            if (data.puntsClau && data.puntsClau.length > 0) {
                data.puntsClau.forEach(pt => {
                    const li = document.createElement('li');
                    li.textContent = pt;
                    aiKeyPoints.appendChild(li);
                });
            } else {
                aiKeyPoints.innerHTML = '<li>Sense punts clau destacats aquesta setmana.</li>';
            }

            // Render Sectors
            aiSectors.innerHTML = '';
            if (data.categoriesDestacades && data.categoriesDestacades.length > 0) {
                data.categoriesDestacades.forEach(sec => {
                    const div = document.createElement('div');
                    div.className = 'ai-sector-item';
                    div.innerHTML = `
                        <span class="ai-sector-name">${escapeHtml(sec.nom)}</span>
                        <span class="ai-sector-desc">${escapeHtml(sec.explicacio)}</span>
                    `;
                    aiSectors.appendChild(div);
                });
            } else {
                aiSectors.innerHTML = '<div class="ai-sector-item"><span class="ai-sector-desc">No s\'ha categoritzat cap sector destacat.</span></div>';
            }

            // Render Date
            const dateText = new Date(data.timestamp).toLocaleDateString('ca-ES', { 
                day: '2-digit', 
                month: '2-digit', 
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            aiSummaryDate.innerHTML = `<i class="fa-regular fa-clock"></i> Resum del darrer període. Generat el ${dateText}`;
            aiSummaryMethod.innerHTML = data.editorialMode === 'ai'
                ? `<i class="fa-solid fa-wand-magic-sparkles"></i> Edició assistida per IA sobre fonts oficials`
                : `<i class="fa-solid fa-shield-halved"></i> Síntesi automàtica de fonts oficials`;
            aiSummaryMethod.title = data.editorialNote || '';

            // Show content, hide loading
            aiLoading.classList.add('hide');
            aiSummaryContent.classList.remove('hide');
            
            // Reset button state
            btnAiSummary.disabled = false;
            btnAiSummary.innerHTML = `<i class="fa-solid fa-rotate"></i> Actualitzar brief`;

        } catch (error) {
            console.error('Error al generar el resum amb IA:', error);
            aiLoading.classList.add('hide');
            aiSummaryContent.classList.add('hide');
            aiError.classList.remove('hide');

            let displayMsg = error.message;
            if (error.message.includes('QUOTA_EXCEEDED') || error.message.includes('Quota exceeded') || error.message.includes('quota') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('429')) {
                displayMsg = `<strong>Quota de l'API de Gemini excedida (Límit de regió o facturació).</strong><br><br>
                A la regió europea, Google AI Studio requereix tenir un compte de facturació vinculat al projecte de Google Cloud associat per poder utilitzar l'API, fins i tot si es manté dins els límits de crides de la tarifa gratuïta (Free Tier).<br><br>
                <strong>Com solucionar-ho:</strong><br>
                1. Afegeix un mètode de pagament al teu compte de facturació a Google AI Studio/Google Cloud per verificar el teu compte (el consum d'API seguirà sent gratuït dins els límits estàndard).<br>
                2. Alternativament, utilitza una connexió VPN amb IP de fora d'Europa (com ara els Estats Units) per saltar-te aquesta restricció regional de la Free Tier.`;
            } else {
                displayMsg = `S'ha produït un error al connectar amb el resum de la Intel·ligència Artificial:<br><br><code>${error.message}</code>`;
            }
            aiErrorText.innerHTML = displayMsg;

            btnAiSummary.disabled = false;
            btnAiSummary.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Error al generar`;
        }
    }

    // AI Summary button click
    btnAiSummary.addEventListener('click', () => {
        loadAiSummary();
    });

    // FETCH DAILY NEWSLETTER
    async function loadNewsletter(bypassCache = false) {
        btnGenerateNewsletter.disabled = true;
        btnGenerateNewsletter.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generant...`;
        newsletterLoading.classList.remove('hide');
        newsletterContent.classList.add('hide');
        newsletterError.classList.add('hide');

        try {
            const url = bypassCache ? '/api/news/newsletter?refresh=true' : '/api/news/newsletter';
            const response = await fetch(url);
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || `Error del servidor: ${response.status}`);
            }

            const data = await response.json();
            
            newsletterHtml = data.html;
            newsletterText = data.text;

            // Render preview inside iframe to isolate styling
            const iframeDoc = newsletterIframePreview.contentWindow.document || newsletterIframePreview.contentDocument;
            iframeDoc.open();
            iframeDoc.write(newsletterHtml);
            iframeDoc.close();

            // Adjust iframe height dynamically to fit content
            newsletterIframePreview.onload = () => {
                const height = newsletterIframePreview.contentWindow.document.body.scrollHeight;
                newsletterIframePreview.style.height = (height + 40) + 'px';
            };
            
            // Trigger height calculation immediately in case load event was already fired
            setTimeout(() => {
                try {
                    const height = newsletterIframePreview.contentWindow.document.body.scrollHeight;
                    newsletterIframePreview.style.height = (height + 40) + 'px';
                } catch (e) {
                    console.error("Iframe resize failed:", e);
                }
            }, 550);

            // Show content, hide loading
            newsletterLoading.classList.add('hide');
            newsletterContent.classList.remove('hide');
            
            btnGenerateNewsletter.disabled = false;
            btnGenerateNewsletter.innerHTML = `<i class="fa-solid fa-rotate"></i> Regenerar Butlletí`;

        } catch (error) {
            console.error('Error al generar el butlletí:', error);
            newsletterLoading.classList.add('hide');
            newsletterContent.classList.add('hide');
            newsletterError.classList.remove('hide');

            let displayMsg = error.message;
            if (error.message.includes('QUOTA_EXCEEDED')) {
                displayMsg = `<strong>Quota de l'API de Gemini excedida.</strong> Obre AI Studio per configurar la facturació o utilitza una VPN fora d'Europa.`;
            } else {
                displayMsg = `S'ha produït un error al connectar amb el generador de butlletins:<br><br><code>${error.message}</code>`;
            }
            newsletterErrorText.innerHTML = displayMsg;

            btnGenerateNewsletter.disabled = false;
            btnGenerateNewsletter.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Error al generar`;
        }
    }

    // Helper to show visual toast feedback
    function showToast(message) {
        copyToast.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${message}`;
        copyToast.classList.remove('hide');
        copyToast.classList.add('show');
        setTimeout(() => {
            copyToast.classList.remove('show');
            setTimeout(() => copyToast.classList.add('hide'), 300);
        }, 2000);
    }

    // Copy HTML button click
    btnCopyHtml.addEventListener('click', () => {
        if (!newsletterHtml) return;
        navigator.clipboard.writeText(newsletterHtml)
            .then(() => showToast("Codi HTML copiat al porta-retalls!"))
            .catch(err => {
                console.error("Failed to copy HTML:", err);
                const el = document.createElement('textarea');
                el.value = newsletterHtml;
                document.body.appendChild(el);
                el.select();
                document.execCommand('copy');
                document.body.removeChild(el);
                showToast("Codi HTML copiat!");
            });
    });

    // Copy Text button click
    btnCopyText.addEventListener('click', () => {
        if (!newsletterText) return;
        navigator.clipboard.writeText(newsletterText)
            .then(() => showToast("Text pla copiat al porta-retalls!"))
            .catch(err => {
                console.error("Failed to copy Text:", err);
                const el = document.createElement('textarea');
                el.value = newsletterText;
                document.body.appendChild(el);
                el.select();
                document.execCommand('copy');
                document.body.removeChild(el);
                showToast("Text pla copiat!");
            });
    });

    // Download HTML button click
    btnDownloadHtml.addEventListener('click', () => {
        if (!newsletterHtml) return;
        const blob = new Blob([newsletterHtml], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const todayStr = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `butlleti_andorra_${todayStr}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // Generate Newsletter button click
    btnGenerateNewsletter.addEventListener('click', () => {
        loadNewsletter(true);
    });

    // INITIAL LOAD
    loadNewsFeed();
});
