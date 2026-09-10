import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import {
  appShell,
  computePwaCacheVersion,
  pwaAssetCopies,
  renderServiceWorker,
  writeServiceWorker
} from './scripts/pwa-shell-assets.mjs'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000'
const useHttpsDevServer = process.env.VITE_DISABLE_HTTPS !== 'true'

function localHttpsOptions() {
  // Vite serves HTTPS through Node's HTTP/2 server. Node 24 warns when some dev
  // middleware touches HTTP/1-only status messages, so keep local HTTPS on h1.
  return { ALPNProtocols: ['http/1.1'] }
}

function productionAppShell(indexHtml) {
  const builtEntrypoints = [...indexHtml.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\/[^"#?]+(?:[?#][^"]*)?)"/gi)]
    .map((match) => match[1].split(/[?#]/, 1)[0])
    .filter((publicPath) => /\.(?:css|js)$/i.test(publicPath))

  return [...new Set([...appShell, ...builtEntrypoints])]
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
        .replace(/(<link\b(?=[^>]*\brel="icon")[^>]*\bhref=")[^"]*"/, '$1/assets/icons/reportflow-icon.svg"')
        .replace(/href="\/assets\/reportflow-192-[^"]+\.png"/, 'href="/assets/icons/reportflow-192.png"')
        .replace(/href="\/assets\/reportflow-apple-touch-180-[^"]+\.png"/, 'href="/assets/icons/reportflow-apple-touch-180.png"')
        .replace(/(<img\b(?=[^>]*\bid="brandLogo")[^>]*\bsrc=")[^"]*"/, '$1/assets/icons/reportflow-icon.svg"')
      writeFileSync(indexPath, indexHtml)

      const productionShell = productionAppShell(indexHtml)
      const cacheVersion = computePwaCacheVersion(buildDir, productionShell)
      writeFileSync(
        join(buildDir, 'sw.js'),
        renderServiceWorker(rootDir, { shell: productionShell, cacheVersion }),
        'utf8'
      )
    }
  }
}

export default defineConfig({
  plugins: [
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
