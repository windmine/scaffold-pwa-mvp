import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { pwaAssetCopies, writeServiceWorker } from './scripts/pwa-shell-assets.mjs'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000'
const useHttpsDevServer = process.env.VITE_DISABLE_HTTPS !== 'true'

function localHttpsOptions() {
  // Vite serves HTTPS through Node's HTTP/2 server. Node 24 warns when some dev
  // middleware touches HTTP/1-only status messages, so keep local HTTPS on h1.
  return { ALPNProtocols: ['http/1.1'] }
}

function copyPwaAssets() {
  let outDir = 'dist'

  return {
    name: 'copy-pwa-assets',
    enforce: 'post',
    configResolved(config) {
      outDir = config.build.outDir
      writeServiceWorker(rootDir)
    },
    closeBundle() {
      const buildDir = join(rootDir, outDir)
      writeServiceWorker(rootDir)

      for (const [source, target] of pwaAssetCopies) {
        const targetPath = join(buildDir, target)
        mkdirSync(dirname(targetPath), { recursive: true })
        copyFileSync(join(rootDir, source), targetPath)
      }

      const indexPath = join(buildDir, 'index.html')
      const indexHtml = readFileSync(indexPath, 'utf8')
        .replace(/href="\/assets\/manifest-[^"]+\.webmanifest"/, 'href="/manifest.webmanifest"')
        .replace(/href="\/assets\/leader-icon-[^"]+\.svg"/, 'href="/assets/icons/leader-icon.svg"')
        .replace(/href="\/assets\/icon-192-[^"]+\.png(\?v=20260708)?"/, 'href="/assets/icons/icon-192.png?v=20260708"')
        .replace(/href="\/assets\/apple-touch-icon-[^"]+\.png"/, 'href="/assets/icons/apple-touch-icon.png"')
        .replace(/src="\/assets\/leader-logo-export-[^"]+\.png"/, 'src="/assets/icons/leader-logo-export.png"')
      writeFileSync(indexPath, indexHtml)
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    useHttpsDevServer ? basicSsl() : null,
    copyPwaAssets()
  ].filter(Boolean),

  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    ...(useHttpsDevServer ? { https: localHttpsOptions() } : {}),
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      },
      '/uploads': {
        target: apiProxyTarget,
        changeOrigin: true
      }
    }
  },

  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    ...(useHttpsDevServer ? { https: localHttpsOptions() } : {}),
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      },
      '/uploads': {
        target: apiProxyTarget,
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
