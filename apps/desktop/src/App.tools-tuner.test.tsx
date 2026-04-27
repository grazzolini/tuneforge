import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getMockAudioContexts,
  getMockMediaDevices,
  resetAppTestHarness,
  renderApp,
} from "./test/appTestHarness";

describe("Desktop app tools tuner", () => {
  beforeEach(resetAppTestHarness);

  it("renders the tools route with chromatic tuner defaults", async () => {
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chromatic Tuner" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(440);
    expect(screen.getByLabelText("Tuner visual mode")).toHaveValue("simple");
    expect(screen.getByRole("option", { name: "Wide Arc" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Microphone 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "USB Interface" })).not.toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Tuning offset" })).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Input signal level" })).toBeInTheDocument();
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps the wide arc visual mode available", async () => {
    const user = userEvent.setup();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Tuner visual mode"), "wide-arc");

    expect(screen.getByLabelText("Tuner visual mode")).toHaveValue("wide-arc");
    expect(screen.getByRole("meter", { name: "Tuning offset" })).toBeInTheDocument();
  });

  it("keeps tuner preferences synced between tools and settings", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().revealLabels();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "USB Interface" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Microphone source"), "usb");
    changeReferenceInput("442.5");

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("usb");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(442.5);
    expect(screen.getByText("Saved microphone")).toBeInTheDocument();
    expect(screen.getByText("442.5 Hz")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Microphone source"), "");
    changeReferenceInput("441");
    await user.click(screen.getByRole("link", { name: "Tools" }));

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(441);
  });

  it("applies valid reference tuning edits before the field blurs", async () => {
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("A4 reference tuning"), { target: { value: "442" } });

    expect(window.localStorage.getItem("tuneforge.ui-preferences")).toContain(
      '"defaultTunerReferenceHz":442',
    );
  });

  it("normalizes invalid stored tuner preferences", async () => {
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultTunerInputDeviceId: "",
        defaultTunerReferenceHz: 999,
      }),
    );

    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(440);
  });

  it("starts microphone capture with the selected source and stops cleanly", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().revealLabels();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "USB Interface" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Microphone source"), "usb");
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    expect(getMockMediaDevices().getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: false,
        deviceId: { exact: "usb" },
        echoCancellation: false,
        noiseSuppression: false,
      },
      video: false,
    });
    expect(getMockAudioContexts()).toHaveLength(1);
    expect(getMockAudioContexts()[0]?.createdMediaStreamSources[0]?.connect).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("uses cached device labels before start without opening capture", async () => {
    window.localStorage.setItem(
      "tuneforge.tuner-microphone-devices",
      JSON.stringify([{ deviceId: "usb", label: "USB Interface" }]),
    );

    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "USB Interface" })).toBeInTheDocument();
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("does not open capture when settings renders tuner defaults", async () => {
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("caches device labels after real tuner capture starts", async () => {
    const user = userEvent.setup();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "USB Interface" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    expect(window.localStorage.getItem("tuneforge.tuner-microphone-devices")).toContain("USB Interface");
  });

  it("shows microphone permission failures as recoverable state", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().rejectGetUserMedia(new DOMException("Denied", "NotAllowedError"));
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Microphone permission was denied.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });
});

function changeReferenceInput(value: string) {
  const input = screen.getByLabelText("A4 reference tuning");
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
