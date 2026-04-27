import { type CSSProperties } from "react";
import { getTunerDisplay } from "./tunerMeterState";
import { type TunerPitchReading } from "./tunerPitch";

export type TunerVisualMode = "simple" | "wide-arc";

type TunerMeterProps = {
  inputLevel: number;
  reading: TunerPitchReading | null;
  referenceHz: number;
};

export function SimpleTunerMeter({ inputLevel, reading, referenceHz }: TunerMeterProps) {
  const display = getTunerDisplay(reading, referenceHz);
  const style = {
    "--tuner-marker-position": `${display.markerPositionPercent}%`,
  } as CSSProperties;
  const centerDirectionLabel = display.hasPitch ? "In tune" : "Center";

  return (
    <div
      className="simple-tuner-meter"
      data-testid="simple-tuner-meter"
      data-tuning-state={display.toneState}
      style={style}
    >
      <div className="simple-tuner-meter__readout" aria-live="polite">
        <span className="simple-tuner-meter__note">{display.noteName}</span>
        <span className="simple-tuner-meter__status">{display.statusLabel}</span>
        {display.hasPitch ? (
          <span className="simple-tuner-meter__cents">{display.centsLabel}</span>
        ) : null}
        <span className="simple-tuner-meter__meta">{display.metaLabel}</span>
      </div>

      <div
        aria-label="Tuning offset"
        aria-valuemax={50}
        aria-valuemin={-50}
        aria-valuenow={display.hasPitch ? Math.round(display.clampedCents) : undefined}
        className="simple-tuner-meter__bar"
        role="meter"
      >
        <div className="simple-tuner-meter__scale" aria-hidden="true">
          <span>-50</span>
          <span>-25</span>
          <span>0</span>
          <span>+25</span>
          <span>+50</span>
        </div>
        <div className="simple-tuner-meter__track">
          <span className="simple-tuner-meter__center" />
          <span
            aria-hidden={!display.hasPitch}
            className="simple-tuner-meter__marker"
            data-testid="simple-tuner-marker"
          />
        </div>
        <div className="simple-tuner-meter__directions" aria-hidden="true">
          <span>Flat</span>
          <span>{centerDirectionLabel}</span>
          <span>Sharp</span>
        </div>
      </div>

      <InputLevelMeter inputLevel={inputLevel} />
    </div>
  );
}

export function WideArcTunerMeter({ inputLevel, reading, referenceHz }: TunerMeterProps) {
  const display = getTunerDisplay(reading, referenceHz);
  const style = {
    "--tuner-needle-rotation": `${display.clampedCents * 0.9}deg`,
  } as CSSProperties;

  return (
    <div
      className="wide-arc-tuner-meter"
      data-testid="wide-arc-tuner-meter"
      data-tuning-state={display.toneState}
      style={style}
    >
      <div
        aria-label="Tuning offset"
        aria-valuemax={50}
        aria-valuemin={-50}
        aria-valuenow={display.hasPitch ? Math.round(display.clampedCents) : undefined}
        className="tuner-gauge"
        role="meter"
      >
        <div className="tuner-gauge__scale" aria-hidden="true">
          <span>-50</span>
          <span>-25</span>
          <span>0</span>
          <span>+25</span>
          <span>+50</span>
        </div>
        <div className="tuner-gauge__arc" aria-hidden="true">
          <span className="tuner-gauge__tick tuner-gauge__tick--left" />
          <span className="tuner-gauge__tick tuner-gauge__tick--center" />
          <span className="tuner-gauge__tick tuner-gauge__tick--right" />
          <span className="tuner-gauge__needle" />
        </div>
      </div>

      <div className="tuner-readout" aria-live="polite">
        <span className="tuner-readout__note">{display.noteName}</span>
        <span className="tuner-readout__cents">{display.centsLabel}</span>
        <span className="tuner-readout__meta">{display.metaLabel}</span>
      </div>

      <InputLevelMeter inputLevel={inputLevel} />
    </div>
  );
}

export function InputLevelMeter({ inputLevel }: { inputLevel: number }) {
  const clampedLevel = clamp(inputLevel, 0, 1);
  const levelPercent = Math.round(Math.sqrt(clampedLevel) * 100);
  const style = {
    "--tuner-level": `${levelPercent}%`,
  } as CSSProperties;

  return (
    <div
      aria-label="Input signal level"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={levelPercent}
      className="tuner-level"
      role="meter"
      style={style}
    >
      <span>Signal</span>
      <div className="tuner-level__track">
        <span className="tuner-level__bar" />
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
