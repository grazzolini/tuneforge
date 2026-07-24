import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBuildInfo } from "../../scripts/build-info.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fsAllow = Array.from(
  new Set(
    [
      workspaceRoot,
      realpathIfPresent(workspaceRoot),
      realpathIfPresent(resolve(workspaceRoot, "node_modules")),
    ].filter((path): path is string => Boolean(path)),
  ),
);

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

export default defineConfig(() => {
  const versionFilePath = process.env.TUNEFORGE_VERSION_FILE;
  const buildInfo = resolveBuildInfo({ workspaceRoot, versionFilePath });

  return {
    plugins: [reactRefreshPreamble, react()],
    define: {
      __TUNEFORGE_FRONTEND_GIT_REF__: JSON.stringify(buildInfo.frontend.git_ref),
      __TUNEFORGE_FRONTEND_PACKAGE_VERSION__: JSON.stringify(buildInfo.frontend.package_version),
    },
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
      fs: {
        allow: fsAllow,
      },
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: "vendor", test: /node_modules/, priority: 2 },
              { name: "tools", test: /src[\\/]features[\\/]tools/, priority: 1 },
            ],
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      env: {
        NODE_ENV: "test",
      },
      globals: true,
      setupFiles: "./src/setupTests.ts",
    },
  };
});

function realpathIfPresent(path: string) {
  return existsSync(path) ? realpathSync(path) : null;
}
