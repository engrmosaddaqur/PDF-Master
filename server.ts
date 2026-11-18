import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import JSZip from 'jszip';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'pdf-master-api' });
  });

  app.get('/api/apk/status', async (req, res) => {
    try {
      const rawRepo = typeof req.query.repo === 'string' ? req.query.repo.trim() : 'engrmosaddaqur/PDF-Master';
      const repo = rawRepo || 'engrmosaddaqur/PDF-Master';
      if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
        res.status(400).json({ error: 'Invalid repository format. Use username/repository-name.' });
        return;
      }

      const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'PDF-MASTER-App',
      };

      const [repoResp, releaseResp, runsResp] = await Promise.all([
        fetch(`https://api.github.com/repos/${repo}`, { headers }),
        fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers }),
        fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=1`, { headers }),
      ]);

      const repoExists = repoResp.ok;
      let release: {
        tag: string;
        name: string;
        publishedAt: string;
        apkUrl: string;
        apkName: string;
        apkSizeBytes: number;
      } | null = null;

      if (releaseResp.ok) {
        const relJson = (await releaseResp.json()) as {
          tag_name?: string;
          name?: string;
          published_at?: string;
          assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
        };
        const apkAsset = relJson.assets?.find((a) => a.name?.toLowerCase().endsWith('.apk'));
        if (apkAsset?.browser_download_url && apkAsset.name) {
          release = {
            tag: relJson.tag_name || 'latest',
            name: relJson.name || 'PDF MASTER APK',
            publishedAt: relJson.published_at || '',
            apkUrl: apkAsset.browser_download_url,
            apkName: apkAsset.name,
            apkSizeBytes: apkAsset.size || 0,
          };
        }
      }

      let latestRun: {
        status: string;
        conclusion: string | null;
        htmlUrl: string;
        updatedAt: string;
      } | null = null;

      if (runsResp.ok) {
        const runsJson = (await runsResp.json()) as {
          workflow_runs?: Array<{
            status?: string;
            conclusion?: string | null;
            html_url?: string;
            updated_at?: string;
          }>;
        };
        const first = runsJson.workflow_runs?.[0];
        if (first?.status && first.html_url) {
          latestRun = {
            status: first.status,
            conclusion: first.conclusion ?? null,
            htmlUrl: first.html_url,
            updatedAt: first.updated_at || '',
          };
        }
      }

      res.json({
        repo,
        repoExists,
        release,
        latestRun,
        directFallbackUrl: `https://github.com/${repo}/releases/latest/download/PDF-Master.apk`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to check GitHub APK status.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/apk/project-zip', async (req, res) => {
    try {
      const rawRepo = typeof req.query.repo === 'string' ? req.query.repo.trim() : 'engrmosaddaqur/PDF-Master';
      const repo = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(rawRepo)
        ? rawRepo
        : 'engrmosaddaqur/PDF-Master';

      const zip = new JSZip();
      const skipDirs = new Set(['node_modules', 'dist', 'dev-dist', '.git', 'android', 'build', 'coverage']);
      const skipFiles = new Set(['.env', '.env.local', '.DS_Store', 'bun.lock']);

      const walkDir = async (dirPath: string, relBase: string) => {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const fullPath = path.join(dirPath, entry.name);
          const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) continue;
            await walkDir(fullPath, relPath);
          } else if (entry.isFile()) {
            if (skipFiles.has(entry.name) || entry.name.endsWith('.apk') || entry.name.endsWith('.log')) {
              continue;
            }
            const content = await fs.promises.readFile(fullPath);
            zip.file(relPath, content);
          }
        }
      };

      await walkDir(__dirname, '');

      const winPushScript = `@echo off
setlocal
echo ============================================
echo   PDF MASTER - 1-Click GitHub APK Builder
echo ============================================
echo.
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not installed. Download Git from https://git-scm.com/downloads
  pause
  exit /b 1
)
set REPO=${repo}
set /p INPUT_REPO="GitHub repo [%REPO%]: "
if not "%INPUT_REPO%"=="" set REPO=%INPUT_REPO%

if not exist ".git" (
  git init
)
git add -A
git diff --cached --quiet || git commit -m "Build PDF MASTER Android APK"
git branch -M main
git remote remove origin >nul 2>nul
git remote add origin https://github.com/%REPO%.git
echo.
echo Pushing to https://github.com/%REPO%.git ...
git push -u origin main --force
if errorlevel 1 (
  echo.
  echo [INFO] Make sure https://github.com/new?name=PDF-Master exists and you signed in to GitHub.
  pause
  exit /b 1
)
echo.
echo [SUCCESS] Push complete! GitHub Actions is now building PDF-Master.apk (~2-3 minutes).
echo Download link once complete:
echo https://github.com/%REPO%/releases/latest/download/PDF-Master.apk
pause
`;

      const unixPushScript = `#!/usr/bin/env bash
set -euo pipefail
REPO="\${1:-${repo}}"
echo "============================================"
echo "  PDF MASTER - 1-Click GitHub APK Builder"
echo "============================================"
if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is not installed."
  exit 1
fi
if [ ! -d ".git" ]; then
  git init
fi
git add -A
if ! git diff --cached --quiet; then
  git commit -m "Build PDF MASTER Android APK"
fi
git branch -M main
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/$REPO.git"
git push -u origin main --force
echo ""
echo "Push complete! GitHub Actions is building PDF-Master.apk (~2-3 minutes)."
echo "APK URL: https://github.com/$REPO/releases/latest/download/PDF-Master.apk"
`;

      const unixLocalBuild = `#!/usr/bin/env bash
set -euo pipefail
npm install
npm run build
if [ ! -d "android" ]; then
  npx cap add android
fi
npx cap sync android
cd android
chmod +x gradlew
./gradlew assembleDebug --no-daemon
cp app/build/outputs/apk/debug/app-debug.apk ../PDF-Master.apk
echo "APK built at: ../PDF-Master.apk"
`;

      const winLocalBuild = `@echo off
setlocal
call npm install || exit /b 1
call npm run build || exit /b 1
if not exist "android" (
  call npx cap add android || exit /b 1
)
call npx cap sync android || exit /b 1
cd android
call gradlew.bat assembleDebug --no-daemon || exit /b 1
copy /y app\\build\\outputs\\apk\\debug\\app-debug.apk ..\\PDF-Master.apk
echo APK built at PDF-Master.apk
pause
`;

      zip.file('1-CLICK-GITHUB-APK.bat', winPushScript);
      zip.file('1-CLICK-GITHUB-APK.sh', unixPushScript, { unixPermissions: '755' });
      zip.file('BUILD-LOCAL-APK.sh', unixLocalBuild, { unixPermissions: '755' });
      zip.file('BUILD-LOCAL-APK.bat', winLocalBuild);

      const buffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="PDF-Master-Android-APK-Kit.zip"'
      );
      res.setHeader('Content-Length', String(buffer.length));
      res.send(buffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to generate project ZIP.';
      res.status(500).json({ error: message });
    }
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.get('/@vite/client', (_req, res) => {
      res.type('application/javascript').send(`const sheetsMap = new Map();
export function updateStyle(id, content) {
  if (typeof document === 'undefined') return;
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  if (typeof document === 'undefined') return;
  const style = sheetsMap.get(id);
  if (style && style.parentNode) {
    style.parentNode.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) { return url; }
const BaseHTMLElement = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};
export class ErrorOverlay extends BaseHTMLElement {}
`);
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PDF MASTER server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start PDF MASTER server:', err);
  process.exit(1);
});
