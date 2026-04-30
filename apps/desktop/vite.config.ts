import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const reactRefreshPreamble = {
  name: "tuneforge-react-refresh-preamble",
  apply: "serve" as const,
  transformIndexHtml: {
    order: "pre" as const,
    handler() {
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          children: [
            'import { injectIntoGlobalHook } from "/@react-refresh";',
            "if (!window.$RefreshSig$) {",
            "  injectIntoGlobalHook(window);",
            "  window.$RefreshReg$ = () => {};",
            "  window.$RefreshSig$ = () => (type) => type;",
            "}",
          ].join("\n"),
        },
      ];
    },
  },
};

export default defineConfig({
  plugins: [reactRefreshPreamble, react()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    env: {
      NODE_ENV: "test",
    },
    globals: true,
    setupFiles: "./src/setupTests.ts",
  },
});
