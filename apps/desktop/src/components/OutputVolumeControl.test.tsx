import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OutputVolumeControl } from "./OutputVolumeControl";

describe("OutputVolumeControl", () => {
  it("resets from slider double-click and the accessible percentage button", async () => {
    const user = userEvent.setup();
    const onGainChange = vi.fn();
    render(
      <OutputVolumeControl
        gain={0.42}
        label="Project volume"
        onGainChange={onGainChange}
      />,
    );

    fireEvent.doubleClick(screen.getByRole("slider", { name: "Project volume" }));
    expect(onGainChange).toHaveBeenLastCalledWith(1);

    const reset = screen.getByRole("button", { name: "Reset project volume to 100%" });
    reset.focus();
    await user.keyboard("{Enter}");
    expect(onGainChange).toHaveBeenLastCalledWith(1);
    expect(onGainChange).toHaveBeenCalledTimes(2);
  });

  it("toggles mute independently from the configured gain", async () => {
    const user = userEvent.setup();
    const onGainChange = vi.fn();
    const onMutedChange = vi.fn();
    render(
      <OutputVolumeControl
        gain={0.37}
        label="App volume"
        muted
        onGainChange={onGainChange}
        onMutedChange={onMutedChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unmute app volume" }));
    expect(onMutedChange).toHaveBeenCalledWith(false);
    expect(onGainChange).not.toHaveBeenCalled();
    expect(screen.getByRole("slider", { name: "App volume" })).toHaveValue("0.37");
  });

  it("activates only when a range interaction can change gain", async () => {
    const onGainChange = vi.fn();
    const onInteractionStart = vi.fn();
    render(
      <OutputVolumeControl
        gain={0.5}
        label="Vocals volume"
        onGainChange={onGainChange}
        onInteractionStart={onInteractionStart}
      />,
    );
    const slider = screen.getByRole("slider", { name: "Vocals volume" });

    fireEvent.keyDown(slider, { key: "Tab" });
    fireEvent.keyDown(slider, { key: "Escape" });
    expect(onInteractionStart).not.toHaveBeenCalled();

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.change(slider, { target: { value: "0.51" } });
    expect(onInteractionStart).toHaveBeenCalledTimes(1);
    expect(onGainChange).toHaveBeenCalledWith(0.51);
  });
});
