import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app uses postMessage-transferred typed arrays to move samples from the
// serial worker to the UI, so no SharedArrayBuffer / cross-origin isolation
// headers are needed. Any static host (GitHub Pages, S3, Netlify, etc.) works.
export default defineConfig({
    plugins: [react()],
    worker: {
        format: 'es',
    },
});
