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
downloads handle exports, and project recovery uses browser IndexedDB.
Electron-only native dialogs, local texture folders, and desktop autosave are
intentionally unavailable in this Web App test.

## Offline use on iPad

Open the deployed site once while online, then use Safari's **Add to Home Screen**
command. The installed app caches its code, bundled assets, and brush library
for offline startup. Automatic project recovery uses IndexedDB, which supports
larger documents than localStorage. Keep exported `.shaderpaint` files for
important work because iPadOS may clear website storage when device space is low.
Development servers skip and remove Shader Paint's offline cache so Vite's
hot-reload module responses cannot be reused as production CSS or JavaScript.

## Rendering and memory

- Paused filters reuse results keyed by animation time and image-map revision.
  Advancing time or completing an image load invalidates the affected result.
- Mask scratch textures are allocated on the first brush operation. An unpainted
  4096 x 4096 mask avoids a 16 MiB R8 scratch texture while keeping editable mask
  data and its primary texture at full resolution.
- Hiding, deleting, or replacing a mask releases its textures and framebuffers,
  including bound-mask targets. Filter and material image loads cannot recreate
  resources after their owner is released.
- Duplicated filters and parameter-offset instances own independent GPU resources.
- Preview limits, native-resolution PNG export, iPad input controls, IndexedDB
  recovery, offline support, and the 239 bundled brushes remain unchanged.

## Manual image editing

Base image and Paint layers support a Photoshop-style tool strip in the upper
left of the canvas:

- Brush (`B`) paints color directly only on Paint layers. On Base image layers,
  it keeps the existing mask-painting workflow. A completed marquee clips
  normal, stamp, and directional brush strokes.
- Select/Transform (`V` or `Ctrl+T`) transforms the whole layer or the current
  marquee. Drag corners with the aspect ratio locked, hold `Shift` for free
  scaling, hold `Ctrl`/`Cmd` to pull one corner, and drag outside to rotate.
  `Shift` snaps rotation to 5-degree increments. Leaving Transform clears its
  selection outline.
- Marquee (`M`) includes rectangular, freehand lasso, and point-by-point
  polygonal selection.
- Fill (`G`) fills the whole layer or current marquee with the active paint
  color. Transform and fill operations use the existing undo/redo history.
- Layer blend modes account for the backdrop's actual alpha, so lowering a
  lower layer's opacity changes the overlap continuously.
