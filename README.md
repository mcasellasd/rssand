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
- `SUBSCRIPTION_WEBHOOK_URL`: endpoint HTTPS del proveïdor de newsletter o automatització que registrarà la subscripció.
- `SUBSCRIPTION_WEBHOOK_TOKEN`: token Bearer opcional enviat al webhook.
- `PRIVACY_POLICY_URL`: política de privacitat HTTPS que s’ha d’acceptar abans de mostrar la subscripció per correu.

La subscripció per correu només s’activa quan `SUBSCRIPTION_WEBHOOK_URL` i `PRIVACY_POLICY_URL` són vàlids. El webhook rep `email`, `practiceArea`, `relevance`, `locale`, `source`, `doubleOptInRequested` i `subscribedAt`; el proveïdor ha d’enviar i registrar la doble confirmació i gestionar la baixa.

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

## Lectura professional

Cada publicació incorpora una pauta editorial determinista i traçable:

- fase jurídica o institucional del document;
- perfils professionals o clients als quals pot interessar;
- comprovacions suggerides segons el tipus documental, sense substituir la lectura de la font oficial.

La pestanya `Noves` mostra les publicacions aparegudes des de la visita anterior i `Pendents` permet desar localment les lectures que cal revisar. Aquest estat només es conserva al navegador de l’usuari.

## Seguiment local

El navegador conserva, sense enviar-ho al servidor:

- els enllaços ja coneguts, per destacar què ha aparegut des de la visita anterior;
- fins a 100 publicacions desades a la pestanya `Pendents`;
- l’àrea de pràctica preferida.

La primera visita crea el punt de referència i no marca artificialment tot el catàleg com a nou.
