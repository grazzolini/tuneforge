import {
  formatChordDisplay,
  formatKeyDisplay,
  formatRawMusicalLabel,
  type ChordQuality,
  type EnharmonicDisplayMode,
  type FormattedMusicalLabel,
  type MusicalKey,
  type PitchFormatOptions,
} from "../lib/music";

export type MusicalLabelVariant =
  | "key-card"
  | "source-selector-current"
  | "source-selector-option"
  | "selector-current"
  | "selector-preview"
  | "selector-option"
  | "chord-card"
  | "chord-chip";

function RenderMusicalLabel({
  label,
  variant,
}: {
  label: FormattedMusicalLabel;
  variant: MusicalLabelVariant;
}) {
  return (
    <span
      aria-label={label.ariaLabel}
      className={`musical-label musical-label--${variant}${label.secondary ? " musical-label--dual" : ""}`}
      title={label.ariaLabel}
    >
      <span className="musical-label__primary">
        <span className="musical-label__root">{label.primary.root}</span>
        {label.primary.suffix ? (
          <span className="musical-label__suffix">{label.primary.suffix}</span>
        ) : null}
      </span>
      {label.secondary ? (
        <span className="musical-label__secondary">
          <span className="musical-label__root">{label.secondary.root}</span>
          {label.secondary.suffix ? (
            <span className="musical-label__suffix">{label.secondary.suffix}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function MusicalKeyLabel({
  activeKey,
  keyValue,
  mode,
  variant,
}: {
  activeKey?: MusicalKey | null;
  keyValue: MusicalKey;
  mode: EnharmonicDisplayMode;
  variant: MusicalLabelVariant;
}) {
  return (
    <RenderMusicalLabel
      label={formatKeyDisplay(keyValue, { activeKey: activeKey ?? keyValue, mode })}
      variant={variant}
    />
  );
}

export function MusicalChordLabel({
  activeKey,
  fallbackLabel,
  mode,
  pitchClass,
  quality,
  variant,
}: {
  activeKey?: MusicalKey | null;
  fallbackLabel: string;
  mode: EnharmonicDisplayMode;
  pitchClass?: number | null;
  quality?: string | null;
  variant: MusicalLabelVariant;
}) {
  const isSupportedChord = typeof pitchClass === "number" && (quality === "major" || quality === "minor");
  const options: PitchFormatOptions = { activeKey: activeKey ?? null, mode };
  const label = isSupportedChord
    ? formatChordDisplay(pitchClass, quality as ChordQuality, options)
    : formatRawMusicalLabel(fallbackLabel);

  return <RenderMusicalLabel label={label} variant={variant} />;
}
