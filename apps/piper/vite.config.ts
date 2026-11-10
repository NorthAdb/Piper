// Piper 前端构建：源码在 web/，产物输出到 public/ 由 server.mjs 静态托管（接口不变）。
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "web",
	plugins: [react()],
	build: {
		outDir: "../public",
		emptyOutDir: true,
	},
});
