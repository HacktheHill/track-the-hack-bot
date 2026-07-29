import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	root: "corpus-ui",
	build: {
		outDir: "../dist/corpus-ui",
		emptyOutDir: true,
	},
});
