import { beforeEach, expect, test, vi } from "vitest";
const boot = vi.hoisted(() => ({ render: vi.fn(), initialize: vi.fn(), api: vi.fn(), app: vi.fn() }));
vi.mock("react-dom/client", () => ({ default: { createRoot: () => ({ render: boot.render }) } }));
vi.mock("./lib/musicCore", () => ({ initializeBundledMusicCore: boot.initialize }));
vi.mock("./lib/api", () => ({ initializeApi: boot.api }));
vi.mock("./App", () => { boot.app(); return { default: () => null }; });
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
});
test("initializes the bundled core before importing the application", async () => {
  const order: string[] = [];
  boot.initialize.mockImplementation(async () => { order.push("core"); });
  boot.api.mockImplementation(async () => { order.push("api"); });
  boot.app.mockImplementation(() => { order.push("app"); });
  await import("./main");
  await vi.waitFor(() => expect(boot.render).toHaveBeenCalledTimes(2));
  expect(boot.render.mock.calls[0][0].props.title).toBe("Starting TuneForge");
  expect(order).toEqual(["core", "api", "app"]);
});
test("shows the existing boot failure screen with a useful core error", async () => {
  boot.initialize.mockRejectedValue(new Error("Bundled music core could not initialize."));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("./main");
  await vi.waitFor(() => expect(boot.render).toHaveBeenCalledTimes(2));
  expect(boot.render.mock.calls[1][0].props).toEqual({ title: "TuneForge could not start", message: "Bundled music core could not initialize." });
  expect(boot.api).not.toHaveBeenCalled();
  expect(boot.app).not.toHaveBeenCalled();
  error.mockRestore();
});
