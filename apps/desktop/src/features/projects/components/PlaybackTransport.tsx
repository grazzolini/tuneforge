import { RotateCcw } from "lucide-react";
import { PlayPauseGlyph, SeekGlyph, StopGlyph } from "./TransportGlyphs";
import { formatPlaybackClock } from "../projectViewUtils";

export function PlaybackTransport({
  compact = false,
  isPlaying,
  maxSeconds,
  playbackTimeSeconds,
  seekAnimationRevision,
  tempoDisplayBpm,
  tempoTargetBpm,
  onSeek,
  onSeekTo,
  onResetTempo,
  onStop,
  onTogglePlayback,
}: {
  compact?: boolean;
  isPlaying: boolean;
  maxSeconds: number;
  playbackTimeSeconds: number;
  seekAnimationRevision: Record<"backward" | "forward", number>;
  tempoDisplayBpm: number | null;
  tempoTargetBpm: number | null;
  onSeek: (secondsDelta: number) => void;
  onSeekTo: (timeSeconds: number) => void;
  onResetTempo: () => void;
  onStop: () => void;
  onTogglePlayback: () => Promise<void>;
}) {
  const tempoLabel =
    tempoDisplayBpm === null
      ? "--"
      : Number.isInteger(tempoDisplayBpm)
        ? tempoDisplayBpm.toFixed(0)
        : tempoDisplayBpm.toFixed(1);

  return (
    <div className={`transport${compact ? " transport--compact" : ""}`}>
      <div className="transport__controls">
        <button
          aria-label="Seek back 10 seconds"
          className="button transport__button transport__button--seek"
          onClick={() => onSeek(-10)}
          type="button"
        >
          <SeekGlyph
            key={`backward-${seekAnimationRevision.backward}`}
            animate={seekAnimationRevision.backward > 0}
            direction="backward"
          />
        </button>
        <button
          aria-label={isPlaying ? "Pause playback" : "Play playback"}
          aria-pressed={isPlaying}
          className="button transport__button transport__button--play"
          onClick={() => void onTogglePlayback()}
          type="button"
        >
          <PlayPauseGlyph isPlaying={isPlaying} />
        </button>
        <button
          aria-label="Stop playback"
          className="button transport__button transport__button--stop"
          onClick={onStop}
          type="button"
        >
          <StopGlyph />
        </button>
        <button
          aria-label="Seek forward 10 seconds"
          className="button transport__button transport__button--seek"
          onClick={() => onSeek(10)}
          type="button"
        >
          <SeekGlyph
            key={`forward-${seekAnimationRevision.forward}`}
            animate={seekAnimationRevision.forward > 0}
            direction="forward"
          />
        </button>
      </div>

      <button
        aria-label={tempoTargetBpm === null ? "Tempo at original" : "Reset tempo"}
        className={`transport__tempo${tempoTargetBpm === null ? "" : " transport__tempo--active"}`}
        disabled={tempoDisplayBpm === null || tempoTargetBpm === null}
        onClick={onResetTempo}
        type="button"
      >
        <span>Tempo</span>
        <strong>{tempoLabel} BPM</strong>
        {tempoTargetBpm !== null ? <RotateCcw aria-hidden="true" size={14} /> : null}
      </button>

      <label className="transport__scrubber">
        <span className="metric-label">Playback position</span>
        <input
          aria-label="Playback position"
          max={maxSeconds}
          min={0}
          onChange={(event) => onSeekTo(Number(event.target.value))}
          step={0.001}
          type="range"
          value={Math.min(playbackTimeSeconds, maxSeconds)}
        />
        <div className="transport__times">
          <strong>{formatPlaybackClock(playbackTimeSeconds)}</strong>
          <span>{formatPlaybackClock(maxSeconds)}</span>
        </div>
      </label>
    </div>
  );
}
