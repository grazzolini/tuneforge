import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
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
  type MusicalKey,
} from "../../lib/music";
import {
  buildChordDictionaryFollowContext,
  type ChordDictionaryFollowContext,
  type ChordDictionaryFollowStatus,
} from "../projects/chordDictionaryFollowContext";
import { usePlayback } from "../projects/playback-context";
import { useChordDictionaryFollowArm } from "./chordDictionaryFollowArm-context";

type ChordDictionarySurface = "dictionary" | "follow";
type NotePoint = {
  degree: string;
  displayFret: number;
  displayString: number;
  finger: string | null;
  fret: number;
  id: string;
  isOpen: boolean;
  note: string;
  shapeNote?: string;
  string: number;
};
type GuitarStringView = {
  displayString: number;
  label: string;
  string: number;
};
type GuitarStringMarker =
  | {
      degree: string;
      displayString: number;
      id: string;
      kind: "open";
      note: string;
      noteId: string;
      string: number;
    }
  | {
      displayString: number;
      id: string;
      kind: "muted";
      string: number;
    }
  | {
      displayString: number;
      id: string;
      kind: "empty";
      string: number;
    };
type GuitarBarreGroup = {
  displayFret: number;
  endDisplayString: number;
  endString: number;
  finger: string;
  fret: number;
  id: string;
  noteIds: readonly string[];
  startDisplayString: number;
  startString: number;
};
type GuitarFretWindow = {
  fretCount: number;
  frets: readonly number[];
  startFret: number;
};
type GuitarShape = {
  barreGroups: readonly GuitarBarreGroup[];
  fretWindow: GuitarFretWindow;
  id: string;
  label: string;
  meta: string;
  mutedStrings: readonly number[];
  notes: NotePoint[];
  stringMarkers: readonly GuitarStringMarker[];
  strings: readonly GuitarStringView[];
};

const COMMON_CHORD_LABELS = ["C", "Dm", "Em", "F", "G", "Am", "Bdim"] as const;

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ChordDictionaryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const routeFollowPlayback = searchParams.get("followPlayback") === "1";
  const routeProjectId = searchParams.get("projectId");
  const { manualFollowArmed, setManualFollowArmed } = useChordDictionaryFollowArm();
  const { isPlaying, playbackTimeSeconds, session } = usePlayback();
  const followArmed = routeFollowPlayback || manualFollowArmed;
  const followProject = useMemo(() => {
    if (!session) {
      return null;
    }
    if (routeProjectId && session.projectId !== routeProjectId) {
      return null;
    }
    return session.chordDictionaryFollowProject;
  }, [routeProjectId, session]);
  const followContext = useMemo(
    () =>
      buildChordDictionaryFollowContext({
        followArmed,
        playbackActive: isPlaying && Boolean(followProject),
        playbackTimeSeconds,
        project: followProject,
      }),
    [followArmed, followProject, isPlaying, playbackTimeSeconds],
  );
  const [surface, setSurface] = useState<ChordDictionarySurface>(() =>
    followArmed ? "follow" : "dictionary",
  );

  useEffect(() => {
    if (routeFollowPlayback) {
      setSurface("follow");
    }
  }, [routeFollowPlayback, routeProjectId]);

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
              onClick={() => {
                setManualFollowArmed(false);
                setSurface("dictionary");
                if (routeFollowPlayback || routeProjectId) {
                  const nextSearchParams = new URLSearchParams(searchParams);
                  nextSearchParams.set("tool", "chord-dictionary");
                  nextSearchParams.delete("followPlayback");
                  nextSearchParams.delete("projectId");
                  setSearchParams(nextSearchParams);
                }
              }}
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
              onClick={() => {
                setManualFollowArmed(true);
                setSurface("follow");
              }}
              title="Live follow"
              type="button"
            >
              <AudioLines aria-hidden="true" />
              <span>Live Follow</span>
            </button>
          </div>
        </div>

        {surface === "dictionary" ? (
          <DictionarySurface />
        ) : (
          <LiveFollowSurface context={followContext} requestedProjectId={routeProjectId} />
        )}
      </div>
    </div>
  );
}

function DictionarySurface() {
  const [activeChord, setActiveChord] = useState("C");
  const [activeShape, setActiveShape] = useState<string | null>(null);
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
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
        const voicing = voicings[0] ?? null;
        return {
          id: spelling.label,
          label: spelling.label,
          notes: spelling.notes.join(" "),
          quality: CHORD_QUALITY_DEFINITIONS[spelling.quality].label,
          shape: voicing ? toGuitarShape(voicing, GUITAR_STANDARD_PROFILE) : null,
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
    () => guitarVoicings.map((voicing) => toGuitarShape(voicing, GUITAR_STANDARD_PROFILE)),
    [guitarVoicings],
  );
  const resultKey = guitarShapes.map((shape) => shape.id).join("|");
  const firstShapeId = guitarShapes[0]?.id ?? null;
  const firstNoteId = guitarShapes[0]?.notes[0]?.id ?? null;
  useEffect(() => {
    setActiveShape(firstShapeId);
    setPreviewNoteId(null);
    setSelectedNoteId(firstNoteId);
  }, [firstNoteId, firstShapeId, resultKey]);
  const selectedShape = guitarShapes.find((shape) => shape.id === activeShape) ?? guitarShapes[0] ?? null;
  const selectedNote =
    selectedShape?.notes.find((note) => note.id === selectedNoteId) ?? selectedShape?.notes[0] ?? null;
  const previewNote = previewNoteId
    ? guitarShapes.flatMap((shape) => shape.notes).find((note) => note.id === previewNoteId) ?? null
    : null;
  const displayedNote = previewNote ?? selectedNote;
  const activeTooltipNoteId = previewNote?.id ?? selectedNote?.id ?? null;
  const selectedVoicing = guitarVoicings.find((voicing) => voicing.id === selectedShape?.id) ?? null;
  const sourceKeyLabel = displayContext.sourceKey
    ? formatKey(displayContext.sourceKey, "long")
    : "No source key";
  const transposeLabel = `${displayContext.transposeSemitones ?? 0} semitones`;
  const capoLabel = displayContext.capoFret ? `Capo ${displayContext.capoFret}` : "No capo";
  const tuningLabel = formatGuitarTuning(GUITAR_STANDARD_PROFILE);

  return (
    <div className="chord-dictionary">
      <div className="chord-dictionary-toolbar">
        <label className="chord-search">
          <span className="sr-only">Chord search</span>
          <Music2 aria-hidden="true" />
          <input
            aria-label="Chord search"
            onChange={(event) => {
              setActiveChord(event.currentTarget.value);
              setPreviewNoteId(null);
            }}
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
                        setPreviewNoteId(null);
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
              <div className="chord-shape-grid" data-layout="responsive">
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
                        setPreviewNoteId(null);
                        setSelectedNoteId(shape.notes[0]?.id ?? null);
                      }}
                      type="button"
                    >
                      {shape.label}
                    </button>
                    <GuitarFretboard
                      activeTooltipNoteId={activeTooltipNoteId}
                      notes={shape.notes}
                      selectedNoteId={selectedNoteId}
                      shape={shape}
                      onPreviewNote={setPreviewNoteId}
                      onSelectNote={(noteId) => {
                        setPreviewNoteId(null);
                        setSelectedNoteId(noteId);
                      }}
                    />
                    <span className="chord-shape-card__meta">{shape.meta}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {displayedNote ? <NoteInspector note={displayedNote} capoFret={displayContext.capoFret ?? 0} /> : null}

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
                    onClick={() => {
                      setActiveChord(chord.label);
                      setPreviewNoteId(null);
                    }}
                    type="button"
                  >
                    <strong>{chord.label}</strong>
                    <span>{chord.quality}</span>
                    <MiniFretboard shape={chord.shape} />
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

function toGuitarShape(voicing: GuitarVoicing, profile: typeof GUITAR_STANDARD_PROFILE): GuitarShape {
  const strings = getGuitarStringViews(profile);
  const displayStringByString = new Map(strings.map((string) => [string.string, string.displayString]));
  const fretWindow = getGuitarFretWindow(voicing.notes);
  const sourceLabel = voicing.source === "common" ? "Common" : "Generated";
  const mutedLabel = voicing.mutedStrings.length > 0 ? ` · ${formatCount(voicing.mutedStrings.length, "muted string")}` : "";
  const notes = voicing.notes.map((note) => {
    const shapePitch =
      voicing.capoFret > 0 ? midiToPitch(note.pitch.midi - voicing.capoFret)?.label : null;
    return {
      degree: note.degree,
      displayFret: getDisplayFret(note.fret, fretWindow),
      displayString: displayStringByString.get(note.string) ?? note.string,
      finger: note.finger ? String(note.finger) : null,
      fret: note.fret,
      id: `${voicing.id}-${note.string}-${note.fret}`,
      isOpen: note.fret === 0,
      note: note.note,
      shapeNote: shapePitch ?? undefined,
      string: note.string,
    };
  });
  const mutedStrings = [...voicing.mutedStrings];
  const mutedStringSet = new Set(mutedStrings);
  const frettedLabel = formatFretWindowLabel(notes);
  return {
    barreGroups: getGuitarBarreGroups(notes, mutedStringSet, voicing.label.toLowerCase().includes("barre")),
    fretWindow,
    id: voicing.id,
    label: voicing.label,
    meta: `${sourceLabel} · ${formatCount(voicing.notes.length, "note")} · ${frettedLabel}${mutedLabel}`,
    mutedStrings,
    notes,
    stringMarkers: getGuitarStringMarkers(strings, notes, mutedStringSet),
    strings,
  };
}

function getGuitarStringViews(profile: typeof GUITAR_STANDARD_PROFILE): readonly GuitarStringView[] {
  return profile.tuning
    .slice()
    .sort((left, right) => right.string - left.string)
    .map((stringTuning, index) => ({
      displayString: index + 1,
      label: stringTuning.openPitch.noteName,
      string: stringTuning.string,
    }));
}

function getGuitarFretWindow(notes: readonly GuitarVoicing["notes"][number][]): GuitarFretWindow {
  const frettedFrets = notes.map((note) => note.fret).filter((fret) => fret > 0);
  const maxFret = frettedFrets.length > 0 ? Math.max(...frettedFrets) : 0;
  const minFret = frettedFrets.length > 0 ? Math.min(...frettedFrets) : 0;
  const hasOpenString = notes.some((note) => note.fret === 0);
  const startFret = !hasOpenString && minFret > 1 ? minFret : 0;
  const neededFrets = startFret > 0 ? maxFret - startFret + 1 : Math.max(maxFret, 4);
  const fretCount = Math.max(4, neededFrets);
  const firstFretNumber = startFret > 0 ? startFret : 1;
  return {
    fretCount,
    frets: Array.from({ length: fretCount }, (_, index) => firstFretNumber + index),
    startFret,
  };
}

function getDisplayFret(fret: number, fretWindow: GuitarFretWindow) {
  if (fret === 0) {
    return 0;
  }
  return fretWindow.startFret > 0 ? fret - fretWindow.startFret + 1 : fret;
}

function formatFretWindowLabel(notes: readonly NotePoint[]) {
  const frets = notes.map((note) => note.fret);
  if (frets.length === 0) {
    return "open strings";
  }
  const minFret = Math.min(...frets);
  const maxFret = Math.max(...frets);
  return minFret === maxFret ? `fret ${minFret}` : `frets ${minFret}-${maxFret}`;
}

function getGuitarStringMarkers(
  strings: readonly GuitarStringView[],
  notes: readonly NotePoint[],
  mutedStrings: ReadonlySet<number>,
): readonly GuitarStringMarker[] {
  const openNotesByString = new Map(notes.filter((note) => note.isOpen).map((note) => [note.string, note]));
  return strings.map((string) => {
    const openNote = openNotesByString.get(string.string);
    if (openNote) {
      return {
        degree: openNote.degree,
        displayString: string.displayString,
        id: `${openNote.id}-open-marker`,
        kind: "open",
        note: openNote.note,
        noteId: openNote.id,
        string: string.string,
      };
    }
    if (mutedStrings.has(string.string)) {
      return {
        displayString: string.displayString,
        id: `muted-string-${string.string}`,
        kind: "muted",
        string: string.string,
      };
    }
    return {
      displayString: string.displayString,
      id: `empty-string-${string.string}`,
      kind: "empty",
      string: string.string,
    };
  });
}

function getGuitarBarreGroups(
  notes: readonly NotePoint[],
  mutedStrings: ReadonlySet<number>,
  inferUnfingeredBarre: boolean,
): readonly GuitarBarreGroup[] {
  const groupedNotes = new Map<string, NotePoint[]>();
  for (const note of notes) {
    if (!note.finger || note.fret === 0) {
      continue;
    }
    const key = `${note.finger}-${note.fret}`;
    groupedNotes.set(key, [...(groupedNotes.get(key) ?? []), note]);
  }

  const barreGroups: GuitarBarreGroup[] = [];
  for (const group of groupedNotes.values()) {
    const barreGroup = makeGuitarBarreGroup(group, mutedStrings, group[0]?.finger ?? "fingered");
    if (barreGroup) {
      barreGroups.push(barreGroup);
    }
  }

  if (inferUnfingeredBarre && barreGroups.length === 0) {
    const frettedNotes = notes.filter((note) => note.fret > 0);
    const lowestFret = frettedNotes.length > 0 ? Math.min(...frettedNotes.map((note) => note.fret)) : null;
    const lowestFretNotes = lowestFret === null ? [] : frettedNotes.filter((note) => note.fret === lowestFret);
    const inferredBarre = makeGuitarBarreGroup(lowestFretNotes, mutedStrings, "unfingered");
    if (inferredBarre) {
      barreGroups.push(inferredBarre);
    }
  }

  return barreGroups.sort(
    (left, right) =>
      left.displayFret - right.displayFret ||
      left.startDisplayString - right.startDisplayString ||
      right.endDisplayString - left.endDisplayString,
  );
}

function makeGuitarBarreGroup(
  group: readonly NotePoint[],
  mutedStrings: ReadonlySet<number>,
  idPrefix: string,
): GuitarBarreGroup | null {
  if (group.length < 2) {
    return null;
  }
  const sortedGroup = [...group].sort((left, right) => left.displayString - right.displayString);
  const numericStrings = sortedGroup.map((note) => note.string);
  const lowString = Math.min(...numericStrings);
  const highString = Math.max(...numericStrings);
  if (hasMutedStringBetween(lowString, highString, mutedStrings)) {
    return null;
  }
  const displayStrings = sortedGroup.map((note) => note.displayString);
  const startDisplayString = Math.min(...displayStrings);
  const endDisplayString = Math.max(...displayStrings);
  const firstNote = sortedGroup[0];
  return {
    displayFret: firstNote.displayFret,
    endDisplayString,
    endString: lowString,
    finger: firstNote.finger ?? "",
    fret: firstNote.fret,
    id: `barre-${idPrefix}-${firstNote.fret}-${highString}-${lowString}`,
    noteIds: sortedGroup.map((note) => note.id),
    startDisplayString,
    startString: highString,
  };
}

function hasMutedStringBetween(
  lowString: number,
  highString: number,
  mutedStrings: ReadonlySet<number>,
) {
  for (let string = lowString; string <= highString; string += 1) {
    if (mutedStrings.has(string)) {
      return true;
    }
  }
  return false;
}

function formatNoteButtonLabel(note: NotePoint) {
  return `${note.note} string ${note.string} fret ${note.fret}`;
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

function MiniFretboard({ shape }: { shape: GuitarShape | null }) {
  if (!shape) {
    return <span className="mini-fretboard" aria-hidden="true" />;
  }
  return (
    <span
      className="mini-fretboard"
      style={
        {
          "--display-frets": shape.fretWindow.fretCount,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span className="mini-fretboard__markers">
        {shape.stringMarkers.map((marker) => (
          <span
            key={marker.id}
            className={classNames(
              "mini-fretboard__marker",
              marker.kind === "open" && "mini-fretboard__marker--open",
              marker.kind === "muted" && "mini-fretboard__marker--muted",
            )}
            style={{ "--string": marker.displayString } as CSSProperties}
          >
            {marker.kind === "open" ? "O" : marker.kind === "muted" ? "X" : ""}
          </span>
        ))}
      </span>
      {shape.barreGroups.map((barre) => (
        <span
          key={barre.id}
          className="mini-fretboard__barre"
          style={
            {
              "--barre-end-string": barre.endString,
              "--barre-fret": barre.fret,
              "--barre-start-string": barre.startString,
              "--end-string": barre.endDisplayString,
              "--fret": barre.fret,
              "--fret-position": barre.displayFret,
              "--start-string": barre.startDisplayString,
              "--string-end": barre.endDisplayString,
              "--string-start": barre.startDisplayString,
              "--visible-fret": barre.displayFret,
            } as CSSProperties
          }
        />
      ))}
      {shape.notes.map((note) => (
        <span
          key={note.id}
          className="mini-fretboard__dot"
          style={
            {
              "--fret": note.fret,
              "--fret-position": note.displayFret,
              "--string": note.displayString,
              "--visible-fret": note.displayFret,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

function GuitarFretboard({
  activeTooltipNoteId,
  notes,
  onPreviewNote,
  onSelectNote,
  selectedNoteId,
  shape,
}: {
  activeTooltipNoteId: string | null;
  notes: readonly NotePoint[];
  onPreviewNote: (noteId: string | null) => void;
  onSelectNote: (noteId: string | null) => void;
  selectedNoteId: string | null;
  shape: GuitarShape;
}) {
  return (
    <span
      className="guitar-fretboard guitar-fretboard--standard"
      data-fret-orientation="horizontal"
      data-layout="compact"
      data-start-fret={shape.fretWindow.startFret}
      data-string-orientation="vertical"
      style={
        {
          "--display-frets": shape.fretWindow.fretCount,
        } as CSSProperties
      }
      aria-label={`${shape.label} standard guitar diagram`}
      role="group"
    >
      <span className="guitar-fretboard__markers" role="group" aria-label="String status markers">
        {shape.stringMarkers.map((marker) =>
          marker.kind === "open" ? (
            <span
              key={marker.id}
              aria-label={`Open string ${marker.string}`}
              className={classNames(
                "guitar-fretboard__marker",
                "guitar-fretboard__marker--open",
                "guitar-fretboard__string-marker",
                "guitar-fretboard__string-marker--open",
              )}
              data-string={marker.string}
              role="img"
              style={{ "--string": marker.displayString } as CSSProperties}
            >
              O
            </span>
          ) : marker.kind === "muted" ? (
            <span
              key={marker.id}
              aria-label={`Muted string ${marker.string}`}
              className="guitar-fretboard__marker guitar-fretboard__marker--muted guitar-fretboard__string-marker guitar-fretboard__string-marker--muted"
              data-string={marker.string}
              role="img"
              style={{ "--string": marker.displayString } as CSSProperties}
            >
              X
            </span>
          ) : (
            <span
              key={marker.id}
              aria-hidden="true"
              className="guitar-fretboard__marker guitar-fretboard__marker--empty"
              data-string={marker.string}
              style={{ "--string": marker.displayString } as CSSProperties}
            />
          ),
        )}
      </span>
      <span className="guitar-fretboard__board">
        {shape.barreGroups.map((barre) => (
          <span
            key={barre.id}
            aria-label={
              barre.finger
                ? `Barre finger ${barre.finger} fret ${barre.fret} strings ${barre.startString} to ${barre.endString}`
                : `Barre fret ${barre.fret} strings ${barre.startString} to ${barre.endString}`
            }
            className="guitar-fretboard__barre"
            data-barre-fret={barre.fret}
            data-barre-from-string={barre.startString}
            data-barre-to-string={barre.endString}
            data-finger={barre.finger}
            style={
              {
                "--barre-end-string": barre.endString,
                "--barre-fret": barre.fret,
                "--barre-start-string": barre.startString,
                "--end-string": barre.endDisplayString,
                "--fret": barre.fret,
                "--fret-position": barre.displayFret,
                "--start-string": barre.startDisplayString,
                "--string-end": barre.endDisplayString,
                "--string-start": barre.startDisplayString,
                "--visible-fret": barre.displayFret,
              } as CSSProperties
            }
          />
        ))}
        {notes.map((note) => (
          <button
            key={note.id}
            aria-label={formatNoteButtonLabel(note)}
            className={classNames(
              "guitar-fretboard__dot",
              note.isOpen && "guitar-fretboard__dot--open",
              shape.barreGroups.some((barre) => barre.noteIds.includes(note.id)) &&
                "guitar-fretboard__dot--over-barre",
              selectedNoteId === note.id && "guitar-fretboard__dot--selected",
              activeTooltipNoteId === note.id && "guitar-fretboard__dot--tooltip-active",
            )}
            data-fret={note.fret}
            data-note={note.note}
            data-note-kind={note.isOpen ? "open" : "fretted"}
            data-tooltip-active={activeTooltipNoteId === note.id ? "true" : "false"}
            data-string={note.string}
            onBlur={() => onPreviewNote(null)}
            onClick={(event) => {
              event.stopPropagation();
              onSelectNote(note.id);
            }}
            onFocus={() => onPreviewNote(note.id)}
            onPointerEnter={() => onPreviewNote(note.id)}
            onPointerLeave={() => onPreviewNote(null)}
            style={
              {
                "--fret": note.fret,
                "--fret-position": note.displayFret,
                "--string": note.displayString,
                "--visible-fret": note.displayFret,
              } as CSSProperties
            }
            title={note.note}
            type="button"
          >
            <span className="guitar-fretboard__dot-finger" aria-hidden="true">
              {note.finger}
            </span>
            <span className="guitar-fretboard__note-tooltip" aria-hidden="true">
              {note.note}
            </span>
          </button>
        ))}
      </span>
      <span className="guitar-fretboard__numbers" aria-hidden="true">
        {shape.fretWindow.frets.map((fret) => (
          <span key={fret}>{fret}</span>
        ))}
      </span>
      <span className="guitar-fretboard__strings">
        {shape.strings.map((string) => (
          <span
            key={string.string}
            aria-label={`String ${string.string} ${string.label}`}
            data-string={string.string}
          >
            {string.label}
          </span>
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

function LiveFollowSurface({
  context,
  requestedProjectId,
}: {
  context: ChordDictionaryFollowContext;
  requestedProjectId: string | null;
}) {
  if (context.status !== "active") {
    const showDictionaryFallback = context.status === "paused" || context.status === "follow-off";
    return (
      <div
        className="live-follow-page live-follow-page--waiting"
        data-follow-status={context.status}
      >
        <LiveFollowTopbar context={context} statusLabel={formatFollowStatusLabel(context.status)} />
        <LiveFollowStatusCard context={context} requestedProjectId={requestedProjectId} />
        {showDictionaryFallback ? <DictionarySurface /> : null}
      </div>
    );
  }

  return <LiveFollowActiveState context={context} />;
}

function LiveFollowActiveState({ context }: { context: ChordDictionaryFollowContext }) {
  const currentChord = context.currentChord;
  const project = context.project;
  const [activeShape, setActiveShape] = useState<string | null>(null);
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const displayContext = useMemo<Partial<ChordDisplayContext>>(
    () => ({
      canCapo: GUITAR_STANDARD_PROFILE.canCapo,
      capoFret: Math.max(0, Math.trunc(project?.visualCapoSemitoneShift ?? 0)),
      sourceKey: project?.displayedKey ?? null,
      transposeSemitones: 0,
      useCapoShapes: (project?.visualCapoSemitoneShift ?? 0) > 0,
    }),
    [project?.displayedKey, project?.visualCapoSemitoneShift],
  );
  const chordSpelling = useMemo(
    () =>
      currentChord
        ? spellChord(currentChord.displayLabel, {
            activeKey: project?.displayedKey ?? undefined,
          })
        : null,
    [currentChord, project?.displayedKey],
  );
  const guitarVoicings = useMemo(
    () =>
      chordSpelling
        ? generateGuitarVoicings(
            chordSpelling,
            GUITAR_STANDARD_PROFILE,
            displayContext,
            project?.displayedKey ? { activeKey: project.displayedKey } : {},
          )
        : [],
    [chordSpelling, displayContext, project?.displayedKey],
  );
  const guitarShapes = useMemo(
    () => guitarVoicings.map((voicing) => toGuitarShape(voicing, GUITAR_STANDARD_PROFILE)),
    [guitarVoicings],
  );
  const resultKey = guitarShapes.map((shape) => shape.id).join("|");
  const firstShapeId = guitarShapes[0]?.id ?? null;
  const firstNoteId = guitarShapes[0]?.notes[0]?.id ?? null;

  useEffect(() => {
    setActiveShape(firstShapeId);
    setPreviewNoteId(null);
    setSelectedNoteId(firstNoteId);
  }, [currentChord?.displayLabel, firstNoteId, firstShapeId, resultKey]);

  if (!currentChord || !project) {
    return (
      <div className="live-follow-page live-follow-page--waiting" data-follow-status="no-project">
        <LiveFollowTopbar context={context} statusLabel="No Project" />
        <LiveFollowStatusCard context={context} requestedProjectId={null} />
      </div>
    );
  }

  const playbackSourceLabel = formatPlaybackProjectLabel(project.projectName);

  if (!chordSpelling) {
    return (
      <LiveFollowChordIssue
        context={context}
        copy="The project timeline chord cannot be parsed by the chord dictionary, so no guitar voicing or note inspector is shown."
        statusLabel="Unsupported"
        title={`Unsupported chord: ${currentChord.displayLabel}`}
      />
    );
  }

  if (guitarShapes.length === 0) {
    return (
      <LiveFollowChordIssue
        context={context}
        copy="Chord spelling is supported, but the standard guitar model returned no voicings for this chord."
        statusLabel="No Voicing"
        title={`No guitar voicing for ${chordSpelling.label}`}
      />
    );
  }

  const selectedShape = guitarShapes.find((shape) => shape.id === activeShape) ?? guitarShapes[0] ?? null;
  const selectedNote =
    selectedShape?.notes.find((note) => note.id === selectedNoteId) ?? selectedShape?.notes[0] ?? null;
  const previewNote = previewNoteId
    ? guitarShapes.flatMap((shape) => shape.notes).find((note) => note.id === previewNoteId) ?? null
    : null;
  const displayedNote = previewNote ?? selectedNote;
  const activeTooltipNoteId = previewNote?.id ?? selectedNote?.id ?? null;
  const selectedVoicing = guitarVoicings.find((voicing) => voicing.id === selectedShape?.id) ?? null;
  const capoFret = displayContext.capoFret ?? 0;

  return (
    <div className="live-follow-page live-follow-page--active" data-follow-status="active">
      <LiveFollowTopbar context={context} statusLabel="Live" />

      <div className="chord-context-strip" aria-label="Live follow display context">
        <ContextChip icon="instrument" label={GUITAR_STANDARD_PROFILE.label} />
        <ContextChip icon="key" label={`Source ${formatOptionalKey(project.sourceKey)}`} />
        <ContextChip icon="key" label={`Display ${formatOptionalKey(project.displayedKey)}`} />
        <ContextChip
          icon="transpose"
          label={formatSemitoneContext(project.totalDisplayTransposeSemitones)}
        />
        <ContextChip icon="capo" label={capoFret > 0 ? `Capo ${capoFret}` : "No capo"} />
        <ContextChip icon="sound" label={chordSpelling.label} />
        {selectedVoicing?.shapeFamily ? (
          <ContextChip icon="shape" label={`${selectedVoicing.shapeFamily} shape`} />
        ) : null}
      </div>

      <div className="live-follow-grid">
        <main className="live-follow-main">
          <section className="live-current-chord" aria-label="Current chord">
            <p className="metric-label">Current chord</p>
            <h3>{currentChord.displayLabel}</h3>
            <dl className="live-follow-provenance">
              <div>
                <dt>Source chord</dt>
                <dd>{currentChord.sourceLabel}</dd>
              </div>
              <div>
                <dt>Display chord</dt>
                <dd>{currentChord.displayLabel}</dd>
              </div>
              <div>
                <dt>Segment</dt>
                <dd>
                  {formatFollowTime(currentChord.sourceSegment.start_seconds)} -{" "}
                  {formatFollowTime(currentChord.sourceSegment.end_seconds)}
                </dd>
              </div>
              <div>
                <dt>Timeline</dt>
                <dd>Detected/imported project chords</dd>
              </div>
              <div>
                <dt>Playback source</dt>
                <dd>{playbackSourceLabel}</dd>
              </div>
            </dl>
          </section>

          <section className="chord-section" aria-label="Current guitar voicing">
            <div className="chord-section-heading chord-section-heading--inline">
              <div>
                <p className="metric-label">{chordSpelling.notes.join(" ")}</p>
                <h3>{chordSpelling.label} guitar shapes</h3>
              </div>
              <div className="chord-shape-tabs" role="group" aria-label="Live guitar shape choices">
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
                      setPreviewNoteId(null);
                      setSelectedNoteId(shape.notes[0]?.id ?? null);
                    }}
                    type="button"
                  >
                    {shape.label}
                  </button>
                ))}
              </div>
            </div>
            <ChordSpellingSummary spelling={chordSpelling} />
            <div className="chord-shape-grid" data-layout="responsive">
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
                      setPreviewNoteId(null);
                      setSelectedNoteId(shape.notes[0]?.id ?? null);
                    }}
                    type="button"
                  >
                    {shape.label}
                  </button>
                  <GuitarFretboard
                    activeTooltipNoteId={activeTooltipNoteId}
                    notes={shape.notes}
                    selectedNoteId={selectedNoteId}
                    shape={shape}
                    onPreviewNote={setPreviewNoteId}
                    onSelectNote={(noteId) => {
                      setPreviewNoteId(null);
                      setSelectedNoteId(noteId);
                    }}
                  />
                  <span className="chord-shape-card__meta">{shape.meta}</span>
                </div>
              ))}
            </div>
          </section>
        </main>

        <aside className="live-follow-sidebar">
          <section className="live-next-chord" aria-label="Next chord">
            <p className="metric-label">Next chord</p>
            {context.nextChord ? (
              <>
                <strong>{context.nextChord.displayLabel}</strong>
                <span>
                  Source {context.nextChord.sourceLabel} at{" "}
                  {formatFollowTime(context.nextChord.sourceSegment.start_seconds)}
                </span>
              </>
            ) : (
              <>
                <strong>End of timeline</strong>
                <span>No later project chord is available.</span>
              </>
            )}
          </section>
          {displayedNote ? <NoteInspector note={displayedNote} capoFret={capoFret} /> : null}
        </aside>
      </div>
    </div>
  );
}

function LiveFollowTopbar({
  context,
  statusLabel,
}: {
  context: ChordDictionaryFollowContext;
  statusLabel: string;
}) {
  return (
    <div className="live-follow-topbar">
      <div className="live-follow-controls" role="group" aria-label="Live chord display status">
        <span className="chord-pill chord-pill--active">
          <Music2 aria-hidden="true" />
          <span>{GUITAR_STANDARD_PROFILE.label}</span>
        </span>
        <span
          className={classNames(
            "chord-pill",
            context.status === "active" ? "chord-pill--active" : "chord-pill--muted",
          )}
        >
          <AudioLines aria-hidden="true" />
          <span>{statusLabel}</span>
        </span>
        {context.project ? (
          <span className="chord-pill chord-pill--muted">
            <span>{formatPlaybackProjectLabel(context.project.projectName)}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LiveFollowStatusCard({
  context,
  requestedProjectId,
}: {
  context: ChordDictionaryFollowContext;
  requestedProjectId: string | null;
}) {
  const statusCopy = getLiveFollowStatusCopy(context, requestedProjectId);
  return (
    <div className="lyrics-follow-stage lyrics-follow-stage--empty" role="status" aria-live="polite">
      <div className="live-follow-empty">
        <AudioLines aria-hidden="true" />
        <h3>{statusCopy.title}</h3>
        <p>{statusCopy.copy}</p>
        {context.nextChord ? (
          <p>
            Next project chord: {context.nextChord.displayLabel} at{" "}
            {formatFollowTime(context.nextChord.sourceSegment.start_seconds)}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LiveFollowChordIssue({
  context,
  copy,
  statusLabel,
  title,
}: {
  context: ChordDictionaryFollowContext;
  copy: string;
  statusLabel: string;
  title: string;
}) {
  return (
    <div className="live-follow-page live-follow-page--waiting" data-follow-status="unsupported">
      <LiveFollowTopbar context={context} statusLabel={statusLabel} />
      <div className="lyrics-follow-stage lyrics-follow-stage--empty" role="status" aria-live="polite">
        <div className="live-follow-empty">
          <AudioLines aria-hidden="true" />
          <h3>{title}</h3>
          <p>{copy}</p>
          {context.currentChord ? (
            <p>
              Source chord {context.currentChord.sourceLabel}; displayed as{" "}
              {context.currentChord.displayLabel}.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function getLiveFollowStatusCopy(
  context: ChordDictionaryFollowContext,
  requestedProjectId: string | null,
) {
  switch (context.status) {
    case "no-project":
      return {
        title: "No matching project playback",
        copy: requestedProjectId
          ? "Live Follow is armed from a project, but no matching playback session is active."
          : "Live Follow needs an active project playback session before it can show song chords.",
      };
    case "follow-off":
      return {
        title: "Live Follow is off",
        copy: "Chord Dictionary is not armed from project playback, so no live project chord is shown.",
      };
    case "paused":
      return {
        title: "Playback paused",
        copy: "Paused playback returns to normal dictionary behavior. No stale live chord is shown.",
      };
    case "no-chord-timeline":
      return {
        title: "No project chord timeline",
        copy: "The active playback session has no detected or imported chord timeline to follow.",
      };
    case "no-current-chord":
      return {
        title: "No current chord at playback time",
        copy: `Playback is at ${formatFollowTime(context.playbackTimeSeconds)}, outside any current chord segment.`,
      };
    case "active":
      return {
        title: "Live chord active",
        copy: "Project playback is providing the current chord.",
      };
  }
}

function formatFollowStatusLabel(status: ChordDictionaryFollowStatus) {
  switch (status) {
    case "no-project":
      return "No Project";
    case "follow-off":
      return "Follow Off";
    case "paused":
      return "Paused";
    case "no-chord-timeline":
      return "No Timeline";
    case "no-current-chord":
      return "No Current Chord";
    case "active":
      return "Live";
  }
}

function formatPlaybackProjectLabel(projectName: string) {
  return projectName.trim() || "Project playback";
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

function formatOptionalKey(key: MusicalKey | null) {
  return key ? formatKey(key, "short") : "No key";
}

function formatSemitoneContext(semitones: number) {
  if (semitones === 0) {
    return "No transpose";
  }
  return `${semitones > 0 ? "+" : ""}${semitones} semitones`;
}

function formatFollowTime(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return "0:00";
  }
  const clampedSeconds = Math.max(0, seconds);
  const minutes = Math.floor(clampedSeconds / 60);
  const remainder = Math.floor(clampedSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatBooleanCapability(value: boolean) {
  return value ? "Supported" : "Unavailable";
}

function formatCount(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
