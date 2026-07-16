# Informe de Revisió Jurídica: Andorra Legal Brief

Aquest informe analitza el projecte **Andorra Legal Brief** ([rssand](https://rssand-production.up.railway.app/)) des d'una perspectiva jurídica, avaluant-ne la conformitat amb la legislació andorrana vigent i els estàndards europeus aplicables.

L'anàlisi s'estructura en quatre grans blocs:
1. **Protecció de Dades Personals (LQPD)**
2. **Responsabilitat Civil i Exempcions (Disclaimers)**
3. **Propietat Intel·lectual i Ús de Fonts (Scraping i Dades Obertes)**
4. **Regulació de la Intel·ligència Artificial i Transparència**

---

## 1. Protecció de Dades Personals (LQPD)

La plataforma recull i tracta dades dels usuaris principalment a través del formulari de subscripció per correu electrònic i de l'ús de l'aplicació. El Principat d'Andorra es regeix per la **Llei 29/2021, del 28 d'octubre, qualificada de protecció de dades personals (LQPD)**, altament alineada amb el Reglament General de Protecció de Dades (RGPD) de la UE.

### Punts Forts en Protecció de Dades:
* **Privacitat per Disseny (Privacy by Design):** L'estat de lectura, les publicacions desades com a "Pendents" i la selecció d'àrea preferida es guarden exclusivament al navegador de l'usuari mitjançant `localStorage` (comprovable a [state.js](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/public/state.js)). Aquestes dades no s'envien mai al servidor, la qual cosa compleix perfectament amb el principi de minimització de dades (Article 6 LQPD).
* **Bloqueig del formulari sense configuració:** L'opció de subscripció per correu electrònic només s'activa si s'han definit correctament les variables d'entorn `SUBSCRIPTION_WEBHOOK_URL` i `PRIVACY_POLICY_URL` ([server.js:L51-68](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js#L51-68)). Si no hi són, el formulari s'amaga i es demana a l'usuari que utilitzi el canal RSS (que no recull cap dada personal).
* **Consentiment Actiu:** El formulari exigeix marcar expressament una casella d'acceptació de la política de privacitat (`body.consent !== true` llança un error al servidor, [server.js:L78](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js#L78)).
* **Doble Confirmació (Double Opt-In):** El sistema delega la gestió del registre i de les baixes al proveïdor de correu extern, exigint que aquest demani i registri la doble confirmació. Això és clau per acreditar que el consentiment és lliure i verificable.

### Recomanacions de Millora (LQPD):
> [!WARNING]
> **Registre d'Adreces IP per Seguretat:**
> El servidor utilitza la funció `checkSubscriptionRateLimit(ip)` ([server.js:L89-103](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js#L89-103)) per evitar el correu brossa i atacs de denegació de servei, emmagatzemant les adreces IP en memòria. 
> * **Acció requerida:** L'adreça IP es considera una dada de caràcter personal. Cal incloure de manera explícita en la Política de Privacitat que es tracten les adreces IP com a part de les mesures de seguretat, basant-se en l'**interès legítim**.

---

## 2. Responsabilitat Civil i Exempcions (Disclaimers)

L'aplicació ofereix serveis que extreuen dades crítiques per a la pràctica de l'advocacia: l'**entrada en vigor** d'una norma i els **terminis operatius** (per exemple, per interposar recursos o presentar sol·licituds).

### El Risc:
L'extracció s'efectua de dues maneres:
1. **Algorisme determinista de text (Regex):** Cerca patrons de text per identificar terminis de dies/mesos/anys o expressions com "entra en vigor" ([server.js:L472-504](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js#L472-504)). Aquest sistema pot patir de falsos positius o no detectar excepcions complexes (p. ex., disposicions transitòries, suspensions de terminis o exclusions d'articles concrets).
2. **Intel·ligència Artificial:** El resum setmanal i la newsletter són generats o filtrats per Gemini. Tot i les restriccions del *prompt*, les IA poden al·lucinar conceptes jurídics o terminis operatius.

Si un advocat confia cegament en aquestes dades per al seu exercici professional i perd un termini judicial, podria intentar repetir contra el proveïdor de la plataforma per responsabilitat civil professional (danys patrimonials).

### Avaluació dels Avisos de Seguretat (Disclaimers):
L'aplicació inclou clàusules de salvaguarda:
* Al peu de la web: *“Fonts oficials · Síntesi informativa, no assessorament jurídic.”*
* A l'alerta del BOPA: *“La selecció prioritza lleis, reglaments... cal consultar sempre el text oficial.”*
* A les plantilles de la newsletter (HTML i text): *“Contingut informatiu: cal consultar sempre el text oficial i no constitueix assessorament jurídic.”* ([server.js:L1510-1512](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js#L1510-1512)).
* Instruccions d'IA: El prompt de Gemini limita la generació d'informació no continguda a la font i defineix els terminis com a "fragments per comprovar".

### Recomanacions de Millora (Responsabilitat):
> [!IMPORTANT]
> **Reforç del Disclaimer de Terminis:**
> Tot i que el text de la newsletter adverteix de comprovar el text oficial, la interfície web mostra directament una pestanya de "Butlletí Setmanal" on el codi copiat podria ometre fàcilment els avisos si l'advocat fa un simple *copy-paste* d'un extracte.
> * **Acció recomanada:** Afegir una petita advertència visual directament a l'apartat de "Possibles terminis" de la fitxa de cada notícia al *feed* web:
>   * *“⚠️ Termini extret automàticament. Verifiqueu-lo sempre a la font oficial abans de qualsevol actuació jurídica.”*
> * **Condicions d'ús:** És molt aconsellable disposar d'un document de "Termes i Condicions d'Ús" enllaçat al peu de pàgina on s'exclogui explícitament qualsevol responsabilitat per decisions preses basant-se en la informació de la web.

---

## 3. Propietat Intel·lectual i Ús de Fonts (Scraping i Dades Obertes)

L'aplicació recopila dades de dues tipologies de fonts: oficials i mitjans de comunicació privats.

### A. Fonts Oficials (BOPA, Govern, Consell General, AFA, APDA):
* **Marc jurídic:** A Andorra, els textos oficials (lleis, reglaments, sentències, decrets, edictes) estan exclosos de la protecció dels drets d'autor en virtut del dret d'accés a la informació i transparència pública. 
* **Compliment:** L'ús de les API del BOPA o del Consell General per indexar i enllaçar a les fonts originals és plenament legítim i respecta el prinsip de publicitat de les normes.

### B. Mitjans de Comunicació Privats (Bondia, El Periòdic, Diari d'Andorra, Altaveu, etc.):
* **Marc jurídic:** Els mitjans de comunicació privats tenen drets de propietat intel·lectual sobre les seves notícies i articles (*Llei sobre els drets d'autor i els drets veïns, del 10 de juny de 1999*).
* **Compliment de l'App:** 
  * L'aplicació només consumeix els **canals RSS oficials** que els mateixos mitjans proporcionen per a la redifusió.
  * Només es reprodueix el títol, un petit fragment (*snippet*) de text i l'enllaç original per redirigir el lector al mitjà. Això s'empara en el **dret de citació** i la finalitat de ressenya periodística.
  * No es fa *scraping* del contingut complet de la notícia de premsa.
  * El servidor utilitza un identificador clar (*User-Agent*) que permet als servidors dels mitjans aplicar regles de filtratge (p. ex. via `robots.txt`) si ho desitgessin:
    `'User-Agent': 'AndorraLegalBrief/1.0 (+https://rssand-production.up.railway.app/)'` ([server.js:L947-960](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js#L947-960)).
* **Valoració:** Excel·lent pràctica legal i tècnica. No hi ha infracció de drets d'autor.

---

## 4. Intel·ligència Artificial i Transparència

Andorra es troba en un procés d'acostament a la Unió Europea a través de la negociació de l'**Acord d'Associació**. Això comporta la transposició progressiva de l'*Acquis* comunitari, inclosa la futura aplicació de directives i reglaments digitals, com el **Reglament d'Intel·ligència Artificial de la UE (AI Act)**.

### Transparència de l'ús de la IA:
L'AI Act imposa obligacions de transparència quan es fa ús de sistemes de generació de text mitjançant IA: els usuaris han de ser informats que estan interactuant amb contingut generat o assistit per IA.

* **Compliment de l'App:** 
  * La web etiqueta clarament el brief setmanal com a "generat o assistit per IA".
  * Les plantilles de la newsletter inclouen una etiqueta distingible: *“Edició assistida per IA sobre fonts oficials”* o *“Síntesi automàtica de fonts oficials”* segons el mètode utilitzat ([server.js:L1366-1368](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js#L1366-1368)).
  * A nivell intern, el codi disposa de mecanismes per verificar que els resums executius d'IA no inventin títols ni enllaços, contrastant el JSON de sortida de Gemini amb els enllaços oficials extrets abans de mostrar-los (`normalizeAiSummary`, [server.js:L337-367](file:///Users/marccasellas/Desktop/docus2024/DOCUS%202026/rssand/server.js#L337-367)).

---

## Conclusions i Propostes de Millora Jurídica

L'aplicació **Andorra Legal Brief** està dissenyada amb un nivell excel·lent de conformitat normatiu inicial, demostrant preocupació per la privacitat des del disseny i evitant pràctiques d'intrusisme en la propietat intel·lectual. 

Per blindar completament la plataforma i assegurar el conformitat del 100% de les normatives de dades i consum, es recomana dur a terme les següents accions:

1. **Redactar i publicar la Política de Privacitat:** Assegurar que la URL del `PRIVACY_POLICY_URL` contingui el detall complet del tractament, incloent-hi de forma explícita el tractament de l'adreça IP per a motius de seguretat (interès legítim) i el fet que les dades de subscripció s'envien a un processador extern per gestionar l'enviament de correus (encarregat del tractament).
2. **Redactar les Condicions d'Ús i avís de limitació de responsabilitat (Disclaimer):** Penjar un enllaç al peu de pàgina detallant que la plataforma és un agregador d'informació i que l'usuari assumeix la responsabilitat de qualsevol acció jurídica que realitzi, obligant-se a contrastar les dades amb els Butlletins Oficials corresponents.
3. **Reforçar l'avís de terminis al web:** Afegir un text breu a la fitxa dels documents on es llegeixi un possible termini operatiu (p. ex. *"Terminis aproximats extrets per via algorítmica. Valideu-los al document BOPA oficial"*).
