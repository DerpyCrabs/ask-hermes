import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  // solid-refresh's virtual file URL is not loadable by Vitest on Windows.
  // Tests do not need HMR; normal dev builds keep it enabled.
  plugins: [solid({ hot: process.env.VITEST !== 'true' })],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: { target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13' }
})
