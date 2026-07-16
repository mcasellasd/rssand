(function exposeLegalBriefState(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LegalBriefState = api;
}(typeof window !== 'undefined' ? window : globalThis, function createLegalBriefState() {
    function parseArray(value) {
        if (!value) return [];
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function uniqueLinks(items, limit = 800) {
        const links = [];
        const seen = new Set();
        for (const item of items || []) {
            const link = typeof item === 'string' ? item : item?.link;
            if (!link || seen.has(link)) continue;
            seen.add(link);
            links.push(link);
            if (links.length === limit) break;
        }
        return links;
    }

    function findNewLinks(items, knownLinks, hasBaseline) {
        if (!hasBaseline) return [];
        const known = new Set(knownLinks || []);
        return uniqueLinks(items).filter(link => !known.has(link));
    }

    function normalizeSavedItems(items, limit = 100) {
        const normalized = [];
        const seen = new Set();
        for (const item of items || []) {
            if (!item || typeof item !== 'object' || !item.link || seen.has(item.link)) continue;
            seen.add(item.link);
            normalized.push({
                source: item.source || 'Font oficial',
                sourceId: item.sourceId || 'other',
                title: item.title || 'Publicació sense títol',
                link: item.link,
                date: item.date || null,
                snippet: item.snippet || '',
                category: item.category || 'Actualitat jurídica',
                documentType: item.documentType || 'Actualitat oficial',
                practiceArea: item.practiceArea || 'General i institucional',
                legalRelevance: item.legalRelevance || 'medium',
                isLegislative: item.isLegislative !== false,
                officialDocument: Boolean(item.officialDocument),
                entryIntoForce: item.entryIntoForce || null,
                operativeDeadlines: Array.isArray(item.operativeDeadlines) ? item.operativeDeadlines.slice(0, 2) : [],
                legalStage: item.legalStage || 'Seguiment',
                professionalAction: item.professionalAction || null,
                affectedProfiles: item.affectedProfiles || null,
                savedAt: item.savedAt || new Date().toISOString()
            });
            if (normalized.length === limit) break;
        }
        return normalized;
    }

    function toggleSavedItem(savedItems, item) {
        const normalized = normalizeSavedItems(savedItems);
        const exists = normalized.some(saved => saved.link === item.link);
        if (exists) return normalized.filter(saved => saved.link !== item.link);
        return normalizeSavedItems([{ ...item, savedAt: new Date().toISOString() }, ...normalized]);
    }

    return {
        parseArray,
        uniqueLinks,
        findNewLinks,
        normalizeSavedItems,
        toggleSavedItem
    };
}));
