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

// Source modules remain publishable for older clients and diagnostics. Installed
// builds use the compiled dependency graph, so they never need a second raw copy.
function chunkAssets(bundle, entryName, excludedName) {
  const paths = new Set()
  function visit(name) {
    if (name === excludedName || paths.has('/' + name)) return
    const chunk = bundle[name]
    if (!chunk) throw new Error('Missing PWA build asset: ' + name)
    paths.add('/' + name)
    if (chunk.type !== 'chunk') return
    for (const asset of [...chunk.viteMetadata.importedCss, ...chunk.viteMetadata.importedAssets]) paths.add('/' + asset)
    for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency)
  }
  visit(entryName)
  return [...paths].sort()
}

function copyPwaAssets() {
  let outDir = 'dist'
  let productionShell, fieldShell

  return {
    name: 'copy-pwa-assets',
    enforce: 'post',
    configResolved(config) {
      outDir = config.build.outDir
      writeServiceWorker(rootDir)
    },
    writeBundle(_, bundle) {
      const chunks = Object.values(bundle).filter((chunk) => chunk.type === 'chunk')
      const main = chunks.find((chunk) => chunk.isEntry && chunk.name === 'main')
      const field = chunks.find((chunk) => chunk.facadeModuleId?.replaceAll('\\', '/').endsWith('/assets/js/field-tools.js'))
      if (!main || !field) throw new Error('Missing ReportFlow or field tools entry')
      const core = chunkAssets(bundle, main.fileName, field.fileName)
      const publicPages = appShell.filter((path) => !path.startsWith('/assets/js/') && !path.startsWith('/assets/css/'))
      // Install is a standalone offline page. Setup and password recovery require
      // a live connection and still use their published source modules on demand.
      productionShell = [...new Set([...publicPages, '/assets/css/install.css', '/assets/js/install.js', ...core])]
      fieldShell = chunkAssets(bundle, field.fileName).filter((path) => !productionShell.includes(path))
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

      const cacheVersion = computePwaCacheVersion(buildDir, productionShell)
      writeFileSync(
        join(buildDir, 'sw.js'),
        renderServiceWorker(rootDir, { shell: productionShell, fieldShell, cacheVersion }),
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
