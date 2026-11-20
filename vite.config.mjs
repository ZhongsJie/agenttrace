import {fileURLToPath, URL} from 'node:url';
import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  publicDir: false,
  define: {'process.env.NODE_ENV': JSON.stringify('production')},
  build: {
    write: false,
    lib: {
      entry: fileURLToPath(new URL('./frontend/src/main.js', import.meta.url)),
      name: 'AgentTraceFrontend',
      formats: ['iife'],
    },
  },
});
