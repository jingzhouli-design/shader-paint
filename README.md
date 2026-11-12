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

## Phone workspace

On screens up to 700 CSS pixels wide (or touch-device landscape screens up to
980 pixels wide and 700 pixels high), the app uses a canvas-first phone layout.
This includes iPhone portrait/landscape and folded Duo touch screens.

- Brush, Layers and Effects in the bottom bar open one panel at a time. Tap
  the active button or Done to return to the full canvas. Landscape places the
  panel beside the canvas. The same controls and document data are used on PC.
- The image tool strip has visible labels. Apply and Cancel buttons let you
  finish transforms without a keyboard. Undo, redo, eraser, Fit and zoom stay
  reachable on the canvas. Transform handles have larger phone touch targets.
- Use one finger to draw and two fingers to zoom/pan, with the existing
  two-finger undo and three-finger redo taps. The "Ignore touch drawing"
  setting is still respected; turn it off in input settings for finger drawing.
- File, Import, Export and input settings remain in the compact top bar.
  Pause/Play FX is available in the editing-panel header.
  Menus and libraries fit the phone viewport; long controls scroll vertically.
  iOS safe-area insets and dynamic viewport height keep controls clear of the
  home indicator and browser chrome.
- Returning to desktop restores the original panel positions and collapse
  preferences without writing phone panel state into desktop settings.
- Desktop canvas fitting follows the responsive panel widths, rather than
  reserving a fixed 330px in narrow windows. Collapsing the brush frees that
  space for the canvas; Fit centers the full document at the new size.
  The mask-painting target label lives in brush controls, outside the zoomed
  canvas, so it cannot cover the image or grow when zooming.

## Duo dual-screen workspace

Span the browser across both screens. When the browser exposes two viewport
segments, the app places the canvas and its toolbar entirely on the first
screen and a filter-first workspace on the second. Filters use the main area;
an independently scrolling 88px layer rail stays visible at the far right.
Tap a thumbnail to change the layer and its filters. The header identifies the
current layer. Hold and drag the grip beside a thumbnail to reorder layers;
scrolling on the thumbnails or names still scrolls the rail.

The selected layer's **...** button (or **Layer settings** in the top bar)
opens its name, blend mode, opacity, mask and layer actions on demand. Tap
**Done**, outside the settings, or press Escape to dismiss. **Brush** opens
temporary brush controls without replacing the layer rail; Done, Filters,
Escape or selecting a layer returns to filters. Phone tabs and desktop panels
keep their existing layout.

The actual hinge gap is excluded, including from menus, libraries and settings.
Switching controls never shrinks the canvas.
Rotating to stacked screens puts the canvas above the controls; folding back
to one screen restores the normal responsive layout without changing the
document, undo history, or desktop panel preferences.

Automatic detection supports `window.viewport.segments`, the earlier
`visualViewport.segments`/`getWindowSegments()` APIs, and CSS viewport-segment
media queries/environment variables. Support depends on the browser and OS.
If detection is unavailable, choose **Settings > Dual-screen workspace > Duo
compatibility mode** and set **Hinge gap** in CSS pixels. This manual fallback
assumes two equal screens, starts with a 34px gap, and follows window orientation.
It activates at 900 x 500 or larger in landscape, or 500 x 900 in portrait;
smaller folded windows return to single-screen layout. Choose **Single-screen
layout** to disable spanning detection. These preferences are application
settings, not part of project files. Physical Duo testing is still recommended.

## Manual image editing

Base image and Paint layers support a Photoshop-style tool strip in the upper
left of the canvas:

- Drag image files anywhere into the app to add them above the selected layer,
  using the same flow as Import image. Multiple images import in order without
  resizing or replacing the current document. Invalid files show an error;
  internal layer/filter drag-to-reorder is unaffected.
- Brush (`B`) paints color directly only on Paint layers. On Base image layers,
  it keeps the existing mask-painting workflow. A completed marquee clips
  normal, stamp, and directional brush strokes.
- Select/Transform (`T`, `V` or `Ctrl+T`) frames the layer's nontransparent
  content (not empty canvas margins), or transforms the current marquee.
  Drag corners with the aspect ratio locked, hold `Shift` for free
  scaling, hold `Ctrl`/`Cmd` to pull one corner, and drag outside to rotate.
  `Shift` snaps rotation to 5-degree increments. Leaving Transform clears its
  selection outline. `Enter` applies the transform and returns to Brush only
  while Transform is active; polygon marquee `Enter` still closes its polygon.
  Transform handles remain visible and draggable outside the canvas, within
  the workspace. Zoom out or pan to reach handles beyond the workspace.
  Pixels moved outside the canvas are retained across further transforms,
  undo/redo, layer copies, project saves and recovery; preview and PNG export
  still use the document's original bounds. Off-canvas storage is allocated
  only when needed and released when all content returns inside the canvas.
  Excessively large transforms are rejected with a message to avoid unsafe
  image allocations.
  Undo (`Q` or `Ctrl`/`Cmd+Z`) and redo (`W` or `Ctrl`/`Cmd+Shift+Z`) include
  the current transform even before `Enter`: undo records and reverts it,
  so redo can restore it, including off-canvas pixels. A new transform after
  undo starts a new history branch; `Escape` remains an explicit cancellation.
- Run `npm test` for content-bound, off-canvas geometry and overlay-coordinate
  regression checks (Node.js built-in test runner; no extra dependencies).
- Marquee (`M`) includes rectangular, freehand lasso, and point-by-point
  polygonal selection.
- Fill (`G`) fills the whole layer or current marquee with the active paint
  color. Transform and fill operations use the existing undo/redo history.
- Layer blend modes account for the backdrop's actual alpha, so lowering a
  lower layer's opacity changes the overlap continuously.
