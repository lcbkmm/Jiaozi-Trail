import { defineConfig } from 'vite';
export default defineConfig(({ mode }) => ({
  base: process.env.DJ_BASE || './',
  server: { port: 5188, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: mode === 'module' ? {
    outDir: 'dist-module',
    lib: { entry: 'src/module.ts', formats: ['es'], fileName: 'digital-jiaozi', cssFileName: 'digital-jiaozi' }
  } : { outDir: 'dist', target: 'es2022' }
}));
