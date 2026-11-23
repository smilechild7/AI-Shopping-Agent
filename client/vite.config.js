/**
 * 역할: React·Tailwind 플러그인, 개발 서버의 /api 프록시와 프런트엔드 빌드 출력 경로를 설정한다.
 */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3000'
    }
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true
  }
});
