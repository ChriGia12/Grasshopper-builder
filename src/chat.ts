// In-page chat with Claude. Claude edits the project through a small set of tools; every edit
// triggers a rebuild and the new result goes back to Claude so it can check its own change.
// The API key is the user's own, kept in this browser only (there is no backend).
import type Anthropic from '@anthropic-ai/sdk';

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** What the chat may read and change in the app. */
export interface AppBridge {
  state(): unknown;
  update(target: 'print' | 'robot', patch: Record<string, unknown>): string[];
  chooseOrientation(index: number): string | null;
  rotate(axis: 'x' | 'y' | 'z', degrees: number): string | null;
  rebuild(): Promise<unknown>;
}

const MODEL = 'claude-opus-5-5';
const KEY_STORAGE = 'gb.apikey';

const SYSTEM = `Sei l'assistente di Grasshopper Builder, un'app web che trasforma un modello 3D (mesh o BREP) in un percorso di stampa 3D a estrusione per un robot KUKA KR16 R2010 e lo esporta come file .src.

Lavori sul progetto aperto nella pagina tramite gli strumenti. Unità: millimetri e gradi. Le coordinate X/Y/Z sono nel sistema BASE del robot (BASE_DATA). Il robot sta nel punto indicato da robot.baseData rispetto alla BASE (con i valori attuali il robot è a Y = −1000, quindi Y più bassa = più vicino al robot). Il piano di lavoro è il rettangolo bedSizeX × bedSizeY centrato in (bedCenterX, bedCenterY).

Cose che l'utente chiede spesso e come farle:
- Spostare il pezzo sul piano: robot.placement = "origin" e robot.originX/originY (centro del pezzo in BASE); robot.rotationZ lo ruota sul piano.
- Cambiare il punto iniziale: print.startMode = "point" con print.startX/startY in BASE; la stampa parte dal punto del contorno più vicino. "auto" torna all'angolo davanti-sinistra.
- Orientamento: choose_orientation con l'indice della lista, oppure rotate_part per ruotare di 90° attorno a un asse.
- Modo di stampa: print.mode "auto" | "spiral" | "planar".

Regole:
- Se non conosci i valori attuali, chiama get_state prima di modificare.
- Dopo ogni modifica guarda il risultato che ricevi (avvisi, estensione in BASE, sbraccio) e dillo se qualcosa non va.
- Non inventare dati del controller (BASE_DATA, TOOL_DATA): cambiali solo se l'utente ti dà i valori.
- Se la richiesta è ambigua, fai una sola domanda breve invece di indovinare.
- Rispondi in italiano, in poche frasi: cosa hai cambiato e l'effetto sul percorso.`;

const TOOLS: BetaTool[] = [
  {
    name: 'get_state',
    description:
      'Legge lo stato del progetto: modello, orientamenti candidati, impostazioni di stampa (print) e robot (robot), e il risultato attuale (modo, strati, primo punto, estensione in BASE, sbraccio, avvisi).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_settings',
    description:
      'Modifica impostazioni di stampa e/o robot. Passa solo le chiavi da cambiare, con i nomi esatti restituiti da get_state. Il percorso viene ricalcolato e il nuovo risultato ti viene restituito.',
    input_schema: {
      type: 'object',
      properties: {
        print: { type: 'object', description: 'Chiavi di print da cambiare, es. {"startMode":"point","startX":120,"startY":400}' },
        robot: { type: 'object', description: 'Chiavi di robot da cambiare, es. {"originX":0,"originY":600,"rotationZ":90}' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'choose_orientation',
    description: "Sceglie uno degli orientamenti candidati (indice nella lista di get_state; 0 = il migliore). Annulla le rotazioni manuali.",
    input_schema: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0 } },
      required: ['index'],
      additionalProperties: false,
    },
  },
  {
    name: 'rotate_part',
    description: "Ruota il pezzo attorno a un asse del modello (cambia l'orientamento di stampa, non la posizione sul piano).",
    input_schema: {
      type: 'object',
      properties: {
        axis: { type: 'string', enum: ['x', 'y', 'z'] },
        degrees: { type: 'integer', enum: [90, 180, 270] },
      },
      required: ['axis', 'degrees'],
      additionalProperties: false,
    },
  },
];

const readKey = () => {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
};

export function mountChat(bridge: AppBridge) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = $('chat');
  const log = $('chatLog');
  const input = $<HTMLTextAreaElement>('chatInput');
  const send = $<HTMLButtonElement>('chatSend');
  const keyInput = $<HTMLInputElement>('chatKey');
  const keyBox = $('chatKeyBox');

  keyInput.value = readKey();
  keyBox.hidden = !!keyInput.value;
  keyInput.addEventListener('change', () => {
    try {
      localStorage.setItem(KEY_STORAGE, keyInput.value.trim());
    } catch {
      /* not persisted */
    }
    keyBox.hidden = !!keyInput.value.trim();
  });
  $('chatKeyEdit').onclick = () => (keyBox.hidden = !keyBox.hidden);
  $('chatToggle').onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  };
  $('chatClose').onclick = () => (panel.hidden = true);

  const messages: BetaMessageParam[] = [];
  let busy = false;

  const bubble = (text: string, cls: string) => {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = text;
    log.append(d);
    log.scrollTop = log.scrollHeight;
    return d;
  };

  async function runTool(name: string, input: unknown): Promise<{ text: string; error: boolean }> {
    const inp = (input ?? {}) as Record<string, unknown>;
    const withResult = async (note: string) => {
      bubble(note, 'action');
      const result = await bridge.rebuild();
      return { text: JSON.stringify({ ok: true, result }), error: false };
    };
    switch (name) {
      case 'get_state':
        return { text: JSON.stringify(bridge.state()), error: false };
      case 'update_settings': {
        const errors: string[] = [];
        const changed: string[] = [];
        for (const target of ['print', 'robot'] as const) {
          const patch = inp[target];
          if (patch === undefined) continue;
          if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
            errors.push(`${target} deve essere un oggetto`);
            continue;
          }
          const errs = bridge.update(target, patch as Record<string, unknown>);
          errors.push(...errs);
          changed.push(
            ...Object.entries(patch)
              .filter(([k]) => !errs.some((e) => e.startsWith(`${target}.${k}`)))
              .map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
          );
        }
        if (!changed.length) return { text: errors.join('; ') || 'Nessuna modifica', error: true };
        const r = await withResult('✓ ' + changed.join(', '));
        return errors.length ? { text: `${r.text}\nIgnorati: ${errors.join('; ')}`, error: false } : r;
      }
      case 'choose_orientation': {
        const err = typeof inp.index === 'number' ? bridge.chooseOrientation(inp.index) : 'index mancante';
        return err ? { text: err, error: true } : withResult(`✓ orientamento #${(inp.index as number) + 1}`);
      }
      case 'rotate_part': {
        const axis = inp.axis as 'x' | 'y' | 'z';
        const deg = inp.degrees as number;
        const err = ['x', 'y', 'z'].includes(axis) && [90, 180, 270].includes(deg) ? bridge.rotate(axis, deg) : 'asse o gradi non validi';
        return err ? { text: err, error: true } : withResult(`✓ rotazione ${axis.toUpperCase()} ${deg}°`);
      }
      default:
        return { text: `Strumento sconosciuto: ${name}`, error: true };
    }
  }

  async function ask(text: string) {
    const key = readKey();
    if (!key) {
      keyBox.hidden = false;
      bubble('Inserisci prima la tua chiave API Anthropic.', 'error');
      return;
    }
    busy = true;
    send.disabled = true;
    bubble(text, 'user');
    const waiting = bubble('…', 'assistant pending');
    const turnStart = messages.length;
    messages.push({ role: 'user', content: text });
    const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
    try {
      const client = new AnthropicClient({ apiKey: key, dangerouslyAllowBrowser: true });
      for (let turn = 0; turn < 12; turn++) {
        const response = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          system: SYSTEM,
          tools: TOOLS,
          messages,
        });
        // Append the full content (thinking blocks included) so the history stays append-only.
        messages.push({ role: 'assistant', content: response.content });
        for (const block of response.content) if (block.type === 'text' && block.text.trim()) bubble(block.text, 'assistant');

        if (response.stop_reason === 'refusal') {
          bubble('Claude ha rifiutato questa richiesta.', 'error');
          break;
        }
        if (response.stop_reason === 'max_tokens') {
          bubble('Risposta interrotta (troppo lunga).', 'error');
          break;
        }
        if (response.stop_reason === 'pause_turn') continue;
        if (response.stop_reason !== 'tool_use') break;

        const results: BetaToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          const r = await runTool(block.name, block.input);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: r.text, ...(r.error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      // Roll back this exchange so the next attempt starts from a valid history.
      messages.length = turnStart;
      let msg = e instanceof Error ? e.message : String(e);
      if (e instanceof AnthropicClient.AuthenticationError) msg = 'Chiave API non valida.';
      else if (e instanceof AnthropicClient.RateLimitError) msg = 'Troppe richieste: riprova tra poco.';
      else if (e instanceof AnthropicClient.APIConnectionError) msg = 'Connessione ad Anthropic non riuscita.';
      bubble(msg, 'error');
    } finally {
      waiting.remove();
      busy = false;
      send.disabled = false;
    }
  }

  const submit = () => {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    ask(text);
  };
  send.onclick = submit;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
}
