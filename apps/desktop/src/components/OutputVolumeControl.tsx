import { Volume2, VolumeX } from "lucide-react";

export function OutputVolumeControl({
  gain,
  label,
  muted = false,
  onGainChange,
  onInteractionStart,
  onMutedChange,
  resetGain = 1,
  showLabel = true,
}: {
  gain: number;
  label: string;
  muted?: boolean;
  onGainChange: (gain: number) => void;
  onInteractionStart?: () => void;
  onMutedChange?: (muted: boolean) => void;
  resetGain?: number;
  showLabel?: boolean;
}) {
  const clampedGain = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 0;
  const percentage = Math.round(clampedGain * 100);
  const resetPercentage = Math.round(resetGain * 100);
  const reset = () => onGainChange(resetGain);
  return (
    <div
      className="output-volume"
      data-gain-only={onMutedChange ? undefined : true}
      data-muted={muted || undefined}
    >
      {showLabel ? <span className="output-volume__label">{label}</span> : null}
      {onMutedChange ? (
        <button
          aria-label={`${muted ? "Unmute" : "Mute"} ${label.toLowerCase()}`}
          aria-pressed={muted}
          className="output-volume__mute"
          onClick={() => onMutedChange(!muted)}
          type="button"
        >
          {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
        </button>
      ) : null}
      <div className="output-volume__range">
        <span aria-hidden="true" className="output-volume__track">
          <span className="output-volume__fill" style={{ width: `${percentage}%` }} />
        </span>
        <input
          aria-label={label}
          aria-valuetext={`${percentage}%`}
          max={1}
          min={0}
          onChange={(event) => {
            onInteractionStart?.();
            onGainChange(Number(event.target.value));
          }}
          onDoubleClick={reset}
          onPointerDown={onInteractionStart}
          step={0.01}
          type="range"
          value={clampedGain}
        />
      </div>
      <button
        aria-label={`Reset ${label.toLowerCase()} to ${resetPercentage}%`}
        className="output-volume__percentage"
        onClick={() => {
          onInteractionStart?.();
          reset();
        }}
        type="button"
      >
        {percentage}%
      </button>
    </div>
  );
}
