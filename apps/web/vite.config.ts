import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the built app works from any subpath (Cloudflare Pages, previews).
  base: './',
  test: { environment: 'node' },
});
