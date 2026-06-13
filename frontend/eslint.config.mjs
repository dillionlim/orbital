import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // eslint-config-next 16 ships this React-Compiler rule as an error. The
      // dashboard deliberately calls setState inside effects to sync with
      // external systems — engine WebSocket subscriptions and server-switch
      // resets — which React's own docs sanction. Keep it a warning rather than
      // a build-blocking error instead of refactoring working real-time hooks.
      // (Tighten to 'error' + refactor if/when we adopt the React Compiler.)
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
