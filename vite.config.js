import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function porsDeviceConfigSource() {
  return `window.PORS_NOBLESSE_READ_TOKEN = ${JSON.stringify(
    process.env.PORS_NOBLESSE_READ_TOKEN || ""
  )};\nwindow.PORS_NOBLESSE_WRITE_TOKEN = ${JSON.stringify(
    process.env.PORS_NOBLESSE_WRITE_TOKEN || ""
  )};\n`;
}

function porsDeviceConfigPlugin() {
  return {
    name: "pors-device-config",
    configureServer(server) {
      server.middlewares.use("/pors-device-config.js", (_req, response) => {
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/javascript; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(porsDeviceConfigSource());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "pors-device-config.js",
        source: porsDeviceConfigSource()
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), porsDeviceConfigPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
