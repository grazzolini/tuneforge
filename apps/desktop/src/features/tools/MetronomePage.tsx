import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useMetronome } from "./metronome-context";
import {
  MAX_BEATS_PER_BAR,
  MAX_METRONOME_BPM,
  MIN_BEATS_PER_BAR,
  MIN_METRONOME_BPM,
} from "./metronomeUtils";

export function MetronomePage() {
  const [searchParams] = useSearchParams();
  const {
    accentFirstBeat,
    activeBeat,
    beatsPerBar,
    bpm,
    bpmDraft,
    commitBpmDraft,
    errorMessage,
    followPlayback,
    handleTapTempo,
    isRunning,
    launchMetronome,
    resetVolume,
    seedBpm,
    setAccentFirstBeat,
    setBeatsPerBarValue,
    setBpmDraftValue,
    setFollowPlaybackEnabled,
    setVolume,
    startMetronome,
    stopMetronome,
    syncStatus,
    tapBpm,
    volume,
  } = useMetronome();
  const queryBpm = searchParams.get("bpm");
  const queryProjectId = searchParams.get("projectId");
  const queryFollowPlayback = searchParams.get("followPlayback");
  const lastQueryKeyRef = useRef<string | null>(null);
  const seededFromAnalysis = queryBpm !== null && queryProjectId !== null;
  const volumePercent = Math.round(volume * 100);

  useEffect(() => {
    const queryKey = `${queryBpm ?? ""}|${queryProjectId ?? ""}|${queryFollowPlayback ?? ""}`;
    if (lastQueryKeyRef.current === queryKey) {
      return;
    }
    lastQueryKeyRef.current = queryKey;

    if (queryFollowPlayback === "1") {
      void launchMetronome({ bpm: queryBpm, followPlayback: true });
      return;
    }

    if (queryBpm !== null) {
      seedBpm(queryBpm);
    }
  }, [launchMetronome, queryBpm, queryFollowPlayback, queryProjectId, seedBpm]);

  return (
    <div className="metronome-shell">
      <div className="panel metronome-panel">
        <div className="metronome-header">
          <div>
            <h2>Metronome</h2>
            <p className="subpanel__copy">
              {seededFromAnalysis ? "Seeded from project analysis." : syncStatus}
            </p>
          </div>
          <div className="button-row">
            {isRunning ? (
              <button className="button button--ghost" onClick={stopMetronome} type="button">
                Stop
              </button>
            ) : (
              <button
                className="button button--primary"
                onClick={() => void startMetronome()}
                type="button"
              >
                Start
              </button>
            )}
          </div>
        </div>

        <div className="metronome-grid">
          <label className="metronome-field metronome-field--tempo">
            <span>Tempo BPM</span>
            <input
              aria-label="Tempo BPM"
              max={MAX_METRONOME_BPM}
              min={MIN_METRONOME_BPM}
              onBlur={commitBpmDraft}
              onChange={(event) => setBpmDraftValue(event.target.value)}
              step="0.1"
              type="number"
              value={bpmDraft}
            />
          </label>
          <label className="metronome-field">
            <span>Beats per bar</span>
            <input
              aria-label="Beats per bar"
              max={MAX_BEATS_PER_BAR}
              min={MIN_BEATS_PER_BAR}
              onChange={(event) => setBeatsPerBarValue(event.target.value)}
              step="1"
              type="number"
              value={beatsPerBar}
            />
          </label>
          <div className="metronome-field">
            <div className="metronome-field__label-row">
              <span>Metronome volume</span>
              <button
                aria-label={`Metronome volume ${volumePercent}%`}
                className="metronome-volume-value"
                onDoubleClick={resetVolume}
                type="button"
              >
                {volumePercent}%
              </button>
            </div>
            <input
              aria-label="Metronome volume"
              max="1"
              min="0"
              onChange={(event) => setVolume(Number(event.target.value))}
              step="0.01"
              type="range"
              value={volume}
            />
          </div>
        </div>

        <div className="metronome-switches">
          <label className="metronome-toggle">
            <input
              checked={accentFirstBeat}
              onChange={(event) => setAccentFirstBeat(event.target.checked)}
              type="checkbox"
            />
            <span>Accent first beat</span>
          </label>
          <label className="metronome-toggle">
            <input
              checked={followPlayback}
              onChange={(event) => void setFollowPlaybackEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>Follow project playback</span>
          </label>
        </div>

        <div className="metronome-readout" aria-live="polite">
          <div className="metronome-readout__tempo">
            <strong>{bpm.toFixed(1)}</strong>
            <span>BPM</span>
          </div>
          <div className="metronome-beats" aria-label="Beat position">
            {Array.from({ length: beatsPerBar }, (_, index) => index + 1).map((beatNumber) => (
              <span
                key={beatNumber}
                className={`metronome-beats__dot${
                  activeBeat === beatNumber ? " metronome-beats__dot--active" : ""
                }${beatNumber === 1 && accentFirstBeat ? " metronome-beats__dot--accent" : ""}`}
              >
                {beatNumber}
              </span>
            ))}
          </div>
          <p className="artifact-meta">{syncStatus}</p>
        </div>

        <button className="metronome-tap-pad" onClick={handleTapTempo} type="button">
          <span>Tap Tempo</span>
          <strong>{tapBpm === null ? "Tap here" : `${tapBpm.toFixed(1)} BPM`}</strong>
        </button>

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}
      </div>
    </div>
  );
}
