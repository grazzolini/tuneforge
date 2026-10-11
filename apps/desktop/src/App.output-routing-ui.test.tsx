import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMockInvoke, getMockMediaDevices, renderApp,
  resetAppTestHarness, setMockNativeAudioState } from "./test/appTestHarness";
import { generateStems, openPlaybackWorkspace, openStudioPanel } from "./test/projectTestActions";

function savedRouteStorage() {
  const entries = { ...window.localStorage };
  delete entries["tuneforge.browser-output-inventory"];
  Reflect.deleteProperty(entries, "length");
  return entries;
}

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
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  afterEach(() => {
    if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  });
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

  it.each([{ inventory: [] }, { inventory: [outputDevice("default", "")] }])("discovers from restricted inventories with keyboard and preserves the route", async ({ inventory }) => {
    allowBrowserOutputSelection();
    let granted = false;
    let finish!: (value: MediaStream) => void;
    const stop = vi.fn();
    const microphone = vi.fn(() => new Promise<MediaStream>((resolve) => { finish = resolve; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn(async () => granted ? [outputDevice("usb", "USB speakers")] : inventory),
      getUserMedia: microphone,
    } });
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await generateStems(user);
    await openStudioPanel(user);
    await user.click(screen.getByRole("tab", { name: "Outputs" }));
    expect(screen.getAllByRole("button", { name: / output:/ }).length).toBeGreaterThan(3);
    expect(screen.getAllByText(/Opening outputs briefly uses microphone access/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Discover outputs" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: /Project output: Follow Settings/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveAccessibleDescription(/Opening outputs briefly uses microphone access.*no audio is recorded/);
    trigger.focus();
    expect(microphone).not.toHaveBeenCalled();
    const storage = savedRouteStorage();
    await user.keyboard("{Enter}");
    const choices = within(screen.getByRole("group", { name: "Project output choices" }));
    expect(microphone).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
    expect(screen.getAllByText(/Opening outputs briefly uses microphone access/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Discover outputs/ })).not.toBeInTheDocument();
    expect(choices.getByRole("button", { name: "System Default" })).toBeEnabled();
    expect(choices.getByRole("button", { name: "Follow Settings" })).toBeEnabled();
    granted = true;
    await act(async () => finish({ getTracks: () => [{ stop }] } as unknown as MediaStream));
    await waitFor(() => expect(choices.getByRole("button", { name: "USB speakers" })).toBeInTheDocument());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveAccessibleName(/Follow Settings/);
    expect(savedRouteStorage()).toEqual(storage);
    expect(screen.queryByText(/Opening outputs briefly uses microphone access/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Outputs refreshed/)).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute("aria-describedby");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    await user.click(screen.getByRole("tab", { name: "Outputs" }));
    await user.click(screen.getByRole("button", { name: /Metronome & count-in output:/ }));
    expect(within(screen.getByRole("group", { name: "Metronome & count-in output choices" }))
      .getByRole("button", { name: "USB speakers" })).toBeInTheDocument();
    expect(microphone).toHaveBeenCalledTimes(1);
  });

  it.each(["NotAllowedError", "AbortError"])("shows one retry after chooser %s and clears it after default-only success", async (errorName) => {
    allowBrowserOutputSelection();
    let finish!: (value: MediaDeviceInfo) => void;
    const chooser = vi.fn().mockRejectedValueOnce(new DOMException("synthetic", errorName))
      .mockImplementation(() => new Promise<MediaDeviceInfo>((resolve) => { finish = resolve; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn(async () => []), selectAudioOutput: chooser,
    } });
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await generateStems(user);
    await openStudioPanel(user);
    await user.click(screen.getByRole("tab", { name: "Outputs" }));
    const trigger = screen.getByRole("button", { name: /Project output: Follow Settings/ });
    await user.click(trigger);
    const project = within(screen.getByRole("region", { name: "Project output" }));
    const retry = await project.findByRole("button", { name: "Discover outputs" });
    expect(screen.getAllByRole("button", { name: "Discover outputs" })).toHaveLength(1);
    expect(project.getAllByText(/Output access wasn’t granted/)).toHaveLength(1);
    expect(within(screen.getByRole("group", { name: "Project output choices" }))
      .getByRole("button", { name: "System Default" })).toBeEnabled();
    retry.focus();
    await user.keyboard(" ");
    expect(chooser).toHaveBeenCalledTimes(2);
    expect(retry).toBeDisabled();
    await act(async () => finish(outputDevice("default", "")));
    expect(screen.queryByRole("button", { name: "Discover outputs" })).not.toBeInTheDocument();
    expect(project.queryByText(/Output access wasn’t granted/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Outputs refreshed/)).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("restores remembered Settings outputs without prompting on focus and authorizes only an opening gesture", async () => {
    allowBrowserOutputSelection();
    window.localStorage.setItem("tuneforge.browser-output-device", "saved");
    window.localStorage.setItem("tuneforge.browser-output-inventory", JSON.stringify([{ deviceId: "saved", label: "Studio" }]));
    let finish!: (stream: MediaStream) => void;
    const stop = vi.fn();
    const microphone = vi.fn().mockRejectedValueOnce(new DOMException("synthetic", "NotAllowedError"))
      .mockImplementation(() => new Promise<MediaStream>((resolve) => { finish = resolve; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn(async () => []), getUserMedia: microphone,
    } });
    renderApp(["/settings"]);
    const select = await screen.findByRole("combobox", { name: "Audio output" });
    expect(select).toHaveValue("saved");
    expect(within(select).getByRole("option", { name: "Studio (remembered)" })).toBeInTheDocument();
    fireEvent.focus(select);
    fireEvent.keyDown(select, { key: "ArrowDown" });
    expect(microphone).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Discover outputs" })).not.toBeInTheDocument();
    expect(select).toHaveAccessibleDescription(/Opening outputs briefly uses microphone access/);
    expect(screen.getAllByText(/Opening outputs briefly uses microphone access/)).toHaveLength(1);
    await act(async () => { fireEvent.pointerDown(select, { button: 0 }); });
    expect(microphone).toHaveBeenCalledTimes(1);
    expect(select).toHaveValue("saved");
    await act(async () => { fireEvent.keyDown(select, { key: "Enter" }); });
    expect(microphone).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.change(select, { target: { value: "default" } }); });
    expect(select).toHaveValue("default");
    expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBeNull();
    const retry = screen.getByRole("button", { name: "Discover outputs" });
    retry.focus();
    act(() => { fireEvent.click(retry); });
    expect(microphone).toHaveBeenCalledTimes(2);
    expect(retry).toBeDisabled();
    expect(screen.getAllByText(/Opening outputs briefly uses microphone access/)).toHaveLength(1);
    await act(async () => finish({ getTracks: () => [{ stop }] } as unknown as MediaStream));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Discover outputs" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Opening outputs briefly uses microphone access/)).not.toBeInTheDocument();
    expect(select).toHaveFocus();
  });

  it("selects a Settings browser default using the chooser-returned ID without changing project overrides", async () => {
    allowBrowserOutputSelection();
    const routes = { project: { kind: "explicit-device", deviceId: "override" }, cue: { kind: "inherit" }, stems: {} };
    window.localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({ proj_123: { outputRouting: { browser: routes } } }));
    const chooser = vi.fn().mockResolvedValue(outputDevice("rotated", "Studio"));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn(async () => [outputDevice("old", "Studio")]), selectAudioOutput: chooser,
    } });
    renderApp(["/settings"]);
    const select = await screen.findByRole("combobox", { name: "Audio output" });
    await waitFor(() => expect(within(select).getByRole("option", { name: "Studio" })).toBeInTheDocument());
    expect(chooser).not.toHaveBeenCalled();
    const saved = window.localStorage.getItem("tuneforge.project-playback-state");
    await act(async () => { fireEvent.change(select, { target: { value: "old" } }); });
    expect(chooser).toHaveBeenCalledWith({ deviceId: "old" });
    expect(select).toHaveValue("rotated");
    expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBe("rotated");
    expect(window.localStorage.getItem("tuneforge.project-playback-state")).toBe(saved);
    expect(screen.getByText(/Default for projects using Follow Settings/)).toBeInTheDocument();
  });

  it("resets the browser default without permission and supersedes a pending selection", async () => {
    allowBrowserOutputSelection();
    window.localStorage.setItem("tuneforge.browser-output-device", "usb");
    window.localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({ proj_123: {
      outputRouting: { browser: { project: { kind: "explicit-device", deviceId: "override" },
        cue: { kind: "inherit" }, stems: {} } },
    } }));
    let grant!: (device: MediaDeviceInfo) => void;
    const chooser = vi.fn(() => new Promise<MediaDeviceInfo>((resolve) => { grant = resolve; }));
    const microphone = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn(async () => [outputDevice("usb", "Studio"), outputDevice("other", "Other")]),
      selectAudioOutput: chooser, getUserMedia: microphone,
    } });
    renderApp(["/settings"]);
    const select = await screen.findByRole("combobox", { name: "Audio output" });
    await waitFor(() => expect(within(select).getByRole("option", { name: "Other" })).toBeInTheDocument());
    const routes = window.localStorage.getItem("tuneforge.project-playback-state");
    const inventory = window.localStorage.getItem("tuneforge.browser-output-inventory");
    act(() => { fireEvent.change(select, { target: { value: "other" } }); });
    expect(chooser).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "Reset All Settings" }));
    expect(select).toHaveValue("default");
    expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBeNull();
    expect(window.localStorage.getItem("tuneforge.browser-output-inventory")).toBe(inventory);
    await act(async () => { grant(outputDevice("late", "Late output")); });
    expect(select).toHaveValue("default");
    expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBeNull();
    expect(window.localStorage.getItem("tuneforge.project-playback-state")).toBe(routes);
    expect(chooser).toHaveBeenCalledTimes(1);
    expect(microphone).not.toHaveBeenCalled();
  });

  it("shows unavailable discovery separately from unavailable routing", async () => {
    allowBrowserOutputSelection();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn(async () => []),
    } });
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openStudioPanel(user);
    const trigger = screen.getByRole("button", { name: /Project output: Follow Settings/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    const choices = within(screen.getByRole("group", { name: "Project output choices" }));
    expect(trigger).toHaveAccessibleDescription("Output discovery is unavailable in this browser. System Default remains available.");
    expect(screen.getByText("Output discovery is unavailable in this browser. System Default remains available."))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discover outputs" })).not.toBeInTheDocument();
    expect(choices.getByRole("button", { name: "System Default" })).toBeEnabled();
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
    allowBrowserOutputSelection();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn(async () => []),
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("synthetic", "NotAllowedError")),
    } });
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Open Practice Controls" }));
    const drawer = screen.getByRole("dialog", { name: "Practice Controls" });
    await user.click(within(drawer).getByRole("tab", { name: "Outputs" }));
    const cue = within(drawer).getByRole("button", { name: /Metronome & count-in output:/ });
    const notice = document.getElementById(cue.getAttribute("aria-describedby")!);
    expect(drawer).toContainElement(notice);
    expect(within(drawer).getAllByText(/Opening outputs briefly uses microphone access/)).toHaveLength(1);
    const noticeIds = Array.from(document.querySelectorAll('[id*="output-discovery"]'), (node) => node.id);
    expect(new Set(noticeIds).size).toBe(noticeIds.length);
    await user.click(cue);
    expect(within(drawer).getAllByRole("button", { name: "Discover outputs" })).toHaveLength(1);
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

  it("shows an unverified saved preference while preserving default-only capability truth", async () => {
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
    expect(within(projectRoute).getByRole("button", { name: /Saved output \(availability unknown\)/ })).toBeInTheDocument();
    expect(within(projectRoute).getByText(/This runtime uses System Default/)).toBeInTheDocument();
    expect(within(projectRoute).getByText("Output unavailable. Saved choice kept.")).toBeInTheDocument();
  });
});
