import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke, mockInvokeImplementation, renderApp, resetAppTestHarness } from "./test/appTestHarness";

function installedPackage(packageId: string, isTestPackage: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: mockInvoke },
  });
  mockInvoke.mockImplementation((command, args) => command === "get_package_identity"
    ? Promise.resolve({ packageId, isTestPackage })
    : mockInvokeImplementation(command, args));
}

describe("installed package identity", () => {
  beforeEach(resetAppTestHarness);
  afterEach(() => vi.unstubAllEnvs());

  it("shows the test marker in compact chrome and the actual ID in diagnostics", async () => {
    installedPackage("com.example.tuneforge.local", true);
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    const brand = await screen.findByRole("link", { name: "TuneForge library", description: "Test build" });
    expect(brand.querySelector(".brand__mark .brand__test-tab")).toHaveTextContent("TEST");
    expect(brand.closest(".app-shell")).toHaveClass("app-shell--compact");
    await user.click(screen.getByRole("link", { name: "Settings" }));
    await user.click(screen.getByText("Show diagnostics"));
    expect(await screen.findByText("com.example.tuneforge.local")).toBeInTheDocument();
    expect(screen.getByText("Installed Package ID")).toBeInTheDocument();
    expect(mockInvoke.mock.calls.filter(([command]) => command === "get_package_identity")).toHaveLength(1);
  });

  it("keeps the production brand free of the test marker", async () => {
    installedPackage("com.tuneforge.desktop", false);
    renderApp(["/"]);
    const brand = await screen.findByRole("link", { name: "TuneForge library" });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_package_identity"));
    expect(brand).not.toHaveAttribute("aria-describedby");
    expect(brand.querySelector(".brand__test-tab")).toBeNull();
  });

  it("does not present an installed ID in the browser", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);
    await user.click(screen.getByText("Show diagnostics"));
    expect(screen.getByText("Installed Package ID").parentElement).toHaveTextContent("Unavailable");
    expect(mockInvoke.mock.calls.some(([command]) => command === "get_package_identity")).toBe(false);
  });
  it.each([false, true])("shows independent dev TEST visuals with actual production identity or browser diagnostics (%s)", async (installed) => {
    vi.stubEnv("VITE_TUNEFORGE_DEV_TEST_VISUALS", "1");
    if (installed) installedPackage("com.tuneforge.desktop", false);
    const user = userEvent.setup();
    renderApp(["/"]);
    const brand = await screen.findByRole("link", { name: "TuneForge library", description: "Test build" });
    expect(brand).toHaveAttribute("title", "TuneForge Test");
    expect(brand.querySelector(".brand__test-tab")).toHaveTextContent("TEST");
    await user.click(screen.getByRole("link", { name: "Settings" }));
    await user.click(screen.getByText("Show diagnostics"));
    expect(screen.getByText("Installed Package ID").parentElement).toHaveTextContent(installed ? "com.tuneforge.desktop" : "Unavailable");
  });

});
