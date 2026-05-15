import { act, screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import type { renderApp } from "./appTestHarness";

export async function openPlaybackWorkspace(user: UserEvent) {
  await user.click(screen.getByRole("tab", { name: "Playback" }));
}

export async function ensureInspectorVisible(user: UserEvent) {
  const showInspectorButton = screen.queryByRole("button", { name: "Show Inspector" });
  if (showInspectorButton) {
    await user.click(showInspectorButton);
  }
}

export async function openProjectPanel(user: UserEvent, name: "Studio" | "Analysis") {
  const tab = screen.getByRole("tab", { name });
  if (tab.getAttribute("aria-selected") !== "true") {
    await user.click(tab);
  }
}

export async function openStudioPanel(user: UserEvent) {
  await openProjectPanel(user, "Studio");
}

export async function openAnalysisPanel(user: UserEvent) {
  await openProjectPanel(user, "Analysis");
}

export async function generateStems(user: UserEvent) {
  await openStudioPanel(user);
  await user.click(screen.getByRole("button", { name: "Generate Stems" }));
}

export async function refreshJobs(queryClient: ReturnType<typeof renderApp>["queryClient"]) {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  });
}

export async function selectFirstStemInAnalysis(user: UserEvent) {
  const stemList = await screen.findByRole("group", { name: "Stem track list" });
  await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
  await openAnalysisPanel(user);
}
