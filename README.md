# Andorra Legal Brief

Agregador i brief setmanal de novetats jurídiques andorranes procedents de fonts oficials.

## Desenvolupament

```bash
npm install
npm start
```

Per executar les proves:

```bash
npm test
```

## Configuració

- `PORT`: port HTTP; per defecte `3000`.
- `GEMINI_API_KEY`: activa l’edició assistida del brief. Sense clau, el sistema genera una síntesi determinista basada en metadades oficials.
- `DISABLE_AI=true`: força el mode determinista.
- `PUBLIC_BASE_URL`: URL pública canònica, recomanada en producció, per exemple `https://rssand-production.up.railway.app`.

## Subscripció RSS

El feed general és `/feed.xml`. Admet filtres combinables:

- `area`: nom exacte d’una àrea de pràctica publicada per l’API.
- `relevance=high`: només publicacions amb impacte jurídic alt.

Exemple:

```text
/feed.xml?area=Penal+i+seguretat&relevance=high
```

La interfície “Rep el brief” construeix i copia aquests enllaços sense recollir dades personals.

## Edicions per àrea

El filtre d’àrea es conserva al navegador i s’aplica també al brief i al generador de newsletter. Els endpoints accepten el mateix nom exacte d’àrea:

```text
/api/news/summary?area=Penal+i+seguretat
/api/news/newsletter?area=Penal+i+seguretat
```

Cada edició es desa en una entrada de memòria cau independent per evitar barrejar continguts d’àrees diferents.
