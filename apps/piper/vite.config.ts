// Piper 前端构建：源码在 web/，产物输出到 public/ 由 server.ts 编译产物静态托管（接口不变）。
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	root: "web",
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./web/src", import.meta.url)),
		},
	},
	build: {
		outDir: "../public",
		emptyOutDir: true,
	},
});
