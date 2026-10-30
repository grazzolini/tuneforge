import { useMemo } from "react";
import {
  formatChordDisplay,
  formatKeyDisplay,
  formatRawMusicalLabel,
  isSupportedChordQuality,
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
  const { pitchClass, mode: keyMode } = keyValue;
  const contextPitchClass = activeKey?.pitchClass ?? pitchClass;
  const contextMode = activeKey?.mode ?? keyMode;
  const label = useMemo(() => formatKeyDisplay(
    { pitchClass, mode: keyMode },
    { activeKey: { pitchClass: contextPitchClass, mode: contextMode }, mode },
  ), [pitchClass, keyMode, contextPitchClass, contextMode, mode]);

  return <RenderMusicalLabel label={label} variant={variant} />;
}

export function MusicalChordLabel({
  activeKey,
  bassPitchClass,
  fallbackLabel,
  mode,
  pitchClass,
  quality,
  variant,
}: {
  activeKey?: MusicalKey | null;
  bassPitchClass?: number | null;
  fallbackLabel: string;
  mode: EnharmonicDisplayMode;
  pitchClass?: number | null;
  quality?: string | null;
  variant: MusicalLabelVariant;
}) {
  const contextPitchClass = activeKey?.pitchClass;
  const contextMode = activeKey?.mode;
  const label = useMemo(() => {
    const isSupportedChord = typeof pitchClass === "number" && isSupportedChordQuality(quality);
    const options: PitchFormatOptions = {
      activeKey: contextPitchClass !== undefined && contextMode !== undefined
        ? { pitchClass: contextPitchClass, mode: contextMode }
        : null,
      mode,
    };
    return isSupportedChord
      ? formatChordDisplay(pitchClass, quality, options, bassPitchClass)
      : formatRawMusicalLabel(fallbackLabel);
  }, [pitchClass, quality, bassPitchClass, fallbackLabel, contextPitchClass, contextMode, mode]);

  return <RenderMusicalLabel label={label} variant={variant} />;
}
