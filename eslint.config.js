import globals from "globals";
import pluginJs from "@eslint/js";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.{js,mjs,cjs,ts,tsx}", "example/**/*.{js,mjs,cjs,ts,tsx}"],
  },
  {
    ignores: [
      "dist/**",
      "eslint.config.js",
      "**/_generated/",
      "vitest.config.ts",
    ],
  },
  {
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.node,
      },
      parser: typescriptParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: ".",
      },
    },
    plugins: {
      "@typescript-eslint": typescriptEslint,
    },
    rules: {
      ...typescriptEslint.configs["recommended"].rules,
      ...pluginJs.configs.recommended.rules,
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "off",
      // allow (_arg: number) => {} and const _foo = 1;
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
];
