# KinePath

*[English version](README.en.md)*

Sito web che sostituisce la catena Rhino/Grasshopper per la **stampa 3D robotica a estrusione con KUKA**:

1. carichi un modello **mesh o BREP**,
2. il sito propone l'**orientamento** migliore; il **modo di stampa** lo scegli tu (default: contorno a strati),
3. calcola il **percorso che segue il contorno** del pezzo entro la tolleranza impostata (default 0,2 mm), strato per strato,
4. esporta il file **`.src` KUKA** con la stessa struttura di `Tavolino1.src` (INI, BASE/TOOL, I/O estrusore, `LIN … C_DIS`, spegnimento, homing).

Tutto gira nel browser (TypeScript + Three.js + WebAssembly): il modello non viene caricato su nessun server.

Il sito è in **italiano e inglese**: il pulsante EN / IT in alto a destra cambia la lingua di tutta la pagina (anche avvisi, note e orientamenti già calcolati) e la scelta resta salvata nel browser.

**Controlli prima dell'esportazione.** Il pulsante *Scarica .src* resta disattivato:
- mentre un calcolo è in corso o dopo qualsiasi modifica, finché l'ultimo calcolo non è finito (un risultato vecchio non è mai scaricabile);
- se un parametro è fuori dai valori ammessi ($VEL.CP, uscite ANOUT, n° di strati, posizione sicura e posa di homing entro i limiti degli assi, …): i parametri sono controllati *prima* del calcolo, quindi un valore eccessivo non lo avvia nemmeno;
- `BASE_DATA[1]`, `TOOL_DATA[11]` ed E1–E4 = 0 sono bloccati: sono le sole configurazioni di cui la simulazione e il controllo di raggiungibilità conoscono le misure;
- se il robot non raggiunge un punto del percorso o un punto intermedio dei LIN (campionati ogni 20 mm), o se un asse supera i limiti del KR16;
- se un punto del percorso scende sotto il piano di lavoro (lastra a Z 38 in BASE): non si può confermare;
- se un campo numerico è vuoto o non valido;
- se il percorso esce dal piano di lavoro in pianta, se con *inclina utensile* ci sono punti con pendenza lungo X non seguibile, o se nell'orientamento scelto il pezzo ha isole che partono nel vuoto o più del 2% di superficie in sbalzo oltre l'angolo critico: in questi casi serve una conferma esplicita, che si azzera a ogni modifica.

**Limiti.** Il sito non verifica le collisioni del braccio o del mandrino con tavola e pezzo, né il moto PTP verso le posizioni di sicurezza. Il controllo dei LIN intermedi verifica il percorso geometrico programmato, non la traiettoria raccordata che il controller esegue con `C_DIS` (default, come Tavolino1): con `C_DIS` il robot non passa esattamente per ogni punto; l'opzione *Approssimazione LIN → Nessuna* fa fermare il robot su ogni punto. Prima della stampa il `.src` va comunque provato a vuoto o nella simulazione della cella reale.

## Cella fissa

All'apertura il sito mostra già la cella, che non si sposta e non si può eliminare:

- **KUKA KR16 R2010** posato dalla cinematica reale (assi ricavati dal CAD: A2 a 160/520 mm, braccio 980 mm, avambraccio 150/860 mm, flangia a 153,9 mm dal polso);
- **mandrino** montato sulla flangia: la sua punta coincide con `TOOL_DATA[11] = {X 372.65, Y 0, Z 78.111}`;
- **tavole e lastra** di lavoro (piano di stampa a Z 38 nel sistema BASE, 640 × 1350 mm).

La geometria viene da `BASE ROBOT.3dm` ed è salvata in `public/cell.bin` (≈2 MB). Per rigenerarla:

```bash
node scripts/build-cell.mjs "/percorso/BASE ROBOT.3dm"
```

Il robot sta nel mondo Rhino a (0, −1000, 0): il punto disegnato in `BASE ROBOT.3dm` spostato di −1000 in Y, al centro del tavolo come la BASE, con la base 32 mm sotto il piano superiore delle tavole. La BASE del post-processore Python (1448, −1000, 5) in coordinate mondo risulta quindi a (1448, 0, 5) rispetto al robot.

**Orientamento utensile.** L'asse del mandrino è l'asse Z del TCP, come calibrato sul robot: con A = −180°, B = 0° il parametro C inclina l'utensile (C 180 = verticale verso il basso, C 135 ≈ 45°, C 90 / 270 = orizzontale). Con A −180 / B 0 / C 180 il robot lavora in verticale sopra il punto.

**Simulazione.** Il pulsante *▶ Simula* fa eseguire al robot i movimenti `LIN` del file `.src`, alla velocità reale ($VEL.CP) moltiplicata per 1–500×. Il percorso già eseguito è colorato, quello da eseguire resta grigio chiaro; sotto sono indicati la riga `LIN` corrente, le coordinate X/Y/Z/A/B/C scritte nel file e gli angoli A1–A6. Lo slider permette di andare a qualsiasi movimento, quello degli strati salta alla fine di uno strato. Per ogni punto il sito risolve la cinematica inversa e segnala i punti fuori portata o oltre i limiti degli assi.

## Uso rapido

1. **Carica il pezzo**: una mesh o un BREP; un nuovo file sostituisce il precedente. Da un `.3dm` con tutta la scena viene preso solo l'oggetto che sta sul piano di lavoro.
2. Il sito propone l'orientamento migliore (sezione Orientamento); scegli il modo di stampa in *Stampa*.
3. **Posiziona pezzo**: clicca sulla lastra nell'anteprima per spostare il centro del pezzo; la rotazione sul piano è in *Robot KUKA e piano → Rotazione pezzo Z*.
4. **Punto iniziale**: clicca vicino al contorno dove vuoi che parta la stampa (punto azzurro).
5. **Scarica .src**.

## Formati supportati

| Formato | Come viene letto |
|---|---|
| STL, OBJ, PLY | loader Three.js (unità assunte in mm) |
| 3DM (Rhino) | rhino3dm: mesh, polisuperfici ed estrusioni (usa le mesh di render salvate nel file), SubD. Unità convertite in mm |
| STEP, IGES, BREP | OpenCascade (occt-import-js), tassellazione 0,1 mm |

Le librerie rhino3dm e OpenCascade sono servite dal sito stesso (`public/vendor`, copiate da `node_modules` a ogni build): l'importazione non usa CDN né rete.

> Polisuperfici `.3dm` senza mesh di render (file salvati con "Salva piccolo") non sono leggibili: apri il file in Rhino in vista ombreggiata e risalva, oppure esporta STEP.

## Come funziona

- **Slicing esatto**: ogni strato è l'intersezione del piano con la mesh; i segmenti vengono concatenati usando la topologia (spigoli condivisi), quindi i contorni sono chiusi e seguono la geometria reale. Semplificazione Douglas–Peucker con tolleranza impostabile (default 0,2 mm), opzionale suddivisione dei LIN troppo lunghi (come "Divide Length").
- **Orientamento**: prova ±X/±Y/±Z e le facce piane più grandi dell'inviluppo convesso. Punteggio su sbalzi oltre l'angolo critico, isole che partono nel vuoto, numero di contorni per strato (ogni contorno separato = stop dell'estrusore), superficie d'appoggio, altezza. Prima del punteggio ogni orientamento passa i controlli bloccanti (nessuna isola nel vuoto, sbalzi entro il 2%): quelli che non li superano sono segnati *non validi* e messi in fondo. Se nessuno è valido il sito lo dice e l'esportazione richiede la conferma.
- **Modo di stampa**: di default *contorno a strati* (Z fissa per strato, cambio strato sulla stessa verticale senza fermare l'estrusore, come Tavolino1); tra contorni separati estrusore spento, sollevamento e riaccensione. Gli altri modi (spirale, pieno, superficie) si scelgono dal menu: vedi la tabella sotto. La spirale si usa solo se ogni strato è un unico contorno, altrimenti torna agli strati planari.
- **Collegamenti verificati**: un collegamento tra due tratti viene estruso solo se è corto (*Salto senza stop*, o fino a 8 cordoli tra passate vicine della serpentina) **e** resta sul materiale per tutta la lunghezza (dentro la sezione dello strato, o sulla superficie superiore nel modo superficie), con un margine di 1 mm al massimo. Tutti gli altri diventano spostamenti sollevati a estrusore spento. Le scelte euristiche (direzione delle passate, ordine) avvengono solo tra percorsi i cui collegamenti hanno passato questo controllo.
- **Gusci sottili**: un solido cavo con spessore ≤ "Guscio → linea media" viene stampato con un solo cordolo sulla linea media (invece di pelle esterna + interna).
- **Pareti multiple**: offset verso l'interno con Clipper.

### Modi di stampa

| Modo | Cosa fa |
|---|---|
| Contorno a strati | il contorno di ogni strato a Z costante, +altezza strato a ogni strato (come Tavolino1) |
| Contorno a spirale | come sopra ma la Z sale lungo il giro (vase mode), senza giunzione |
| Pieno a serpentina | il pezzo pieno con una serpentina continua (passata dopo passata, come un tosaerba), contorno esterno opzionale. Strati planari interi fino sotto il punto più basso della superficie superiore; poi, con *strati graduali*, N strati non planari che passano dal piano alla forma della superficie (strato k a quota taglio + (superficie − taglio)·k/N): ognuno copre tutta la sezione, cambia solo lo spessore (≈ ½–1½ altezza strato), l'ultimo è la superficie vera. Così non si formano isole e l'estrusore non si ferma (sella: 13 planari + 17 graduali, 0 stop). Direzione delle passate automatica (0/45/90/135°, meno interruzioni) |
| Superficie superiore a serpentina | non planare: la serpentina segue la superficie superiore del pezzo (le facce più ripide di *pendenza max* sono fianchi e vengono escluse), mezzo cordolo dal bordo; più strati sovrapposti con *n° di strati*. Con *inclina utensile* il parametro C segue la pendenza nel piano Y-Z (C = 180° − arccos(Nz) per pendenze lungo Y, come nella calibrazione A −180 / B 0); la pendenza lungo X non è rappresentabile con il solo C e viene segnalata. Senza l'opzione l'utensile resta verticale. Il risultato indica la *copertura*: quota della superficie superiore effettivamente coperta dall'unione delle fasce depositate (griglia ≤ 2 mm), quindi i buchi locali la fanno scendere; è una misura su griglia, non una verifica continua di ogni punto |

## Posizione sul robot

Due modalità (sezione *Robot KUKA e piano*):

- **Centra sul punto indicato**: il centro del pezzo va in `X/Y` e la sua base alla *Quota pezzo Z in BASE* (default 38, cioè appoggiato sulla lastra); la prima passata è 0,5 mm sopra → Z 38,5 come Tavolino1. Il campo sposta il pezzo, non la lastra: la lastra e la sua griglia restano sempre a Z 38, quindi un pezzo messo più in basso si vede compenetrare il piano e l’esportazione è bloccata.
- **Mantieni posizione del file**: usa la posizione del pezzo nel file Rhino e sottrae l'origine della BASE in coordinate mondo (default 1448 / −1000 / 5, dal post-processore Python).

I dati del controller (`BASE_DATA[1]`, `TOOL_DATA[11]`, E1–E4 = 0) sono fissi e servono alla simulazione e al controllo di raggiungibilità. Il `.src` richiama `BASE_DATA[1]` e `TOOL_DATA[11]` del controller e, fuori dai movimenti `LIN`/`PTP`, è identico byte per byte a `Tavolino1.src`.

Tutti i parametri restano salvati nel browser.

## Sviluppo

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # test del motore (slicing, percorso, orientamento, writer KUKA)
npm run build    # sito statico in dist/
```

Test opzionale su un file Rhino reale:

```bash
GB_SAMPLE_3DM="/percorso/file.3dm" GB_SAMPLE_LAYER="Livello 04" GB_SAMPLE_INDEX=0 npx vitest run tests/real-file.test.ts
```

Ogni push su `main` esegue i test e pubblica il sito su GitHub Pages.

## Struttura

```
src/core/loaders.ts      import file → mesh (per layer/oggetto)
src/core/mesh.ts         mesh indicizzata, saldatura vertici, trasformazioni
src/core/slicer.ts       intersezione piano/mesh → contorni chiusi
src/core/walls.ts        pareti interne e linea media dei gusci (Clipper)
src/core/orientation.ts  analisi orientamenti
src/core/toolpath.ts     percorso: contorno a strati, spirale, pieno, superficie
src/core/zigzag.ts       riempimento a serpentina e ordinamento delle passate
src/core/surface.ts      superficie superiore: proiezione, normali, parametro C
src/core/kuka.ts         writer KRL .src
src/core/pipeline.ts     orientamento → percorso → .src
src/worker.ts            calcolo in Web Worker
src/viewer.ts            anteprima 3D, clic su piano
src/core/robot.ts        frame KUKA, cinematica diretta/inversa KR16
scripts/build-cell.mjs   estrae robot, tavole e mandrino da BASE ROBOT.3dm
public/cell.*            cella fissa
src/main.ts              interfaccia
src/i18n.ts              traduzioni IT / EN
```
