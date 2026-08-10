# ShaderPaintIpad

This is a standalone browser version of Shader Paint prepared for iPad UI
work. It can be moved out of the parent project without requiring Electron,
the parent `Texture` directory, or any other parent-project files.

## Included brush library

The Web App includes every currently supported image in the source `Texture`
brush library: 239 brushes across 11 groups. The images and their portable
`brush-library.json` manifest are served from `public/brushes/` and loaded by
the existing brush UI.

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
