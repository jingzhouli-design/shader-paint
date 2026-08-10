# Shader Paint Web App

This is a standalone browser version of Shader Paint. Its interface and
browser rendering code match the current project; Electron packaging is not
included in this folder.

## Included brush library

The Web App includes all 42 PNG brushes used by the current brush panel:
Essential (4), Surface & Wear (16), Scratch Marks (6), Textured Scratches
(6), and Fabrication (10). The brush images are served from
`public/brushes/` and are loaded by the existing brush UI.

The unrelated desktop material/3D texture folders are intentionally excluded.

## Test locally

```powershell
npm install
npm run dev
```

For a production build:

```powershell
npm run build
npm run preview
```

## Deploy with GitHub Pages

Use this folder as the root of a GitHub repository. The included GitHub Actions
workflow builds and deploys the app whenever changes are pushed to `main`.

1. Create a GitHub repository with `main` as its default branch.
2. Push this folder's contents to that branch.
3. In the repository, open **Settings > Pages** and set **Source** to
   **GitHub Actions**.
4. After the workflow finishes, open the GitHub Pages URL shown in the
   deployment details.

The application is static: browser file inputs handle imports, browser
downloads handle exports, and small documents can use browser local storage.
Electron-only native dialogs, local texture folders, and desktop autosave are
intentionally unavailable in this Web App test.
