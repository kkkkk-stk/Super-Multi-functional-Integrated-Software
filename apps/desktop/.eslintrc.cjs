/**
 * ESLint 配置（**可选**：本仓库刻意不把 ESLint 装进依赖清单）。
 *
 * 现状：`package.json` 的 `lint` 脚本会回退成 `tsc --noEmit`。
 * 想启用 ESLint 时，按下面注释里的依赖装好即可（不要动锁定的技术栈版本）。
 *
 *   pnpm add -D -F @toolforge/desktop eslint@8 \
 *     @typescript-eslint/parser@7 @typescript-eslint/eslint-plugin@7 \
 *     eslint-plugin-react-hooks@4 eslint-plugin-react-refresh@0.4
 *
 * 然后把 `lint` 脚本改成 `eslint src --ext .ts,.tsx --max-warnings 0`。
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  settings: { react: { version: "18.3" } },
  plugins: ["@typescript-eslint", "react-hooks", "react-refresh"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
  ],
  ignorePatterns: ["dist", "node_modules", "src-tauri"],
  rules: {
    // 全应用唯一允许 any 的地方是第三方类型不兼容的兜底，且必须写清楚原因
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
  },
};
