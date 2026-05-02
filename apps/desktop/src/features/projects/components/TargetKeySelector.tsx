import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { MusicalKeyLabel } from "../../../components/MusicalLabel";
import type { EnharmonicDisplayMode, MusicalKey } from "../../../lib/music";
import {
  MAX_TARGET_TRANSPOSE,
  MIN_TARGET_TRANSPOSE,
  clampTargetTranspose,
  type TargetShiftOption,
} from "../projectViewUtils";

type TargetKeySelectorProps = {
  currentKey: MusicalKey;
  currentMeta: string;
  enharmonicDisplayMode: EnharmonicDisplayMode;
  headingLabel: string;
  higherButtonLabel: string;
  higherPreview: MusicalKey | null;
  higherTargetShiftOptions: TargetShiftOption[];
  isOpen: boolean;
  listboxLabel: string;
  lowerButtonLabel: string;
  lowerPreview: MusicalKey | null;
  lowerTargetShiftOptions: TargetShiftOption[];
  optionRefs: MutableRefObject<Record<number, HTMLButtonElement | null>>;
  selectorLabel: string;
  selectorRef: RefObject<HTMLDivElement | null>;
  setIsOpen: Dispatch<SetStateAction<boolean>>;
  setSemitones: Dispatch<SetStateAction<number>>;
  showCompactControls?: boolean;
  sourceKey: MusicalKey;
  supportingCopy?: string | null;
  value: number;
};

export function TargetKeySelector({
  currentKey,
  currentMeta,
  enharmonicDisplayMode,
  headingLabel,
  higherButtonLabel,
  higherPreview,
  higherTargetShiftOptions,
  isOpen,
  listboxLabel,
  lowerButtonLabel,
  lowerPreview,
  lowerTargetShiftOptions,
  optionRefs,
  selectorLabel,
  selectorRef,
  setIsOpen,
  setSemitones,
  showCompactControls = false,
  sourceKey,
  supportingCopy,
  value,
}: TargetKeySelectorProps) {
  const compactClass = showCompactControls ? " key-stepper--small" : "";

  return (
    <>
      <div className="key-stepper__heading">
        <span className="metric-label">{headingLabel}</span>
        {supportingCopy ? <span className="artifact-meta">{supportingCopy}</span> : null}
      </div>
      <div className={`key-stepper${compactClass}`}>
        <button
          className="button"
          aria-label={lowerButtonLabel}
          disabled={value <= MIN_TARGET_TRANSPOSE}
          onClick={() => {
            setIsOpen(false);
            setSemitones((current) => clampTargetTranspose(current - 1));
          }}
          type="button"
        >
          -
        </button>
        <div className="key-stepper__value">
          <div className="target-selector" ref={selectorRef}>
            <button
              className={`target-selector__trigger${
                enharmonicDisplayMode === "dual" ? " target-selector__trigger--dual" : ""
              }`}
              aria-label={selectorLabel}
              aria-expanded={isOpen}
              aria-haspopup="listbox"
              onClick={() => setIsOpen((current) => !current)}
              type="button"
            >
              <span
                className={`target-selector__preview target-selector__preview--lower${
                  !lowerPreview ? " target-selector__preview--disabled" : ""
                }`}
              >
                {lowerPreview ? (
                  <MusicalKeyLabel
                    keyValue={lowerPreview}
                    mode={enharmonicDisplayMode}
                    variant="selector-preview"
                  />
                ) : null}
              </span>
              <span
                className={`target-selector__current${
                  enharmonicDisplayMode === "dual" ? " target-selector__current--dual" : ""
                }`}
              >
                <span
                  className={`target-selector__current-key${
                    enharmonicDisplayMode === "dual" ? " target-selector__current-key--dual" : ""
                  }`}
                >
                  <MusicalKeyLabel
                    keyValue={currentKey}
                    mode={enharmonicDisplayMode}
                    variant="selector-current"
                  />
                </span>
                <span className="target-selector__current-meta">
                  <span className="target-selector__current-meta-icon" aria-hidden="true">
                    •
                  </span>
                  <span className="target-selector__current-meta-text">{currentMeta}</span>
                </span>
              </span>
              <span
                className={`target-selector__preview target-selector__preview--higher${
                  !higherPreview ? " target-selector__preview--disabled" : ""
                }`}
              >
                {higherPreview ? (
                  <MusicalKeyLabel
                    keyValue={higherPreview}
                    mode={enharmonicDisplayMode}
                    variant="selector-preview"
                  />
                ) : null}
              </span>
              <span className="target-selector__chevron" aria-hidden="true">
                ⌄
              </span>
            </button>

            {isOpen ? (
              <div className="target-selector__menu" role="listbox" aria-label={listboxLabel}>
                <div className="target-selector__group-label target-selector__group-label--higher">
                  <span className="target-selector__group-icon" aria-hidden="true">
                    ↑
                  </span>
                  <span className="target-selector__group-text">Higher pitch</span>
                </div>
                {higherTargetShiftOptions.map((option) => (
                  <button
                    key={option.semitones}
                    ref={(node) => {
                      optionRefs.current[option.semitones] = node;
                    }}
                    className={`target-selector__option${
                      option.semitones === value ? " target-selector__option--selected" : ""
                    }`}
                    role="option"
                    aria-selected={option.semitones === value}
                    onClick={() => {
                      setSemitones(option.semitones);
                      setIsOpen(false);
                    }}
                    type="button"
                  >
                    <span className="target-selector__option-direction" aria-hidden="true">
                      ↑
                    </span>
                    <span className="target-selector__option-content">
                      <span className="target-selector__option-label">
                        <MusicalKeyLabel
                          keyValue={option.key}
                          mode={enharmonicDisplayMode}
                          variant="selector-option"
                        />
                      </span>
                    </span>
                  </button>
                ))}
                <div className="target-selector__group-label target-selector__group-label--original">
                  <span className="target-selector__group-icon" aria-hidden="true">
                    •
                  </span>
                  <span className="target-selector__group-text">Original</span>
                </div>
                <button
                  ref={(node) => {
                    optionRefs.current[0] = node;
                  }}
                  className={`target-selector__option${
                    value === 0 ? " target-selector__option--selected" : ""
                  }`}
                  role="option"
                  aria-selected={value === 0}
                  onClick={() => {
                    setSemitones(0);
                    setIsOpen(false);
                  }}
                  type="button"
                >
                  <span className="target-selector__option-direction" aria-hidden="true">
                    •
                  </span>
                  <span className="target-selector__option-content">
                    <span className="target-selector__option-label">
                      <MusicalKeyLabel
                        keyValue={sourceKey}
                        mode={enharmonicDisplayMode}
                        variant="selector-option"
                      />
                    </span>
                  </span>
                </button>
                <div className="target-selector__group-label target-selector__group-label--lower">
                  <span className="target-selector__group-icon" aria-hidden="true">
                    ↓
                  </span>
                  <span className="target-selector__group-text">Lower pitch</span>
                </div>
                {lowerTargetShiftOptions.map((option) => (
                  <button
                    key={option.semitones}
                    ref={(node) => {
                      optionRefs.current[option.semitones] = node;
                    }}
                    className={`target-selector__option${
                      option.semitones === value ? " target-selector__option--selected" : ""
                    }`}
                    role="option"
                    aria-selected={option.semitones === value}
                    onClick={() => {
                      setSemitones(option.semitones);
                      setIsOpen(false);
                    }}
                    type="button"
                  >
                    <span className="target-selector__option-direction" aria-hidden="true">
                      ↓
                    </span>
                    <span className="target-selector__option-content">
                      <span className="target-selector__option-label">
                        <MusicalKeyLabel
                          keyValue={option.key}
                          mode={enharmonicDisplayMode}
                          variant="selector-option"
                        />
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <button
          className="button"
          aria-label={higherButtonLabel}
          disabled={value >= MAX_TARGET_TRANSPOSE}
          onClick={() => {
            setIsOpen(false);
            setSemitones((current) => clampTargetTranspose(current + 1));
          }}
          type="button"
        >
          +
        </button>
      </div>
    </>
  );
}
