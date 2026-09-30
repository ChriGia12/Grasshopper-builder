// KUKA KRL writer. Output mirrors Tavolino1.src (header, extruder I/O, LIN C_DIS, homing).
import type { RobotSettings } from './settings';
import type { PathPoint, Toolpath } from './toolpath';

export interface SrcInfo {
  sourceName: string;
  layerHeight: number;
}

const f3 = (v: number) => {
  const s = v.toFixed(3);
  return s === '-0.000' ? '0.000' : s;
};

/** KRL identifiers: letter first, then letters/digits/_ , max 24 chars. */
export function sanitizeProgramName(name: string): string {
  let n = name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(n)) n = 'P' + n;
  return n.slice(0, 24) || 'Pezzo1';
}

export function toBase(p: PathPoint, r: RobotSettings): [number, number, number] {
  return [p.x + r.originX, p.y + r.originY, p.z + r.originZ];
}

function frame(p: PathPoint, r: RobotSettings): string {
  const [x, y, z] = toBase(p, r);
  return (
    `{X ${f3(x)}, Y ${f3(y)}, Z ${f3(z)}, A ${f3(r.a)}, B ${f3(r.b)}, C ${f3(r.c)}, ` +
    `E1 ${f3(r.e1)}, E2 ${f3(r.e2)}, E3 ${f3(r.e3)}, E4 ${f3(r.e4)}}`
  );
}

function axes(a: number[], withExternal: boolean): string {
  const v = a.map((x) => f3(x));
  const ext = withExternal ? ', E1 0, E2 0, E3 0, E4 0, E5 0, E6 0' : '';
  return `{A1 ${v[0]}, A2 ${v[1]}, A3 ${v[2]}, A4 ${v[3]}, A5 ${v[4]}, A6 ${v[5]}${ext}}`;
}

function extruderOn(r: RobotSettings, title: string): string[] {
  return [
    '; =========================',
    `; ${title}`,
    `; ANOUT[${r.extruderSpeedAnout}] = 10 CORRISPONDE A 100%`,
    '; =========================',
    `$ANOUT[${r.extruderSpeedAnout}]=${r.extruderSpeed}`,
    `$ANOUT[${r.extruderAnout}]=1`,
    `WAIT SEC ${r.extruderDelay}`,
    '$OUT[16]=TRUE',
  ];
}

export function writeKukaSrc(tp: Toolpath, r: RobotSettings, info: SrcInfo): string {
  if (!tp.points.length) throw new Error('Percorso vuoto: niente da esportare.');
  const name = sanitizeProgramName(r.programName);
  const pts = tp.points;
  const safe = axes(r.safeAxes, true);
  const L: string[] = [];
  const h = (lines: string) => L.push(...lines.split('\n'));

  h(`DEF ${name} ( )
GLOBAL INTERRUPT DECL 3 WHEN $STOPMESS==TRUE DO IR_STOPM ( )

; =========================
; GENERATO DA GRASSHOPPER BUILDER
; MODELLO: ${info.sourceName.replace(/[\r\n;]/g, ' ')}
; MODO: ${tp.mode === 'spiral' ? 'SPIRALE CONTINUA' : 'STRATI PLANARI'} | STRATI: ${tp.layerCount} | H STRATO: ${info.layerHeight} mm
; PUNTI: ${pts.length} | STAMPA: ${(tp.printLength / 1000).toFixed(2)} m | SPOSTAMENTI: ${tp.travels}
; =========================

;FOLD INI
BAS (#INITMOV,0)
BAS (#VEL_PTP,50)
BAS (#ACC_PTP,100)
;ENDFOLD

;FOLD STARTPOS
$BWDSTART = FALSE
PDAT_ACT = {VEL 50,ACC 100,APO_DIST 10}
BAS(#PTP_DAT)
FDAT_ACT = {TOOL_NO 0,BASE_NO 0,IPO_FRAME #BASE}
BAS (#FRAMES)
BAS (#VEL_PTP,50)
;ENDFOLD

;FOLD SET DEFAULT SPEED
$VEL.CP=${r.velCP}
BAS(#VEL_PTP,50)
BAS(#TOOL,0)
BAS(#BASE,0)
;ENDFOLD

;FOLD PTP FIRST POSITION
$BWDSTART = FALSE
PDAT_ACT = {VEL 50,ACC 100,APO_DIST 10}
FDAT_ACT = {TOOL_NO 0,BASE_NO 0,IPO_FRAME #BASE}
BAS(#FRAMES)
$ADVANCE = ${r.advance}
;ENDFOLD

PTP $AXIS_ACT ; skip BCO quickly

$OUT[6]=FALSE
$OUT[7]=TRUE
$OUT[8]=FALSE
$OUT[9]=TRUE

; =========================
; ESTRUSORE SPENTO IN AVVIO
; ANOUT[${r.extruderAnout}] = ON/OFF ESTRUSORE
; ANOUT[${r.extruderSpeedAnout}] = VELOCITA ESTRUSORE
; =========================
$ANOUT[${r.extruderAnout}]=0
$OUT[16]=FALSE
$ANOUT[${r.extruderSpeedAnout}]=0

WAIT SEC 1

$BASE=BASE_DATA[${r.baseNumber}]
$TOOL=TOOL_DATA[${r.toolNumber}]
$VEL.CP=${r.velCP}

; =========================
; POSIZIONE SICURA
; A5 = -1 PER EVITARE SINGOLARITA
; =========================
PTP ${safe}

; =========================
; POSIZIONE ASSE LINEARE
; ESTRUSORE ANCORA SPENTO
; =========================
PTP ${safe}

; =========================
; AVVICINAMENTO AL PRIMO PUNTO
; ESTRUSORE SPENTO
; =========================
PTP ${frame(pts[0], r)}

; =========================
; PRIMO PUNTO REALE
; ANCORA SENZA ESTRUSIONE
; =========================
LIN ${frame(pts[0], r)} C_DIS
`);

  L.push(...extruderOn(r, 'ACCENSIONE ESTRUSORE'), '', '; =========================', '; INIZIO STAMPA', '; =========================');

  let extruding = true;
  let layer = 0;
  for (let i = 1; i < pts.length; i++) {
    while (layer + 1 < tp.layerStart.length && tp.layerStart[layer + 1] <= i) {
      layer++;
      if (tp.mode === 'planar') L.push(`; STRATO ${layer + 1}`);
    }
    const p = pts[i];
    if (!p.e && extruding) {
      L.push('; ESTRUSORE OFF - SPOSTAMENTO', '$OUT[16]=FALSE', `$ANOUT[${r.extruderAnout}]=0`);
      extruding = false;
    } else if (p.e && !extruding) {
      L.push(...extruderOn(r, 'RIACCENSIONE ESTRUSORE'));
      extruding = true;
    }
    L.push(`LIN ${frame(p, r)} C_DIS`);
  }

  h(`$VEL.CP=${r.velCP.toFixed(2)}

; =========================
; SPEGNIMENTO ESTRUSORE
; =========================
$OUT[16]=FALSE
$ANOUT[${r.extruderAnout}]=0
$ANOUT[${r.extruderSpeedAnout}]=0

PTP ${safe}

PTP ${safe}
`);
  if (r.useHoming) {
    const [a1, a2, , a4, a5, a6] = r.safeAxes;
    h(`; MACRO FINALE
PTP $AXIS_ACT ; skip BCO quickly
; HOMING
PTP ${axes([a1, a2, 0, a4, a5, a6], false)}
$ANOUT[4]=0.6
WAIT SEC 2
WAIT FOR ($ANIN[2] < 0)
PTP ${axes(r.safeAxes, false)}`);
  }
  L.push('END');
  return L.join('\r\n');
}
