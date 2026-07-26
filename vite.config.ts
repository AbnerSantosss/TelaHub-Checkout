import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  server: {
    // 3000 é o painel e 5173 é o site de vendas — o checkout usa 3030 para os
    // três rodarem juntos em desenvolvimento.
    port: 3030,
    host: '0.0.0.0',
    proxy: {
      // Em dev o backend roda em 3001. Em produção o Nginx faz o proxy de /api,
      // então o cliente sempre chama caminho relativo (ver src/lib/api.ts).
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
