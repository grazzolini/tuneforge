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
  ACCORDION_STANDARD_PROFILE,
  CHORD_QUALITY_DEFINITIONS,
  GUITAR_STANDARD_PROFILE,
  formatKey,
  formatPitchClass,
  generateGuitarVoicings,
  generateAccordionVoicings,
  midiToPitch,
  parsePitch,
  spellChord,
  type AccordionVoicing,
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
import {
  hasGlobalChordDictionaryPreferredShape,
  hasProjectChordDictionaryPreferredShape,
  resetGlobalChordDictionaryPreferredShape,
  resetProjectChordDictionaryPreferredShape,
  resolveChordDictionaryPreferredShapeId,
  writeGlobalChordDictionaryPreferredShape,
  writeProjectChordDictionaryPreferredShape,
  type ChordDictionaryPreferenceContext,
} from "./chordDictionaryPreferences";

type ChordDictionarySurface = "dictionary" | "follow";
type ChordDictionaryInstrumentId = "guitar" | "accordion";
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
type AccordionInspectorPoint = {
  degree: string | null;
  finger: string | null;
  hand: "Left" | "Right";
  id: string;
  label: string;
  pitchLabel: string;
  side: string;
  source: string;
  surface: string;
};
type AccordionButtonView = {
  candidateIds: readonly string[];
  column: number;
  degree: string | null;
  hand: "Left";
  id: string;
  isChordTone: boolean;
  label: string;
  noteLabel: string;
  pitchClass: number | null;
  pitchLabel: string;
  rowId: AccordionStradellaRowIdView;
  rowLabel: string;
  side: string;
  sourceColumn: number;
  surface: "Stradella";
};
type AccordionKeyboardNoteView = {
  degree: string;
  finger: string | null;
  hand: "Right";
  id: string;
  midi: number;
  noteLabel: string;
  pitchLabel: string;
  side: "Treble";
  surface: "Keyboard";
};
type AccordionKeyboardKeyView = {
  isBlack: boolean;
  midi: number;
  note: AccordionKeyboardNoteView | null;
  pitchLabel: string;
  whiteIndex: number;
};
type AccordionKeyboardSlice = {
  keys: readonly AccordionKeyboardKeyView[];
  whiteKeyCount: number;
};
type CompactKeyboardWindow = {
  endMidi: number;
  startMidi: number;
};
const COMPACT_KEYBOARD_C_FAMILY_END_PITCH_CLASS = 4;
const COMPACT_KEYBOARD_F_FAMILY_END_PITCH_CLASS = 11;
type AccordionLeftHandCandidateView = {
  addedTones: readonly string[];
  buttons: readonly AccordionButtonView[];
  buttonIds: readonly string[];
  detail: string;
  fingering: string | null;
  id: string;
  isExact: boolean;
  label: string;
  missingTones: readonly string[];
  rank: number;
};
type AccordionVoicingView = {
  buttons: readonly AccordionButtonView[];
  candidateIds: readonly string[];
  chordLabel: string;
  id: string;
  keyboardSlice: AccordionKeyboardSlice;
  label: string;
  leftHandCandidates: readonly AccordionLeftHandCandidateView[];
  rank: number;
  regionRoot: string | null;
  rightHandNotes: readonly AccordionKeyboardNoteView[];
  selectedCandidateId: string | null;
};
type AccordionStradellaRowIdView =
  | "diminished"
  | "seventh"
  | "minor"
  | "major"
  | "bass"
  | "counterbass"
  | (string & {});
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
const GUITAR_INSTRUMENT_ID = GUITAR_STANDARD_PROFILE.id;
const ACCORDION_INSTRUMENT_ID = ACCORDION_STANDARD_PROFILE.id;
const CHORD_DICTIONARY_INSTRUMENTS = [
  { id: GUITAR_INSTRUMENT_ID, label: GUITAR_STANDARD_PROFILE.label },
  { id: ACCORDION_INSTRUMENT_ID, label: ACCORDION_STANDARD_PROFILE.label },
] as const satisfies ReadonlyArray<{ id: ChordDictionaryInstrumentId; label: string }>;
const ACCORDION_STRADDELLA_ROWS = [
  { id: "diminished", label: "Dim" },
  { id: "seventh", label: "7" },
  { id: "minor", label: "Min" },
  { id: "major", label: "Maj" },
  { id: "bass", label: "Bass" },
  { id: "counterbass", label: "CB" },
] as const satisfies ReadonlyArray<{ id: AccordionStradellaRowIdView; label: string }>;
const ACCORDION_STRADDELLA_ROW_INDEX = new Map<string, number>(
  ACCORDION_STRADDELLA_ROWS.map((row, index) => [row.id, index]),
);

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function getChordDictionaryInstrumentLabel(instrumentId: ChordDictionaryInstrumentId) {
  return (
    CHORD_DICTIONARY_INSTRUMENTS.find((instrument) => instrument.id === instrumentId)?.label ??
    GUITAR_STANDARD_PROFILE.label
  );
}

function formatPreferenceKeyLabel(key: MusicalKey | null | undefined) {
  return key ? formatKey(key, "short") : null;
}

function buildShapePreferenceContext({
  capoFret,
  chordLabel,
  displayedKey,
  instrumentId,
  projectId,
  sourceKey,
  transposeSemitones,
  useCapoShapes,
}: {
  capoFret: number | null;
  chordLabel: string;
  displayedKey: MusicalKey | null;
  instrumentId: ChordDictionaryInstrumentId;
  projectId: string | null;
  sourceKey: MusicalKey | null;
  transposeSemitones: number | null;
  useCapoShapes: boolean | null;
}): ChordDictionaryPreferenceContext {
  return {
    capoFret,
    chordLabel,
    displayedKeyLabel: formatPreferenceKeyLabel(displayedKey),
    instrumentId,
    projectId,
    sourceKeyLabel: formatPreferenceKeyLabel(sourceKey),
    transposeSemitones,
    useCapoShapes,
  };
}

function promoteShapeToFirst<T extends { id: string }>(
  shapes: readonly T[],
  preferredShapeId: string | null,
): readonly T[] {
  const preferredShapeIndex = preferredShapeId
    ? shapes.findIndex((shape) => shape.id === preferredShapeId)
    : -1;
  if (preferredShapeIndex <= 0) {
    return shapes;
  }

  const preferredShape = shapes[preferredShapeIndex];
  if (!preferredShape) {
    return shapes;
  }

  return [
    preferredShape,
    ...shapes.slice(0, preferredShapeIndex),
    ...shapes.slice(preferredShapeIndex + 1),
  ];
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
  const [instrumentId, setInstrumentId] =
    useState<ChordDictionaryInstrumentId>(GUITAR_INSTRUMENT_ID);

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
          <DictionarySurface
            instrumentId={instrumentId}
            onInstrumentChange={setInstrumentId}
          />
        ) : (
          <LiveFollowSurface
            context={followContext}
            instrumentId={instrumentId}
            requestedProjectId={routeProjectId}
            onInstrumentChange={setInstrumentId}
          />
        )}
      </div>
    </div>
  );
}

function DictionarySurface({
  instrumentId,
  onInstrumentChange,
}: {
  instrumentId: ChordDictionaryInstrumentId;
  onInstrumentChange: (instrumentId: ChordDictionaryInstrumentId) => void;
}) {
  const [activeChord, setActiveChord] = useState("C");
  const [activeShape, setActiveShape] = useState<string | null>(null);
  const [activeAccordionVoicing, setActiveAccordionVoicing] = useState<string | null>(null);
  const [activeAccordionCandidate, setActiveAccordionCandidate] = useState<string | null>(null);
  const [previewAccordionPointId, setPreviewAccordionPointId] = useState<string | null>(null);
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
  const [, setPreferenceRevision] = useState(0);
  const [selectedAccordionPointId, setSelectedAccordionPointId] = useState<string | null>(null);
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
  const generatedGuitarShapes = useMemo(
    () => guitarVoicings.map((voicing) => toGuitarShape(voicing, GUITAR_STANDARD_PROFILE)),
    [guitarVoicings],
  );
  const generatedShapeIds = useMemo(
    () => generatedGuitarShapes.map((shape) => shape.id),
    [generatedGuitarShapes],
  );
  const preferenceContext = useMemo(
    () =>
      chordSpelling
        ? buildShapePreferenceContext({
            capoFret: displayContext.capoFret ?? null,
            chordLabel: chordSpelling.label,
            displayedKey: null,
            instrumentId: GUITAR_INSTRUMENT_ID,
            projectId: null,
            sourceKey: displayContext.sourceKey ?? null,
            transposeSemitones: displayContext.transposeSemitones ?? null,
            useCapoShapes: displayContext.useCapoShapes ?? null,
          })
        : null,
    [chordSpelling, displayContext],
  );
  const preferredShapeId = resolveChordDictionaryPreferredShapeId(
    preferenceContext,
    generatedShapeIds,
  );
  const hasGlobalShapePreference = hasGlobalChordDictionaryPreferredShape(
    preferenceContext,
    generatedShapeIds,
  );
  const guitarShapes = useMemo(
    () => promoteShapeToFirst(generatedGuitarShapes, preferredShapeId),
    [generatedGuitarShapes, preferredShapeId],
  );
  const resultKey = guitarShapes.map((shape) => shape.id).join("|");
  const firstShapeId = guitarShapes[0]?.id ?? null;
  const firstNoteId = guitarShapes[0]?.notes[0]?.id ?? null;
  const bumpPreferenceRevision = () => setPreferenceRevision((revision) => revision + 1);
  const selectShape = (shape: GuitarShape) => {
    writeGlobalChordDictionaryPreferredShape(preferenceContext, shape.id);
    bumpPreferenceRevision();
    setActiveShape(shape.id);
    setPreviewNoteId(null);
    setSelectedNoteId(shape.notes[0]?.id ?? null);
  };
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
  const accordionVoicings = useMemo(
    () =>
      chordSpelling
        ? generateAccordionVoicings(chordSpelling, null)
        : [],
    [chordSpelling],
  );
  const generatedAccordionVoicingViews = useMemo(
    () => toAccordionVoicingViews(accordionVoicings),
    [accordionVoicings],
  );
  const generatedAccordionVoicingIds = useMemo(
    () => generatedAccordionVoicingViews.map((voicing) => voicing.id),
    [generatedAccordionVoicingViews],
  );
  const accordionPreferenceContext = useMemo(
    () =>
      chordSpelling
        ? buildShapePreferenceContext({
            capoFret: null,
            chordLabel: chordSpelling.label,
            displayedKey: null,
            instrumentId: ACCORDION_INSTRUMENT_ID,
            projectId: null,
            sourceKey: null,
            transposeSemitones: null,
            useCapoShapes: null,
          })
        : null,
    [chordSpelling],
  );
  const preferredAccordionVoicingId = resolveChordDictionaryPreferredShapeId(
    accordionPreferenceContext,
    generatedAccordionVoicingIds,
  );
  const hasGlobalAccordionPreference = hasGlobalChordDictionaryPreferredShape(
    accordionPreferenceContext,
    generatedAccordionVoicingIds,
  );
  const accordionVoicingViews = useMemo(
    () => promoteShapeToFirst(generatedAccordionVoicingViews, preferredAccordionVoicingId),
    [generatedAccordionVoicingViews, preferredAccordionVoicingId],
  );
  const accordionResultKey = accordionVoicingViews.map((voicing) => voicing.id).join("|");
  const firstAccordionVoicingId = accordionVoicingViews[0]?.id ?? null;
  const firstAccordionCandidateId =
    accordionVoicingViews[0]?.selectedCandidateId ??
    accordionVoicingViews[0]?.leftHandCandidates[0]?.id ??
    null;
  const firstAccordionPointId =
    accordionVoicingViews[0]?.rightHandNotes[0]?.id ??
    accordionVoicingViews[0]?.buttons.find((button) =>
      firstAccordionCandidateId ? button.candidateIds.includes(firstAccordionCandidateId) : false,
    )?.id ??
    null;
  const selectAccordionVoicing = (voicing: AccordionVoicingView) => {
    writeGlobalChordDictionaryPreferredShape(accordionPreferenceContext, voicing.id);
    bumpPreferenceRevision();
    setActiveAccordionVoicing(voicing.id);
    setActiveAccordionCandidate(voicing.selectedCandidateId ?? voicing.leftHandCandidates[0]?.id ?? null);
    setPreviewAccordionPointId(null);
    setSelectedAccordionPointId(voicing.rightHandNotes[0]?.id ?? null);
  };
  useEffect(() => {
    setActiveAccordionVoicing(firstAccordionVoicingId);
    setActiveAccordionCandidate(firstAccordionCandidateId);
    setPreviewAccordionPointId(null);
    setSelectedAccordionPointId(firstAccordionPointId);
  }, [accordionResultKey, firstAccordionCandidateId, firstAccordionPointId, firstAccordionVoicingId]);
  const selectedAccordionVoicing =
    accordionVoicingViews.find((voicing) => voicing.id === activeAccordionVoicing) ??
    accordionVoicingViews[0] ??
    null;
  const selectedAccordionCandidate =
    selectedAccordionVoicing?.leftHandCandidates.find(
      (candidate) => candidate.id === activeAccordionCandidate,
    ) ??
    selectedAccordionVoicing?.leftHandCandidates.find(
      (candidate) => candidate.id === selectedAccordionVoicing.selectedCandidateId,
    ) ??
    selectedAccordionVoicing?.leftHandCandidates[0] ??
    null;
  const selectedAccordionPoint = selectedAccordionVoicing
    ? findAccordionInspectorPoint(
        selectedAccordionVoicing,
        selectedAccordionCandidate,
        selectedAccordionPointId,
      )
    : null;
  const previewAccordionPoint = previewAccordionPointId && selectedAccordionVoicing
    ? findAccordionInspectorPoint(
        selectedAccordionVoicing,
        selectedAccordionCandidate,
        previewAccordionPointId,
      )
    : null;
  const displayedAccordionPoint = previewAccordionPoint ?? selectedAccordionPoint;
  const activeAccordionPointId = previewAccordionPoint?.id ?? selectedAccordionPoint?.id ?? null;
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
              setPreviewAccordionPointId(null);
            }}
            placeholder="C major"
            value={activeChord}
          />
        </label>
        <InstrumentSelector
          ariaLabel="Instrument status"
          instrumentId={instrumentId}
          onInstrumentChange={onInstrumentChange}
        />
      </div>

      {unsupportedChord ? (
        <div className="chord-dictionary-status" role="status">
          <strong>{activeChord}</strong>
          <span>
            Unsupported chord symbol. No backed spelling or{" "}
            {instrumentId === ACCORDION_INSTRUMENT_ID ? "accordion voicings" : "guitar voicings"} available.
          </span>
        </div>
      ) : null}

      {instrumentId === ACCORDION_INSTRUMENT_ID ? (
        <AccordionDictionaryContent
          activePointId={activeAccordionPointId}
          activeChord={activeChord}
          chordSpelling={chordSpelling}
          displayedPoint={displayedAccordionPoint}
          hasGlobalPreference={hasGlobalAccordionPreference}
          selectedCandidate={selectedAccordionCandidate}
          selectedVoicing={selectedAccordionVoicing}
          unsupportedChord={unsupportedChord}
          voicings={accordionVoicingViews}
          onClearPreference={() => {
            resetGlobalChordDictionaryPreferredShape(accordionPreferenceContext);
            bumpPreferenceRevision();
          }}
          onPreviewPoint={setPreviewAccordionPointId}
          onSelectCandidate={(candidateId) => {
            setActiveAccordionCandidate(candidateId);
            setPreviewAccordionPointId(null);
            const nextCandidate =
              selectedAccordionVoicing?.leftHandCandidates.find((candidate) => candidate.id === candidateId) ??
              null;
            const nextPointId =
              (selectedAccordionVoicing
                ? getAccordionFirstCandidateButtonId(selectedAccordionVoicing, nextCandidate)
                : null) ??
              selectedAccordionVoicing?.rightHandNotes[0]?.id ??
              null;
            setSelectedAccordionPointId(nextPointId);
          }}
          onSelectPoint={(pointId) => {
            setPreviewAccordionPointId(null);
            setSelectedAccordionPointId(pointId);
          }}
          onSelectVoicing={selectAccordionVoicing}
        />
      ) : (
        <>
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
                <div className="chord-shape-controls">
                  <div className="chord-shape-control-row">
                    <div
                      aria-describedby="dictionary-shape-preference-copy"
                      aria-label="Global guitar shape preference choices"
                      className="chord-shape-tabs"
                      role="group"
                    >
                      {guitarShapes.map((shape) => (
                        <button
                          key={shape.id}
                          aria-pressed={selectedShape?.id === shape.id}
                          className={classNames(
                            "chord-shape-tab",
                            selectedShape?.id === shape.id && "chord-shape-tab--active",
                          )}
                          onClick={() => selectShape(shape)}
                          type="button"
                        >
                          {shape.label}
                        </button>
                      ))}
                    </div>
                    {hasGlobalShapePreference ? (
                      <button
                        aria-label="Clear this chord/instrument global preference"
                        className="chord-reset-button"
                        onClick={() => {
                          resetGlobalChordDictionaryPreferredShape(preferenceContext);
                          bumpPreferenceRevision();
                        }}
                        type="button"
                      >
                        Clear global preference
                      </button>
                    ) : null}
                  </div>
                  <p
                    className="chord-shape-preference-copy"
                    id="dictionary-shape-preference-copy"
                  >
                    Saves locally as global for this chord and instrument.
                  </p>
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
                      onClick={() => selectShape(shape)}
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
                      setPreviewAccordionPointId(null);
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
        </>
      )}
    </div>
  );
}

function InstrumentSelector({
  ariaLabel,
  instrumentId,
  onInstrumentChange,
}: {
  ariaLabel: string;
  instrumentId: ChordDictionaryInstrumentId;
  onInstrumentChange: (instrumentId: ChordDictionaryInstrumentId) => void;
}) {
  return (
    <div className="chord-toolbar-cluster chord-instrument-selector" role="group" aria-label={ariaLabel}>
      {CHORD_DICTIONARY_INSTRUMENTS.map((instrument) => (
        <button
          key={instrument.id}
          aria-pressed={instrumentId === instrument.id}
          className={classNames(
            "chord-pill",
            "chord-instrument-button",
            instrumentId === instrument.id && "chord-instrument-button--active",
          )}
          data-selected={instrumentId === instrument.id ? "true" : "false"}
          onClick={() => onInstrumentChange(instrument.id)}
          type="button"
        >
          <Music2 aria-hidden="true" />
          <span>{instrument.label}</span>
        </button>
      ))}
    </div>
  );
}

function AccordionDictionaryContent({
  activeChord,
  activePointId,
  chordSpelling,
  displayedPoint,
  hasGlobalPreference,
  onClearPreference,
  onPreviewPoint,
  onSelectCandidate,
  onSelectPoint,
  onSelectVoicing,
  selectedCandidate,
  selectedVoicing,
  unsupportedChord,
  voicings,
}: {
  activeChord: string;
  activePointId: string | null;
  chordSpelling: NonNullable<ReturnType<typeof spellChord>> | null;
  displayedPoint: AccordionInspectorPoint | null;
  hasGlobalPreference: boolean;
  selectedCandidate: AccordionLeftHandCandidateView | null;
  selectedVoicing: AccordionVoicingView | null;
  unsupportedChord: boolean;
  voicings: readonly AccordionVoicingView[];
  onClearPreference: () => void;
  onPreviewPoint: (pointId: string | null) => void;
  onSelectCandidate: (candidateId: string) => void;
  onSelectPoint: (pointId: string) => void;
  onSelectVoicing: (voicing: AccordionVoicingView) => void;
}) {
  const soundLabel = chordSpelling?.label ?? "No supported chord";
  const regionLabel = selectedVoicing?.regionRoot ? `Region ${selectedVoicing.regionRoot}` : "No key region";

  return (
    <>
      <div className="chord-context-strip" aria-label="Accordion display context">
        <ContextChip icon="instrument" label={ACCORDION_STANDARD_PROFILE.label} />
        <ContextChip icon="key" label={regionLabel} />
        <ContextChip icon="sound" label={soundLabel} />
      </div>

      {!chordSpelling || unsupportedChord ? (
        <EmptyDictionaryState
          title="Unsupported chord"
          copy="No spelling, accordion buttons, keyboard, or note inspector data shown for this search."
        />
      ) : voicings.length === 0 || !selectedVoicing ? (
        <EmptyDictionaryState
          title={`Accordion unavailable for ${chordSpelling.label}`}
          copy="Chord spelling is supported, but the accordion generator returned no voicings."
        />
      ) : (
        <div className="accordion-tool-grid">
          <main className="accordion-tool-main">
            <section className="chord-section" aria-label={`${chordSpelling.label} accordion positions`}>
              <div className="chord-section-heading chord-section-heading--inline">
                <div>
                  <p className="metric-label">{chordSpelling.notes.join(" ")}</p>
                  <h3>{chordSpelling.label} accordion positions</h3>
                </div>
                <div className="chord-shape-controls">
                  <div className="chord-shape-control-row">
                    <div
                      aria-describedby="accordion-voicing-preference-copy"
                      aria-label="Global accordion right-hand preference choices"
                      className="chord-shape-tabs"
                      role="group"
                    >
                      {voicings.map((voicing) => (
                        <button
                          key={voicing.id}
                          aria-pressed={selectedVoicing.id === voicing.id}
                          className={classNames(
                            "chord-shape-tab",
                            selectedVoicing.id === voicing.id && "chord-shape-tab--active",
                          )}
                          onClick={() => onSelectVoicing(voicing)}
                          type="button"
                        >
                          {voicing.label}
                        </button>
                      ))}
                    </div>
                    {hasGlobalPreference ? (
                      <button
                        aria-label="Clear this chord/instrument global preference"
                        className="chord-reset-button"
                        onClick={onClearPreference}
                        type="button"
                      >
                        Clear global preference
                      </button>
                    ) : null}
                  </div>
                  <p
                    className="chord-shape-preference-copy"
                    id="accordion-voicing-preference-copy"
                  >
                    Saves right-hand inversion only.
                  </p>
                </div>
              </div>
              <ChordSpellingSummary spelling={chordSpelling} />
              <AccordionVoicingPanel
                activeChord={activeChord}
                activePointId={activePointId}
                selectedCandidate={selectedCandidate}
                voicing={selectedVoicing}
                onPreviewPoint={onPreviewPoint}
                onSelectPoint={onSelectPoint}
              />
            </section>
          </main>

          <aside className="accordion-tool-sidebar">
          {displayedPoint ? <AccordionNoteInspector point={displayedPoint} /> : null}
          <AccordionCandidateList
            candidates={selectedVoicing.leftHandCandidates}
            selectedCandidateId={selectedCandidate?.id ?? null}
            onSelectCandidate={onSelectCandidate}
          />
          </aside>
        </div>
      )}
    </>
  );
}

function AccordionVoicingPanel({
  activeChord,
  activePointId,
  onPreviewPoint,
  onSelectPoint,
  selectedCandidate,
  voicing,
}: {
  activeChord: string;
  activePointId: string | null;
  selectedCandidate: AccordionLeftHandCandidateView | null;
  voicing: AccordionVoicingView;
  onPreviewPoint: (pointId: string | null) => void;
  onSelectPoint: (pointId: string) => void;
}) {
  const visibleButtons = getAccordionVoicingButtonsForCandidate(voicing, selectedCandidate);
  return (
    <div className="accordion-position-grid">
      <section className="accordion-position-card" aria-label="Left hand" role="group">
        <div className="accordion-position-card__heading">
          <h4>Left hand</h4>
          {selectedCandidate ? (
            <span
              className={classNames(
                "accordion-match-badge",
                selectedCandidate.isExact && "accordion-match-badge--exact",
              )}
            >
              {selectedCandidate.isExact ? "Exact" : "Approx"}
            </span>
          ) : null}
        </div>
        {visibleButtons.length > 0 ? (
          <AccordionStradellaLattice
            activePointId={activePointId}
            buttons={visibleButtons}
            selectedCandidate={selectedCandidate}
            onPreviewPoint={onPreviewPoint}
            onSelectPoint={onSelectPoint}
          />
        ) : (
          <EmptyDictionaryState
            title="No left-hand buttons"
            copy="Accordion data did not include visible Stradella buttons for this voicing."
          />
        )}
      </section>

      <section className="accordion-position-card" aria-label="Right hand" role="group">
        <div className="accordion-position-card__heading">
          <h4>Right hand</h4>
          <span className="accordion-match-badge accordion-match-badge--exact">Treble</span>
        </div>
        {voicing.keyboardSlice.keys.length > 0 ? (
          <AccordionKeyboard
            activeChord={activeChord}
            activePointId={activePointId}
            slice={voicing.keyboardSlice}
            onPreviewPoint={onPreviewPoint}
            onSelectPoint={onSelectPoint}
          />
        ) : (
          <EmptyDictionaryState
            title="No right-hand keyboard"
            copy="Accordion data did not include right-hand notes for this voicing."
          />
        )}
      </section>
    </div>
  );
}

function AccordionStradellaLattice({
  activePointId,
  buttons,
  onPreviewPoint,
  onSelectPoint,
  selectedCandidate,
}: {
  activePointId: string | null;
  buttons: readonly AccordionButtonView[];
  selectedCandidate: AccordionLeftHandCandidateView | null;
  onPreviewPoint: (pointId: string | null) => void;
  onSelectPoint: (pointId: string) => void;
}) {
  const selectedButtonIds = new Set(selectedCandidate?.buttonIds ?? []);
  const maxColumn = Math.max(10, ...buttons.map((button) => button.column)) + ACCORDION_STRADDELLA_ROWS.length;

  return (
    <div
      className="accordion-stradella"
      data-surface="stradella"
      style={{ "--accordion-root-count": maxColumn + 2 } as CSSProperties}
      aria-label="Accordion Stradella button lattice"
      role="group"
    >
      <div className="accordion-stradella__headers" aria-hidden="true">
        {ACCORDION_STRADDELLA_ROWS.map((row) => (
          <span key={row.id}>{row.label}</span>
        ))}
      </div>
      <div className="accordion-stradella__board">
        {buttons.map((button) => {
          const rowIndex = ACCORDION_STRADDELLA_ROW_INDEX.get(button.rowId) ?? 0;
          const isSelectedButton = selectedButtonIds.has(button.id);
          const isActiveButton = isSelectedButton || activePointId === button.id;
          return (
            <button
              key={button.id}
              aria-label={`${button.label} ${button.rowLabel} accordion button`}
              aria-pressed={isSelectedButton}
              className={classNames(
                "accordion-stradella__button",
                `accordion-stradella__button--${button.rowId}`,
                isSelectedButton && "accordion-stradella__button--selected",
                isActiveButton && "accordion-stradella__button--active",
              )}
              data-active={isActiveButton ? "true" : "false"}
              data-label={button.label}
              data-selected={isSelectedButton ? "true" : "false"}
              data-row={button.rowId}
              onBlur={() => onPreviewPoint(null)}
              onClick={() => onSelectPoint(button.id)}
              onFocus={() => onPreviewPoint(button.id)}
              onPointerEnter={() => onPreviewPoint(button.id)}
              onPointerLeave={() => onPreviewPoint(null)}
              style={
                {
                  "--accordion-button-column": rowIndex + 1,
                  "--accordion-button-row":
                    button.column + ACCORDION_STRADDELLA_ROWS.length - rowIndex,
                } as CSSProperties
              }
              title={`${button.label} ${button.rowLabel}`}
              type="button"
            >
              {button.rowId === "counterbass" ? null : button.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AccordionKeyboard({
  activeChord,
  activePointId,
  onPreviewPoint,
  onSelectPoint,
  slice,
}: {
  activeChord: string;
  activePointId: string | null;
  slice: AccordionKeyboardSlice;
  onPreviewPoint: (pointId: string | null) => void;
  onSelectPoint: (pointId: string) => void;
}) {
  const whiteKeys = slice.keys.filter((key) => !key.isBlack);
  const blackKeys = slice.keys.filter((key) => key.isBlack);

  return (
    <div
      className="accordion-keyboard"
      data-black-offset="true"
      data-layout="piano-vertical"
      data-orientation="vertical"
      data-surface="keyboard"
      style={{ "--accordion-white-key-count": slice.whiteKeyCount } as CSSProperties}
      aria-label={`${activeChord} right-hand accordion keyboard`}
      role="group"
    >
      <div className="accordion-keyboard__white-keys">
        {whiteKeys.map((key) => (
          <AccordionKeyboardKey
            key={key.midi}
            activePointId={activePointId}
            keyView={key}
            onPreviewPoint={onPreviewPoint}
            onSelectPoint={onSelectPoint}
          />
        ))}
      </div>
      <div className="accordion-keyboard__black-keys" aria-hidden={blackKeys.length === 0 ? "true" : undefined}>
        {blackKeys.map((key) => (
          <AccordionKeyboardKey
            key={key.midi}
            activePointId={activePointId}
            keyView={key}
            onPreviewPoint={onPreviewPoint}
            onSelectPoint={onSelectPoint}
          />
        ))}
      </div>
    </div>
  );
}

function AccordionKeyboardKey({
  activePointId,
  keyView,
  onPreviewPoint,
  onSelectPoint,
}: {
  activePointId: string | null;
  keyView: AccordionKeyboardKeyView;
  onPreviewPoint: (pointId: string | null) => void;
  onSelectPoint: (pointId: string) => void;
}) {
  const note = keyView.note;
  const className = classNames(
    "accordion-keyboard__key",
    keyView.isBlack ? "accordion-keyboard__key--black" : "accordion-keyboard__key--white",
    note && "accordion-keyboard__key--active-tone",
    note?.id === activePointId && "accordion-keyboard__key--selected",
  );
  const style = { "--accordion-white-index": keyView.whiteIndex } as CSSProperties;

  if (!note) {
    return (
      <span
        aria-hidden="true"
        className={className}
        data-midi={keyView.midi}
        data-key-color={keyView.isBlack ? "black" : "white"}
        data-key-position={keyView.isBlack ? "black-overlay" : "white-surface-row"}
        style={style}
      />
    );
  }

  return (
    <button
      aria-label={`${note.pitchLabel} degree ${note.degree} accordion keyboard key`}
      className={className}
      data-key-color={keyView.isBlack ? "black" : "white"}
      data-midi={keyView.midi}
      data-key-position={keyView.isBlack ? "black-overlay" : "white-surface-row"}
      onBlur={() => onPreviewPoint(null)}
      onClick={() => onSelectPoint(note.id)}
      onFocus={() => onPreviewPoint(note.id)}
      onPointerEnter={() => onPreviewPoint(note.id)}
      onPointerLeave={() => onPreviewPoint(null)}
      style={style}
      title={note.pitchLabel}
      type="button"
    >
      <strong>{note.pitchLabel}</strong>
      <span>{note.degree}</span>
    </button>
  );
}

export function AccordionCandidateList({
  candidates,
  onSelectCandidate,
  selectedCandidateId,
}: {
  candidates: readonly AccordionLeftHandCandidateView[];
  selectedCandidateId: string | null;
  onSelectCandidate: (candidateId: string) => void;
}) {
  if (candidates.length === 0) {
    return (
      <section className="accordion-candidate-panel" aria-label="Accordion left-hand candidates">
        <h4>Left hand</h4>
        <EmptyDictionaryState
          title="No left-hand candidates"
          copy="Accordion data did not include a valid left-hand button combination."
        />
      </section>
    );
  }

  const primaryCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) ?? candidates[0] ?? null;
  const missingToneSummary = primaryCandidate?.missingTones ?? [];
  const addedToneSummary = primaryCandidate?.addedTones ?? [];

  return (
    <section className="accordion-candidate-panel" aria-label="Accordion left-hand candidates">
      <h4>Left hand</h4>
      <div className="accordion-candidate-list">
        {candidates.map((candidate) => {
          const isSelectedCandidate = selectedCandidateId === candidate.id;
          return (
            <button
              key={candidate.id}
              aria-pressed={isSelectedCandidate}
              className={classNames(
                "accordion-candidate-card",
                isSelectedCandidate && "accordion-candidate-card--active",
              )}
              onClick={() => onSelectCandidate(candidate.id)}
              type="button"
            >
              <span className="accordion-candidate-card__title">
                <strong>{candidate.label}</strong>
                <span
                  className={classNames(
                    "accordion-match-badge",
                    candidate.isExact && "accordion-match-badge--exact",
                  )}
                >
                  {candidate.isExact ? "Exact" : "Approx"}
                </span>
              </span>
              <span>{candidate.detail}</span>
              {candidate.fingering ? <span>Fingering {candidate.fingering}</span> : null}
              {candidate.missingTones.length > 0 || candidate.addedTones.length > 0 ? (
                <span className="accordion-candidate-card__diff">
                  {candidate.missingTones.length > 0 ? (
                    <small>Missing: {candidate.missingTones.join(", ")}</small>
                  ) : null}
                  {candidate.addedTones.length > 0 ? (
                    <small>Added: {candidate.addedTones.join(", ")}</small>
                  ) : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {missingToneSummary.length > 0 || addedToneSummary.length > 0 ? (
        <div className="accordion-candidate-diff" aria-label="Accordion approximation differences">
          {missingToneSummary.length > 0 ? (
            <small>Missing: {missingToneSummary.join(", ")}</small>
          ) : null}
          {addedToneSummary.length > 0 ? (
            <small>Added: {addedToneSummary.join(", ")}</small>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AccordionNoteInspector({ point }: { point: AccordionInspectorPoint }) {
  return (
    <section className="note-inspector accordion-note-inspector" aria-label="Note inspector">
      <div className="note-inspector__badge">
        <strong>{point.pitchLabel}</strong>
        <span>{point.degree ?? point.label}</span>
      </div>
      <dl>
        <div>
          <dt>Pitch</dt>
          <dd>{point.pitchLabel}</dd>
        </div>
        <div>
          <dt>Degree</dt>
          <dd>{point.degree ?? "Not a chord tone"}</dd>
        </div>
        <div>
          <dt>Hand</dt>
          <dd>{point.hand}</dd>
        </div>
        <div>
          <dt>Side</dt>
          <dd>{point.side}</dd>
        </div>
        <div>
          <dt>Surface</dt>
          <dd>{point.surface}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{point.source}</dd>
        </div>
        {point.finger ? (
          <div>
            <dt>Finger</dt>
            <dd>{point.finger}</dd>
          </div>
        ) : null}
      </dl>
    </section>
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

function toAccordionVoicingViews(voicings: readonly AccordionVoicing[]): readonly AccordionVoicingView[] {
  return voicings.flatMap((voicing, voicingIndex): AccordionVoicingView[] => {
    const record = asUnknownRecord(voicing);
    if (!record) {
      return [];
    }

    const id = readString(record, ["id"]) ?? `accordion-voicing-${voicingIndex + 1}`;
    const rightHandNotes = readArray(record, ["rightHandNotes", "notes"]).flatMap((note, noteIndex) =>
      toAccordionKeyboardNoteView(note, id, noteIndex),
    );
    const rawLeftHandCandidates = readArray(record, ["leftHandCandidates", "candidates"]).flatMap(
      (candidate, candidateIndex) => toAccordionCandidateView(candidate, id, candidateIndex),
    );
    const leftHandCandidates = dedupeAccordionCandidateViews(rawLeftHandCandidates);
    const selectedCandidateRecord = asUnknownRecord(record.selectedLeftHandCandidate);
    const rawSelectedCandidateId = readString(selectedCandidateRecord, ["id"]);
    const selectedCandidateId =
      rawSelectedCandidateId && leftHandCandidates.some((candidate) => candidate.id === rawSelectedCandidateId)
        ? rawSelectedCandidateId
        : leftHandCandidates[0]?.id ?? null;
    const chordLabel = readString(record, ["chordLabel"]) ?? "";
    const buttons = annotateAccordionButtonDegrees(
      normalizeAccordionButtonColumns(
        readArray(record, ["visibleStradellaButtons", "buttons"]).flatMap((button, buttonIndex) =>
          toAccordionButtonView(button, id, buttonIndex, leftHandCandidates),
        ),
      ),
      chordLabel,
    );

    if (rightHandNotes.length === 0 && leftHandCandidates.length === 0 && buttons.length === 0) {
      return [];
    }

    return [
      {
        buttons,
        candidateIds: leftHandCandidates.map((candidate) => candidate.id),
        chordLabel,
        id,
        keyboardSlice: buildAccordionKeyboardSlice(rightHandNotes),
        label: readString(record, ["label"]) ?? `Voicing ${voicingIndex + 1}`,
        leftHandCandidates,
        rank: readNumber(record, ["rank"]) ?? voicingIndex,
        regionRoot: readAccordionRegionRoot(record),
        rightHandNotes,
        selectedCandidateId,
      },
    ];
  });
}

function toAccordionKeyboardNoteView(
  value: unknown,
  voicingId: string,
  noteIndex: number,
): AccordionKeyboardNoteView[] {
  const record = asUnknownRecord(value);
  if (!record) {
    return [];
  }
  const pitch = readPitchDescriptor(record, ["pitch", "parsedPitch"]);
  const midi = readNumber(record, ["midi", "pitchMidi"]) ?? pitch?.midi ?? null;
  if (midi === null) {
    return [];
  }
  const pitchLabel = pitch?.label ?? midiToPitch(midi)?.label ?? `MIDI ${midi}`;
  return [
    {
      degree: readString(record, ["degree"]) ?? "",
      finger: formatOptionalFinger(record.finger),
      hand: "Right",
      id: readString(record, ["id"]) ?? `${voicingId}-right-${noteIndex}`,
      midi,
      noteLabel: readString(record, ["note", "noteName"]) ?? pitch?.noteName ?? pitchLabel,
      pitchLabel,
      side: "Treble",
      surface: "Keyboard",
    },
  ];
}

function toAccordionCandidateView(
  value: unknown,
  voicingId: string,
  candidateIndex: number,
): AccordionLeftHandCandidateView[] {
  const record = asUnknownRecord(value);
  if (!record) {
    return [];
  }
  const id = readString(record, ["id"]) ?? `${voicingId}-left-${candidateIndex}`;
  const missingTones = readStringArray(record, ["missingTones", "missing", "missingNotes"]);
  const addedTones = readStringArray(record, ["addedTones", "added", "addedNotes", "extraTones"]);
  const buttonIds = collectAccordionCandidateButtonIds(record);
  const buttons = collectAccordionCandidateButtonViews(record, voicingId, candidateIndex, id);
  const matchText = readString(record, ["match", "matchKind", "quality", "status"]);
  const explicitExact = readBoolean(record, ["isExact", "exact"]);
  const isExact =
    explicitExact ??
    (matchText ? matchText.toLowerCase().includes("exact") : missingTones.length === 0 && addedTones.length === 0);
  const label =
    readString(record, ["label"]) ??
    formatAccordionCandidateLabel(record, buttonIds) ??
    `Left ${candidateIndex + 1}`;
  const detail =
    readString(record, ["detail", "summary", "description"]) ??
    formatAccordionCandidateDetail(record) ??
    "Left-hand button combination";

  return [
    {
      addedTones,
      buttons,
      buttonIds,
      detail,
      fingering: formatOptionalFinger(record.fingering ?? record.fingers),
      id,
      isExact,
      label,
      missingTones,
      rank: readNumber(record, ["rank"]) ?? candidateIndex,
    },
  ];
}

function dedupeAccordionCandidateViews(
  candidates: readonly AccordionLeftHandCandidateView[],
): readonly AccordionLeftHandCandidateView[] {
  const seenOptions = new Set<string>();
  return candidates.filter((candidate) => {
    const visibleKey = getAccordionCandidateVisibleKey(candidate);
    if (seenOptions.has(visibleKey)) {
      return false;
    }
    seenOptions.add(visibleKey);
    return true;
  });
}

function getAccordionCandidateVisibleKey(candidate: AccordionLeftHandCandidateView): string {
  return [
    candidate.label,
    candidate.detail,
    candidate.fingering ?? "",
    candidate.isExact ? "exact" : "approx",
    candidate.missingTones.join(","),
    candidate.addedTones.join(","),
  ].join("\u0000");
}

function toAccordionButtonView(
  value: unknown,
  voicingId: string,
  buttonIndex: number,
  candidates: readonly AccordionLeftHandCandidateView[],
): AccordionButtonView[] {
  const record = asUnknownRecord(value);
  if (!record) {
    return [];
  }
  const rowId = normalizeAccordionRowId(readString(record, ["rowId", "row", "type", "kind"]));
  const noteLabel = readAccordionButtonRoot(record) ?? `Button ${buttonIndex + 1}`;
  const explicitLabel = readString(record, ["compactLabel"]);
  const id = readString(record, ["id"]) ?? `${voicingId}-button-${rowId}-${buttonIndex}`;
  const sourceColumn = readNumber(record, ["column", "rootIndex", "index"]) ?? buttonIndex;
  const candidateIds = readStringArray(record, ["candidateIds", "matches"]).concat(
    readString(record, ["candidateId"]) ? [readString(record, ["candidateId"]) as string] : [],
  );
  const inferredCandidateIds = candidateIds.length > 0
    ? candidateIds
    : candidates
        .filter((candidate) => candidate.buttonIds.includes(id))
        .map((candidate) => candidate.id);
  const pitch = readPitchDescriptor(record, ["pitch", "parsedPitch"]);

  return [
    {
      candidateIds: inferredCandidateIds,
      column: sourceColumn,
      degree: readString(record, ["degree"]),
      hand: "Left",
      id,
      isChordTone: readBoolean(record, ["isChordTone", "target"]) ?? false,
      label: formatAccordionButtonLabel(explicitLabel, noteLabel, rowId),
      noteLabel,
      pitchClass: readNumber(record, ["pitchClass"]),
      pitchLabel: pitch?.label ?? readString(record, ["pitchLabel", "pitch"]) ?? noteLabel,
      rowId,
      rowLabel: formatAccordionRowLabel(rowId),
      side: formatTitleCase(readString(record, ["side"]) ?? "Bass"),
      sourceColumn,
      surface: "Stradella",
    },
  ];
}

function collectAccordionCandidateButtonViews(
  record: Record<string, unknown>,
  voicingId: string,
  candidateIndex: number,
  candidateId: string,
): readonly AccordionButtonView[] {
  const buttonsById = new Map<string, AccordionButtonView>();
  const candidateButtonValues = [
    record.bassButton,
    record.rootButton,
    record.chordButton,
    ...readArray(record, ["buttons", "pressedButtons"]),
  ];

  candidateButtonValues.forEach((button, buttonIndex) => {
    const buttonView = toAccordionButtonView(
      button,
      voicingId,
      candidateIndex * 10 + buttonIndex,
      [],
    )[0];
    if (!buttonView) {
      return;
    }
    buttonsById.set(buttonView.id, {
      ...buttonView,
      candidateIds: [...new Set([...buttonView.candidateIds, candidateId])],
    });
  });

  return [...buttonsById.values()];
}

function normalizeAccordionButtonColumns(
  buttons: readonly AccordionButtonView[],
): readonly AccordionButtonView[] {
  if (buttons.length === 0) {
    return buttons;
  }
  const minColumn = Math.min(...buttons.map((button) => button.sourceColumn));
  if (minColumn === 0) {
    return buttons.map((button) => ({
      ...button,
      column: button.sourceColumn,
    }));
  }
  return buttons.map((button) => ({
    ...button,
    column: button.sourceColumn - minColumn,
  }));
}

function getAccordionVoicingButtonsForCandidate(
  voicing: AccordionVoicingView,
  selectedCandidate: AccordionLeftHandCandidateView | null,
): readonly AccordionButtonView[] {
  if (!selectedCandidate || selectedCandidate.buttons.length === 0) {
    return voicing.buttons;
  }

  const buttonsById = new Map(voicing.buttons.map((button) => [button.id, button]));
  selectedCandidate.buttons.forEach((button) => {
    const existingButton = buttonsById.get(button.id);
    buttonsById.set(button.id, {
      ...(existingButton ?? button),
      candidateIds: [
        ...new Set([
          ...(existingButton?.candidateIds ?? []),
          ...button.candidateIds,
          selectedCandidate.id,
        ]),
      ],
      sourceColumn: existingButton?.sourceColumn ?? button.sourceColumn,
    });
  });

  return annotateAccordionButtonDegrees(
    normalizeAccordionButtonColumns([...buttonsById.values()]),
    voicing.chordLabel,
  );
}

function getAccordionFirstCandidateButtonId(
  voicing: AccordionVoicingView,
  selectedCandidate: AccordionLeftHandCandidateView | null,
): string | null {
  if (!selectedCandidate) {
    return null;
  }
  return (
    getAccordionVoicingButtonsForCandidate(voicing, selectedCandidate).find(
      (button) =>
        selectedCandidate.buttonIds.includes(button.id) ||
        button.candidateIds.includes(selectedCandidate.id),
    )?.id ?? null
  );
}

function annotateAccordionButtonDegrees(
  buttons: readonly AccordionButtonView[],
  chordLabel: string,
): readonly AccordionButtonView[] {
  const spelling = spellChord(chordLabel);
  if (!spelling) {
    return buttons;
  }
  return buttons.map((button) => {
    const buttonPitchClass = button.pitchClass;
    if (button.degree || buttonPitchClass === null) {
      return button;
    }
    const matchingTone = spelling.tones.find(
      (tone) => normalizePitchClassView(tone.pitchClass) === normalizePitchClassView(buttonPitchClass),
    );
    if (!matchingTone) {
      return button;
    }
    return {
      ...button,
      degree: matchingTone.degree,
      isChordTone: true,
    };
  });
}

function buildAccordionKeyboardSlice(
  notes: readonly AccordionKeyboardNoteView[],
): AccordionKeyboardSlice {
  if (notes.length === 0) {
    return { keys: [], whiteKeyCount: 0 };
  }

  const noteByMidi = new Map(notes.map((note) => [note.midi, note]));
  const window = buildCompactKeyboardWindow(notes.map((note) => note.midi));
  if (!window) {
    return { keys: [], whiteKeyCount: 0 };
  }

  const keysByPitch: Array<
    Omit<AccordionKeyboardKeyView, "whiteIndex"> & {
      lowerWhiteIndex: number;
      whiteAscendingIndex: number | null;
    }
  > = [];
  let whiteIndex = 0;
  for (let midi = window.startMidi; midi <= window.endMidi; midi += 1) {
    const pitch = midiToPitch(midi);
    const isBlack = isBlackPianoKey(midi);
    keysByPitch.push({
      isBlack,
      lowerWhiteIndex: isBlack ? Math.max(0, whiteIndex - 1) : whiteIndex,
      midi,
      note: noteByMidi.get(midi) ?? null,
      pitchLabel: pitch?.label ?? `MIDI ${midi}`,
      whiteAscendingIndex: isBlack ? null : whiteIndex,
    });
    if (!isBlack) {
      whiteIndex += 1;
    }
  }

  const whiteKeyCount = whiteIndex;
  const keys = keysByPitch.map(({ lowerWhiteIndex, whiteAscendingIndex, ...key }) => ({
    ...key,
    whiteIndex: key.isBlack
      ? Math.max(0, whiteKeyCount - 2 - lowerWhiteIndex)
      : whiteKeyCount - 1 - (whiteAscendingIndex ?? 0),
  }));

  return { keys, whiteKeyCount };
}

function buildCompactKeyboardWindow(activeMidis: readonly number[]): CompactKeyboardWindow | null {
  if (activeMidis.length === 0) {
    return null;
  }

  const lowestActiveMidi = Math.min(...activeMidis);
  const highestActiveMidi = Math.max(...activeMidis);
  const contextStartMidi = findCompactKeyboardWindowStartMidi(lowestActiveMidi);
  const minimumContextEndMidi = Math.max(
    lowestActiveMidi + 12,
    findCompactKeyboardWindowEndMidi(lowestActiveMidi, contextStartMidi),
  );

  return {
    startMidi: contextStartMidi,
    endMidi: findNearestWhiteKeyAtOrAbove(Math.max(highestActiveMidi, minimumContextEndMidi)),
  };
}

function findCompactKeyboardWindowStartMidi(lowestActiveMidi: number): number {
  return getCompactKeyboardFamilyStartMidi(lowestActiveMidi);
}

function getCompactKeyboardFamilyStartMidi(midi: number): number {
  const pitchClass = normalizePitchClassView(midi);
  return midi - (pitchClass < 5 ? pitchClass : pitchClass - 5);
}

function findCompactKeyboardWindowEndMidi(lowestActiveMidi: number, contextStartMidi: number): number {
  switch (getCompactKeyboardFamilyEndPitchClass(lowestActiveMidi)) {
    case null:
      return lowestActiveMidi + 12;
    case COMPACT_KEYBOARD_C_FAMILY_END_PITCH_CLASS:
      return getNextMidiForPitchClassAtOrAbove(contextStartMidi + 12, COMPACT_KEYBOARD_C_FAMILY_END_PITCH_CLASS);
    case COMPACT_KEYBOARD_F_FAMILY_END_PITCH_CLASS:
      return getNextMidiForPitchClassAtOrAbove(contextStartMidi + 12, COMPACT_KEYBOARD_F_FAMILY_END_PITCH_CLASS);
  }
  return lowestActiveMidi + 12;
}

function getCompactKeyboardFamilyEndPitchClass(lowestActiveMidi: number): number | null {
  const pitchClass = normalizePitchClassView(lowestActiveMidi);
  if (pitchClass >= 2 && pitchClass <= COMPACT_KEYBOARD_C_FAMILY_END_PITCH_CLASS) {
    return COMPACT_KEYBOARD_C_FAMILY_END_PITCH_CLASS;
  }
  if (pitchClass >= 9) {
    return COMPACT_KEYBOARD_F_FAMILY_END_PITCH_CLASS;
  }
  return null;
}

function getNextMidiForPitchClassAtOrAbove(midi: number, pitchClass: number): number {
  let keyMidi = midi;
  while (normalizePitchClassView(keyMidi) !== pitchClass) {
    keyMidi += 1;
  }
  return keyMidi;
}

function findNearestWhiteKeyAtOrAbove(midi: number): number {
  let keyMidi = midi;
  while (isBlackPianoKey(keyMidi)) {
    keyMidi += 1;
  }
  return keyMidi;
}

function findAccordionInspectorPoint(
  voicing: AccordionVoicingView,
  selectedCandidate: AccordionLeftHandCandidateView | null,
  pointId: string | null,
): AccordionInspectorPoint | null {
  const candidateButtonIds = new Set(selectedCandidate?.buttonIds ?? []);
  const visibleButtons = getAccordionVoicingButtonsForCandidate(voicing, selectedCandidate);
  const fallbackButton =
    visibleButtons.find((button) => candidateButtonIds.has(button.id)) ??
    visibleButtons.find((button) =>
      selectedCandidate ? button.candidateIds.includes(selectedCandidate.id) : false,
    ) ??
    null;
  const fallbackPointId = pointId ?? voicing.rightHandNotes[0]?.id ?? fallbackButton?.id ?? null;
  if (!fallbackPointId) {
    return null;
  }

  const rightNote = voicing.rightHandNotes.find((note) => note.id === fallbackPointId);
  if (rightNote) {
    return {
      degree: rightNote.degree,
      finger: rightNote.finger,
      hand: rightNote.hand,
      id: rightNote.id,
      label: rightNote.noteLabel,
      pitchLabel: rightNote.pitchLabel,
      side: rightNote.side,
      source: "Target chord tone",
      surface: rightNote.surface,
    };
  }

  const button = visibleButtons.find((buttonView) => buttonView.id === fallbackPointId);
  if (!button) {
    return null;
  }
  return {
    degree: button.degree,
    finger: null,
    hand: button.hand,
    id: button.id,
    label: button.noteLabel,
    pitchLabel: button.pitchLabel,
    side: button.side,
    source: selectedCandidate?.label ?? "Left-hand button",
    surface: button.surface,
  };
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function readNumber(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): number | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue)) {
        return numberValue;
      }
    }
  }
  return null;
}

function readBoolean(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): boolean | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function readArray(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): readonly unknown[] {
  if (!record) {
    return [];
  }
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function readStringArray(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): readonly string[] {
  return readArray(record, keys).flatMap((value) => {
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
    const nestedRecord = asUnknownRecord(value);
    const nestedLabel = readString(nestedRecord, ["label", "note", "pitch", "degree"]);
    return nestedLabel ? [nestedLabel] : [];
  });
}

function readPitchDescriptor(
  record: Record<string, unknown>,
  keys: readonly string[],
): { label: string; midi: number; noteName: string } | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const parsedPitch = parsePitch(value);
      if (parsedPitch) {
        return {
          label: parsedPitch.label,
          midi: parsedPitch.midi,
          noteName: parsedPitch.noteName,
        };
      }
    }
    const pitchRecord = asUnknownRecord(value);
    if (pitchRecord) {
      const midi = readNumber(pitchRecord, ["midi"]);
      const label = readString(pitchRecord, ["label", "pitch", "noteName"]);
      const noteName = readString(pitchRecord, ["noteName", "note", "label"]);
      if (midi !== null && label) {
        return { label, midi, noteName: noteName ?? label };
      }
    }
  }
  return null;
}

function readAccordionRegionRoot(record: Record<string, unknown>): string | null {
  const directRegionRoot = readString(record, ["regionRoot", "region", "keyRoot"]);
  if (directRegionRoot) {
    return directRegionRoot;
  }

  for (const key of ["regionRoot", "region", "keyRoot"]) {
    const regionRecord = asUnknownRecord(record[key]);
    if (!regionRecord) {
      continue;
    }

    const note = readString(regionRecord, ["note", "label", "root"]);
    if (note) {
      return note;
    }

    const pitchClass = readNumber(regionRecord, ["pitchClass"]);
    if (pitchClass !== null) {
      return formatPitchClass(pitchClass);
    }
  }

  return null;
}

function collectAccordionCandidateButtonIds(record: Record<string, unknown>): readonly string[] {
  const ids = new Set<string>(readStringArray(record, ["buttonIds"]));
  for (const key of ["buttons", "pressedButtons"]) {
    for (const button of readArray(record, [key])) {
      const buttonRecord = asUnknownRecord(button);
      const id = readString(buttonRecord, ["id"]);
      if (id) {
        ids.add(id);
      }
    }
  }
  for (const key of ["bassButton", "rootButton", "chordButton", "counterbassButton"]) {
    const buttonRecord = asUnknownRecord(record[key]);
    const id = readString(buttonRecord, ["id"]);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

function formatAccordionCandidateLabel(
  record: Record<string, unknown>,
  buttonIds: readonly string[],
): string | null {
  const bass = formatAccordionBassCandidateLabel(asUnknownRecord(record.bassButton ?? record.rootButton));
  const chord = formatAccordionButtonRecordCompactLabel(asUnknownRecord(record.chordButton));
  if (bass && chord) {
    return `${bass} + ${chord}`;
  }
  return buttonIds.length > 0 ? buttonIds.join(" + ") : null;
}

function formatAccordionCandidateDetail(record: Record<string, unknown>): string | null {
  const bass = formatAccordionBassCandidateLabel(asUnknownRecord(record.bassButton ?? record.rootButton));
  const chord = formatAccordionButtonRecordCompactLabel(asUnknownRecord(record.chordButton));
  if (bass && chord) {
    return `${bass} + ${chord} row`;
  }
  return null;
}

function formatAccordionBassCandidateLabel(record: Record<string, unknown> | null): string | null {
  const root = readAccordionButtonRoot(record);
  if (!root) {
    return null;
  }
  const rowId = normalizeAccordionRowId(readString(record, ["rowId", "row", "type", "kind"]));
  return rowId === "counterbass" ? `${root} counterbass` : `${root} bass`;
}

function formatAccordionButtonRecordCompactLabel(record: Record<string, unknown> | null): string | null {
  const root = readAccordionButtonRoot(record);
  if (!root) {
    return null;
  }
  const rowId = normalizeAccordionRowId(readString(record, ["rowId", "row", "type", "kind"]));
  return formatAccordionButtonLabel(readString(record, ["compactLabel"]), root, rowId);
}

function readAccordionButtonRoot(record: Record<string, unknown> | null | undefined): string | null {
  const root = readString(record, ["root", "note"]);
  if (root) {
    return root;
  }
  const label = readString(record, ["label", "button"]);
  return label?.replace(/\s+(counterbass|bass|major|minor|seventh|diminished)$/i, "") ?? null;
}

function normalizeAccordionRowId(value: string | null): AccordionStradellaRowIdView {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  if (normalized === "dim" || normalized === "dim7" || normalized === "diminished") {
    return "diminished";
  }
  if (normalized === "7" || normalized === "seventh" || normalized === "dominant7") {
    return "seventh";
  }
  if (normalized === "m" || normalized === "minor") {
    return "minor";
  }
  if (normalized === "maj" || normalized === "major") {
    return "major";
  }
  if (normalized === "counter" || normalized === "counterbass") {
    return "counterbass";
  }
  if (normalized === "bass" || normalized === "rootbass") {
    return "bass";
  }
  return normalized || "bass";
}

function formatAccordionRowLabel(rowId: AccordionStradellaRowIdView) {
  return ACCORDION_STRADDELLA_ROWS.find((row) => row.id === rowId)?.label ?? formatTitleCase(rowId);
}

function formatAccordionButtonLabel(
  explicitLabel: string | null,
  noteLabel: string,
  rowId: AccordionStradellaRowIdView,
) {
  if (rowId === "bass" || rowId === "counterbass") {
    return noteLabel;
  }
  if (explicitLabel && explicitLabel !== noteLabel) {
    return explicitLabel;
  }
  switch (rowId) {
    case "major":
      return `${noteLabel}M`;
    case "minor":
      return `${noteLabel}m`;
    case "seventh":
      return `${noteLabel}7`;
    case "diminished":
      return `${noteLabel}dim`;
    default:
      return noteLabel;
  }
}

function formatOptionalFinger(value: unknown): string | null {
  if (Array.isArray(value)) {
    const fingers = value
      .map((finger) => (typeof finger === "number" || typeof finger === "string" ? String(finger).trim() : ""))
      .filter(Boolean);
    return fingers.length > 0 ? fingers.join(" + ") : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function formatTitleCase(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isBlackPianoKey(midi: number) {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

function normalizePitchClassView(pitchClass: number) {
  return ((Math.trunc(pitchClass) % 12) + 12) % 12;
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
  instrumentId,
  onInstrumentChange,
  requestedProjectId,
}: {
  context: ChordDictionaryFollowContext;
  instrumentId: ChordDictionaryInstrumentId;
  onInstrumentChange: (instrumentId: ChordDictionaryInstrumentId) => void;
  requestedProjectId: string | null;
}) {
  if (context.status !== "active") {
    const showDictionaryFallback = context.status === "paused" || context.status === "follow-off";
    return (
      <div
        className="live-follow-page live-follow-page--waiting"
        data-follow-status={context.status}
      >
        <LiveFollowTopbar
          context={context}
          instrumentId={instrumentId}
          statusLabel={formatFollowStatusLabel(context.status)}
          onInstrumentChange={onInstrumentChange}
        />
        <LiveFollowStatusCard context={context} requestedProjectId={requestedProjectId} />
        {showDictionaryFallback ? (
          <DictionarySurface
            instrumentId={instrumentId}
            onInstrumentChange={onInstrumentChange}
          />
        ) : null}
      </div>
    );
  }

  return instrumentId === ACCORDION_INSTRUMENT_ID ? (
    <LiveFollowAccordionActiveState
      context={context}
      instrumentId={instrumentId}
      onInstrumentChange={onInstrumentChange}
    />
  ) : (
    <LiveFollowActiveState
      context={context}
      instrumentId={instrumentId}
      onInstrumentChange={onInstrumentChange}
    />
  );
}

function LiveFollowActiveState({
  context,
  instrumentId,
  onInstrumentChange,
}: {
  context: ChordDictionaryFollowContext;
  instrumentId: ChordDictionaryInstrumentId;
  onInstrumentChange: (instrumentId: ChordDictionaryInstrumentId) => void;
}) {
  const currentChord = context.currentChord;
  const project = context.project;
  const [activeShape, setActiveShape] = useState<string | null>(null);
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
  const [, setPreferenceRevision] = useState(0);
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
  const generatedGuitarShapes = useMemo(
    () => guitarVoicings.map((voicing) => toGuitarShape(voicing, GUITAR_STANDARD_PROFILE)),
    [guitarVoicings],
  );
  const generatedShapeIds = useMemo(
    () => generatedGuitarShapes.map((shape) => shape.id),
    [generatedGuitarShapes],
  );
  const preferenceContext = useMemo(
    () =>
      chordSpelling
        ? buildShapePreferenceContext({
            capoFret: displayContext.capoFret ?? null,
            chordLabel: chordSpelling.label,
            displayedKey: project?.displayedKey ?? null,
            instrumentId: GUITAR_INSTRUMENT_ID,
            projectId: project?.projectId ?? null,
            sourceKey: project?.sourceKey ?? null,
            transposeSemitones: project?.totalDisplayTransposeSemitones ?? null,
            useCapoShapes: displayContext.useCapoShapes ?? null,
          })
        : null,
    [
      chordSpelling,
      displayContext.capoFret,
      displayContext.useCapoShapes,
      project?.displayedKey,
      project?.projectId,
      project?.sourceKey,
      project?.totalDisplayTransposeSemitones,
    ],
  );
  const preferredShapeId = resolveChordDictionaryPreferredShapeId(
    preferenceContext,
    generatedShapeIds,
  );
  const hasProjectShapePreference = hasProjectChordDictionaryPreferredShape(
    preferenceContext,
    generatedShapeIds,
  );
  const guitarShapes = useMemo(
    () => promoteShapeToFirst(generatedGuitarShapes, preferredShapeId),
    [generatedGuitarShapes, preferredShapeId],
  );
  const resultKey = guitarShapes.map((shape) => shape.id).join("|");
  const firstShapeId = guitarShapes[0]?.id ?? null;
  const firstNoteId = guitarShapes[0]?.notes[0]?.id ?? null;
  const bumpPreferenceRevision = () => setPreferenceRevision((revision) => revision + 1);
  const selectShape = (shape: GuitarShape) => {
    writeProjectChordDictionaryPreferredShape(preferenceContext, shape.id);
    bumpPreferenceRevision();
    setActiveShape(shape.id);
    setPreviewNoteId(null);
    setSelectedNoteId(shape.notes[0]?.id ?? null);
  };

  useEffect(() => {
    setActiveShape(firstShapeId);
    setPreviewNoteId(null);
    setSelectedNoteId(firstNoteId);
  }, [currentChord?.displayLabel, firstNoteId, firstShapeId, resultKey]);

  if (!currentChord || !project) {
    return (
      <div className="live-follow-page live-follow-page--waiting" data-follow-status="no-project">
        <LiveFollowTopbar
          context={context}
          instrumentId={instrumentId}
          statusLabel="No Project"
          onInstrumentChange={onInstrumentChange}
        />
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
        instrumentId={instrumentId}
        statusLabel="Unsupported"
        title={`Unsupported chord: ${currentChord.displayLabel}`}
        onInstrumentChange={onInstrumentChange}
      />
    );
  }

  if (guitarShapes.length === 0) {
    return (
      <LiveFollowChordIssue
        context={context}
        copy="Chord spelling is supported, but the standard guitar model returned no voicings for this chord."
        instrumentId={instrumentId}
        statusLabel="No Voicing"
        title={`No guitar voicing for ${chordSpelling.label}`}
        onInstrumentChange={onInstrumentChange}
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
      <LiveFollowTopbar
        allowInstrumentSelection
        context={context}
        instrumentId={instrumentId}
        statusLabel="Live"
        onInstrumentChange={onInstrumentChange}
      />

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
              <div className="chord-shape-controls">
                <div className="chord-shape-control-row">
                  <div
                    aria-describedby="live-shape-preference-copy"
                    aria-label="Project guitar shape preference choices"
                    className="chord-shape-tabs"
                    role="group"
                  >
                    {guitarShapes.map((shape) => (
                      <button
                        key={shape.id}
                        aria-pressed={selectedShape?.id === shape.id}
                        className={classNames(
                          "chord-shape-tab",
                          selectedShape?.id === shape.id && "chord-shape-tab--active",
                        )}
                        onClick={() => selectShape(shape)}
                        type="button"
                      >
                        {shape.label}
                      </button>
                    ))}
                  </div>
                  {hasProjectShapePreference ? (
                    <button
                      aria-label="Clear this project override and fall back to global or default"
                      className="chord-reset-button"
                      onClick={() => {
                        resetProjectChordDictionaryPreferredShape(preferenceContext);
                        bumpPreferenceRevision();
                      }}
                      type="button"
                    >
                      Clear project override
                    </button>
                  ) : null}
                </div>
                <p
                  className="chord-shape-preference-copy"
                  id="live-shape-preference-copy"
                >
                  Saves locally for this project chord and instrument; clear uses global/default.
                </p>
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
                    onClick={() => selectShape(shape)}
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

function LiveFollowAccordionActiveState({
  context,
  instrumentId,
  onInstrumentChange,
}: {
  context: ChordDictionaryFollowContext;
  instrumentId: ChordDictionaryInstrumentId;
  onInstrumentChange: (instrumentId: ChordDictionaryInstrumentId) => void;
}) {
  const currentChord = context.currentChord;
  const project = context.project;
  const [activeVoicing, setActiveVoicing] = useState<string | null>(null);
  const [activeCandidate, setActiveCandidate] = useState<string | null>(null);
  const [previewPointId, setPreviewPointId] = useState<string | null>(null);
  const [, setPreferenceRevision] = useState(0);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const chordSpelling = useMemo(
    () =>
      currentChord
        ? spellChord(currentChord.displayLabel, {
            activeKey: project?.displayedKey ?? undefined,
          })
        : null,
    [currentChord, project?.displayedKey],
  );
  const accordionVoicings = useMemo(
    () =>
      chordSpelling
        ? generateAccordionVoicings(
            chordSpelling,
            {
              currentChordRoot: currentChord?.displayLabel ?? null,
              regionKey: project?.displayedKey ?? null,
            },
            { activeKey: project?.displayedKey ?? undefined },
          )
        : [],
    [chordSpelling, currentChord?.displayLabel, project?.displayedKey],
  );
  const generatedVoicingViews = useMemo(
    () => toAccordionVoicingViews(accordionVoicings),
    [accordionVoicings],
  );
  const generatedVoicingIds = useMemo(
    () => generatedVoicingViews.map((voicing) => voicing.id),
    [generatedVoicingViews],
  );
  const preferenceContext = useMemo(
    () =>
      chordSpelling
        ? buildShapePreferenceContext({
            capoFret: null,
            chordLabel: chordSpelling.label,
            displayedKey: project?.displayedKey ?? null,
            instrumentId: ACCORDION_INSTRUMENT_ID,
            projectId: project?.projectId ?? null,
            sourceKey: project?.sourceKey ?? null,
            transposeSemitones: project?.totalDisplayTransposeSemitones ?? null,
            useCapoShapes: null,
          })
        : null,
    [
      chordSpelling,
      project?.displayedKey,
      project?.projectId,
      project?.sourceKey,
      project?.totalDisplayTransposeSemitones,
    ],
  );
  const preferredVoicingId = resolveChordDictionaryPreferredShapeId(
    preferenceContext,
    generatedVoicingIds,
  );
  const hasProjectPreference = hasProjectChordDictionaryPreferredShape(
    preferenceContext,
    generatedVoicingIds,
  );
  const voicingViews = useMemo(
    () => promoteShapeToFirst(generatedVoicingViews, preferredVoicingId),
    [generatedVoicingViews, preferredVoicingId],
  );
  const resultKey = voicingViews.map((voicing) => voicing.id).join("|");
  const firstVoicingId = voicingViews[0]?.id ?? null;
  const firstCandidateId =
    voicingViews[0]?.selectedCandidateId ?? voicingViews[0]?.leftHandCandidates[0]?.id ?? null;
  const firstPointId =
    voicingViews[0]?.rightHandNotes[0]?.id ??
    voicingViews[0]?.buttons.find((button) =>
      firstCandidateId ? button.candidateIds.includes(firstCandidateId) : false,
    )?.id ??
    null;
  const bumpPreferenceRevision = () => setPreferenceRevision((revision) => revision + 1);
  const selectVoicing = (voicing: AccordionVoicingView) => {
    writeProjectChordDictionaryPreferredShape(preferenceContext, voicing.id);
    bumpPreferenceRevision();
    setActiveVoicing(voicing.id);
    setActiveCandidate(voicing.selectedCandidateId ?? voicing.leftHandCandidates[0]?.id ?? null);
    setPreviewPointId(null);
    setSelectedPointId(voicing.rightHandNotes[0]?.id ?? null);
  };

  useEffect(() => {
    setActiveVoicing(firstVoicingId);
    setActiveCandidate(firstCandidateId);
    setPreviewPointId(null);
    setSelectedPointId(firstPointId);
  }, [currentChord?.displayLabel, firstCandidateId, firstPointId, firstVoicingId, resultKey]);

  if (!currentChord || !project) {
    return (
      <div className="live-follow-page live-follow-page--waiting" data-follow-status="no-project">
        <LiveFollowTopbar
          context={context}
          instrumentId={instrumentId}
          statusLabel="No Project"
          onInstrumentChange={onInstrumentChange}
        />
        <LiveFollowStatusCard context={context} requestedProjectId={null} />
      </div>
    );
  }

  if (!chordSpelling) {
    return (
      <LiveFollowChordIssue
        context={context}
        copy="The project timeline chord cannot be parsed by the chord dictionary, so no accordion voicing or note inspector is shown."
        instrumentId={instrumentId}
        statusLabel="Unsupported"
        title={`Unsupported chord: ${currentChord.displayLabel}`}
        onInstrumentChange={onInstrumentChange}
      />
    );
  }

  if (voicingViews.length === 0) {
    return (
      <LiveFollowChordIssue
        context={context}
        copy="Chord spelling is supported, but the accordion model returned no voicings for this chord."
        instrumentId={instrumentId}
        statusLabel="No Voicing"
        title={`Accordion unavailable for ${chordSpelling.label}`}
        onInstrumentChange={onInstrumentChange}
      />
    );
  }

  const selectedVoicing =
    voicingViews.find((voicing) => voicing.id === activeVoicing) ?? voicingViews[0] ?? null;
  const selectedCandidate =
    selectedVoicing?.leftHandCandidates.find((candidate) => candidate.id === activeCandidate) ??
    selectedVoicing?.leftHandCandidates.find(
      (candidate) => candidate.id === selectedVoicing.selectedCandidateId,
    ) ??
    selectedVoicing?.leftHandCandidates[0] ??
    null;
  const selectedPoint = selectedVoicing
    ? findAccordionInspectorPoint(selectedVoicing, selectedCandidate, selectedPointId)
    : null;
  const previewPoint = previewPointId && selectedVoicing
    ? findAccordionInspectorPoint(selectedVoicing, selectedCandidate, previewPointId)
    : null;
  const displayedPoint = previewPoint ?? selectedPoint;
  const activePointId = previewPoint?.id ?? selectedPoint?.id ?? null;
  const playbackSourceLabel = formatPlaybackProjectLabel(project.projectName);

  if (!selectedVoicing) {
    return null;
  }

  return (
    <div className="live-follow-page live-follow-page--active" data-follow-status="active">
      <LiveFollowTopbar
        allowInstrumentSelection
        context={context}
        instrumentId={instrumentId}
        statusLabel="Live"
        onInstrumentChange={onInstrumentChange}
      />

      <div className="chord-context-strip" aria-label="Live follow accordion display context">
        <ContextChip icon="instrument" label={ACCORDION_STANDARD_PROFILE.label} />
        <ContextChip icon="key" label={`Source ${formatOptionalKey(project.sourceKey)}`} />
        <ContextChip icon="key" label={`Display ${formatOptionalKey(project.displayedKey)}`} />
        {selectedVoicing.regionRoot ? (
          <ContextChip icon="key" label={`Region ${selectedVoicing.regionRoot}`} />
        ) : null}
        <ContextChip icon="sound" label={chordSpelling.label} />
      </div>

      <div className="live-follow-grid live-follow-grid--accordion">
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
                <dt>Playback source</dt>
                <dd>{playbackSourceLabel}</dd>
              </div>
            </dl>
          </section>

          <section className="chord-section" aria-label="Current accordion voicing">
            <div className="chord-section-heading chord-section-heading--inline">
              <div>
                <p className="metric-label">{chordSpelling.notes.join(" ")}</p>
                <h3>{chordSpelling.label} accordion positions</h3>
              </div>
              <div className="chord-shape-controls">
                <div className="chord-shape-control-row">
                  <div
                    aria-describedby="live-accordion-preference-copy"
                    aria-label="Project accordion right-hand preference choices"
                    className="chord-shape-tabs"
                    role="group"
                  >
                    {voicingViews.map((voicing) => (
                      <button
                        key={voicing.id}
                        aria-pressed={selectedVoicing.id === voicing.id}
                        className={classNames(
                          "chord-shape-tab",
                          selectedVoicing.id === voicing.id && "chord-shape-tab--active",
                        )}
                        onClick={() => selectVoicing(voicing)}
                        type="button"
                      >
                        {voicing.label}
                      </button>
                    ))}
                  </div>
                  {hasProjectPreference ? (
                    <button
                      aria-label="Clear this project override and fall back to global or default"
                      className="chord-reset-button"
                      onClick={() => {
                        resetProjectChordDictionaryPreferredShape(preferenceContext);
                        bumpPreferenceRevision();
                      }}
                      type="button"
                    >
                      Clear project override
                    </button>
                  ) : null}
                </div>
                <p className="chord-shape-preference-copy" id="live-accordion-preference-copy">
                  Saves right-hand inversion for this project chord.
                </p>
              </div>
            </div>
            <ChordSpellingSummary spelling={chordSpelling} />
            <AccordionVoicingPanel
              activeChord={currentChord.displayLabel}
              activePointId={activePointId}
              selectedCandidate={selectedCandidate}
              voicing={selectedVoicing}
              onPreviewPoint={setPreviewPointId}
              onSelectPoint={(pointId) => {
                setPreviewPointId(null);
                setSelectedPointId(pointId);
              }}
            />
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
          {displayedPoint ? <AccordionNoteInspector point={displayedPoint} /> : null}
          <AccordionCandidateList
            candidates={selectedVoicing.leftHandCandidates}
            selectedCandidateId={selectedCandidate?.id ?? null}
            onSelectCandidate={(candidateId) => {
              setActiveCandidate(candidateId);
              setPreviewPointId(null);
              const nextCandidate =
                selectedVoicing.leftHandCandidates.find((candidate) => candidate.id === candidateId) ??
                null;
              const nextPointId =
                getAccordionFirstCandidateButtonId(selectedVoicing, nextCandidate) ??
                selectedVoicing.rightHandNotes[0]?.id ??
                null;
              setSelectedPointId(nextPointId);
            }}
          />
        </aside>
      </div>
    </div>
  );
}

function LiveFollowTopbar({
  allowInstrumentSelection = false,
  context,
  instrumentId,
  onInstrumentChange,
  statusLabel,
}: {
  allowInstrumentSelection?: boolean;
  context: ChordDictionaryFollowContext;
  instrumentId: ChordDictionaryInstrumentId;
  onInstrumentChange: (instrumentId: ChordDictionaryInstrumentId) => void;
  statusLabel: string;
}) {
  return (
    <div className="live-follow-topbar">
      <div className="live-follow-controls" role="group" aria-label="Live chord display status">
        {allowInstrumentSelection ? (
          <InstrumentSelector
            ariaLabel="Live instrument"
            instrumentId={instrumentId}
            onInstrumentChange={onInstrumentChange}
          />
        ) : (
          <span className="chord-pill chord-pill--active">
            <Music2 aria-hidden="true" />
            <span>{getChordDictionaryInstrumentLabel(instrumentId)}</span>
          </span>
        )}
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
  instrumentId,
  onInstrumentChange,
  statusLabel,
  title,
}: {
  context: ChordDictionaryFollowContext;
  copy: string;
  instrumentId: ChordDictionaryInstrumentId;
  onInstrumentChange: (instrumentId: ChordDictionaryInstrumentId) => void;
  statusLabel: string;
  title: string;
}) {
  return (
    <div className="live-follow-page live-follow-page--waiting" data-follow-status="unsupported">
      <LiveFollowTopbar
        allowInstrumentSelection
        context={context}
        instrumentId={instrumentId}
        statusLabel={statusLabel}
        onInstrumentChange={onInstrumentChange}
      />
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
