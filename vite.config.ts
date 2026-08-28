import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "es2022",
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["siyuan"],
      output: {
        exports: "default",
        interop: "auto",
      },
    },
    minify: "esbuild",
    sourcemap: true,
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    alias: {
      siyuan: resolve(import.meta.dirname, "tests/siyuan-mock.ts"),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
