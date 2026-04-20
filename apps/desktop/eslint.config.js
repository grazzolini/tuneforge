import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// Keep the long-standing Hooks lint policy without forcing React Compiler cleanup
// into a dependency rollup PR.
const reactHooksRules = {
  "react-hooks/rules-of-hooks":
    reactHooks.configs.recommended.rules["react-hooks/rules-of-hooks"],
  "react-hooks/exhaustive-deps":
    reactHooks.configs.recommended.rules["react-hooks/exhaustive-deps"],
};

export default tseslint.config(
  { ignores: ["dist", "src-tauri/resources", "src-tauri/target", "src-tauri/gen"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooksRules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
);
