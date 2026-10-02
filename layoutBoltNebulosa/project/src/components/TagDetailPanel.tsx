import { ArrowUpRight, ChevronRight, Hash, Sparkles, X } from 'lucide-react';
import type { OracleThought, TagDetail } from '@/lib/api';

// Cosa dice l'Oracolo sulla stella aperta.
export type OracleState = {
  // stella a cui si riferisce
  tag: string;
  // chi ha fatto la domanda: il visitatore (dalla barra) o l'Oracolo stesso
  asker: 'visitor' | 'oracle';
  // null finche' l'Oracolo la sta formulando
  question: string | null;
  // null finche' non e' stata data
  answer: string | null;
  // vero mentre l'Oracolo sta rispondendo
  answering: boolean;
  // pensieri della nebulosa a cui si e' ispirata la risposta
  entries: OracleThought[];
  // l'Oracolo non e' raggiungibile: il riquadro non si mostra
  silent: boolean;
};

type Props = {
  tag: TagDetail | null;
  // Quante stelle collegate sono illuminate nella nebulosa (tutte, non solo
  // le 12 piu' rilevanti elencate qui sotto).
  linkedCount?: number;
  // Tappe del viaggio fatto finora, dalla prima alla stella aperta.
  trail?: string[];
  oracle?: OracleState | null;
  onClose: () => void;
  onSelectTag: (name: string) => void;
  // Torna a una tappa precedente del viaggio (indice in `trail`).
  onTrailStep?: (index: number) => void;
  // Passando il mouse su un tag, la sua stella si illumina.
  onHoverTag?: (name: string | null) => void;
  // Chiede all'Oracolo la risposta alla sua domanda, o un'altra domanda.
  onOracleAnswer?: () => void;
  onOracleAnother?: () => void;
};

// Scheda del tag, ancorata a destra: a differenza del vecchio modale non ha
// sfondo scuro ne' blocca i click, cosi' la nebulosa resta navigabile.
export default function TagDetailPanel({
  tag,
  linkedCount,
  trail = [],
  oracle,
  onClose,
  onSelectTag,
  onTrailStep,
  onHoverTag,
  onOracleAnswer,
  onOracleAnother,
}: Props) {
  if (!tag) return null;

  // L'Oracolo parla solo della stella mostrata (la scheda puo' essere ancora
  // quella precedente mentre la nuova si carica).
  const voice = oracle && oracle.tag === tag.name && !oracle.silent ? oracle : null;

  const hover = (name: string) => ({
    onMouseEnter: () => onHoverTag?.(name),
    onMouseLeave: () => onHoverTag?.(null),
    onFocus: () => onHoverTag?.(name),
    onBlur: () => onHoverTag?.(null),
  });

  return (
    <aside className="detail-dock" aria-label={`Tag ${tag.name}`}>
      <button className="modal-close" onClick={onClose} aria-label="Chiudi"><X size={18} /></button>
      <div className="detail-dock-scroll" key={tag.name}>
        {trail.length > 1 && (
          <nav className="detail-trail" aria-label="Viaggio">
            <p className="detail-trail-heading">Viaggio</p>
            <ol>
              {trail.map((name, i) => {
                const current = i === trail.length - 1;
                return (
                  // la stessa stella puo' comparire in piu' tappe: la chiave include la posizione
                  <li key={`${i}-${name}`}>
                    {i > 0 && <ChevronRight size={11} aria-hidden="true" />}
                    {current ? (
                      <span className="detail-trail-step is-current" aria-current="step">{name}</span>
                    ) : (
                      <button className="detail-trail-step" onClick={() => onTrailStep?.(i)} {...hover(name)}>{name}</button>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        <div className="detail-kind"><Hash size={15} /> Tag</div>
        <h2 className="detail-title">{tag.name}</h2>
        <div className="detail-meta">
          <div><span>Frammenti</span><strong>{tag.count}</strong></div>
          <div><span>Stelle collegate</span><strong>{linkedCount ?? tag.related.length}</strong></div>
        </div>

        {voice && (
          <section className="detail-oracle" aria-label="L'Oracolo">
            <p className="detail-oracle-heading"><Sparkles size={12} /> L'Oracolo</p>
            {voice.asker === 'visitor' && <p className="detail-oracle-label">Hai chiesto</p>}
            {voice.question ? (
              <p className={`detail-oracle-question${voice.asker === 'visitor' ? ' is-visitor' : ''}`}>{voice.question}</p>
            ) : (
              <p className="detail-oracle-waiting">l'Oracolo ti osserva…</p>
            )}
            {voice.answering && <p className="detail-oracle-waiting">l'Oracolo riflette…</p>}
            {voice.answer && <p className="detail-oracle-answer">{voice.answer}</p>}
            {voice.answer && voice.entries.length > 0 && (
              <div className="detail-oracle-sources">
                <p className="detail-oracle-label">Pensieri che ha ascoltato</p>
                {voice.entries.map((entry) => (
                  <p key={entry.id}>{entry.text}</p>
                ))}
              </div>
            )}
            {voice.asker === 'oracle' && voice.question && (
              <div className="detail-oracle-actions">
                {!voice.answer && (
                  <button onClick={onOracleAnswer} disabled={voice.answering}>chiedi la risposta</button>
                )}
                <button onClick={onOracleAnother} disabled={voice.answering}>un'altra domanda</button>
              </div>
            )}
          </section>
        )}

        {tag.entries.length > 0 && (
          <div className="detail-entries">
            {tag.entries.map((entry) => (
              <p className="detail-entry" key={entry.id}>{entry.text}</p>
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
