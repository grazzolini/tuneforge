import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getMockInvoke,
  renderApp,
  resetAppTestHarness,
  setMockPowerInhibitionState,
} from "./test/appTestHarness";

function mockTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: getMockInvoke() },
  });
}

describe("power protection UI", () => {
  beforeEach(() => {
    resetAppTestHarness();
    mockTauriRuntime();
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("shows only confirmed native protection details in Settings diagnostics", async () => {
    const user = userEvent.setup();
    setMockPowerInhibitionState({
      phase: "active",
      backend: "android-foreground-service",
      activeReasons: ["playback", "sync-listener"],
      screenProtected: true,
      backgroundProtected: true,
      errorCode: null,
      errorMessage: null,
    });
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await user.click(screen.getByText("Show diagnostics"));
    const section = screen.getByRole("heading", { name: "Power Protection" }).closest("section");
    expect(section).not.toBeNull();
    await waitFor(() => {
      expect(within(section!).getAllByText("Android foreground service")).toHaveLength(2);
    });
    expect(within(section!).queryByText("android-foreground-service")).not.toBeInTheDocument();
    expect(within(section!).getByText("Playback, Sync listener")).toBeInTheDocument();
    expect(within(section!).getAllByText("Confirmed")).toHaveLength(2);
    expect(within(section!).getByText("Inactive")).toBeInTheDocument();
  });

  it("labels tuner-only Android screen protection without claiming background coverage", async () => {
    const user = userEvent.setup();
    setMockPowerInhibitionState({
      phase: "active",
      backend: "android-activity-screen",
      activeReasons: ["tuner-capture"],
      screenProtected: true,
      backgroundProtected: false,
      errorCode: null,
      errorMessage: null,
    });
    renderApp(["/settings"]);

    await user.click(await screen.findByText("Show diagnostics"));
    const section = screen.getByRole("heading", { name: "Power Protection" }).closest("section");
    expect(section).not.toBeNull();
    await waitFor(() => {
      expect(within(section!).getAllByText("Android activity screen")).toHaveLength(2);
    });
    expect(within(section!).getByText("Tuner capture")).toBeInTheDocument();
    expect(within(section!).getByText("Native Screen Protected").nextElementSibling).toHaveTextContent(
      "Confirmed",
    );
    expect(
      within(section!).getByText("Native Background Protected").nextElementSibling,
    ).toHaveTextContent("Not confirmed");
  });

  it("shows a sync reliability alert only for relevant protection failure", async () => {
    const user = userEvent.setup();
    setMockPowerInhibitionState({
      phase: "failed",
      backend: null,
      activeReasons: ["sync-listener"],
      screenProtected: false,
      backgroundProtected: false,
      errorCode: "linux-inhibition-failed",
      errorMessage: "Linux power protection is unavailable.",
    });
    renderApp(["/activity"]);

    await user.click(screen.getByRole("tab", { name: "Sync" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Sync" })).toBeInTheDocument();
    expect(await screen.findByRole("alert", { name: "" })).toHaveTextContent(
      "Linux power protection is unavailable.",
    );
  });
});
