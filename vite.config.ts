import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// In dev, the room API and photos come from `npm run server` on :8080.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080', '/data': 'http://localhost:8080' } },
  // local/ holds rooms and output, never tests.
  test: { exclude: [...configDefaults.exclude, 'local/**'] },
})
