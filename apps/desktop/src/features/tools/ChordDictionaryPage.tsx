import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ArrowUpDown,
  AudioLines,
  Gauge,
  Layers,
  Music2,
  RefreshCw,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import {
  CHORD_QUALITY_DEFINITIONS,
  GUITAR_STANDARD_PROFILE,
  formatKey,
  generateGuitarVoicings,
  midiToPitch,
  spellChord,
  type ChordDisplayContext,
  type GuitarVoicing,
} from "../../lib/music";

type ChordDictionarySurface = "dictionary" | "follow";
type InstrumentId = "guitar" | "piano" | "accordion" | "organ";
type NotePoint = {
  degree: string;
  finger: string;
  fret: number;
  id: string;
  note: string;
  shapeNote?: string;
  string: number;
};
type GuitarShape = {
  id: string;
  label: string;
  meta: string;
  notes: NotePoint[];
};

const COMMON_CHORD_LABELS = ["C", "Dm", "Em", "F", "G", "Am", "Bdim"] as const;

const liveProgression = [
  { chord: "C", shape: "C", seconds: "0:38", notes: "C4 E4 G4" },
  { chord: "G/D", shape: "close", seconds: "0:42", notes: "D4 G4 B4" },
  { chord: "Am/C", shape: "close", seconds: "0:46", notes: "C4 E4 A4" },
  { chord: "F/C", shape: "close", seconds: "0:50", notes: "C4 F4 A4" },
] as const;

const instrumentOptions: Array<{ id: InstrumentId; label: string }> = [
  { id: "guitar", label: "Guitar" },
  { id: "piano", label: "Piano" },
  { id: "accordion", label: "Accordion" },
  { id: "organ", label: "Organ" },
];

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ChordDictionaryPage() {
  const [surface, setSurface] = useState<ChordDictionarySurface>("dictionary");

  return (
    <div className="chord-dictionary-shell">
      <div className="panel chord-dictionary-panel">
        <div className="chord-dictionary-header">
          <div>
            <h2>Chord Dictionary</h2>
            <p className="subpanel__copy">Shapes, voicings, notes.</p>
          </div>
          <div className="chord-dictionary-actions" role="group" aria-label="Chord dictionary views">
            <button
              aria-pressed={surface === "dictionary"}
              className={classNames(
                "chord-icon-button",
                surface === "dictionary" && "chord-icon-button--active",
              )}
              onClick={() => setSurface("dictionary")}
              title="Dictionary"
              type="button"
            >
              <Layers aria-hidden="true" />
              <span>Dictionary</span>
            </button>
            <button
              aria-pressed={surface === "follow"}
              className={classNames(
                "chord-icon-button",
                surface === "follow" && "chord-icon-button--active",
              )}
              onClick={() => setSurface("follow")}
              title="Live follow"
              type="button"
            >
              <AudioLines aria-hidden="true" />
              <span>Live Follow</span>
            </button>
          </div>
        </div>

        {surface === "dictionary" ? <DictionarySurface /> : <LiveFollowSurface />}
      </div>
    </div>
  );
}

function DictionarySurface() {
  const [instrument, setInstrument] = useState<InstrumentId>("guitar");
  const [activeChord, setActiveChord] = useState("C");
  const [activeShape, setActiveShape] = useState("c-open");
  const [selectedNoteId, setSelectedNoteId] = useState("c-open-4");
  const [followArmed, setFollowArmed] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const displayContext = useMemo<Partial<ChordDisplayContext>>(
    () =>
      followArmed && previewActive
        ? {
            canCapo: true,
            capoFret: 2,
            sourceKey: { pitchClass: 6, mode: "major" },
            useCapoShapes: true,
          }
        : {
            canCapo: true,
            capoFret: 0,
            sourceKey: { pitchClass: 0, mode: "major" },
            useCapoShapes: false,
          },
    [followArmed, previewActive],
  );
  const effectiveChord = followArmed && previewActive ? "F#" : activeChord;
  const chordSpelling = spellChord(effectiveChord);
  const commonChords = useMemo(
    () =>
      COMMON_CHORD_LABELS.map((label) => {
        const spelling = spellChord(label);
        const voicing = generateGuitarVoicings(label)[0] ?? null;
        return {
          id: label,
          label,
          notes: spelling?.notes.join(" ") ?? "",
          quality: spelling ? CHORD_QUALITY_DEFINITIONS[spelling.quality].label : "",
          voicing,
        };
      }),
    [],
  );
  const guitarVoicings = useMemo(
    () => generateGuitarVoicings(effectiveChord, GUITAR_STANDARD_PROFILE, displayContext),
    [displayContext, effectiveChord],
  );
  const cagedShapes = useMemo(
    () => guitarVoicings.map((voicing) => toGuitarShape(voicing)),
    [guitarVoicings],
  );
  useEffect(() => {
    const firstShape = cagedShapes[0];
    if (!firstShape) {
      return;
    }
    setActiveShape(firstShape.id);
    setSelectedNoteId(firstShape.notes[0]?.id ?? "empty-note");
  }, [cagedShapes]);
  const selectedShape = cagedShapes.find((shape) => shape.id === activeShape) ?? cagedShapes[0];
  const selectedNote =
    cagedShapes.flatMap((shape) => shape.notes).find((note) => note.id === selectedNoteId) ??
    selectedShape?.notes[0] ??
    emptyNotePoint;
  const shapeFamily =
    guitarVoicings.find((voicing) => voicing.id === selectedShape?.id)?.shapeFamily ??
    selectedShape?.label.slice(0, 1) ??
    "C";
  const sourceKeyLabel = displayContext.sourceKey
    ? formatKey(displayContext.sourceKey, "long")
    : "C major";
  const transposeLabel = `${displayContext.transposeSemitones ?? 0}`;
  const capoLabel = displayContext.capoFret ? `+${displayContext.capoFret}` : "0";

  return (
    <div className="chord-dictionary">
      <div className="chord-dictionary-toolbar">
        <label className="chord-search">
          <span className="sr-only">Chord search</span>
          <Music2 aria-hidden="true" />
          <input
            aria-label="Chord search"
            onChange={(event) => setActiveChord(event.currentTarget.value || "C")}
            placeholder="C major"
            value={activeChord}
          />
        </label>
        <div className="chord-toolbar-cluster" aria-label="Instrument controls">
          {instrumentOptions.map((option) => (
            <button
              key={option.id}
              aria-pressed={instrument === option.id}
              className={classNames(
                "chord-pill",
                instrument === option.id && "chord-pill--active",
              )}
              onClick={() => setInstrument(option.id)}
              type="button"
            >
              <Music2 aria-hidden="true" />
              <span>{option.label}</span>
            </button>
          ))}
          <button className="chord-pill chord-pill--muted" type="button">
            <span>48</span>
            <span>More</span>
          </button>
        </div>
        <div className="chord-toolbar-cluster chord-toolbar-cluster--end">
          <button
            aria-label="Toggle project follow"
            aria-pressed={followArmed}
            className={classNames("chord-icon-button", followArmed && "chord-icon-button--active")}
            onClick={() => setFollowArmed((current) => !current)}
            title="Follow project playback"
            type="button"
          >
            <RefreshCw aria-hidden="true" />
            <span className="chord-live-dot" aria-hidden="true" />
          </button>
          <button
            aria-label="Preview playback active state"
            aria-pressed={previewActive}
            className={classNames("chord-icon-button", previewActive && "chord-icon-button--active")}
            onClick={() => setPreviewActive((current) => !current)}
            title="Playback active"
            type="button"
          >
            <AudioLines aria-hidden="true" />
          </button>
          <button className="chord-icon-button" title="Saved shapes" type="button">
            <Music2 aria-hidden="true" />
          </button>
          <button className="chord-icon-button" title="Settings" type="button">
            <Settings aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="chord-context-strip" aria-label="Display context">
        <ContextChip icon="key" label={sourceKeyLabel} />
        <ContextChip icon="transpose" label={transposeLabel} />
        <ContextChip icon="capo" label={capoLabel} />
        <span className="chord-context-arrow" aria-hidden="true">-&gt;</span>
        <ContextChip icon="shape" label={`${shapeFamily} shape`} />
        <ContextChip icon="sound" label={effectiveChord} />
      </div>

      <div className="chord-tool-grid">
        <main className="chord-tool-main">
          <div className="chord-field-row">
            <button className="chord-field" type="button">
              <span>Instrument</span>
              <strong>{instrumentOptions.find((option) => option.id === instrument)?.label}</strong>
            </button>
            <button className="chord-field" type="button">
              <span>Tuning</span>
              <strong>E A D G B E</strong>
            </button>
            <button className="chord-field chord-field--compact" type="button">
              <span>Capo</span>
              <strong>Yes</strong>
            </button>
            <button className="chord-field chord-field--compact" type="button">
              <span>Retune</span>
              <strong>Yes</strong>
            </button>
          </div>

          <section className="chord-section">
            <div className="chord-section-heading">
              <div>
                <p className="metric-label">Basic chords</p>
                <h3>C major</h3>
              </div>
              <div className="chord-view-toggle" role="group" aria-label="Dictionary filters">
                <button className="chord-mini-button chord-mini-button--active" type="button">
                  Major
                </button>
                <button className="chord-mini-button" type="button">Minor</button>
                <button className="chord-mini-button" type="button">7ths</button>
              </div>
            </div>
            <div className="chord-card-row">
              {commonChords.map((chord) => (
                <button
                  key={chord.id}
                  className={classNames(
                    "chord-family-card",
                    activeChord === chord.label && "chord-family-card--active",
                  )}
                  onClick={() => setActiveChord(chord.label)}
                  type="button"
                >
                  <strong>{chord.label}</strong>
                  <span>{chord.quality}</span>
                  <MiniFretboard notes={chord.voicing?.notes ?? []} />
                  <small>{chord.notes}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="chord-section">
            <div className="chord-section-heading chord-section-heading--inline">
              <div>
                <p className="metric-label">{chordSpelling?.label ?? effectiveChord}</p>
                <h3>CAGED</h3>
              </div>
              <div className="chord-shape-tabs" role="tablist" aria-label="CAGED shape family">
                {cagedShapes.map((shape) => (
                  <button
                    key={shape.id}
                    aria-selected={selectedShape?.id === shape.id}
                    className={classNames(
                      "chord-shape-tab",
                      selectedShape?.id === shape.id && "chord-shape-tab--active",
                    )}
                    onClick={() => {
                      setActiveShape(shape.id);
                      setSelectedNoteId(shape.notes[0]?.id ?? selectedNoteId);
                    }}
                    role="tab"
                    type="button"
                  >
                    {shape.label.replace(/\s.*$/, "")}
                  </button>
                ))}
              </div>
            </div>
            <div className="chord-shape-grid">
              {cagedShapes.map((shape) => (
                <div
                  key={shape.id}
                  className={classNames(
                    "chord-shape-card",
                    shape.id === activeShape && "chord-shape-card--active",
                  )}
                >
                  <button
                    className="chord-shape-card__label"
                    onClick={() => {
                      setActiveShape(shape.id);
                      setSelectedNoteId(shape.notes[0]?.id ?? selectedNoteId);
                    }}
                    type="button"
                  >
                    {shape.label}
                  </button>
                  <GuitarFretboard
                    maxFret={Math.max(...shape.notes.map((note) => note.fret), 4)}
                    notes={shape.notes}
                    selectedNoteId={selectedNoteId}
                    onSelectNote={setSelectedNoteId}
                  />
                  <span className="chord-shape-card__meta">{shape.meta}</span>
                </div>
              ))}
            </div>
          </section>

          <NoteInspector note={selectedNote} capoActive={followArmed && previewActive} />
        </main>

        <aside className="chord-understanding-panel">
          <div className="chord-understanding-panel__header">
            <div>
              <p className="metric-label">Instrument</p>
              <h3>Guitar</h3>
            </div>
            <SlidersHorizontal aria-hidden="true" />
          </div>
          <dl className="chord-fact-list">
            <div>
              <dt>Range</dt>
              <dd>E2 - E6</dd>
            </div>
            <div>
              <dt>Tuning</dt>
              <dd>EADGBE</dd>
            </div>
            <div>
              <dt>Surface</dt>
              <dd>6 x 22</dd>
            </div>
            <div>
              <dt>Capo</dt>
              <dd>Yes</dd>
            </div>
          </dl>
          <div className="chord-accordion-list">
            {[
              ["CAGED", "Common path"],
              ["Generated", "All shapes"],
              ["Setup", "Tunings"],
              ["Atlas", "Piano, accordion, organ"],
            ].map(([label, meta]) => (
              <button key={label} className="chord-accordion-row" type="button">
                <span>
                  <strong>{label}</strong>
                  <small>{meta}</small>
                </span>
                <span aria-hidden="true">-&gt;</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

const emptyNotePoint: NotePoint = {
  degree: "1",
  finger: "",
  fret: 0,
  id: "empty-note",
  note: "C4",
  string: 1,
};

function toGuitarShape(voicing: GuitarVoicing): GuitarShape {
  const frets = voicing.notes.map((note) => note.fret);
  const minFret = Math.min(...frets);
  const maxFret = Math.max(...frets);
  return {
    id: voicing.id,
    label: voicing.label,
    meta: `${voicing.source === "common" ? "Common" : "Generated"} · frets ${minFret}-${maxFret}`,
    notes: voicing.notes.map((note) => {
      const shapePitch =
        voicing.capoFret > 0 ? midiToPitch(note.pitch.midi - voicing.capoFret)?.label : null;
      return {
        degree: note.degree,
        finger: note.finger ? String(note.finger) : "",
        fret: note.fret,
        id: `${voicing.id}-${note.string}-${note.fret}`,
        note: note.note,
        shapeNote: shapePitch ?? undefined,
        string: note.string,
      };
    }),
  };
}

function ContextChip({ icon, label }: { icon: "capo" | "key" | "shape" | "sound" | "transpose"; label: string }) {
  const Icon =
    icon === "transpose" ? ArrowUpDown : icon === "capo" ? Gauge : icon === "shape" ? Layers : Music2;
  return (
    <span className="chord-context-chip">
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function MiniFretboard({ notes }: { notes: readonly GuitarVoicing["notes"][number][] }) {
  const dots = notes.slice(0, 4).map((note) => ({
    fret: Math.max(1, Math.min(4, note.fret + 1)),
    string: Math.max(1, Math.min(5, note.string)),
  }));
  return (
    <span className="mini-fretboard" aria-hidden="true">
      {dots.map((dot) => (
        <span
          key={`${dot.string}-${dot.fret}`}
          className="mini-fretboard__dot"
          style={{ "--fret": dot.fret, "--string": dot.string } as CSSProperties}
        />
      ))}
    </span>
  );
}

function GuitarFretboard({
  maxFret,
  notes,
  onSelectNote,
  selectedNoteId,
}: {
  maxFret: number;
  notes: readonly NotePoint[];
  onSelectNote: (noteId: string) => void;
  selectedNoteId: string;
}) {
  const displayFrets = Math.max(4, Math.min(8, maxFret));
  return (
    <span
      className="guitar-fretboard"
      style={{ "--display-frets": displayFrets } as CSSProperties}
      aria-label="Guitar fretboard"
      role="group"
    >
      <span className="guitar-fretboard__numbers" aria-hidden="true">
        {Array.from({ length: displayFrets + 1 }, (_, fret) => (
          <span key={fret}>{fret}</span>
        ))}
      </span>
      <span className="guitar-fretboard__board">
        {notes.map((note) => (
          <button
            key={note.id}
            aria-label={`${note.note} string ${note.string} fret ${note.fret}`}
            className={classNames(
              "guitar-fretboard__dot",
              selectedNoteId === note.id && "guitar-fretboard__dot--selected",
            )}
            onClick={(event) => {
              event.stopPropagation();
              onSelectNote(note.id);
            }}
            style={{ "--fret": note.fret, "--string": note.string } as CSSProperties}
            type="button"
          >
            {note.finger}
          </button>
        ))}
      </span>
      <span className="guitar-fretboard__strings" aria-hidden="true">
        <span>E</span>
        <span>B</span>
        <span>G</span>
        <span>D</span>
        <span>A</span>
        <span>E</span>
      </span>
    </span>
  );
}

function NoteInspector({ capoActive, note }: { capoActive: boolean; note: NotePoint }) {
  return (
    <section className="note-inspector" aria-label="Note inspector">
      <div className="note-inspector__badge">
        <strong>{note.note}</strong>
        <span>{note.degree}</span>
      </div>
      <dl>
        <div>
          <dt>String</dt>
          <dd>{note.string}</dd>
        </div>
        <div>
          <dt>Fret</dt>
          <dd>{note.fret}</dd>
        </div>
        <div>
          <dt>Finger</dt>
          <dd>{note.finger}</dd>
        </div>
        <div>
          <dt>Degree</dt>
          <dd>{note.degree}</dd>
        </div>
        {capoActive ? (
          <>
            <div>
              <dt>Capo</dt>
              <dd>+2</dd>
            </div>
            <div>
              <dt>Shape note</dt>
              <dd>{note.shapeNote ?? note.note}</dd>
            </div>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function LiveFollowSurface() {
  const [peekOpen, setPeekOpen] = useState(false);
  const [activeShape, setActiveShape] = useState("close");

  return (
    <div className="live-follow-page">
      <div className="live-follow-topbar">
        <div className="live-follow-controls" role="group" aria-label="Live chord display controls">
          <button className="chord-pill chord-pill--active" type="button">
            <Music2 aria-hidden="true" />
            <span>Accordion</span>
          </button>
          <button className="chord-pill" type="button">
            <Layers aria-hidden="true" />
            <span>{activeShape}</span>
          </button>
          <button className="chord-pill" type="button">
            <ArrowUpDown aria-hidden="true" />
            <span>C major</span>
          </button>
        </div>
        <div className="live-follow-tray" aria-label="Upcoming chord shapes">
          {liveProgression.map((item, index) => (
            <button
              key={item.chord}
              className={classNames("live-shape-chip", index === 0 && "live-shape-chip--active")}
              onClick={() => setActiveShape(item.shape)}
              type="button"
            >
              <strong>{item.chord}</strong>
              <span>{item.shape}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="lyrics-follow-stage">
        <div className="lyrics-follow-line lyrics-follow-line--muted">
          <div className="lyrics-chord-space" />
          <span>Tonight is heavy on one side</span>
        </div>
        <div className="lyrics-follow-line lyrics-follow-line--active">
          <div className="lyrics-chord-space">
            <button
              className="lyrics-chord-chip lyrics-chord-chip--active"
              onFocus={() => setPeekOpen(true)}
              onClick={() => setPeekOpen(true)}
              onMouseEnter={() => setPeekOpen(true)}
              type="button"
            >
              C
            </button>
            {peekOpen ? (
              <div className="chord-peek" role="dialog" aria-label="C chord preview">
                <div className="chord-peek__header">
                  <strong>C</strong>
                  <div className="chord-shape-tabs chord-shape-tabs--compact" role="group" aria-label="C shape choices">
                    {["natural", "C/E", "C/G"].map((shape) => (
                      <button
                        key={shape}
                        className={classNames(
                          "chord-shape-tab",
                          shape === "natural" && "chord-shape-tab--active",
                        )}
                        type="button"
                      >
                        {shape}
                      </button>
                    ))}
                  </div>
                </div>
                <AccordionPreview />
                <div className="chord-note-row">
                  {["C4", "E4", "G4"].map((note) => (
                    <span key={note}>{note}</span>
                  ))}
                </div>
                <div className="chord-peek__actions">
                  <button className="chord-mini-button chord-mini-button--active" type="button">
                    Pin
                  </button>
                  <button className="chord-mini-button" type="button">Dictionary</button>
                </div>
              </div>
            ) : null}
          </div>
          <span>You've got something on your mind and so have I</span>
        </div>
        <div className="lyrics-follow-line">
          <div className="lyrics-chord-space">
            <button className="lyrics-chord-chip" type="button">G/D</button>
            <button className="lyrics-chord-chip" type="button">Am/C</button>
          </div>
          <span>I can see it from here, oh</span>
        </div>
        <div className="lyrics-follow-line lyrics-follow-line--muted">
          <div className="lyrics-chord-space">
            <button className="lyrics-chord-chip" type="button">F/C</button>
          </div>
          <span>Ten years later, it's been a decade</span>
        </div>
      </div>

      <div className="live-follow-bottom">
        <div className="live-follow-timeline">
          {liveProgression.map((item, index) => (
            <button
              key={item.chord}
              className={classNames("live-timeline-segment", index === 0 && "live-timeline-segment--active")}
              type="button"
            >
              <strong>{item.chord}</strong>
              <span>{item.seconds}</span>
            </button>
          ))}
        </div>
        <div className="live-transport-strip">
          <button aria-label="Seek back" className="chord-icon-button" type="button">
            <RefreshCw aria-hidden="true" />
          </button>
          <button aria-label="Play playback" className="chord-icon-button chord-icon-button--active" type="button">
            <AudioLines aria-hidden="true" />
          </button>
          <input aria-label="Playback position" max="100" min="0" type="range" value="38" readOnly />
        </div>
      </div>
    </div>
  );
}

function AccordionPreview() {
  return (
    <div className="accordion-preview" aria-label="Accordion C chord">
      <div className="accordion-buttons" aria-hidden="true">
        {Array.from({ length: 36 }, (_, index) => {
          const active = index === 14 || index === 20;
          return <span key={index} className={active ? "accordion-buttons__dot accordion-buttons__dot--active" : "accordion-buttons__dot"} />;
        })}
      </div>
      <div className="accordion-keys" aria-hidden="true">
        {Array.from({ length: 15 }, (_, index) => {
          const active = index === 4 || index === 7 || index === 11;
          return <span key={index} className={active ? "accordion-keys__key accordion-keys__key--active" : "accordion-keys__key"} />;
        })}
      </div>
      <div className="accordion-preview__hint">
        <span>E4</span>
        <small>3</small>
      </div>
    </div>
  );
}
