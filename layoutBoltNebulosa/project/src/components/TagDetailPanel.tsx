import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Hash, Sparkles, X } from 'lucide-react';
import type { OracleReading, OracleThought, TagDetail, TextSource } from '@/lib/api';

// Una domanda della cronologia, con la stella che le ha risposto.
export type AskedQuestion = { question: string; tag: string };

// Cosa dice l'Oracolo sulla stella aperta.
export type OracleState = {
  // stella a cui si riferisce
  tag: string;
  // domanda del visitatore a cui la stella risponde (null = nessuna: la
  // stella pronuncia una sentenza sul suo tema)
  question: string | null;
  // testo oracolare; null finche' l'Oracolo lo sta formulando
  text: string | null;
  // pensieri della nebulosa a cui si e' ispirato
  entries: OracleThought[];
  // frasi dei testi che ha consultato, citate con titolo e autore
  readings: OracleReading[];
  // l'Oracolo non e' raggiungibile: il riquadro non si mostra
  silent: boolean;
};

// Da dove viene una citazione: autore e titolo del testo.
function Attribution({ source }: { source?: TextSource | null }) {
  if (!source) return null;
  return <cite className="detail-source">{source.author}, <em>{source.title}</em></cite>;
}

// Il testo dell'Oracolo compare una parola alla volta, come se lo stesse
// pronunciando in quel momento.
function OracleText({ text }: { text: string }) {
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [said, setSaid] = useState(still ? words.length : 0);

  useEffect(() => {
    if (said >= words.length) return;
    const timer = window.setTimeout(() => setSaid(said + 1), said === 0 ? 500 : 130);
    return () => window.clearTimeout(timer);
  }, [said, words.length]);

  return (
    <p className="detail-oracle-answer" aria-label={text}>
      {words.map((word, i) => (
        // le parole non cambiano posizione: la chiave puo' essere l'indice
        <span key={i} className={i < said ? 'is-said' : undefined} aria-hidden="true">{word} </span>
      ))}
    </p>
  );
}

// Cronologia delle domande della visita, dalla prima all'ultima: si apre
// scorsa fino in fondo, dove ci sono le piu' recenti.
function QuestionHistory({
  history,
  current,
  onStep,
  hover,
}: {
  history: AskedQuestion[];
  current: number;
  onStep?: (index: number) => void;
  hover: (name: string) => object;
}) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [history.length]);

  return (
    <nav className="detail-trail detail-history" aria-label="Le tue domande">
      <p className="detail-trail-heading">Le tue domande</p>
      <ol ref={list}>
        {history.map((step, i) => (
          // la stessa domanda puo' tornare piu' volte: la chiave include la posizione
          <li key={`${i}-${step.question}`}>
            {i === current ? (
              <span className="detail-history-step is-current" aria-current="step">{step.question}</span>
            ) : (
              <button className="detail-history-step" onClick={() => onStep?.(i)} {...hover(step.tag)}>
                {step.question}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

type Props = {
  tag: TagDetail | null;
  // Quante stelle collegate sono illuminate nella nebulosa (tutte, non solo
  // le 12 piu' rilevanti elencate qui sotto).
  linkedCount?: number;
  // Le domande fatte finora nella visita, con la stella che ha risposto.
  history?: AskedQuestion[];
  oracle?: OracleState | null;
  // Vero mentre la nebulosa porta il visitatore su questa stella: la
  // risposta aspetta l'arrivo.
  arriving?: boolean;
  onClose: () => void;
  onSelectTag: (name: string) => void;
  // Torna a una domanda della cronologia (indice in `history`).
  onHistoryStep?: (index: number) => void;
  // Passando il mouse su un tag, la sua stella si illumina.
  onHoverTag?: (name: string | null) => void;
  // Dopo la risposta: fare un'altra domanda, o viaggiare nella nebulosa.
  onAskAnother?: () => void;
  onWander?: () => void;
  // La figura del viaggio e' completa: si puo' guardarla subito.
  figureReady?: boolean;
  onRevealFigure?: () => void;
  // Scheda aperta o ritirata a destra (resta solo la linguetta per riaprirla).
  open?: boolean;
  onToggle?: () => void;
};

// Scheda del tag, ancorata a destra: a differenza del vecchio modale non ha
// sfondo scuro ne' blocca i click, cosi' la nebulosa resta navigabile.
export default function TagDetailPanel({
  tag,
  linkedCount,
  history = [],
  oracle,
  arriving = false,
  onClose,
  onSelectTag,
  onHistoryStep,
  onHoverTag,
  onAskAnother,
  onWander,
  figureReady = false,
  onRevealFigure,
  open = true,
  onToggle,
}: Props) {
  if (!tag) return null;

  // L'Oracolo parla solo della stella mostrata (la scheda puo' essere ancora
  // quella precedente mentre la nuova si carica).
  const voice = oracle && oracle.tag === tag.name && !oracle.silent ? oracle : null;
  // La domanda a cui la stella risponde la rappresenta: diventa il titolo, e
  // il tag resta come piccola etichetta.
  const asked = oracle && oracle.tag === tag.name ? oracle.question : null;

  const hover = (name: string) => ({
    onMouseEnter: () => onHoverTag?.(name),
    onMouseLeave: () => onHoverTag?.(null),
    onFocus: () => onHoverTag?.(name),
    onBlur: () => onHoverTag?.(null),
  });
  // La domanda della cronologia a cui sta rispondendo questa stella (l'ultima volta).
  let current = -1;
  history.forEach((step, i) => {
    if (step.tag === tag.name && step.question === asked) current = i;
  });

  return (
    <aside className={`detail-dock${open ? '' : ' is-closed'}`} aria-label={`Tag ${tag.name}`}>
      {/* Linguetta: apre e chiude la scheda. Il puntino dice che la stella
          ha parlato e la risposta aspetta di essere letta. */}
      <button
        className={`detail-handle${!open && voice?.text && !arriving ? ' has-news' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? 'Nascondi la scheda' : 'Apri la risposta della stella'}
      >
        {open ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        <span>{open ? 'nascondi' : 'la risposta'}</span>
      </button>
      <button className="modal-close" onClick={onClose} aria-label="Chiudi"><X size={18} /></button>
      <div className="detail-dock-scroll" key={tag.name}>
        {history.length > 1 && (
          <QuestionHistory history={history} current={current} onStep={onHistoryStep} hover={hover} />
        )}

        <div className="detail-kind"><Hash size={15} /> {asked ? tag.name : 'Tag'}</div>
        <h2 className={`detail-title${asked ? ' is-question' : ''}`}>{asked ?? tag.name}</h2>
        <div className="detail-meta">
          <div><span>Frammenti</span><strong>{tag.count}</strong></div>
          <div><span>Stelle collegate</span><strong>{linkedCount ?? tag.related.length}</strong></div>
        </div>

        {voice && (
          <section className="detail-oracle" aria-label="L'Oracolo">
            <p className="detail-oracle-heading"><Sparkles size={12} /> L'Oracolo</p>
            {voice.text && !arriving ? (
              <OracleText key={voice.text} text={voice.text} />
            ) : (
              <p className="detail-oracle-waiting">la stella sta per parlare…</p>
            )}
            {voice.text && !arriving && voice.entries.length > 0 && (
              <div className="detail-oracle-sources">
                <p className="detail-oracle-label">Pensieri che ha ascoltato</p>
                {voice.entries.map((entry) => (
                  <p key={entry.id}>{entry.text}<Attribution source={entry.source} /></p>
                ))}
              </div>
            )}
            {voice.text && !arriving && voice.readings.length > 0 && (
              <div className="detail-oracle-sources">
                <p className="detail-oracle-label">Dai testi che ha letto</p>
                {voice.readings.map((reading) => (
                  <p key={`${reading.title}-${reading.text}`}>{reading.text}<Attribution source={reading} /></p>
                ))}
              </div>
            )}
            <div className="detail-oracle-actions">
              {figureReady && (
                <button className="detail-figure-ready" onClick={onRevealFigure}>la nebulosa ha preso forma: guardala</button>
              )}
              <button onClick={onAskAnother}>fai un'altra domanda</button>
              <button onClick={onWander}>viaggia nella nebulosa</button>
            </div>
          </section>
        )}

        {tag.entries.length > 0 && (
          <div className="detail-entries">
            {tag.entries.map((entry) => (
              <p className={`detail-entry${entry.source ? ' is-quote' : ''}`} key={entry.id}>
                {entry.text}
                <Attribution source={entry.source} />
              </p>
            ))}
          </div>
        )}

        {tag.related.length > 0 && (
          <div className="detail-connections">
            <p className="detail-conn-heading">Tag collegati</p>
            <div className="detail-bond-list">
              {tag.related.map((rel) => {
                // La frase che contiene entrambi i tag: perche' sono collegati.
                const shared = rel.entries?.[0];
                const others = rel.weight - 1;
                return (
                  <button key={rel.name} className="detail-bond" onClick={() => onSelectTag(rel.name)} {...hover(rel.name)}>
                    <span className="detail-bond-name">
                      <span className="detail-conn-dot" />
                      {rel.name}
                      <ArrowUpRight size={12} />
                    </span>
                    {shared && <span className="detail-bond-quote">{shared.text}</span>}
                    {shared?.source && <Attribution source={shared.source} />}
                    {shared && others > 0 && (
                      <span className="detail-bond-more">
                        {others === 1 ? 'e un\'altra frase in comune' : `e altre ${others} frasi in comune`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
