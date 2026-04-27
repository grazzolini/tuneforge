import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  InputLevelMeter,
  SimpleTunerMeter,
  WideArcTunerMeter,
} from "./TunerMeters";
import { type TunerPitchReading } from "./tunerPitch";

describe("tuner visual meters", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("renders no pitch without an active centered marker and keeps input level visible", () => {
    render(<SimpleTunerMeter inputLevel={0.42} reading={null} referenceHz={440} />);

    expect(screen.getByText("--")).toBeInTheDocument();
    expect(screen.getAllByText("No pitch")).toHaveLength(1);
    expect(screen.getByText("Center")).toBeInTheDocument();
    expect(screen.queryByText("In tune")).not.toBeInTheDocument();
    expect(screen.getByTestId("simple-tuner-meter")).toHaveAttribute("data-tuning-state", "no-pitch");
    expect(screen.getByTestId("simple-tuner-marker")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("meter", { name: "Input signal level" })).toHaveAttribute("aria-valuenow", "65");
  });

  it("renders in tune readings with the restrained center state", () => {
    render(<SimpleTunerMeter inputLevel={0.5} reading={makeReading(2)} referenceHz={440} />);

    expect(screen.getAllByText("In tune")).toHaveLength(2);
    expect(screen.getByText("+2 cents")).toBeInTheDocument();
    expect(screen.getByTestId("simple-tuner-meter")).toHaveAttribute("data-tuning-state", "in-tune");
    expect(screen.getByTestId("simple-tuner-meter")).toHaveStyle("--tuner-marker-position: 52%");
  });

  it("uses a less twitchy in-tune tolerance", () => {
    render(<SimpleTunerMeter inputLevel={0.5} reading={makeReading(5)} referenceHz={440} />);

    expect(screen.getAllByText("In tune")).toHaveLength(2);
    expect(screen.getByText("+5 cents")).toBeInTheDocument();
  });

  it("renders flat readings to the left of center", () => {
    render(<SimpleTunerMeter inputLevel={0.5} reading={makeReading(-12)} referenceHz={440} />);

    expect(screen.getAllByText("Flat")).toHaveLength(2);
    expect(screen.getByText("-12 cents")).toBeInTheDocument();
    expect(screen.getByTestId("simple-tuner-meter")).toHaveAttribute("data-tuning-state", "flat");
    expect(screen.getByTestId("simple-tuner-meter")).toHaveStyle("--tuner-marker-position: 38%");
  });

  it("renders sharp readings to the right of center", () => {
    render(<SimpleTunerMeter inputLevel={0.5} reading={makeReading(18)} referenceHz={440} />);

    expect(screen.getAllByText("Sharp")).toHaveLength(2);
    expect(screen.getByText("+18 cents")).toBeInTheDocument();
    expect(screen.getByTestId("simple-tuner-meter")).toHaveAttribute("data-tuning-state", "sharp");
    expect(screen.getByTestId("simple-tuner-meter")).toHaveStyle("--tuner-marker-position: 68%");
  });

  it("clamps marker position while preserving actual cents text", () => {
    const { rerender } = render(
      <SimpleTunerMeter inputLevel={0.5} reading={makeReading(63)} referenceHz={440} />,
    );

    expect(screen.getByText("+63 cents")).toBeInTheDocument();
    expect(screen.getByTestId("simple-tuner-meter")).toHaveStyle("--tuner-marker-position: 100%");

    rerender(<SimpleTunerMeter inputLevel={0.5} reading={makeReading(-63)} referenceHz={440} />);

    expect(screen.getByText("-63 cents")).toBeInTheDocument();
    expect(screen.getByTestId("simple-tuner-meter")).toHaveStyle("--tuner-marker-position: 0%");
  });

  it("renders input level as a subtle meter", () => {
    render(<InputLevelMeter inputLevel={0.37} />);

    expect(screen.getByRole("meter", { name: "Input signal level" })).toHaveAttribute("aria-valuenow", "61");
  });

  it("keeps wide arc no-pitch state neutral", () => {
    render(<WideArcTunerMeter inputLevel={0.2} reading={null} referenceHz={440} />);

    expect(screen.getByTestId("wide-arc-tuner-meter")).toHaveAttribute("data-tuning-state", "no-pitch");
  });

  it.each(["light", "dark"] as const)("renders readable meter surfaces in %s theme", (theme) => {
    document.documentElement.dataset.theme = theme;

    render(
      <>
        <SimpleTunerMeter inputLevel={0.5} reading={makeReading(0)} referenceHz={440} />
        <WideArcTunerMeter inputLevel={0.5} reading={makeReading(0)} referenceHz={440} />
      </>,
    );

    expect(screen.getAllByRole("meter", { name: "Tuning offset" })).toHaveLength(2);
    expect(screen.getAllByText("A")).toHaveLength(2);
  });
});

function makeReading(cents: number): TunerPitchReading {
  const targetFrequencyHz = 440;
  const frequencyHz = targetFrequencyHz * 2 ** (cents / 1200);
  return {
    cents,
    confidence: 0.95,
    frequencyHz,
    inputLevel: 0.5,
    noteName: "A",
    pitchClass: 9,
    targetFrequencyHz,
  };
}
