# Pla d'Implementació: Segon Cervell Auditor amb l'API de Mistral

Aquest pla detalla la integració de l'API de **Mistral AI** com a "segon cervell" supervisor. Aquest agent actuarà com a auditor de qualitat jurídica de la informació generada per Gemini (primer cervell), validant dates, terminis i evitant al·lucinacions abans que les dades s'enviïn o es publiquin a la web.

## User Review Required

> [!IMPORTANT]
> **Integració de l'API Key de Mistral:**
> * S'afegirà la clau d'API de Mistral proporcionada al fitxer `.env`.
> * La integració es farà de forma **no bloquejant**: si Mistral falla o la seva clau d'API no està configurada, el sistema continuarà funcionant correctament fent servir només Gemini o la síntesi determinista.

## Open Questions

> [!NOTE]
> **Model de Mistral a utilitzar:**
> Proposem utilitzar el model `open-mistral-nemo` per defecte, ja que té una relació qualitat/preu òptima, una velocitat alta i una gran competència en llengua catalana. Una altra opció és `mistral-large-latest` per a un raonament màxim si el cost no és un inconvenient. Ho farem configurable mitjançant la variable d'entorn `MISTRAL_MODEL` (per defecte `open-mistral-nemo`).

## Proposed Changes

### Servidor Node.js

#### [MODIFY] [server.js](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js)
* Llegir `MISTRAL_API_KEY` i `MISTRAL_MODEL` des del fitxer `.env`.
* Crear una funció `auditSummaryWithMistral(originalNews, draftSummary)` que enviï una petició HTTP POST a `https://api.mistral.ai/v1/chat/completions` amb:
  * El llistat original de publicacions.
  * El resum esborrany generat per Gemini.
  * Un prompt de revisió jurídica exigent que forci un format de sortida JSON idèntic al que espera l'aplicació.
* Modificar `getAiSummary` per connectar en cascada ambdós models:
  ```
  [Notícies BOPA] -> (Gemini) -> [Esborrany] -> (Mistral) -> [Resum Auditat i Final]
  ```
* En cas que Mistral detecti al·lucinacions, corregirà els camps de manera factible seguint les notícies originals.

### Configuració

#### [MODIFY] [.env](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/.env)
* Afegir les línies:
  ```env
  MISTRAL_API_KEY=unZ5d61lY5Z1dAEL8vDaQkR5mgPAfk9v
  MISTRAL_MODEL=open-mistral-nemo
  ```

---

## Verification Plan

### Automated Tests
* Executar les proves unitàries existents:
  ```bash
  npm test
  ```

### Manual Verification
* Iniciar el servidor localment:
  ```bash
  npm start
  ```
* Obrir el navegador a `http://localhost:3000`.
* Generar un brief setmanal i comprovar els logs del servidor per verificar que:
  1. Gemini rep les notícies i redacta l'esborrany.
  2. Mistral rep el text original i l'esborrany de Gemini, l'audita, el corregeix si cal, i el retorna en format JSON.
  3. L'edició final de la web mostra el resum amb l'auditoria aplicada.
