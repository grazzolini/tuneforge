import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { BootScreen } from "./BootScreen";
import { initializeApi } from "./lib/api";
import { queryClient } from "./lib/query-client";
import "./styles.css";

function formatBootError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "The desktop shell started, but the frontend could not initialize.";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof window.setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error("Timed out while initializing the desktop API bridge."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

async function bootstrap() {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Root element was not found.");
  }

  const root = ReactDOM.createRoot(rootElement);
  root.render(<BootScreen title="Starting Tuneforge" />);

  try {
    await withTimeout(initializeApi(), 8000);

    root.render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <HashRouter>
            <App />
          </HashRouter>
        </QueryClientProvider>
      </React.StrictMode>,
    );
  } catch (error) {
    console.error("Tuneforge failed to initialize.", error);
    root.render(
      <BootScreen
        title="Tuneforge could not start"
        message={formatBootError(error)}
      />,
    );
  }
}

void bootstrap();
