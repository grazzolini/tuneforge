import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PreferencesProvider,
  normalizePreferences,
  usePreferences,
} from "./preferences";

function PreferenceProbe() {
  const {
    defaultDurableAudioFormat,
    resetAudioStoragePreferences,
    setDefaultDurableAudioFormat,
  } = usePreferences();
  return (
    <>
      <output>{defaultDurableAudioFormat}</output>
      <button onClick={() => setDefaultDurableAudioFormat("flac")} type="button">Set FLAC</button>
      <button onClick={resetAudioStoragePreferences} type="button">Reset audio</button>
    </>
  );
}

describe("durable audio preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("normalizes missing and invalid values to WAV", () => {
    expect(normalizePreferences({}).defaultDurableAudioFormat).toBe("wav");
    expect(normalizePreferences({ defaultDurableAudioFormat: "ogg" }).defaultDurableAudioFormat)
      .toBe("wav");
    expect(normalizePreferences({ defaultDurableAudioFormat: "m4a" }).defaultDurableAudioFormat)
      .toBe("m4a");
  });

  it("sets, persists, and resets the dedicated preference", async () => {
    const user = userEvent.setup();
    render(<PreferencesProvider><PreferenceProbe /></PreferencesProvider>);

    await user.click(screen.getByRole("button", { name: "Set FLAC" }));
    expect(screen.getByText("flac")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
      .toMatchObject({ defaultDurableAudioFormat: "flac" });

    await user.click(screen.getByRole("button", { name: "Reset audio" }));
    expect(screen.getByText("wav")).toBeInTheDocument();
  });
});

describe("click output preferences", () => {
  it("defaults missing or corrupt values and clamps finite gains", () => {
    expect(normalizePreferences({})).toMatchObject({
      countInOutputGain: 1,
      countInOutputMuted: false,
      metronomeOutputGain: 0.8,
      metronomeOutputMuted: false,
    });
    for (const invalid of [null, false, "", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizePreferences({
        countInOutputGain: invalid,
        countInOutputMuted: invalid,
        metronomeOutputGain: invalid,
        metronomeOutputMuted: invalid,
      })).toMatchObject({
        countInOutputGain: 1,
        countInOutputMuted: false,
        metronomeOutputGain: 0.8,
        metronomeOutputMuted: false,
      });
    }
    expect(normalizePreferences({
      countInOutputGain: -1,
      countInOutputMuted: true,
      metronomeOutputGain: 2,
      metronomeOutputMuted: true,
    })).toMatchObject({
      countInOutputGain: 0,
      countInOutputMuted: true,
      metronomeOutputGain: 1,
      metronomeOutputMuted: true,
    });
  });
});
