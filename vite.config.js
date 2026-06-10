import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

const pwaAssetCopies = [
  ['sw.js', 'sw.js'],
  ['offline.html', 'offline.html'],
  ['manifest.webmanifest', 'manifest.webmanifest'],
  ['assets/css/styles.css', 'assets/css/styles.css'],
  ['assets/js/app.js', 'assets/js/app.js'],
  ['assets/js/api-client.js', 'assets/js/api-client.js'],
  ['assets/js/db.js', 'assets/js/db.js'],
  ['assets/js/history.js', 'assets/js/history.js'],
  ['assets/js/mock-api.js', 'assets/js/mock-api.js'],
  ['assets/js/offline-submissions.js', 'assets/js/offline-submissions.js'],
  ['assets/js/photo-viewer.js', 'assets/js/photo-viewer.js'],
  ['assets/js/staff-sites.js', 'assets/js/staff-sites.js'],
  ['assets/js/supervisor-review.js', 'assets/js/supervisor-review.js'],
  ['assets/js/utils.js', 'assets/js/utils.js'],
  ['assets/js/worker-attendance.js', 'assets/js/worker-attendance.js'],
  ['assets/js/worker-form.js', 'assets/js/worker-form.js'],
  ['assets/js/worker-log.js', 'assets/js/worker-log.js'],
  ['assets/js/work-form-fields.js', 'assets/js/work-form-fields.js'],
  ['assets/icons/leader-logo.svg', 'assets/icons/leader-logo.svg'],
  ['assets/icons/leader-icon.svg', 'assets/icons/leader-icon.svg'],
  ['assets/icons/apple-touch-icon.png', 'assets/icons/apple-touch-icon.png'],
  ['assets/icons/icon-192.png', 'assets/icons/icon-192.png'],
  ['assets/icons/icon-512.png', 'assets/icons/icon-512.png'],
  ['assets/icons/maskable-512.png', 'assets/icons/maskable-512.png']
]

function copyPwaAssets() {
  let outDir = 'dist'

  return {
    name: 'copy-pwa-assets',
    enforce: 'post',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const buildDir = join(rootDir, outDir)

      for (const [source, target] of pwaAssetCopies) {
        const targetPath = join(buildDir, target)
        mkdirSync(dirname(targetPath), { recursive: true })
        copyFileSync(join(rootDir, source), targetPath)
      }

      const indexPath = join(buildDir, 'index.html')
      const indexHtml = readFileSync(indexPath, 'utf8')
        .replace(/href="\/assets\/manifest-[^"]+\.webmanifest"/, 'href="/manifest.webmanifest"')
        .replace(/href="\/assets\/leader-icon-[^"]+\.svg"/, 'href="/assets/icons/leader-icon.svg"')
        .replace(/href="\/assets\/apple-touch-icon-[^"]+\.png"/, 'href="/assets/icons/apple-touch-icon.png"')
      writeFileSync(indexPath, indexHtml)
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    basicSsl(),
    copyPwaAssets()
  ],

  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      },
      '/uploads': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      }
    }
  },

  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      },
      '/uploads': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      }
    }
  },

  build: {
    rollupOptions: {
      input: {
        main: join(rootDir, 'index.html'),
        premiumPreview: join(rootDir, 'premium-preview.html')
      }
    }
  }
})
