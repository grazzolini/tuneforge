import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as core from "@tuneforge/music-core";
import { MusicalChordLabel, MusicalKeyLabel } from "./MusicalLabel";
import type { MusicalKey } from "../lib/music";

afterEach(() => vi.restoreAllMocks());

it("retains chord text and accessibility output across clock-only and same-value key renders", () => {
  const spy = vi.spyOn(core, "callMusicCore");
  const props = {
    activeKey: { pitchClass: 1, mode: "major" } as MusicalKey,
    bassPitchClass: 8, fallbackLabel: "C#/G#", mode: "dual" as const,
    pitchClass: 1, quality: "major", variant: "chord-chip" as const,
  };
  const view = render(<MusicalChordLabel {...props} />);
  const before = view.container.innerHTML;
  expect(spy).toHaveBeenCalledTimes(2);
  spy.mockClear();
  for (let clock = 0; clock < 5; clock++) {
    view.rerender(<MusicalChordLabel {...props} activeKey={{ ...props.activeKey }} />);
  }
  expect(spy).not.toHaveBeenCalled();
  expect(view.container.innerHTML).toBe(before);
  view.rerender(<MusicalChordLabel {...props} variant="chord-card" />);
  expect(spy).not.toHaveBeenCalled();
  expect(view.container.querySelector(".musical-label--chord-card")).toBeInTheDocument();

  for (const change of [
    { pitchClass: 3 }, { bassPitchClass: 10 }, { quality: "minor" },
    { activeKey: { pitchClass: 3, mode: "major" } as MusicalKey },
    { activeKey: { pitchClass: 1, mode: "minor" } as MusicalKey }, { mode: "flats" as const },
  ]) {
    view.rerender(<MusicalChordLabel {...props} {...change} />);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ operation: "formatChordDisplay" }));
    spy.mockClear();
    view.rerender(<MusicalChordLabel {...props} />);
    spy.mockClear();
  }
  view.rerender(<MusicalChordLabel {...props} quality="unknown" fallbackLabel="raw first" />);
  expect(view.container).toHaveTextContent("raw first");
  view.rerender(<MusicalChordLabel {...props} quality="unknown" fallbackLabel="raw changed" />);
  expect(view.container).toHaveTextContent("raw changed");
});

it("retains key formatting by pitch, mode, spelling preference and active key context", () => {
  const spy = vi.spyOn(core, "callMusicCore");
  const props = {
    keyValue: { pitchClass: 1, mode: "major" } as MusicalKey,
    mode: "dual" as const, variant: "key-card" as const,
  };
  const view = render(<MusicalKeyLabel {...props} />);
  const before = view.container.innerHTML;
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockClear();
  view.rerender(<MusicalKeyLabel {...props} keyValue={{ ...props.keyValue }} activeKey={{ ...props.keyValue }} />);
  expect(spy).not.toHaveBeenCalled();
  expect(view.container.innerHTML).toBe(before);
  for (const change of [
    { keyValue: { pitchClass: 3, mode: "major" } as MusicalKey },
    { keyValue: { pitchClass: 1, mode: "minor" } as MusicalKey },
    { activeKey: { pitchClass: 3, mode: "major" } as MusicalKey },
    { activeKey: { pitchClass: 1, mode: "minor" } as MusicalKey }, { mode: "sharps" as const },
  ]) {
    view.rerender(<MusicalKeyLabel {...props} {...change} />);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ operation: "formatKeyDisplay" }));
    spy.mockClear();
    view.rerender(<MusicalKeyLabel {...props} />);
    spy.mockClear();
  }
});
