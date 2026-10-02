import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronRight, Hash, Sparkles, X } from 'lucide-react';
import type { OracleReading, OracleThought, TagDetail, TextSource } from '@/lib/api';

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
  // Dopo la risposta: fare un'altra domanda, o viaggiare nella nebulosa.
  onAskAnother?: () => void;
  onWander?: () => void;
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
  onAskAnother,
  onWander,
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
            {voice.question && (
              <>
                <p className="detail-oracle-label">Hai chiesto</p>
                <p className="detail-oracle-question">{voice.question}</p>
              </>
            )}
            {voice.text ? (
              <OracleText key={voice.text} text={voice.text} />
            ) : (
              <p className="detail-oracle-waiting">la stella sta per parlare…</p>
            )}
            {voice.text && voice.entries.length > 0 && (
              <div className="detail-oracle-sources">
                <p className="detail-oracle-label">Pensieri che ha ascoltato</p>
                {voice.entries.map((entry) => (
                  <p key={entry.id}>{entry.text}<Attribution source={entry.source} /></p>
                ))}
              </div>
            )}
            {voice.text && voice.readings.length > 0 && (
              <div className="detail-oracle-sources">
                <p className="detail-oracle-label">Dai testi che ha letto</p>
                {voice.readings.map((reading) => (
                  <p key={`${reading.title}-${reading.text}`}>{reading.text}<Attribution source={reading} /></p>
                ))}
              </div>
            )}
            <div className="detail-oracle-actions">
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
