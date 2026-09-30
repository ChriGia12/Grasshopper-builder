# Grasshopper Builder

Sito web che sostituisce la catena Rhino/Grasshopper per la **stampa 3D robotica a estrusione con KUKA**:

1. carichi un modello **mesh o BREP**,
2. il sito sceglie **orientamento** e **modo di stampa** migliori,
3. calcola il **percorso che segue esattamente il contorno** del pezzo, strato per strato,
4. esporta il file **`.src` KUKA** con la stessa struttura di `Tavolino1.src` (INI, BASE/TOOL, I/O estrusore, `LIN … C_DIS`, spegnimento, homing).

Tutto gira nel browser (TypeScript + Three.js + WebAssembly): il modello non viene caricato su nessun server.

## Formati supportati

| Formato | Come viene letto |
|---|---|
| STL, OBJ, PLY | loader Three.js (unità assunte in mm) |
| 3DM (Rhino) | rhino3dm: mesh, polisuperfici ed estrusioni (usa le mesh di render salvate nel file), SubD. Unità convertite in mm. Oggetti raggruppati per layer, con selezione "solo" per scegliere il pezzo dentro una scena intera (cella robot, piano…) |
| STEP, IGES, BREP | OpenCascade (occt-import-js), tassellazione 0,1 mm |

> Polisuperfici `.3dm` senza mesh di render (file salvati con "Salva piccolo") non sono leggibili: apri il file in Rhino in vista ombreggiata e risalva, oppure esporta STEP.

## Come funziona

- **Slicing esatto**: ogni strato è l'intersezione del piano con la mesh; i segmenti vengono concatenati usando la topologia (spigoli condivisi), quindi i contorni sono chiusi e seguono la geometria reale. Semplificazione Douglas–Peucker con tolleranza impostabile (default 0,2 mm), opzionale suddivisione dei LIN troppo lunghi (come "Divide Length").
- **Orientamento**: prova ±X/±Y/±Z e le facce piane più grandi dell'inviluppo convesso. Punteggio su sbalzi oltre l'angolo critico, isole che partono nel vuoto, numero di contorni per strato (ogni contorno separato = stop dell'estrusore), superficie d'appoggio, altezza.
- **Modo di stampa** (automatico):
  - *Spirale continua* (vase mode) se il pezzo è un unico contorno per strato: la Z sale lungo il contorno, niente giunzioni né stop. Gli strati di bordo che non sono un anello unico (es. bordi arrotondati) vengono stampati planari.
  - *Strati planari* altrimenti: cambio strato sulla stessa verticale senza fermare l'estrusore (come Tavolino1); tra contorni separati estrusore spento, sollevamento e riaccensione.
- **Gusci sottili**: un solido cavo con spessore ≤ "Guscio → linea media" viene stampato con un solo cordolo sulla linea media (invece di pelle esterna + interna).
- **Pareti multiple**: offset verso l'interno con Clipper.

## Posizione sul robot

Due modalità (sezione *Robot KUKA e piano*):

- **Centra sul punto indicato**: il centro del pezzo va in `X/Y` e il piano a `Z` nel sistema BASE (default 5 / 515 / 37 → prima Z 38,5 come Tavolino1).
- **Mantieni posizione del file**: usa la posizione del pezzo nel file Rhino e sottrae l'origine della BASE in coordinate mondo (default 1448 / −1000 / 5, dal post-processore Python).

Le posizioni definitive di robot e piano di lavoro vanno inserite lì quando disponibili; tutti i parametri restano salvati nel browser.

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
src/core/toolpath.ts     percorso spirale/planare, spostamenti
src/core/kuka.ts         writer KRL .src
src/core/pipeline.ts     orientamento → percorso → .src
src/worker.ts            calcolo in Web Worker
src/viewer.ts            anteprima 3D
src/main.ts              interfaccia
```
