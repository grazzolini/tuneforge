import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockInvoke, getMockMediaDevices, renderApp,
  resetAppTestHarness, setMockNativeAudioState } from "./test/appTestHarness";
import { generateStems, openPlaybackWorkspace, openStudioPanel } from "./test/projectTestActions";

function outputDevice(deviceId: string, label: string): MediaDeviceInfo {
  return { deviceId, label, groupId: "synthetic", kind: "audiooutput", toJSON: () => ({}) };
}

function allowBrowserOutputSelection() {
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    configurable: true,
    value: vi.fn(async () => undefined),
  });
}

describe("project output routing controls", () => {
  beforeEach(() => {
    resetAppTestHarness();
    Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
  });

  it("keeps Project output immediately after Source Track and shares its choice between Studio and Playback", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().setDevices([outputDevice("default", ""), outputDevice("", "")]);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openStudioPanel(user);
    const studioProject = within(screen.getByRole("region", { name: "Project output" }));
    await waitFor(() => expect(studioProject.getByRole("button", { name: /Project output: Follow Settings/ })).toBeEnabled());
    await user.click(studioProject.getByRole("button", { name: /Project output: Follow Settings/ }));
    expect(screen.getByRole("group", { name: "Project output choices" })).toHaveTextContent("System Default");
    expect(within(screen.getByRole("group", { name: "Project output choices" })).getAllByRole("button")).toHaveLength(2);
    act(() => fireEvent.click(within(screen.getByRole("group", { name: "Project output choices" }))
      .getByRole("button", { name: "System Default" })));
    await waitFor(() => expect(studioProject.getByRole("button", { name: /Project output: System Default/ })).toBeInTheDocument());

    await openPlaybackWorkspace(user);
    const base = screen.getByRole("group", { name: "Playback source and mix list" });
    const labels = Array.from(base.querySelectorAll(".artifact-pill__title, .output-routing--project h3"),
      (element) => element.textContent);
    expect(labels.slice(0, 3)).toEqual(["Source Track", "Project output", "Practice Mix"]);
    expect(within(screen.getByRole("region", { name: "Project output" }))
      .getByRole("button", { name: /Project output: System Default/ })).toBeInTheDocument();
  });

  it("offers readable unlabeled devices and resets only route overrides", async () => {
    allowBrowserOutputSelection();
    getMockMediaDevices().setDevices([
      outputDevice("default", ""),
      outputDevice("usb-a", ""),
      outputDevice("usb-b", "Studio speakers"),
    ]);
    getMockMediaDevices().revealLabels();
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    await openStudioPanel(user);
    await user.click(screen.getByRole("tab", { name: "Outputs" }));
    const vocalRoute = screen.getByRole("button", { name: /Vocals output: Follow project/ });
    await waitFor(() => expect(vocalRoute).toBeEnabled());
    await user.click(vocalRoute);
    const choices = within(screen.getByRole("group", { name: "Vocals output choices" }));
    await waitFor(() => expect(choices.getByRole("button", { name: "Audio output 1" })).toBeInTheDocument());
    expect(choices.queryByRole("button", { name: "default" })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(choices.getByRole("button", { name: "Studio speakers" })); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Vocals output: Studio speakers/ })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Reset all outputs" }));
    expect(screen.getByRole("button", { name: /Vocals output: Follow project/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset all outputs" })).toBeDisabled();
  });

  it("refreshes native output choices on pointer and keyboard open without switching routes", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true, value: { invoke: getMockInvoke() },
    });
    setMockNativeAudioState({
      capabilities: {
        platform: "macos", nativePlaybackSupported: true,
        outputSelectionPersistence: "persistent", outputRouteVerification: "backend-selected",
      },
      outputDevices: { supported: true, devices: [], error: null },
    });
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openStudioPanel(user);
    await waitFor(() => expect(getMockInvoke().mock.calls.some(([name]) =>
      name === "audio_list_output_devices")).toBe(true));
    const routeCalls = () => getMockInvoke().mock.calls.filter(([name]) =>
      name === "audio_set_output_routing").length;
    const beforeStudioOpen = routeCalls();
    setMockNativeAudioState({ outputDevices: { devices: [
      { id: "coreaudio:usb", label: "USB speakers", isDefault: false },
    ] } });
    await user.click(screen.getByRole("button", { name: /Project output: Follow Settings/ }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Project output choices" }))
      .getByRole("button", { name: "USB speakers" })).toBeInTheDocument());
    expect(routeCalls()).toBe(beforeStudioOpen);

    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("tab", { name: "Outputs" }));
    setMockNativeAudioState({ outputDevices: { devices: [
      { id: "coreaudio:usb", label: "USB speakers", isDefault: false },
      { id: "coreaudio:headphones", label: "Headphones", isDefault: false },
    ] } });
    const cue = screen.getByRole("button", { name: /Metronome & count-in output:/ });
    const beforePlaybackOpen = routeCalls();
    cue.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Metronome & count-in output choices" }))
      .getByRole("button", { name: "Headphones" })).toBeInTheDocument());
    expect(routeCalls()).toBe(beforePlaybackOpen);
  });

  it("closes a route choice before dismissing the narrow Practice Controls drawer", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Open Practice Controls" }));
    const drawer = screen.getByRole("dialog", { name: "Practice Controls" });
    await user.click(within(drawer).getByRole("tab", { name: "Outputs" }));
    await user.click(within(drawer).getByRole("button", { name: /Metronome & count-in output:/ }));
    expect(within(drawer).getByRole("group", { name: "Metronome & count-in output choices" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(drawer).queryByRole("group", { name: "Metronome & count-in output choices" })).not.toBeInTheDocument();
    expect(drawer).toBeInTheDocument();
    const cueTrigger = within(drawer).getByRole("button", { name: /Metronome & count-in output:/ });
    cueTrigger.focus();
    await user.keyboard("{Enter}");
    const systemDefault = within(drawer).getByRole("group", { name: "Metronome & count-in output choices" })
      .querySelector<HTMLButtonElement>(".output-route-row__choice:nth-child(2)");
    if (!systemDefault) throw new Error("Expected System Default route choice");
    systemDefault.focus();
    await user.keyboard("{Enter}");
    expect(cueTrigger).toHaveFocus();
    expect(within(drawer).queryByRole("group", { name: "Metronome & count-in output choices" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Practice Controls" })).not.toBeInTheDocument();
  });

  it("dismisses pointer-open choices when the playing rail is left without pinning focus", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const projectRoute = screen.getByRole("button", { name: /Project output: Follow Settings/ });
    const rail = projectRoute.closest(".playback-practice-rail");
    if (!(rail instanceof HTMLElement)) throw new Error("Expected Playback practice rail");
    fireEvent.pointerDown(projectRoute);
    await user.click(projectRoute);
    expect(within(rail).getByRole("group", { name: "Project output choices" })).toBeInTheDocument();
    const routeRow = projectRoute.closest(".output-route-row");
    if (!(routeRow instanceof HTMLElement)) throw new Error("Expected output route row");
    fireEvent.pointerLeave(routeRow);
    fireEvent.pointerLeave(rail);
    expect(within(rail).queryByRole("group", { name: "Project output choices" })).not.toBeInTheDocument();
    expect(rail.contains(document.activeElement)).toBe(false);
  });

  it("keeps Outputs selected after pointer leave and exposes Metronome Follow", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const rail = screen.getByRole("tablist", { name: "Playback routes and stems" }).closest(".playback-practice-rail");
    if (!(rail instanceof HTMLElement)) throw new Error("Expected Playback practice rail");
    await user.click(within(rail).getByRole("tab", { name: "Outputs" }));
    fireEvent.pointerLeave(rail);
    fireEvent.pointerEnter(rail);
    expect(within(rail).getByRole("tab", { name: "Outputs" })).toHaveAttribute("aria-selected", "true");
    const follow = within(rail).getByRole("checkbox", { name: "Metronome Follow" });
    expect(within(rail).queryByText("Follow project playback, or run independently from Tools.")).not.toBeInTheDocument();
    await user.click(within(rail).getByRole("button", { name: "Start metronome" }));
    await waitFor(() => expect(within(rail).getByRole("button", { name: "Stop metronome" })).toBeInTheDocument());
    await user.click(follow);
    await waitFor(() => expect(follow).not.toBeChecked());
    await user.click(follow);
    await waitFor(() => expect(follow).toBeChecked());
    expect(within(rail).getByRole("button", { name: "Stop metronome" })).toBeInTheDocument();
    await user.click(within(rail).getByRole("button", { name: "Stop metronome" }));
    await waitFor(() => expect(within(rail).getByRole("button", { name: "Start metronome" })).toBeInTheDocument());
  });

  it("shows an unavailable saved preference while preserving default-only capability truth", async () => {
    window.localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: { outputRouting: {
        browser: {
          project: { kind: "explicit-device", deviceId: "absent-speaker" },
          cue: { kind: "inherit" },
          stems: {},
        },
      } },
    }));
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const projectRoute = screen.getByRole("region", { name: "Project output" });
    expect(within(projectRoute).getByRole("button", { name: /Unavailable · absent-speaker/ })).toBeInTheDocument();
    expect(within(projectRoute).getByText(/This runtime uses System Default/)).toBeInTheDocument();
    expect(within(projectRoute).getByText("Output unavailable. Saved choice kept.")).toBeInTheDocument();
  });
});
