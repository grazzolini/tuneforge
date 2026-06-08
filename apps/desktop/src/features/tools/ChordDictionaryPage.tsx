import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ArrowUpDown,
  AudioLines,
  Gauge,
  Layers,
  Music2,
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
type NotePoint = {
  degree: string;
  finger: string | null;
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
  const [activeChord, setActiveChord] = useState("C");
  const [activeShape, setActiveShape] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const displayContext = useMemo<Partial<ChordDisplayContext>>(
    () => ({
      canCapo: GUITAR_STANDARD_PROFILE.canCapo,
      capoFret: 0,
      sourceKey: null,
      transposeSemitones: 0,
      useCapoShapes: false,
    }),
    [],
  );
  const chordQuery = activeChord.trim();
  const chordSpelling = useMemo(() => (chordQuery ? spellChord(chordQuery) : null), [chordQuery]);
  const unsupportedChord = chordQuery.length > 0 && !chordSpelling;
  const commonChords = useMemo(
    () =>
      COMMON_CHORD_LABELS.flatMap((label) => {
        const spelling = spellChord(label);
        if (!spelling) {
          return [];
        }
        const voicings = generateGuitarVoicings(spelling, GUITAR_STANDARD_PROFILE, displayContext);
        return {
          id: spelling.label,
          label: spelling.label,
          notes: spelling.notes.join(" "),
          quality: CHORD_QUALITY_DEFINITIONS[spelling.quality].label,
          voicing: voicings[0] ?? null,
          voicingCount: voicings.length,
        };
      }),
    [displayContext],
  );
  const guitarVoicings = useMemo(
    () => (chordSpelling ? generateGuitarVoicings(chordSpelling, GUITAR_STANDARD_PROFILE, displayContext) : []),
    [chordSpelling, displayContext],
  );
  const guitarShapes = useMemo(
    () => guitarVoicings.map((voicing) => toGuitarShape(voicing)),
    [guitarVoicings],
  );
  const resultKey = guitarShapes.map((shape) => shape.id).join("|");
  const firstShapeId = guitarShapes[0]?.id ?? null;
  const firstNoteId = guitarShapes[0]?.notes[0]?.id ?? null;
  useEffect(() => {
    setActiveShape(firstShapeId);
    setSelectedNoteId(firstNoteId);
  }, [firstNoteId, firstShapeId, resultKey]);
  const selectedShape = guitarShapes.find((shape) => shape.id === activeShape) ?? guitarShapes[0] ?? null;
  const selectedNote =
    selectedShape?.notes.find((note) => note.id === selectedNoteId) ?? selectedShape?.notes[0] ?? null;
  const selectedVoicing = guitarVoicings.find((voicing) => voicing.id === selectedShape?.id) ?? null;
  const sourceKeyLabel = displayContext.sourceKey
    ? formatKey(displayContext.sourceKey, "long")
    : "No source key";
  const transposeLabel = `${displayContext.transposeSemitones ?? 0} semitones`;
  const capoLabel = displayContext.capoFret ? `Capo ${displayContext.capoFret}` : "No capo";
  const tuningLabel = formatGuitarTuning(GUITAR_STANDARD_PROFILE);
  const stringLabels = getGuitarStringLabels(GUITAR_STANDARD_PROFILE);

  return (
    <div className="chord-dictionary">
      <div className="chord-dictionary-toolbar">
        <label className="chord-search">
          <span className="sr-only">Chord search</span>
          <Music2 aria-hidden="true" />
          <input
            aria-label="Chord search"
            onChange={(event) => setActiveChord(event.currentTarget.value)}
            placeholder="C major"
            value={activeChord}
          />
        </label>
        <div className="chord-toolbar-cluster" role="group" aria-label="Instrument status">
          <span className="chord-pill chord-pill--active">
            <Music2 aria-hidden="true" />
            <span>{GUITAR_STANDARD_PROFILE.label}</span>
          </span>
        </div>
      </div>

      {unsupportedChord ? (
        <div className="chord-dictionary-status" role="status">
          <strong>{activeChord}</strong>
          <span>Unsupported chord symbol. No backed spelling or guitar voicings available.</span>
        </div>
      ) : null}

      <div className="chord-context-strip" aria-label="Display context">
        <ContextChip icon="instrument" label={GUITAR_STANDARD_PROFILE.label} />
        <ContextChip icon="shape" label={tuningLabel} />
        <ContextChip icon="key" label={sourceKeyLabel} />
        <ContextChip icon="transpose" label={transposeLabel} />
        <ContextChip icon="capo" label={capoLabel} />
        <ContextChip icon="sound" label={chordSpelling?.label ?? "No supported chord"} />
        {selectedVoicing?.shapeFamily ? <ContextChip icon="shape" label={`${selectedVoicing.shapeFamily} shape`} /> : null}
      </div>

      <div className="chord-tool-grid">
        <main className="chord-tool-main">
          <div className="chord-field-row">
            <div className="chord-field">
              <span>Instrument</span>
              <strong>{GUITAR_STANDARD_PROFILE.label}</strong>
            </div>
            <div className="chord-field">
              <span>Tuning</span>
              <strong>{tuningLabel}</strong>
            </div>
            <div className="chord-field chord-field--compact">
              <span>Capo</span>
              <strong>{formatBooleanCapability(GUITAR_STANDARD_PROFILE.canCapo)}</strong>
            </div>
            <div className="chord-field chord-field--compact">
              <span>Retune</span>
              <strong>{formatBooleanCapability(GUITAR_STANDARD_PROFILE.canRetune)}</strong>
            </div>
          </div>

          <section className="chord-section">
            <div className="chord-section-heading chord-section-heading--inline">
              <div>
                <p className="metric-label">{chordSpelling?.notes.join(" ") ?? "No chord spelling"}</p>
                <h3>{chordSpelling ? `${chordSpelling.label} guitar shapes` : "Guitar shapes"}</h3>
              </div>
              {guitarShapes.length > 0 ? (
                <div className="chord-shape-tabs" role="group" aria-label="Guitar shape choices">
                  {guitarShapes.map((shape) => (
                    <button
                      key={shape.id}
                      aria-pressed={selectedShape?.id === shape.id}
                      className={classNames(
                        "chord-shape-tab",
                        selectedShape?.id === shape.id && "chord-shape-tab--active",
                      )}
                      onClick={() => {
                        setActiveShape(shape.id);
                        setSelectedNoteId(shape.notes[0]?.id ?? null);
                      }}
                      type="button"
                    >
                      {shape.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {chordSpelling ? (
              <ChordSpellingSummary spelling={chordSpelling} />
            ) : null}
            {chordSpelling && guitarShapes.length === 0 ? (
              <EmptyDictionaryState
                title={`No guitar shapes for ${chordSpelling.label}`}
                copy="Chord spelling is supported, but the guitar generator returned no voicings for the standard profile."
              />
            ) : unsupportedChord ? (
              <EmptyDictionaryState
                title="Unsupported chord"
                copy="No spelling, voicings, fretboard, or note inspector data shown for this search."
              />
            ) : chordQuery.length === 0 ? (
              <EmptyDictionaryState
                title="Enter a chord"
                copy="Type a supported chord symbol to show spelling, degrees, and guitar voicings."
              />
            ) : (
              <div className="chord-shape-grid">
                {guitarShapes.map((shape) => (
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
                        setSelectedNoteId(shape.notes[0]?.id ?? null);
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
                      stringLabels={stringLabels}
                    />
                    <span className="chord-shape-card__meta">{shape.meta}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {selectedNote ? <NoteInspector note={selectedNote} capoFret={displayContext.capoFret ?? 0} /> : null}

          {chordSpelling ? (
            <section className="chord-section">
              <div className="chord-section-heading">
                <div>
                  <p className="metric-label">Reference library</p>
                  <h3>Common chord library</h3>
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
                    <small>{formatCount(chord.voicingCount, "shape")}</small>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </main>

        <aside className="chord-understanding-panel">
          <div className="chord-understanding-panel__header">
            <div>
              <p className="metric-label">Instrument</p>
              <h3>{GUITAR_STANDARD_PROFILE.label}</h3>
            </div>
            <SlidersHorizontal aria-hidden="true" />
          </div>
          <dl className="chord-fact-list">
            <div>
              <dt>Range</dt>
              <dd>{formatGuitarRange(GUITAR_STANDARD_PROFILE)}</dd>
            </div>
            <div>
              <dt>Tuning</dt>
              <dd>{tuningLabel}</dd>
            </div>
            <div>
              <dt>Surface</dt>
              <dd>{`${GUITAR_STANDARD_PROFILE.tuning.length} strings x ${GUITAR_STANDARD_PROFILE.frets} frets`}</dd>
            </div>
            <div>
              <dt>Capo</dt>
              <dd>{formatBooleanCapability(GUITAR_STANDARD_PROFILE.canCapo)}</dd>
            </div>
          </dl>
          <div className="chord-accordion-list">
            <div className="chord-accordion-row chord-accordion-row--static">
              <span>
                <strong>{formatCount(guitarVoicings.filter((voicing) => voicing.source === "common").length, "common shape")}</strong>
                <small>{chordSpelling?.label ?? "No supported chord"}</small>
              </span>
            </div>
            <div className="chord-accordion-row chord-accordion-row--static">
              <span>
                <strong>{formatCount(guitarVoicings.filter((voicing) => voicing.source === "generated").length, "generated shape")}</strong>
                <small>{formatCount(guitarVoicings.length, "total shape")}</small>
              </span>
            </div>
            <div className="chord-accordion-row chord-accordion-row--static">
              <span>
                <strong>{formatCount(GUITAR_STANDARD_PROFILE.tuning.length, "string")}</strong>
                <small>{formatGuitarRange(GUITAR_STANDARD_PROFILE)}</small>
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function toGuitarShape(voicing: GuitarVoicing): GuitarShape {
  const frets = voicing.notes.map((note) => note.fret);
  const minFret = Math.min(...frets);
  const maxFret = Math.max(...frets);
  const sourceLabel = voicing.source === "common" ? "Common" : "Generated";
  const mutedLabel = voicing.mutedStrings.length > 0 ? ` · ${formatCount(voicing.mutedStrings.length, "muted string")}` : "";
  return {
    id: voicing.id,
    label: voicing.label,
    meta: `${sourceLabel} · ${formatCount(voicing.notes.length, "note")} · frets ${minFret}-${maxFret}${mutedLabel}`,
    notes: voicing.notes.map((note) => {
      const shapePitch =
        voicing.capoFret > 0 ? midiToPitch(note.pitch.midi - voicing.capoFret)?.label : null;
      return {
        degree: note.degree,
        finger: note.finger ? String(note.finger) : null,
        fret: note.fret,
        id: `${voicing.id}-${note.string}-${note.fret}`,
        note: note.note,
        shapeNote: shapePitch ?? undefined,
        string: note.string,
      };
    }),
  };
}

function ContextChip({ icon, label }: { icon: "capo" | "instrument" | "key" | "shape" | "sound" | "transpose"; label: string }) {
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
    string: Math.max(1, Math.min(6, note.string)),
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
  stringLabels,
}: {
  maxFret: number;
  notes: readonly NotePoint[];
  onSelectNote: (noteId: string | null) => void;
  selectedNoteId: string | null;
  stringLabels: readonly string[];
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
        {stringLabels.map((label, index) => (
          <span key={`${label}-${index}`}>{label}</span>
        ))}
      </span>
    </span>
  );
}

function NoteInspector({ capoFret, note }: { capoFret: number; note: NotePoint }) {
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
          <dd>{note.finger ?? "Not specified"}</dd>
        </div>
        <div>
          <dt>Degree</dt>
          <dd>{note.degree}</dd>
        </div>
        {capoFret > 0 ? (
          <>
            <div>
              <dt>Capo</dt>
              <dd>{capoFret}</dd>
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
  return (
    <div className="live-follow-page live-follow-page--waiting">
      <div className="live-follow-topbar">
        <div className="live-follow-controls" role="group" aria-label="Live chord display status">
          <span className="chord-pill chord-pill--active">
            <Music2 aria-hidden="true" />
            <span>{GUITAR_STANDARD_PROFILE.label}</span>
          </span>
          <span className="chord-pill chord-pill--muted">
            <AudioLines aria-hidden="true" />
            <span>Waiting</span>
          </span>
        </div>
      </div>

      <div className="lyrics-follow-stage lyrics-follow-stage--empty" role="status" aria-live="polite">
        <div className="live-follow-empty">
          <AudioLines aria-hidden="true" />
          <h3>Live Follow waiting for playback data</h3>
          <p>
            Project playback chord data is not connected yet. No progression, lyrics, shapes, or note previews are shown.
          </p>
        </div>
      </div>
    </div>
  );
}

function ChordSpellingSummary({ spelling }: { spelling: NonNullable<ReturnType<typeof spellChord>> }) {
  return (
    <div className="chord-spelling-summary" aria-label={`${spelling.label} chord spelling`}>
      {spelling.tones.map((tone) => (
        <span key={`${tone.degree}-${tone.noteName}`}>
          <strong>{tone.noteName}</strong>
          <small>{tone.degree}</small>
        </span>
      ))}
    </div>
  );
}

function EmptyDictionaryState({ copy, title }: { copy: string; title: string }) {
  return (
    <div className="chord-empty-state" role="status">
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  );
}

function formatGuitarTuning(profile: typeof GUITAR_STANDARD_PROFILE) {
  return getGuitarStringLabels(profile).slice().reverse().join(" ");
}

function getGuitarStringLabels(profile: typeof GUITAR_STANDARD_PROFILE) {
  return profile.tuning
    .slice()
    .sort((left, right) => left.string - right.string)
    .map((string) => string.openPitch.noteName);
}

function formatGuitarRange(profile: typeof GUITAR_STANDARD_PROFILE) {
  const openPitches = profile.tuning.map((string) => string.openPitch);
  const lowestOpen = openPitches.reduce((lowest, pitch) => (pitch.midi < lowest.midi ? pitch : lowest), openPitches[0]);
  const highestOpen = openPitches.reduce((highest, pitch) => (pitch.midi > highest.midi ? pitch : highest), openPitches[0]);
  const highestFretted = midiToPitch(highestOpen.midi + profile.frets);
  return `${lowestOpen.label} - ${highestFretted?.label ?? highestOpen.label}`;
}

function formatBooleanCapability(value: boolean) {
  return value ? "Supported" : "Unavailable";
}

function formatCount(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
