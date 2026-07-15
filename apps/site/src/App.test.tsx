import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const manifest = {
  schemaVersion: 1,
  status: "captured",
  generatedAt: "2026-04-18T12:00:00.000Z",
  source: "synthetic release capture",
  items: [
    {
      id: "library",
      title: "Practice library",
      kind: "screenshot",
      src: "media/generated/library.png",
      alt: "TuneForge practice library with two synthetic projects",
      caption: "Return to saved songs and practice state.",
      label: "Library",
    },
    {
      id: "overview",
      title: "TuneForge overview",
      kind: "video",
      src: "media/generated/overview.webm",
      poster: "media/generated/library.png",
      caption: "A short tour through the local practice workflow.",
      label: "Video",
    },
  ],
};

function mockManifest(value: unknown = manifest) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(value),
    }),
  );
}

describe("release media gallery", () => {
  beforeEach(() => {
    mockManifest();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens from the keyboard, closes, and restores launcher focus", async () => {
    const user = userEvent.setup();
    render(<App />);
    const launcher = await screen.findByRole("button", {
      name: "Open Practice library in gallery",
    });

    launcher.focus();
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Practice library" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText("1 of 2")).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(launcher).toHaveFocus();
  });

  it("wraps previous and next navigation with arrow keys", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Open Practice library in gallery" }),
    );

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("dialog", { name: "TuneForge overview" })).toBeVisible();
    expect(screen.getByText("2 of 2")).toBeVisible();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog", { name: "Practice library" })).toBeVisible();
    expect(screen.getByText("1 of 2")).toBeVisible();
  });

  it("wraps navigation controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Open TuneForge overview in gallery" }),
    );

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "Practice library" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("dialog", { name: "TuneForge overview" })).toBeVisible();
  });

  it("leaves arrow keys to focused video controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Open TuneForge overview in gallery" }),
    );

    const dialog = screen.getByRole("dialog", { name: "TuneForge overview" });
    const video = dialog.querySelector("video");
    expect(video).not.toBeNull();
    video?.focus();
    expect(video).toHaveFocus();

    await user.keyboard("{ArrowLeft}{ArrowRight}");

    expect(screen.getByRole("dialog", { name: "TuneForge overview" })).toBeVisible();
    expect(screen.getByText("2 of 2")).toBeVisible();
  });

  it("pauses video before changing items and closing", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Open TuneForge overview in gallery" }),
    );

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(pause).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Close gallery" }));
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it("shows public fallback links for a malformed manifest", async () => {
    mockManifest({ schemaVersion: 1, status: "captured", items: "broken" });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Release preview unavailable" })).toBeVisible();
    expect(screen.getByRole("link", { name: "View releases" })).toHaveAttribute(
      "href",
      "https://github.com/grazzolini/tuneforge/releases",
    );
    expect(screen.getByRole("link", { name: "Browse repository" })).toHaveAttribute(
      "href",
      "https://github.com/grazzolini/tuneforge",
    );
    expect(screen.queryByText(/capture-release-media/i)).not.toBeInTheDocument();
  });
});
