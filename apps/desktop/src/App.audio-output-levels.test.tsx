import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp, resetAppTestHarness } from "./test/appTestHarness";

describe("global click output levels", () => {
  beforeEach(() => resetAppTestHarness());

  it("mirrors persisted click levels and mute state between Settings and Tools", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);
    await screen.findByRole("heading", { name: "Control Room" });

    const settingsCountIn = screen.getByRole("slider", { name: "Count-in volume" });
    expect(settingsCountIn).toHaveValue("1");
    fireEvent.change(settingsCountIn, { target: { value: "0.68" } });
    await user.click(screen.getByRole("button", { name: "Mute count-in volume" }));
    expect(settingsCountIn).toHaveValue("0.68");
    const settingsMetronome = screen.getByRole("slider", { name: "Metronome volume" });
    expect(settingsMetronome).toHaveValue("0.8");
    fireEvent.change(settingsMetronome, { target: { value: "0.46" } });
    await user.click(screen.getByRole("button", { name: "Mute metronome volume" }));
    expect(settingsMetronome).toHaveValue("0.46");

    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    expect(screen.getByRole("slider", { name: "Metronome volume" })).toHaveValue("0.46");
    const unmute = screen.getByRole("button", { name: "Unmute metronome volume" });
    expect(unmute).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("slider", { name: "Metronome volume" }), {
      target: { value: "0.62" },
    });
    expect(screen.getByRole("button", { name: "Unmute metronome volume" }))
      .toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Reset metronome volume to 80%" }));
    expect(screen.getByRole("button", { name: "Unmute metronome volume" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
      .toMatchObject({ metronomeOutputGain: 0.8, metronomeOutputMuted: true });
    await user.click(unmute);
    expect(screen.getByRole("slider", { name: "Metronome volume" })).toHaveValue("0.8");
  });
});
