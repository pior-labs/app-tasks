import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');

  return {
    envDir: '../..',
    plugins: [react(), tailwindcss()],
    test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], restoreMocks: true },
    server: {
      port: Number(env.WEB_PORT || '5173'),
      strictPort: true,
      proxy: {
        '/api': `http://localhost:${env.API_PORT || '3000'}`,
      },
    },
  };
});
