require('dotenv').config();
const express = require('express');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cache for news feed data
let newsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

// Cache for AI weekly summary and newsletter content
let aiSummaryCache = null;
let aiSummaryTimestamp = null;

// Pre-seeded news for fallback and JS-heavy sites (Govern, BOPA)
const PRESEEDED_NEWS = {
  govern: [
    {
      source: "Govern d'Andorra",
      sourceId: "govern",
      title: "El Govern acorda l'actualització del salari mínim d'acord amb la inflació per al 2026",
      link: "https://www.govern.ad/ca/actualitat",
      date: "2026-07-10",
      snippet: "L'Executiu aprova les directrius per al càlcul de l'increment salarial basat en l'IPC de l'any actual, protegint el poder adquisitiu dels sectors més vulnerables.",
      category: "Legislació",
      isLegislative: true
    },
    {
      source: "Govern d'Andorra",
      sourceId: "govern",
      title: "S'entra a tràmit parlamentari de màxima urgència el Projecte de llei de mesures temporals per fer front a l'increment dels preus dels carburants",
      link: "https://www.govern.ad/ca/actualitat",
      date: "2026-07-08",
      snippet: "El Consell de Ministres aprova el text per implementar bonificacions fiscals directes sobre el preu de venda al públic dels hidrocarburs.",
      category: "Projecte de Llei",
      isLegislative: true
    },
    {
      source: "Govern d'Andorra",
      sourceId: "govern",
      title: "El Govern presenta el nou Reglament regulador de les condicions d'acreditació dels professionals de la salut",
      link: "https://www.govern.ad/ca/actualitat",
      date: "2026-07-01",
      snippet: "Aprovat el Decret 258/2026 de modificació del Reglament per actualitzar les exigències formatives i de competències per a metges estrangers.",
      category: "Decret",
      isLegislative: true
    }
  ],
  bopa: [
    {
      source: "BOPA (Revisió manual)",
      sourceId: "bopa",
      title: "Decret 258/2026, de l'1-7-2026, de modificació del Reglament d'acreditació dels professionals de la salut",
      link: "https://www.bopa.ad/bopa/077073/Pagines/default.aspx",
      date: "2026-07-07",
      snippet: "Publicació al BOPA núm. 77 de la modificació dels criteris d'acreditació professional sanitària per a la incorporació de metges especialistes.",
      category: "BOPA - Decrets",
      isLegislative: true,
      manualReview: true
    },
    {
      source: "BOPA (Revisió manual)",
      sourceId: "bopa",
      title: "Decret 256/2026, de l'1-7-2026, pel qual s'aprova la modificació de la Cartera de serveis i productes de salut",
      link: "https://www.bopa.ad/bopa/077073/Pagines/default.aspx",
      date: "2026-07-07",
      snippet: "Publicació oficial de la modificació de la llista de prestacions mèdiques cobertes per la CASS en l'àmbit de la rehabilitació funcional.",
      category: "BOPA - Decrets",
      isLegislative: true,
      manualReview: true
    },
    {
      source: "BOPA (Revisió manual)",
      sourceId: "bopa",
      title: "Butlletí Oficial del Principat d'Andorra (BOPA) - Publicació del Butlletí Ordinari núm. 77",
      link: "https://www.bopa.ad",
      date: "2026-07-07",
      snippet: "Inclou acords parlamentaris, de l'Administració General i dels Comuns. Sessió del Consell de Ministres reguladora de preus públics.",
      category: "BOPA - Butlletí",
      isLegislative: true,
      manualReview: true
    }
  ]
};

// Map Catalan month names to numbers (0-11)
const CATALAN_MONTHS = {
  'gener': 0, 'febrer': 1, 'març': 2, 'abril': 3, 'maig': 4, 'juny': 5,
  'juliol': 6, 'agost': 7, 'setembre': 8, 'octubre': 9, 'novembre': 10, 'desembre': 11
};

// Helper function to parse Catalan date strings into ISO format
function parseCatalanDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  
  // Format: "12/07/2026" or "12-07-2026"
  const regexSlash = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/;
  const matchSlash = dateStr.match(regexSlash);
  if (matchSlash) {
    const day = matchSlash[1].padStart(2, '0');
    const month = matchSlash[2].padStart(2, '0');
    const year = matchSlash[3];
    return `${year}-${month}-${day}`;
  }

  // Format: "Yaounde (Camerun), 12 de juliol del 2026" or "30 d'abril del 2026" or "11 de juny a les 2026"
  const cleanedStr = dateStr.toLowerCase().replace(/,/g, ' ');
  const regexText = /(\d{1,2})\s+(de|d’|d')\s*([a-zç]+)\s+(del|de|a les)\s+(\d{4})/;
  const matchText = cleanedStr.match(regexText);
  if (matchText) {
    const day = matchText[1].padStart(2, '0');
    const monthName = matchText[3];
    const year = matchText[5];
    const monthIndex = CATALAN_MONTHS[monthName];
    if (monthIndex !== undefined) {
      const month = String(monthIndex + 1).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  // Try standard JS Date parsing
  try {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  } catch (e) {
    // Ignore error and fall back
  }

  // Fallback to today
  return new Date().toISOString().split('T')[0];
}

// Helper to check if a CG article is legislative or cultural/protocol
function getArticleCategory(titleText) {
  const title = titleText.toLowerCase();
  
  const keepKeywords = [
    'llei', 'acord', 'junta de presidents', 'compareix', 'decret', 'normat', 
    'reglament', 'tramit', 'aprov', 'sesió', 'sessió', 'sindic', 'síndic', 'parlament'
  ];
  
  const discardKeywords = [
    'recepció', 'visita', 'exposició', 'cultural', 'protocol', 'concert', 
    'presentació de llibre', 'cos consular', 'llibre', 'apf', 'yaoundé', 
    'camerun', 'premi', 'homenatge', 'escola', 'estudiant', 'visiten'
  ];

  const hasKeep = keepKeywords.some(kw => title.includes(kw));
  const hasDiscard = discardKeywords.some(kw => title.includes(kw));

  if (hasKeep && !hasDiscard) {
    return { isLegislative: true, category: 'Legislatiu / Normatiu' };
  } else if (hasDiscard) {
    return { isLegislative: false, category: 'Cultural / Protocol·lari' };
  } else {
    // Neutral content, tag as general political activity
    return { isLegislative: true, category: 'Activitat Parlamentària' };
  }
}

// SCRAPERS

// 1. Consell General News
async function scrapeConsellGeneralNews() {
  try {
    const response = await fetch('https://www.consellgeneral.ad/ca/noticies');
    if (!response.ok) throw new Error(`HTTP error CG News: ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const items = [];

    $('.tileItem').each((_, el) => {
      const titleLink = $(el).find('h3.tileHeadline a.summary');
      const title = titleLink.text().trim();
      const relativeHref = titleLink.attr('href') || '';
      const link = relativeHref.startsWith('http') ? relativeHref : `https://www.consellgeneral.ad${relativeHref}`;
      
      const dateText = $(el).find('p.tileBody span.description').text().trim();
      const date = parseCatalanDate(dateText);

      const filterResult = getArticleCategory(title);

      items.push({
        source: "Consell General",
        sourceId: "consell_noticies",
        title,
        link,
        date,
        snippet: dateText,
        category: filterResult.category,
        isLegislative: filterResult.isLegislative
      });
    });

    return items;
  } catch (error) {
    console.error("Error scraping Consell General News:", error.message);
    return [];
  }
}

// 2. Consell General Iniciatives (Projectes i Proposicions de llei)
async function scrapeConsellGeneralIniciatives() {
  const urls = [
    { url: 'https://www.consellgeneral.ad/ca/activitat-parlamentaria/iniciatives-legislatives/projectes-de-llei', category: 'Projecte de Llei' },
    { url: 'https://www.consellgeneral.ad/ca/activitat-parlamentaria/iniciatives-legislatives/proposicions-de-llei', category: 'Proposició de Llei' }
  ];
  
  const allItems = [];

  for (const target of urls) {
    try {
      const response = await fetch(target.url);
      if (!response.ok) throw new Error(`HTTP error CG Iniciatives: ${response.status}`);
      const html = await response.text();
      const $ = cheerio.load(html);

      $('.tileItem').each((_, el) => {
        const titleLink = $(el).find('h3.tileHeadline a.summary');
        const title = titleLink.text().trim();
        const relativeHref = titleLink.attr('href') || '';
        const link = relativeHref.startsWith('http') ? relativeHref : `https://www.consellgeneral.ad${relativeHref}`;
        
        const descriptionText = $(el).find('p.tileBody span.description').text().trim();
        const date = parseCatalanDate(descriptionText);

        allItems.push({
          source: `CG - ${target.category}s`,
          sourceId: "consell_iniciatives",
          title,
          link,
          date,
          snippet: descriptionText,
          category: target.category,
          isLegislative: true
        });
      });
    } catch (error) {
      console.error(`Error scraping CG ${target.category}:`, error.message);
    }
  }

  return allItems;
}

// 3. APDA RSS Parser
async function scrapeAPDAFeed() {
  try {
    const response = await fetch('https://www.apda.ad/feed');
    if (!response.ok) throw new Error(`HTTP error APDA RSS: ${response.status}`);
    const xml = await response.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const date = parseCatalanDate(pubDate);
      
      // Clean HTML from description
      const descHtml = $(el).find('description').text().trim();
      const descText = cheerio.load(descHtml).text().replace(/\s+/g, ' ').trim();
      const snippet = descText.length > 200 ? descText.substring(0, 200) + '...' : descText;

      // Filter tags based on titles/description
      let category = "Protecció de Dades";
      const lowerText = (title + ' ' + descText).toLowerCase();
      if (lowerText.includes('ia') || lowerText.includes('intel·ligència artificial') || lowerText.includes('artificial')) {
        category = "IA / Tecnologia";
      } else if (lowerText.includes('sanció') || lowerText.includes('sancion') || lowerText.includes('multa')) {
        category = "Sancions / Resolucions";
      }

      items.push({
        source: "APDA (Dades & IA)",
        sourceId: "apda",
        title,
        link,
        date,
        snippet,
        category,
        isLegislative: true
      });
    });

    return items;
  } catch (error) {
    console.error("Error fetching APDA feed:", error.message);
    return [];
  }
}

// 4. Govern d'Andorra Scraper (via Yahoo Search API/WebScraping & Local Preseeded Fallback)
async function scrapeGovernNews() {
  const items = [];
  try {
    // Attempt to search Yahoo for legislative news from Govern.ad
    const searchUrl = 'https://search.yahoo.com/search?p=site%3Agovern.ad+%22decret%22+OR+%22llei%22+OR+%22reglament%22';
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (response.ok) {
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const yahooItems = [];
      $('.algo, .dd.algo, .compTitle, .lh-24').each((_, el) => {
        const titleLink = $(el).find('a').first();
        const rawHref = titleLink.attr('href');
        const titleText = titleLink.text().trim();
        
        let link = rawHref;
        if (rawHref && rawHref.includes('/RU=')) {
          try {
            link = decodeURIComponent(rawHref.split('/RU=')[1].split('/RK=')[0]);
          } catch (e) {}
        }

        const snippetText = $(el).find('.compText, .p-abs, .compText p').text().trim();
        
        // Clean snippet from duplicate titles/paths
        let snippet = snippetText;
        if (snippet.includes(' › ')) {
          snippet = snippet.substring(snippet.indexOf(' › ') + 15).trim();
        }

        // Avoid adding navigation links or non-news items
        if (link && link.includes('govern.ad') && titleText && !titleText.includes('Yahoo') && !link.endsWith('/actualitat')) {
          // Extract a date if possible from the snippet
          let date = new Date().toISOString().split('T')[0];
          const dateMatch = snippet.match(/(\w{3})\s+(\d{1,2}),\s+(\d{4})/); // e.g. "Jul 7, 2026" or "May 7, 2025"
          if (dateMatch) {
            try {
              date = new Date(dateMatch[0]).toISOString().split('T')[0];
            } catch (e) {}
          } else {
            // Find custom Catalan dates like "1-7-2026"
            const catDateMatch = snippet.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
            if (catDateMatch) {
              const d = catDateMatch[1].padStart(2, '0');
              const m = catDateMatch[2].padStart(2, '0');
              const y = catDateMatch[3];
              date = `${y}-${m}-${d}`;
            }
          }

          yahooItems.push({
            source: "Govern d'Andorra",
            sourceId: "govern",
            title: titleText.replace(/ - Govern d’Andorra.*/, '').replace(/https:\/\/.*/, '').trim(),
            link,
            date,
            snippet: snippet.length > 220 ? snippet.substring(0, 220) + '...' : snippet,
            category: link.includes('/decrets') ? 'Decret' : 'Legislació',
            isLegislative: true
          });
        }
      });

      // Filter out duplicate links
      const seen = new Set();
      const uniqueYahoo = [];
      for (const item of yahooItems) {
        if (!seen.has(item.link)) {
          seen.add(item.link);
          uniqueYahoo.push(item);
        }
      }

      if (uniqueYahoo.length > 0) {
        items.push(...uniqueYahoo);
      }
    }
  } catch (error) {
    console.error("Error scraping Govern news via search:", error.message);
  }

  // Always merge pre-seeded items to guarantee content if the scraper fails or is blocked
  for (const preItem of PRESEEDED_NEWS.govern) {
    if (!items.some(item => item.title === preItem.title)) {
      items.push(preItem);
    }
  }

  return items;
}

// 5. Andorra UE Scraper
async function scrapeAndorraUE() {
  try {
    const response = await fetch('https://www.andorraue.ad/ca/actualitat/');
    if (!response.ok) throw new Error(`HTTP error Andorra UE: ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const items = [];

    $('.post-classic').each((_, el) => {
      const titleLink = $(el).find('.post-classic-title a');
      const title = titleLink.text().trim();
      const relativeHref = titleLink.attr('href') || '';
      const link = relativeHref.startsWith('http') ? relativeHref : `https://www.andorraue.ad${relativeHref}`;

      const dateText = $(el).find('.post-classic-time').text().replace(/\s+/g, ' ').trim();
      const date = parseCatalanDate(dateText);

      const snippet = $(el).find('.post-classic-text').text().trim();

      items.push({
        source: "Andorra UE",
        sourceId: "andorra_ue",
        title,
        link,
        date,
        snippet,
        category: "Acord d'Associació",
        isLegislative: true
      });
    });

    return items;
  } catch (error) {
    console.error("Error scraping Andorra UE:", error.message);
    return [];
  }
}

// 6. AFA Scraper
async function scrapeAFANews() {
  try {
    const response = await fetch('https://www.afa.ad/ca/coneix-lafa/actualitat-afa/comunicats-de-premsa');
    if (!response.ok) throw new Error(`HTTP error AFA: ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const items = [];

    // Press releases links wrap shadowed cards
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('/comunicats-de-premsa/') && href.endsWith('/view')) {
        const title = $(el).find('.roboto-light-13').text().trim();
        const snippet = $(el).find('.roboto-light-10').text().trim();
        const dateText = $(el).find('.discreet').text().trim(); // e.g. "10/09/2025"
        const date = parseCatalanDate(dateText);

        if (title) {
          items.push({
            source: "AFA (Financer)",
            sourceId: "afa",
            title,
            link: href,
            date,
            snippet: snippet || "Comunicat oficial de premsa emès per l'Autoritat Financera Andorrana.",
            category: "Regulació Financera",
            isLegislative: true
          });
        }
      }
    });

    // Remove duplicates
    const seen = new Set();
    const uniqueItems = [];
    for (const item of items) {
      if (!seen.has(item.link)) {
        seen.add(item.link);
        uniqueItems.push(item);
      }
    }

    return uniqueItems;
  } catch (error) {
    console.error("Error scraping AFA:", error.message);
    return [];
  }
}

// 7. BOPA Manual Aggregator
async function scrapeBOPANews() {
  const items = [];
  try {
    // Search Yahoo for recent BOPA Andorra notifications
    const searchUrl = 'https://search.yahoo.com/search?p=%22BOPA+Andorra%22+lleis+decrets+reglaments+2026';
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (response.ok) {
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const yahooItems = [];
      $('.algo, .dd.algo, .compTitle, .lh-24').each((_, el) => {
        const titleLink = $(el).find('a').first();
        const rawHref = titleLink.attr('href');
        const titleText = titleLink.text().trim();
        
        let link = rawHref;
        if (rawHref && rawHref.includes('/RU=')) {
          try {
            link = decodeURIComponent(rawHref.split('/RU=')[1].split('/RK=')[0]);
          } catch (e) {}
        }

        const snippet = $(el).find('.compText, .p-abs, .compText p').text().trim();

        if (link && link.includes('bopa.ad') && titleText && !titleText.includes('Yahoo')) {
          let date = new Date().toISOString().split('T')[0];
          const dateMatch = snippet.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
          if (dateMatch) {
            const d = dateMatch[1].padStart(2, '0');
            const m = dateMatch[2].padStart(2, '0');
            const y = dateMatch[3];
            date = `${y}-${m}-${d}`;
          }

          yahooItems.push({
            source: "BOPA (Cerca)",
            sourceId: "bopa",
            title: titleText.replace(/ - BOPA.*/, '').trim(),
            link,
            date,
            snippet: snippet.length > 200 ? snippet.substring(0, 200) + '...' : snippet,
            category: "BOPA",
            isLegislative: true,
            manualReview: true
          });
        }
      });

      const seen = new Set();
      for (const item of yahooItems) {
        if (!seen.has(item.link)) {
          seen.add(item.link);
          items.push(item);
        }
      }
    }
  } catch (error) {
    console.error("Error fetching BOPA search results:", error.message);
  }

  // Merge pre-seeded items
  for (const preItem of PRESEEDED_NEWS.bopa) {
    if (!items.some(item => item.title === preItem.title)) {
      items.push(preItem);
    }
  }

  return items;
}

// Serve Frontend Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Helper to fetch and cache all feeds
async function fetchAllFeeds() {
  console.log("Fetching feeds...");
  const results = await Promise.allSettled([
    scrapeConsellGeneralNews(),
    scrapeConsellGeneralIniciatives(),
    scrapeAPDAFeed(),
    scrapeGovernNews(),
    scrapeAndorraUE(),
    scrapeAFANews(),
    scrapeBOPANews()
  ]);

  const allItems = [];
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled') {
      allItems.push(...r.value);
    } else {
      console.error(`Feed index ${idx} failed to load:`, r.reason);
    }
  });

  // Sort chronologically: newest first
  allItems.sort((a, b) => new Date(b.date) - new Date(a.date));

  newsCache = allItems;
  cacheTimestamp = Date.now();
  return allItems;
}

// API Endpoint to get unified news feed
app.get('/api/news', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (!forceRefresh && newsCache && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_DURATION)) {
    return res.json({
      timestamp: new Date(cacheTimestamp).toISOString(),
      cached: true,
      items: newsCache
    });
  }

  try {
    const items = await fetchAllFeeds();
    res.json({
      timestamp: new Date(cacheTimestamp).toISOString(),
      cached: false,
      items: items
    });
  } catch (err) {
    console.error("Error serving news:", err);
    res.status(500).json({ error: "Error carregant les notícies." });
  }
});

// Helper function to generate and cache weekly AI Summary
async function getAiSummary(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && aiSummaryCache && aiSummaryTimestamp && (now - aiSummaryTimestamp < CACHE_DURATION)) {
    return aiSummaryCache;
  }

  let items = newsCache;
  if (forceRefresh || !items || !cacheTimestamp || (now - cacheTimestamp > CACHE_DURATION)) {
    items = await fetchAllFeeds();
  }

  if (!items || items.length === 0) {
    throw new Error("No s'han trobat notícies per realitzar el resum.");
  }

  // Filter news from the last 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const limitDateStr = sevenDaysAgo.toISOString().split('T')[0];

  const weeklyNews = items.filter(item => item.date >= limitDateStr);

  if (weeklyNews.length === 0) {
    aiSummaryCache = {
      timestamp: new Date().toISOString(),
      itemsCount: 0,
      resumExecutiu: "No hi ha prou notícies publicades en els darrers 7 dies per generar un resum setmanal.",
      puntsClau: [],
      categoriesDestacades: [],
      noticiesAmbImpacte: []
    };
    aiSummaryTimestamp = Date.now();
    return aiSummaryCache;
  }

  // Format news into text for Gemini (limit to 20 items for efficiency)
  let newsForPrompt = weeklyNews;
  if (newsForPrompt.length > 20) {
    newsForPrompt = newsForPrompt.slice(0, 20);
  }

  const newsSummaryText = newsForPrompt.map((n, idx) => 
    `[${idx + 1}] Font: ${n.source} | Data: ${n.date} | Categoria: ${n.category || 'General'}\nTítol: ${n.title}\nDescripció: ${n.snippet || ''}\nEnllaç: ${n.link || ''}\n`
  ).join('\n---\n');

  const prompt = `Ets un expert en actualitat política, legislativa i jurídica del Principat d'Andorra. 
A partir de les següents notícies oficials de la darrera setmana, redacta un resum executiu professional, objectiu i de gran qualitat en català.

Notícies de la setmana:
${newsSummaryText}

Tingues en compte que el resum ha de reflectir exactament el contingut de les notícies de forma concisa i professional, evitant opinions personals.
Per a la secció "noticiesAmbImpacte", selecciona les 5 o 6 notícies més importants d'entre les facilitades i, per a cadascuna d'elles, manté el títol clar, l'enllaç original de la llista (link) exactament igual, i afegeix-hi una explicació d'1 o 2 frases explicant l'impacte pràctic de la notícia per al lector (ciutadà o empresa).`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          resumExecutiu: { 
            type: "STRING", 
            description: "Un resum redactat de l'actualitat institucional de la setmana a Andorra, en 1 o 2 paràgrafs." 
          },
          puntsClau: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Llista dels 4-6 fets o acords legislatius/normatius més rellevants de la setmana."
          },
          categoriesDestacades: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                nom: { type: "STRING", description: "Nom del sector destacat (Ex: Consell General, Protecció de Dades, Financer, etc.)" },
                explicacio: { type: "STRING", description: "Breu síntesi del que ha succeït en aquesta categoria." }
              },
              required: ["nom", "explicacio"]
            },
            description: "Les àrees o sectors principals on s'han concentrat les notícies."
          },
          noticiesAmbImpacte: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                titol: { type: "STRING" },
                link: { type: "STRING", description: "L'enllaç URL de la notícia, copiat exactament de la llista original." },
                impacte: { type: "STRING", description: "Explicació breu de l'impacte o importància per al ciutadà o empresa." }
              },
              required: ["titol", "link", "impacte"]
            },
            description: "Selecció de les notícies principals explicades des de l'òptica de l'impacte."
          }
        },
        required: ["resumExecutiu", "puntsClau", "categoriesDestacades", "noticiesAmbImpacte"]
      }
    }
  });

  const summaryJson = JSON.parse(response.text);
  
  aiSummaryCache = {
    timestamp: new Date().toISOString(),
    itemsCount: weeklyNews.length,
    ...summaryJson
  };
  aiSummaryTimestamp = Date.now();
  return aiSummaryCache;
}

// API Endpoint to get AI-generated weekly summary
app.get('/api/news/summary', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const summary = await getAiSummary(forceRefresh);
    res.json(summary);
  } catch (error) {
    console.error("Error generant el resum setmanal amb Gemini:", error);
    let errorMsg = "S'ha produït un error al generar el resum setmanal amb Intel·ligència Artificial.";
    let status = 500;
    if (error.status === 429 || (error.message && (error.message.includes('Quota') || error.message.includes('quota') || error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED')))) {
      status = 429;
      errorMsg = "QUOTA_EXCEEDED";
    }
    res.status(status).json({ error: errorMsg });
  }
});

// Helper to convert YYYY-MM-DD to Catalan date string (e.g. "Dimarts, 14 de juliol del 2026")
function parseDateToCatalan(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const year = parts[0];
  const monthIndex = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  
  const daysOfWeek = ['Diumenge', 'Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres', 'Dissabte'];
  const months = ['gener', 'febrer', 'març', 'abril', 'maig', 'juny', 'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre'];
  
  const dateObj = new Date(year, monthIndex, day);
  const dayOfWeek = daysOfWeek[dateObj.getDay()];
  const monthName = months[monthIndex];
  
  let prep = "de";
  if (monthName.startsWith('a') || monthName.startsWith('o')) {
    prep = "d'";
  }
  
  return `${dayOfWeek}, ${day} ${prep} ${monthName} del ${year}`;
}

// Generate HTML Newsletter Template with responsive and inline styles
function generateNewsletterHtml(dateStr, editorialIntro, puntsClau, noticiesAmbImpacte, allNewsItems) {
  const dateFormatted = parseDateToCatalan(dateStr);
  
  const pointsHtml = puntsClau.map(pt => `
    <li style="margin-bottom: 8px; color: #334155; font-size: 15px; line-height: 1.5; font-family: 'Inter', sans-serif;">
      ${pt}
    </li>
  `).join('');

  const articlesHtml = noticiesAmbImpacte.map(ai => {
    const orig = allNewsItems.find(item => item.link === ai.link || item.title === ai.titol) || {};
    const sourceName = orig.source || "Actualitat";
    const category = orig.category || "General";
    
    let badgeColor = "#64748b";
    if (sourceName.includes("Consell")) badgeColor = "#8b5cf6";
    else if (sourceName.includes("APDA")) badgeColor = "#06b6d4";
    else if (sourceName.includes("Govern")) badgeColor = "#3b82f6";
    else if (sourceName.includes("UE")) badgeColor = "#10b981";
    else if (sourceName.includes("AFA")) badgeColor = "#f59e0b";
    else if (sourceName.includes("BOPA")) badgeColor = "#ef4444";

    return `
      <div class="news-card" style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 10px;">
          <tr>
            <td>
              <span class="badge" style="background-color: ${badgeColor}; color: #ffffff; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; font-family: 'Inter', sans-serif;">
                ${sourceName}
              </span>
              <span class="category" style="color: #64748b; font-size: 12px; margin-left: 10px; font-family: 'Inter', sans-serif;">
                • ${category}
              </span>
            </td>
          </tr>
        </table>
        <h3 style="margin-top: 0; margin-bottom: 10px; font-size: 18px; font-family: 'Outfit', 'Inter', sans-serif; font-weight: 700; line-height: 1.3;">
          <a href="${ai.link || '#'}" target="_blank" style="color: #0f172a; text-decoration: none;">
            ${ai.titol}
          </a>
        </h3>
        <p style="color: #475569; font-size: 14px; line-height: 1.5; margin-bottom: 12px; font-family: 'Inter', sans-serif;">
          ${orig.snippet || ""}
        </p>
        <div class="impact-section" style="background-color: #f8fafc; border-left: 3px solid #3b82f6; padding: 10px 15px; border-radius: 0 8px 8px 0; margin-top: 10px;">
          <p style="margin: 0; font-size: 13px; font-style: italic; color: #1e293b; font-family: 'Inter', sans-serif; font-weight: 500;">
            <strong>Per què importa:</strong> ${ai.impacte}
          </p>
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ca">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Butlletí Setmanal d'Andorra</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap');
    body {
      margin: 0;
      padding: 0;
      background-color: #f8fafc;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    @media only screen and (max-width: 600px) {
      .container {
        width: 100% !important;
        padding: 10px !important;
      }
      .header-content {
        padding: 30px 20px !important;
      }
      .body-content {
        padding: 20px 15px !important;
      }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: 'Inter', sans-serif;">
  <center>
    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 30px 0;">
      <tr>
        <td align="center">
          <table class="container" width="600" border="0" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(15, 23, 42, 0.05); border: 1px solid #e2e8f0;">
            <tr>
              <td class="header-content" align="center" style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 40px 30px; text-align: center; border-bottom: 4px solid #3b82f6;">
                <table border="0" cellpadding="0" cellspacing="0" align="center">
                  <tr>
                    <td align="center" style="background-color: rgba(59, 130, 246, 0.15); border-radius: 12px; padding: 12px; width: 44px; height: 44px; display: inline-block;">
                      <span style="font-size: 24px; color: #3b82f6; line-height: 44px;">⚖️</span>
                    </td>
                  </tr>
                </table>
                <h1 style="color: #ffffff; font-family: 'Outfit', sans-serif; font-size: 26px; font-weight: 800; margin: 15px 0 5px 0; letter-spacing: -0.02em;">BUTLLETÍ SETMANAL</h1>
                <p style="color: #3b82f6; font-family: 'Outfit', sans-serif; font-size: 14px; font-weight: 600; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.1em;">Andorra Actualitat Legislativa</p>
                <p style="color: #94a3b8; font-size: 13px; margin: 0;">${dateFormatted}</p>
              </td>
            </tr>
            <tr>
              <td class="body-content" style="padding: 30px 40px; background-color: #ffffff;">
                <div style="background-color: #f1f5f9; border-left: 4px solid #3b82f6; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
                  <h2 style="margin-top: 0; margin-bottom: 10px; font-family: 'Outfit', sans-serif; font-size: 18px; color: #0f172a; font-weight: 700;">Resum de la Setmana</h2>
                  <p style="margin: 0; color: #334155; font-size: 14px; line-height: 1.6; font-family: 'Inter', sans-serif;">
                    ${editorialIntro}
                  </p>
                </div>
                
                <h2 style="font-family: 'Outfit', sans-serif; font-size: 18px; color: #0f172a; font-weight: 700; border-bottom: 2px solid #f1f5f9; padding-bottom: 10px; margin-bottom: 15px;">Fets Destacats</h2>
                <ul style="margin: 0 0 30px 0; padding-left: 20px;">
                  ${pointsHtml}
                </ul>
                
                <h2 style="font-family: 'Outfit', sans-serif; font-size: 18px; color: #0f172a; font-weight: 700; border-bottom: 2px solid #f1f5f9; padding-bottom: 10px; margin-bottom: 20px;">Notícies de la Setmana</h2>
                <div>
                  ${articlesHtml}
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="background-color: #f8fafc; padding: 30px 40px; border-top: 1px solid #e2e8f0; text-align: center;">
                <p style="color: #64748b; font-size: 12px; margin: 0 0 10px 0; line-height: 1.5; font-family: 'Inter', sans-serif;">
                  Aquest butlletí és una síntesi generada automàticament a partir dels canals oficials d'Andorra (Consell General, Govern d'Andorra, APDA, Andorra UE, AFA i BOPA).
                </p>
                <p style="color: #94a3b8; font-size: 11px; margin: 0; font-family: 'Inter', sans-serif;">
                  © 2026 Andorra RSS Reader. Tots els drets reservats.
                </p>
                <div style="margin-top: 15px;">
                  <a href="https://rssand-production.up.railway.app" style="color: #3b82f6; text-decoration: none; font-size: 12px; font-weight: 600; font-family: 'Outfit', sans-serif;">
                    Obrir l'aplicació web ↗
                  </a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;
}

// Generate Plain Text Fallback Version of the Newsletter
function generateNewsletterText(dateStr, editorialIntro, puntsClau, noticiesAmbImpacte) {
  const dateFormatted = parseDateToCatalan(dateStr);
  const pointsText = puntsClau.map(pt => `• ${pt}`).join('\n');
  const articlesText = noticiesAmbImpacte.map((ai, idx) => {
    return `${idx + 1}. ${ai.titol}\n   Enllaç: ${ai.link}\n   Impacte: ${ai.impacte}\n`;
  }).join('\n');

  return `BUTLLETÍ SETMANAL - Andorra Actualitat Legislativa
Data: ${dateFormatted}
==================================================

RESUM DE LA SETMANA:
${editorialIntro}

--------------------------------------------------
FETS DESTACATS:
${pointsText}

--------------------------------------------------
NOTÍCIES DE LA SETMANA:
${articlesText}

==================================================
Aquest butlletí és una síntesi generada automàticament a partir dels canals oficials d'Andorra.
Obrir l'aplicació web: https://rssand-production.up.railway.app
`;
}

// API Endpoint to get AI-generated daily newsletter
app.get('/api/news/newsletter', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const summary = await getAiSummary(forceRefresh);

    let items = newsCache;
    if (!items || items.length === 0) {
      items = await fetchAllFeeds();
    }

    if (!items || items.length === 0) {
      return res.status(404).json({ error: "No s'han trobat notícies per al butlletí." });
    }

    const dates = [...new Set(items.map(item => item.date))].sort().reverse();
    const latestDate = dates.length > 0 ? dates[0] : new Date().toISOString().split('T')[0];

    // Filter news from the last 7 days for the newsletter's feed content
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const limitDateStr = sevenDaysAgo.toISOString().split('T')[0];
    const weeklyNews = items.filter(item => item.date >= limitDateStr);

    const newsletterData = {
      editorialIntro: summary.resumExecutiu,
      puntsClau: summary.puntsClau,
      noticiesAmbImpacte: summary.noticiesAmbImpacte
    };

    const htmlContent = generateNewsletterHtml(
      latestDate,
      newsletterData.editorialIntro,
      newsletterData.puntsClau,
      newsletterData.noticiesAmbImpacte,
      weeklyNews
    );

    const textContent = generateNewsletterText(
      latestDate,
      newsletterData.editorialIntro,
      newsletterData.puntsClau,
      newsletterData.noticiesAmbImpacte
    );

    res.json({
      timestamp: new Date().toISOString(),
      date: latestDate,
      itemsCount: weeklyNews.length,
      data: newsletterData,
      html: htmlContent,
      text: textContent
    });

  } catch (error) {
    console.error("Error generant el butlletí diari:", error);
    let errorMsg = "S'ha produït un error al generar el butlletí diari amb Intel·ligència Artificial.";
    let status = 500;
    if (error.status === 429 || (error.message && (error.message.includes('Quota') || error.message.includes('quota') || error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED')))) {
      status = 429;
      errorMsg = "QUOTA_EXCEEDED";
    }
    res.status(status).json({ error: errorMsg });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
