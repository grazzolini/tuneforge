import { useId, useSyncExternalStore } from "react";
import { RefreshCw, RefreshCwOff, RotateCcw } from "lucide-react";
import {
  getPlaybackDiagnosticsVersion,
  readPlaybackLiveDiagnostics,
  subscribePlaybackDiagnostics,
} from "../../../lib/playbackDiagnostics";
import {
  getPowerInhibitionVersion,
  playbackPowerProtectionMessage,
  subscribePowerInhibition,
} from "../../../lib/powerInhibition";
import { MetallicGlyphDefs, PlayPauseGlyph, SeekGlyph, StopGlyph } from "./TransportGlyphs";
import { formatPlaybackClock } from "../projectViewUtils";
import type { PlaybackLoopRange } from "../projectPlaybackState";

export function PlaybackTransport({
  compact = false,
  mobile = false,
  isPlaying,
  loopRange,
  loopStatusMessage,
  maxSeconds,
  pendingLoopStartSeconds,
  playbackTimeSeconds,
  seekAnimationRevision,
  tempoDisplayBpm,
  tempoTargetBpm,
  onSeek,
  onSeekTo,
  onResetTempo,
  onStop,
  onToggleLoop,
  onTogglePlayback,
}: {
  compact?: boolean;
  mobile?: boolean;
  isPlaying: boolean;
  loopRange: PlaybackLoopRange | null;
  loopStatusMessage: "Loop in" | "Loop set" | "Loop cleared" | null;
  maxSeconds: number;
  pendingLoopStartSeconds: number | null;
  playbackTimeSeconds: number;
  seekAnimationRevision: Record<"backward" | "forward", number>;
  tempoDisplayBpm: number | null;
  tempoTargetBpm: number | null;
  onSeek: (secondsDelta: number) => void;
  onSeekTo: (timeSeconds: number) => void;
  onResetTempo: () => void;
  onStop: () => void;
  onToggleLoop: () => void;
  onTogglePlayback: () => Promise<void>;
}) {
  useSyncExternalStore(
    subscribePlaybackDiagnostics,
    getPlaybackDiagnosticsVersion,
    getPlaybackDiagnosticsVersion,
  );
  useSyncExternalStore(
    subscribePowerInhibition,
    getPowerInhibitionVersion,
    getPowerInhibitionVersion,
  );
  const playbackDiagnostics = readPlaybackLiveDiagnostics();
  const powerProtectionMessage = playbackPowerProtectionMessage();
  const tempoLabel =
    tempoDisplayBpm === null
      ? "--"
      : Number.isInteger(tempoDisplayBpm)
        ? tempoDisplayBpm.toFixed(0)
        : tempoDisplayBpm.toFixed(1);
  const loopButtonLabel =
    pendingLoopStartSeconds !== null
      ? "Set loop end"
      : loopRange
        ? "Clear loop"
        : "Set loop start";
  const loopButtonActive = Boolean(loopRange || pendingLoopStartSeconds !== null);
  const LoopIcon = loopRange ? RefreshCwOff : RefreshCw;
  const loopGradientId = useId();
  const loopIconStroke = `url(#${loopGradientId})`;

  return (
    <div
      className={`transport${compact ? " transport--compact" : ""}${
        mobile ? " transport--mobile" : ""
      }`}
    >
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
        <button
          aria-label={loopButtonLabel}
          aria-pressed={loopButtonActive}
          className={`button transport__button transport__button--loop${
            loopButtonActive ? " transport__button--loop-active" : ""
          }`}
          onClick={onToggleLoop}
          type="button"
        >
          <LoopIcon
            aria-hidden="true"
            className="transport__icon transport__icon--loop"
            stroke={loopIconStroke}
            strokeWidth={2.35}
          >
            <MetallicGlyphDefs gradientId={loopGradientId} />
          </LoopIcon>
        </button>
        {loopStatusMessage ? (
          <span className="transport__loop-status" role="status">
            {loopStatusMessage}
          </span>
        ) : null}
      </div>

      {!mobile ? (
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
      ) : null}

      <div className="transport__timeline">
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
        {playbackDiagnostics.statusMessage || powerProtectionMessage ? (
          <div className="transport__status-stack">
            {playbackDiagnostics.statusMessage ? (
              <p
                className={`transport__status transport__status--${playbackDiagnostics.currentState}`}
                role={playbackDiagnostics.currentState === "error" ? "alert" : "status"}
              >
                {playbackDiagnostics.statusMessage}
              </p>
            ) : null}
            {powerProtectionMessage ? (
              <p
                className="transport__status transport__status--error"
                role="status"
              >
                {powerProtectionMessage}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
