import * as THREE from "three";
import { FILTER_DEFS, defaultParamsFor, evalGradientAt, fragmentShaderForPass, normalizeGradientValue } from "./filter-library.js";

let DOC_WIDTH = 1200;
let DOC_HEIGHT = 900;
const STORAGE_KEY = "shaderpaint:document:v1";
const STORAGE_METADATA_KEY = "shaderpaint:document:autosave-status:v1";
const MAX_HISTORY_SNAPSHOTS = 40;
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
const MIN_HISTORY_SNAPSHOTS = 3;
const MASK_HISTORY_TILE_SIZE = 64;
const MAX_PAINT_DABS_PER_BATCH = 64;
const PAINT_BRUSH_SPACING_RATIO = 0.05;
const MAX_LOCAL_AUTOSAVE_CHARACTERS = 2_000_000;
const AUTOSAVE_IDLE_DELAY_MS = 4000;
const FILTER_MENU_DRAG_DELAY_MS = 260;
const FILTER_MENU_DEFAULT_CATEGORY_ORDER = ["Color", "Distort", "Blur", "Effect", "Generate"];
const FILTER_CATEGORY_ICONS = {
  "All filters": `<svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h10"/><circle cx="5" cy="4" r=".8"/><circle cx="11" cy="8" r=".8"/><circle cx="7" cy="12" r=".8"/></svg>`,
  Color: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11M2.5 8h11"/></svg>`,
  Distort: `<svg viewBox="0 0 16 16"><path d="M3 4c3 0 2 3 5 3s2-3 5-3M3 12c3 0 2-3 5-3s2 3 5 3"/></svg>`,
  Blur: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" opacity="0.9"/><circle cx="8" cy="8" r="5.4" opacity="0.4"/><circle cx="8" cy="8" r="7" opacity="0.18"/></svg>`,
  Effect: `<svg viewBox="0 0 16 16"><path d="m8 2 .9 3.1L12 6l-3.1.9L8 10l-.9-3.1L4 6l3.1-.9z"/><path d="m12 10 .4 1.6L14 12l-1.6.4L12 14l-.4-1.6L10 12l1.6-.4z"/></svg>`,
  Generate: `<svg viewBox="0 0 16 16"><path d="M2.5 11.5h11M2.5 8h11M2.5 4.5h11"/><circle cx="5" cy="4.5" r=".9"/><circle cx="10.5" cy="8" r=".9"/><circle cx="7" cy="11.5" r=".9"/></svg>`,
};
const DEFAULT_IMAGE_URL = new URL("./assets/default.png", import.meta.url).href;
const heldCanvasShortcutCodes = new Set();
const EMPTY_IMAGE_DATA_URL = (() => {
  const empty = document.createElement("canvas");
  empty.width = 1;
  empty.height = 1;
  return empty.toDataURL("image/png");
})();

const BLEND_MODE_CODES = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  softlight: 4,
  add: 5,
  difference: 6,
  hue: 7,
  color: 8,
};

const canvas = document.getElementById("paintCanvas");
const canvasStage = document.getElementById("canvasStage");
const canvasWrap = document.getElementById("canvasWrap");
const canvasEmpty = document.getElementById("canvasEmpty");
const layerList = document.getElementById("layerList");
const filterList = document.getElementById("filterList");
const filterMenu = document.getElementById("filterMenu");
const filterPanelTitle = document.getElementById("filterPanelTitle");
const adjustmentRangeSettings = document.getElementById("adjustmentRangeSettings");
const filterRatioToggle = document.getElementById("filterRatioToggle");
const filterMatchRatio = document.getElementById("filterMatchRatio");
const filterAddWrap = document.getElementById("filterAddWrap");
const materialPanelTabs = document.getElementById("materialPanelTabs");
const blendMode = document.getElementById("blendMode");
const blendSelectTrigger = document.getElementById("blendSelectTrigger");
const blendSelectLabel = document.getElementById("blendSelectLabel");
const blendSelectMenu = document.getElementById("blendSelectMenu");
const newLayerMenu = document.getElementById("newLayerMenu");
const layerOpacity = document.getElementById("layerOpacity");
const layerOpacityNumber = document.getElementById("layerOpacityNumber");
const brushSize = document.getElementById("brushSize");
const brushSizeNumber = document.getElementById("brushSizeNumber");
const brushOpacity = document.getElementById("brushOpacity");
const brushOpacityNumber = document.getElementById("brushOpacityNumber");
const brushEdgeBlend = document.getElementById("brushEdgeBlend");
const brushEdgeBlendNumber = document.getElementById("brushEdgeBlendNumber");
const brushValue = document.getElementById("brushValue");
const brushValueNumber = document.getElementById("brushValueNumber");
const brushModeButtons = document.getElementById("brushModeButtons");
const brushPreview = document.getElementById("brushPreview");
const brushCursor = document.getElementById("brushCursor");
const brushPreviewDot = document.getElementById("brushPreviewDot");
const paintColorPanel = document.getElementById("paintColorPanel");
const paintHueWheel = document.getElementById("paintHueWheel");
const paintColorSquare = document.getElementById("paintColorSquare");
const eyedropperIndicator = document.getElementById("eyedropperIndicator");
document.body.append(eyedropperIndicator);
const paintColorPanelHome = {
  parent: paintColorPanel.parentElement,
  nextSibling: paintColorPanel.nextSibling,
};
const brushLibrary = document.getElementById("brushLibrary");
const brushGrid = document.getElementById("brushGrid");
const brushLibraryPreview = document.getElementById("brushLibraryPreview");
const brushLibraryName = document.getElementById("brushLibraryName");
const brushLibraryDescription = document.getElementById("brushLibraryDescription");
const maskModeBadge = document.getElementById("maskModeBadge");
const filterPreview = document.getElementById("filterPreview");
const motionButton = document.getElementById("motionButton");
const motionButtonLabel = document.getElementById("motionButtonLabel");
const motionButtonIcon = document.getElementById("motionButtonIcon");
const imageInput = document.getElementById("imageInput");
const projectInput = document.getElementById("projectInput");
const projectLibraryTrigger = document.getElementById("projectLibraryTrigger");
const documentName = document.getElementById("documentName");
const saveStatusButton = document.getElementById("saveStatusButton");
const exportMenuTrigger = document.getElementById("exportMenuTrigger");
const exportMenuPanel = document.getElementById("exportMenuPanel");
const toast = document.getElementById("toast");
const materialLibrary = document.getElementById("materialLibrary");
const materialLibraryGrid = document.getElementById("materialLibraryGrid");
const materialLibraryTitle = document.getElementById("materialLibraryTitle");
const materialLibraryEmpty = document.getElementById("materialLibraryEmpty");
const projectLibrary = document.getElementById("projectLibrary");
const recentProjectsGrid = document.getElementById("recentProjectsGrid");
const recentProjectsEmpty = document.getElementById("recentProjectsEmpty");
const settingsPanel = document.getElementById("settingsPanel");
const projectAutosaveEnabled = document.getElementById("projectAutosaveEnabled");
const projectAutosaveInterval = document.getElementById("projectAutosaveInterval");
const ignoreTouchDraw = document.getElementById("ignoreTouchDraw");
const pressureSizeMinimum = document.getElementById("pressureSizeMinimum");
const pressureSizeMinimumNumber = document.getElementById("pressureSizeMinimumNumber");
const pressureSizeCurveToggle = document.getElementById("pressureSizeCurveToggle");
const pressureSizeCurve = document.getElementById("pressureSizeCurve");
const pressureSizeResponse = document.getElementById("pressureSizeResponse");
const pressureSizeResponseNumber = document.getElementById("pressureSizeResponseNumber");
const pressureSizeCurvePreview = document.getElementById("pressureSizeCurvePreview");
const pressureOpacityMinimum = document.getElementById("pressureOpacityMinimum");
const pressureOpacityMinimumNumber = document.getElementById("pressureOpacityMinimumNumber");
const pressureOpacityCurveToggle = document.getElementById("pressureOpacityCurveToggle");
const pressureOpacityCurve = document.getElementById("pressureOpacityCurve");
const pressureOpacityResponse = document.getElementById("pressureOpacityResponse");
const pressureOpacityResponseNumber = document.getElementById("pressureOpacityResponseNumber");
const pressureOpacityCurvePreview = document.getElementById("pressureOpacityCurvePreview");
const PROJECT_SETTINGS_KEY = "shaderpaint:settings:v1";

const BLEND_MODE_LABELS = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  softlight: "Soft Light",
  add: "Add",
  difference: "Difference",
  hue: "Hue",
  color: "Color",
};

let BRUSH_PRESETS = [
  { id: "soft-round", group: "basic", name: "Soft Airbrush", description: "Clean pressure-shaped feathering for broad blends and controlled buildup.", style: "soft", seed: 11 },
  { id: "hard-round", group: "basic", name: "Hard Surface", description: "Antialiased solid coverage for decals, seams, and precise material boundaries.", style: "hard", seed: 17 },
  { id: "rough-feather", group: "basic", name: "Worn Edge", description: "Broken perimeter with fine surface dropout for naturally abraded boundaries.", style: "rough", seed: 19 },
  { id: "ragged-round", group: "basic", name: "Chipped Edge", description: "Layered flakes and irregular edge loss for damaged coatings and paint masks.", style: "ragged", seed: 21 },
  { id: "pencil-grain", group: "material", name: "Fine Surface Dust", description: "Multi-scale dry particulate for subtle shelf dust and powder residue.", style: "pencil", seed: 23 },
  { id: "charcoal", group: "material", name: "Heavy Industrial Grunge", description: "Large connected deposits with crisp secondary breakup for machinery and floors.", style: "charcoal", seed: 29 },
  { id: "dry-brush", group: "material", name: "Dragged Dirt", description: "Directional streaks interrupted by dry gaps for wiped oil, soot, and residue.", style: "dry", seed: 31 },
  { id: "ink-bleed", group: "material", name: "Oil Smear", description: "Dense greasy center, translucent drag, and pooled edge for lubricant staining.", style: "ink", seed: 37 },
  { id: "spatter", group: "material", name: "Corrosion Pits", description: "Irregular multi-size cavities for rust nucleation and chemical pitting.", style: "spatter", seed: 43 },
  { id: "bristle-fan", group: "material", name: "Directional Abrasion", description: "Broken parallel wear lines for sanded edges, handling wear, and scuffing.", style: "bristle", seed: 47 },
  { id: "flat-marker", group: "material", name: "Coating Flakes", description: "Connected opaque islands with fractured margins for peeling paint and plating.", style: "marker", seed: 53 },
  { id: "scratch", group: "material", name: "Scratch Cluster", description: "Mixed-width scored lines with interrupted lengths and secondary micro-scratches.", style: "scratch", seed: 59 },
  { id: "cloud", group: "material", name: "Dust Buildup", description: "Soft low-frequency accumulation with granular edges for protected recesses.", style: "cloud", seed: 61 },
  { id: "stipple", group: "material", name: "Concrete Pores", description: "Rounded aggregate voids and pinholes with natural size variation.", style: "stipple", seed: 67 },
  { id: "fur", group: "material", name: "Loose Fibers", description: "Short broken filaments for frayed textile, insulation, and composite surfaces.", style: "fur", seed: 71 },
  { id: "square", group: "material", name: "Woven Fabric", description: "Readable over-under warp and weft structure for cloth and technical webbing.", style: "square", seed: 73 },
  { id: "noise-field", group: "material", name: "Leather Grain", description: "Cellular pebble grain with compressed valleys for leather and molded polymer.", style: "noise", seed: 79 },
  { id: "watercolor", group: "material", name: "Mineral Deposit", description: "Uneven tide rings and crystalline residue for water, salt, and coolant marks.", style: "watercolor", seed: 41 },
  { id: "bloom-wash", group: "material", name: "Heat Scorch", description: "Broken concentric heat-affected bands for welds, exhausts, and hot fasteners.", style: "bloom", seed: 83 },
  { id: "torn-paper", group: "material", name: "Peeling Coating", description: "Broad sheet-like loss with curled fractured edges and isolated remaining chips.", style: "torn", seed: 89 },
  { id: "fine-lines", group: "stylized", name: "Fine Machining Lines", description: "Tight antialiased tool marks for turned, milled, and precision-finished metal.", style: "lineFine", seed: 97 },
  { id: "wide-lines", group: "stylized", name: "Brushed Metal", description: "Mixed-width directional striations with natural interruptions and drag variation.", style: "lineWide", seed: 101 },
  { id: "crosshatch", group: "stylized", name: "Knurled Metal", description: "Crossed diagonal tooling ridges for grips, knobs, and machined handles.", style: "crosshatch", seed: 103 },
  { id: "fine-grid", group: "stylized", name: "Wire Mesh", description: "Fine woven orthogonal mesh with clean, scale-stable intersections.", style: "gridFine", seed: 107 },
  { id: "bold-grid", group: "stylized", name: "Expanded Metal", description: "Industrial diamond lattice for vents, guards, walkways, and enclosures.", style: "gridBold", seed: 109 },
  { id: "dot-matrix", group: "stylized", name: "Perforated Sheet", description: "Even circular punch pattern with crisp hole edges for fabricated panels.", style: "dotMatrix", seed: 113 },
  { id: "micro-dots", group: "stylized", name: "Micro Perforation", description: "Dense precision hole field for acoustic panels, filters, and speaker grilles.", style: "microDots", seed: 119 },
  { id: "sparse-dots", group: "stylized", name: "Rivet Heads", description: "Large raised fastener pattern with readable center and rim definition.", style: "sparseDots", seed: 121 },
  { id: "offset-dots", group: "stylized", name: "Staggered Rivets", description: "Offset fastener rows for aircraft skin, tanks, ducts, and sheet assemblies.", style: "offsetDots", seed: 123 },
  { id: "chevron", group: "stylized", name: "Tread Plate", description: "Raised directional lugs for industrial anti-slip plate and molded rubber.", style: "chevron", seed: 127 },
  { id: "scratch-gouges", group: "scratchMarks", name: "Long Gouges", description: "A complete cluster of long, uneven parallel cuts with chipped starts and tapered spacing.", style: "scratchGouges", seed: 131 },
  { id: "scratch-claw", group: "scratchMarks", name: "Claw Drag", description: "Four hooked, converging scars shaped as one directional claw-drag stamp.", style: "scratchClaw", seed: 137 },
  { id: "scratch-cross", group: "scratchMarks", name: "Cross Scuff", description: "Overlapping diagonal scoring with shorter secondary cuts and a clear central impact.", style: "scratchCross", seed: 139 },
  { id: "scratch-crack", group: "scratchMarks", name: "Branch Crack", description: "A complete branching fracture with a heavy trunk and fine angular offshoots.", style: "scratchCrack", seed: 149 },
  { id: "scratch-sweep", group: "scratchMarks", name: "Swept Scrape", description: "Layered curved drag marks forming a broad, directional crescent-shaped scrape.", style: "scratchSweep", seed: 151 },
  { id: "scratch-impact", group: "scratchMarks", name: "Impact Burst", description: "Radial scored fragments extending from a compact chipped impact center.", style: "scratchImpact", seed: 157 },
  { id: "texture-paint-scrape", group: "texturedScratch", name: "Paint Scrape", description: "A broad dragged paint failure with torn edges, exposed islands, scoring, and loose chips.", style: "texturePaintScrape", seed: 163 },
  { id: "texture-rust-gouge", group: "texturedScratch", name: "Rust Gouge", description: "Deep corroded damage with a dense scored core, porous oxidation, and granular fallout.", style: "textureRustGouge", seed: 167 },
  { id: "texture-dry-drag", group: "texturedScratch", name: "Dry Drag", description: "A wide directional scrape built from broken dry streaks, powder gaps, and trailing debris.", style: "textureDryDrag", seed: 173 },
  { id: "texture-splinter-tear", group: "texturedScratch", name: "Splinter Tear", description: "A jagged wedge-shaped tear with fibrous splits, fractured plates, and sharp loose fragments.", style: "textureSplinterTear", seed: 179 },
  { id: "texture-oxidized-scuff", group: "texturedScratch", name: "Oxidized Scuff", description: "Layered elliptical abrasion with a crusted rim, mottled interior, and clustered corrosion pits.", style: "textureOxidizedScuff", seed: 181 },
  { id: "texture-heavy-score", group: "texturedScratch", name: "Heavy Score", description: "A thick mechanical score with raised burr edges, a broken central trench, and metal debris.", style: "textureHeavyScore", seed: 191 },
];

const BRUSH_STYLE_CODES = Object.fromEntries(
  [...new Set(BRUSH_PRESETS.map((preset) => preset.style))].map((style, index) => [style, index]),
);

let BRUSH_GROUPS = [
  { id: "basic", label: "Essential" },
  { id: "material", label: "Surface & Wear" },
  { id: "scratchMarks", label: "Scratch Marks" },
  { id: "texturedScratch", label: "Textured Scratches" },
  { id: "stylized", label: "Fabrication" },
];
const LEGACY_BRUSH_PRESETS = Object.freeze([...BRUSH_PRESETS]);

window.addEventListener("error", (event) => {
  console.error("[Shader Paint error]", event.error?.stack || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[Shader Paint unhandled rejection]", event.reason?.stack || event.reason);
});

const gl = canvas.getContext("webgl2", {
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
  premultipliedAlpha: false,
});
const INTERACTIVE_RENDER_MAX_DIMENSION = 2048;
const TRANSFORM_INTERACTIVE_RENDER_MAX_DIMENSION = 1024;
const TRANSFORM_PREVIEW_MAX_DIMENSION = 768;

if (!gl) {
  canvasEmpty.innerHTML = "<strong>WebGL2 is unavailable</strong><span>Shader Paint needs a modern GPU-enabled browser.</span>";
  throw new Error("WebGL2 is required to run Shader Paint.");
}

function getAdjustmentStartLayer(layer) {
  const adjustmentIndex = state.layers.indexOf(layer);
  if (adjustmentIndex <= 0) return null;
  const requestedIndex = state.layers.findIndex((item) => item.id === layer.adjustmentStartLayerId);
  if (requestedIndex >= 0 && requestedIndex < adjustmentIndex - 1) return state.layers[requestedIndex];
  return state.layers[adjustmentIndex - 1];
}

function hasCustomAdjustmentStart(layer) {
  const adjustmentIndex = state.layers.indexOf(layer);
  const targetIndex = state.layers.findIndex((item) => item.id === layer.adjustmentStartLayerId);
  return layer.kind === "adjustment" && targetIndex >= 0 && targetIndex < adjustmentIndex - 1;
}

function normalizeAdjustmentStarts() {
  state.layers.forEach((layer) => {
    if (layer.kind !== "adjustment" || !layer.adjustmentStartLayerId) return;
    const adjustmentIndex = state.layers.indexOf(layer);
    const targetIndex = state.layers.findIndex((item) => item.id === layer.adjustmentStartLayerId);
    if (targetIndex < 0 || targetIndex >= adjustmentIndex - 1) layer.adjustmentStartLayerId = null;
  });
}

function releaseMaterialMapTextures(layer) {
  ["colorMap", "normalMap", "roughnessMap", "metalnessMap"].forEach((key) => {
    const textureKey = `_${key}Texture`;
    const urlKey = `_${key}TextureUrl`;
    if (layer[textureKey]) gl.deleteTexture(layer[textureKey]);
    layer[textureKey] = null;
    layer[urlKey] = null;
  });
}

function releaseHiddenLayerTextures(layer) {
  if (layer.sourceTexture) gl.deleteTexture(layer.sourceTexture);
  layer.sourceTexture = null;
  if (layer.paintScratchTexture) gl.deleteTexture(layer.paintScratchTexture);
  if (layer.paintFramebuffer) gl.deleteFramebuffer(layer.paintFramebuffer);
  if (layer.paintScratchFramebuffer) gl.deleteFramebuffer(layer.paintScratchFramebuffer);
  layer.paintScratchTexture = null;
  layer.paintFramebuffer = null;
  layer.paintScratchFramebuffer = null;
  destroyLayerFilterCache(layer);
  if (layer.mask?.texture) gl.deleteTexture(layer.mask.texture);
  if (layer.mask) layer.mask.texture = null;
  if (layer.mask?.scratchTexture) gl.deleteTexture(layer.mask.scratchTexture);
  if (layer.mask) layer.mask.scratchTexture = null;
  if (layer.kind === "material") releaseMaterialMapTextures(layer);
}

function ensureLayerGpuTextures(layer) {
  if (!layer.sourceTexture && layer.sourceCanvas) layer.sourceTexture = textureFromCanvas(layer.sourceCanvas);
  if (layer.mask && !layer.mask.texture) {
    createMaskGpuTextures(layer.mask, layer.mask.data);
  }
}
function anchorFloatingColorPicker(pointerX, pointerY) {
  const panelRect = paintColorPanel.getBoundingClientRect();
  const squareRect = paintColorSquare.getBoundingClientRect();
  const markerX = squareRect.left - panelRect.left + state.paintColor.s * squareRect.width;
  const markerY = squareRect.top - panelRect.top + (1 - state.paintColor.v) * squareRect.height;
  paintColorPanel.style.left = `${pointerX - markerX}px`;
  paintColorPanel.style.top = `${pointerY - markerY}px`;
}

gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.disable(gl.DEPTH_TEST);
gl.disable(gl.BLEND);

const state = {
  layers: [],
  selectedLayerId: null,
  selectionPart: "mask",
  effectsPaused: true,
  motionTime: 0,
  lastMotionTimestamp: performance.now(),
  lastAnimatedRender: 0,
  brush: {
    size: 96, opacity: 0.72, edgeBlend: 0, value: 1, presetId: "soft-round", mode: "normal",
  },
  paintColor: { h: 18, s: 0.62, v: 0.84 },
  lastPointer: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  dPicker: { downAt: 0, wasOpen: false },
  colorPickerFloating: false,
  blendPreviewMode: null,
  filterMenuCategory: "All filters",
  filterMenuCategoryOrder: [],
  filterMenuFilterOrders: {},
  filterMenuDrag: null,
  filterMenuIgnoreClick: false,
  gradientStopDrag: null,
  maskSettingsLayerId: null,
  maskClipboard: null,
  filterClipboard: null,
  documentName: "Shader Paint",
  projectFilePath: null,
  projectSaveStatus: "unsaved",
  projectAutosave: { enabled: false, intervalSeconds: 60 },
  ipad: { ignoreTouchDraw: false, layersCollapsed: false, filtersCollapsed: false, brushPanelPosition: null },
  pressure: {
    sizeMinimum: 0.32,
    sizeResponse: 1,
    opacityMinimum: 0.2,
    opacityResponse: 1,
    sizeCurveExpanded: false,
    opacityCurveExpanded: false,
  },
  projectAutosaveTimer: 0,
  zoom: 80,
  viewport: { x: 0, y: 0 },
  renderQueued: false,
  paintPointerId: null,
  panPointerId: null,
  panStart: null,
  spacePressed: false,
  sizeAdjustPressed: false,
  sizeAdjustPointerId: null,
  sizeAdjustStart: null,
  eraserPressed: false,
  eraserToggled: false,
  touchPointers: new Map(),
  touchGesture: null,
  pencilHover: null,
  touchBrushAdjust: null,
  transformStroke: null,
  paintTransformStroke: null,
  paintingLayerContent: false,
  pendingMaskDabs: [],
  pendingMaskLayerId: null,
  pendingMaskTarget: null,
  pendingPaintDabs: [],
  pendingPaintLayerId: null,
  pendingPaintColor: null,
  pendingPaintErase: false,
  pendingPaintStyle: 0,
  pendingPaintSeed: 0,
  lastPaintPoint: null,
  paintStrokeDirty: null,
  paintStrokeHistory: null,
  newDocumentPending: false,
  strokePoints: [],
  saveTimer: 0,
  viewportSaveTimer: 0,
  toastTimer: 0,
  localAutosaveDisabled: false,
  localAutosaveRetryLimit: MAX_LOCAL_AUTOSAVE_CHARACTERS,
  localAutosaveWarningShown: false,
  desktopAutosaveRequestedVersion: 0,
  desktopAutosaveSavedVersion: 0,
  desktopAutosaveWriting: false,
  desktopAutosavePromise: Promise.resolve(),
  desktopAutosaveWarningShown: false,
  history: [],
  historyIndex: -1,
  historyBytes: 0,
  strokeHistory: null,
  filterEditOrigins: new WeakMap(),
  pendingMaskUploads: new Map(),
  gpuMaskStrokeLayerId: null,
  restoringHistory: false,
  materialLibrary: [],
  materialLibraryMessage: "",
  materialLibraryLoadingItemId: null,
  recentProjects: [],
  materialPanelTab: "material",
  hoveredAdjustmentLayerId: null,
};

const gpu = {
  vao: gl.createVertexArray(),
  passPrograms: new Map(),
  compositeProgram: null,
  displayProgram: null,
  materialProgram: null,
  heightProgram: null,
  maskBrushProgram: null,
  maskTransformProgram: null,
  paintBrushProgram: null,
  paintTransformProgram: null,
  filterTargets: [],
  alphaLockTarget: null,
  compositeTargets: [],
  rangeCompositeTargets: [],
  materialTarget: null,
  heightTarget: null,
  heightMeshes: new Map(),
  thumbnailTarget: null,
  whiteMask: null,
  transparentTexture: null,
  flatNormal: null,
  blackRoughness: null,
  blackMetalness: null,
};

const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BRUSH_PATTERN_GLSL = `
float brushHash(vec2 p, float seed) {
  return fract(sin((p.x * 12.9898 + p.y * 78.233 + seed * 37.719) * 0.013) * 43758.5453);
}
float brushNoise(vec2 p, float seed) {
  vec2 cell = floor(p);
  vec2 blend = fract(p);
  blend = blend * blend * (3.0 - 2.0 * blend);
  float a = brushHash(cell, seed);
  float b = brushHash(cell + vec2(1.0, 0.0), seed);
  float c = brushHash(cell + vec2(0.0, 1.0), seed);
  float d = brushHash(cell + vec2(1.0), seed);
  return mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
}
float brushFbm(vec2 p, float seed) {
  float value = 0.0;
  float weight = 0.58;
  for (int octave = 0; octave < 3; octave++) {
    value += brushNoise(p, seed + float(octave) * 17.0) * weight;
    p = mat2(1.72, -1.08, 1.08, 1.72) * p + 7.13;
    weight *= 0.5;
  }
  return value / 1.015;
}
float brushLine(float phase, float width) {
  float wave = abs(sin(phase));
  return 1.0 - smoothstep(width, width + 0.055, wave);
}
float brushCellDot(vec2 local, float density, float radius, float seed, float jitter) {
  vec2 grid = local * density;
  vec2 cellId = floor(grid + 0.5);
  vec2 offset = vec2(
    brushHash(cellId, seed),
    brushHash(cellId.yx + 19.7, seed + 11.0)
  ) - 0.5;
  float cellDistance = length(grid - cellId - offset * jitter);
  return 1.0 - smoothstep(radius, radius + 0.055, cellDistance);
}
float brushSegment(vec2 p, vec2 a, vec2 b, float width) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  float segmentDistance = length(pa - ba * h);
  float aa = max(fwidth(segmentDistance) * 1.35, 0.009);
  return 1.0 - smoothstep(width, width + aa, segmentDistance);
}
float brushStrength(int style, vec2 local, float distanceToCenter, float seed) {
  float radial = max(0.0, 1.0 - distanceToCenter);
  float angle = atan(local.y, local.x);
  float edgeAa = max(fwidth(distanceToCenter) * 1.5, 0.008);
  float disc = 1.0 - smoothstep(1.0 - edgeAa, 1.0, distanceToCenter);
  if (style == 0) return pow(max(0.0, 1.0 - distanceToCenter * distanceToCenter), 2.0);
  if (style == 1) return disc;
  if (style == 2) {
    vec2 edgeUv = vec2(cos(angle), sin(angle)) * 4.5;
    float edge = 0.79 + brushFbm(edgeUv, seed) * 0.2;
    float body = 1.0 - smoothstep(edge - 0.045, edge + 0.025, distanceToCenter);
    float abrasion = smoothstep(0.42, 0.69, brushFbm(local * 10.0, seed + 5.0));
    return body * mix(0.28, 1.0, abrasion);
  }
  if (style == 3) {
    vec2 edgeUv = vec2(cos(angle), sin(angle)) * 6.5;
    float edge = 0.68 + brushFbm(edgeUv, seed) * 0.29;
    float shell = 1.0 - smoothstep(edge - 0.035, edge + 0.02, distanceToCenter);
    float flakes = smoothstep(0.37, 0.61, brushFbm(local * 6.0, seed + 13.0));
    float chips = smoothstep(0.54, 0.73, brushNoise(local * 19.0, seed + 3.0));
    return shell * max(flakes, chips * 0.72);
  }
  if (style == 4) {
    float cloud = smoothstep(0.38, 0.64, brushFbm(local * 7.0, seed));
    float particulate = smoothstep(0.56, 0.78, brushNoise(local * 29.0, seed + 7.0));
    return pow(radial, 0.72) * max(cloud * 0.62, particulate);
  }
  if (style == 5) {
    float deposits = smoothstep(0.28, 0.55, brushFbm(local * 3.3, seed));
    float breakup = smoothstep(0.38, 0.7, brushFbm(local * 11.0, seed + 9.0));
    return pow(radial, 0.5) * deposits * mix(0.55, 1.0, breakup);
  }
  if (style == 6) {
    float streaks = smoothstep(0.43, 0.61, brushNoise(vec2(local.x * 1.7, local.y * 22.0), seed));
    float breaks = smoothstep(0.35, 0.62, brushFbm(vec2(local.x * 5.0, local.y * 1.5), seed + 4.0));
    return pow(radial, 0.72) * streaks * breaks;
  }
  if (style == 7) {
    float smear = 0.3 + brushFbm(vec2(local.x * 3.0, local.y * 7.0), seed) * 0.7;
    float pooled = 1.0 - smoothstep(0.055, 0.12, abs(distanceToCenter - (0.67 + brushNoise(local * 4.0, seed) * 0.08)));
    return pow(radial, 0.32) * clamp(smear * 0.76 + pooled * 0.55, 0.0, 1.0);
  }
  if (style == 8) {
    float pits = brushCellDot(local, 5.0, 0.27, seed, 0.68);
    pits = max(pits, brushCellDot(local, 11.0, 0.16, seed + 17.0, 0.72) * 0.82);
    float gate = smoothstep(0.28, 0.62, brushFbm(local * 3.0, seed + 5.0));
    return disc * pits * gate;
  }
  if (style == 9) {
    float row = floor(local.y * 15.0 + 0.5);
    float width = 0.2 + brushHash(vec2(row, 3.0), seed) * 0.22;
    float line = brushLine(local.y * 47.1, width);
    float broken = smoothstep(0.28, 0.5, brushNoise(vec2(local.x * 8.0, row * 0.21), seed + 8.0));
    return pow(radial, 0.58) * line * broken;
  }
  if (style == 10) {
    float islands = smoothstep(0.31, 0.57, brushFbm(local * 4.8, seed));
    float fracture = smoothstep(0.4, 0.66, brushNoise(local * 17.0, seed + 5.0));
    return disc * islands * mix(0.48, 1.0, fracture);
  }
  if (style == 11) {
    float primary = brushLine(local.y * 43.0 + local.x * 5.0, 0.26);
    float secondary = brushLine(local.y * 79.0 - local.x * 3.5, 0.16) * 0.7;
    float lengths = smoothstep(0.25, 0.5, brushNoise(vec2(local.x * 7.0, floor(local.y * 17.0)), seed));
    return pow(radial, 0.62) * max(primary, secondary) * lengths;
  }
  if (style == 12) {
    float body = smoothstep(0.26, 0.66, brushFbm(local * 2.6, seed));
    float grain = brushNoise(local * 18.0, seed + 9.0);
    return pow(radial, 0.48) * body * mix(0.56, 1.0, grain);
  }
  if (style == 13) {
    float pores = brushCellDot(local, 7.0, 0.25, seed, 0.78);
    pores = max(pores, brushCellDot(local, 14.0, 0.13, seed + 23.0, 0.85) * 0.72);
    return disc * pores;
  }
  if (style == 14) {
    float fibers = brushLine(local.y * 58.0 + local.x * 9.0, 0.27);
    float fragments = smoothstep(0.32, 0.55, brushNoise(vec2(local.x * 13.0, local.y * 3.0), seed));
    return pow(radial, 0.68) * fibers * fragments;
  }
  if (style == 15) {
    float warp = brushLine(local.x * 31.0, 0.2);
    float weft = brushLine(local.y * 27.0, 0.2);
    float overUnder = mod(floor(local.x * 9.8) + floor(local.y * 8.6), 2.0);
    return disc * max(warp * mix(0.5, 1.0, overUnder), weft * mix(1.0, 0.5, overUnder));
  }
  if (style == 16) {
    vec2 grid = local * 7.0;
    vec2 cellId = floor(grid + 0.5);
    vec2 offset = vec2(brushHash(cellId, seed), brushHash(cellId.yx, seed + 9.0)) - 0.5;
    float pebble = length(grid - cellId - offset * 0.48);
    float ridge = 1.0 - smoothstep(0.31, 0.44, abs(pebble - (0.39 + brushHash(cellId, seed + 2.0) * 0.12)));
    return disc * (0.22 + ridge * 0.78);
  }
  if (style == 17) {
    float distortion = (brushFbm(local * 4.0, seed) - 0.5) * 0.12;
    float ringA = 1.0 - smoothstep(0.025, 0.07, abs(distanceToCenter + distortion - 0.72));
    float ringB = 1.0 - smoothstep(0.02, 0.055, abs(distanceToCenter + distortion * 0.7 - 0.48));
    float crystals = smoothstep(0.58, 0.76, brushNoise(local * 24.0, seed + 12.0));
    return disc * max(max(ringA, ringB * 0.65), crystals * radial * 0.72);
  }
  if (style == 18) {
    float distortion = (brushNoise(vec2(angle * 4.0, distanceToCenter * 5.0), seed) - 0.5) * 0.08;
    float bandA = 1.0 - smoothstep(0.04, 0.095, abs(distanceToCenter + distortion - 0.38));
    float bandB = 1.0 - smoothstep(0.04, 0.1, abs(distanceToCenter - distortion - 0.68));
    float breaks = smoothstep(0.32, 0.6, brushNoise(vec2(angle * 3.0, 1.0), seed + 7.0));
    return disc * max(bandA, bandB * 0.82) * mix(0.3, 1.0, breaks);
  }
  if (style == 19) {
    float sheets = smoothstep(0.32, 0.55, brushFbm(local * 3.8, seed));
    float edgeCrust = smoothstep(0.04, 0.13, abs(brushFbm(local * 8.0, seed + 3.0) - 0.53));
    return disc * max(sheets, (1.0 - edgeCrust) * 0.52);
  }
  if (style == 20) {
    float lines = brushLine(local.y * 67.0 + brushNoise(vec2(local.x * 4.0, 1.0), seed) * 0.7, 0.26);
    return pow(radial, 0.55) * lines;
  }
  if (style == 21) {
    float broad = brushLine(local.y * 25.0, 0.38);
    float fine = brushLine(local.y * 73.0 + local.x * 1.7, 0.18) * 0.68;
    float breaks = 0.4 + brushNoise(vec2(local.x * 9.0, local.y * 2.0), seed) * 0.6;
    return pow(radial, 0.5) * max(broad, fine) * breaks;
  }
  if (style == 22) {
    float forward = brushLine((local.x + local.y) * 28.0, 0.19);
    float backward = brushLine((local.x - local.y) * 28.0, 0.19);
    return disc * max(forward, backward);
  }
  if (style == 23) {
    float vertical = brushLine(local.x * 47.0, 0.16);
    float horizontal = brushLine(local.y * 47.0, 0.16);
    return disc * max(vertical, horizontal);
  }
  if (style == 24) {
    float forward = brushLine((local.x + local.y) * 16.0, 0.2);
    float backward = brushLine((local.x - local.y) * 16.0, 0.2);
    float segment = smoothstep(0.18, 0.42, abs(sin((local.x - local.y) * 8.0)));
    return disc * max(forward * segment, backward * (1.0 - segment));
  }
  if (style == 25) return disc * brushCellDot(local, 6.2, 0.24, seed, 0.0);
  if (style == 26) return disc * brushCellDot(local, 11.5, 0.17, seed, 0.0);
  if (style == 27 || style == 28) {
    float density = style == 27 ? 3.7 : 5.4;
    float row = floor(local.y * density + 0.5);
    float offset = style == 28 && mod(abs(row), 2.0) >= 1.0 ? 0.5 : 0.0;
    vec2 grid = vec2(local.x * density + offset, local.y * density);
    float headDistance = length(grid - floor(grid + 0.5));
    float head = 1.0 - smoothstep(0.25, 0.31, headDistance);
    float rim = 1.0 - smoothstep(0.04, 0.09, abs(headDistance - 0.27));
    return disc * max(head * 0.72, rim);
  }
  if (style == 29) {
    vec2 grid = local * vec2(3.2, 5.4);
    vec2 cell = fract(grid + 0.5) - 0.5;
    float row = floor(grid.y + 0.5);
    cell.x *= mod(abs(row), 2.0) >= 1.0 ? -1.0 : 1.0;
    float lug = abs(cell.y - abs(cell.x) * 0.48);
    float shape = (1.0 - smoothstep(0.12, 0.18, lug)) * (1.0 - smoothstep(0.28, 0.39, abs(cell.x)));
    return disc * shape;
  }
  if (style == 30) {
    float gouges = brushSegment(local, vec2(-0.86, -0.48), vec2(0.82, 0.35), 0.052);
    gouges = max(gouges, brushSegment(local, vec2(-0.78, -0.26), vec2(0.7, 0.46), 0.031));
    gouges = max(gouges, brushSegment(local, vec2(-0.72, -0.66), vec2(0.55, -0.02), 0.023));
    gouges = max(gouges, brushSegment(local, vec2(-0.42, 0.18), vec2(0.48, 0.62), 0.018));
    float chipRegion = 1.0 - smoothstep(0.18, 0.42, length(local + vec2(0.58, 0.36)));
    float chips = brushCellDot(local + vec2(0.58, 0.36), 10.0, 0.19, seed, 0.65) * chipRegion;
    return max(gouges, chips * 0.72);
  }
  if (style == 31) {
    float claw = brushSegment(local, vec2(-0.78, -0.58), vec2(-0.12, -0.18), 0.038);
    claw = max(claw, brushSegment(local, vec2(-0.12, -0.18), vec2(0.68, -0.3), 0.025));
    claw = max(claw, brushSegment(local, vec2(-0.82, -0.28), vec2(-0.08, 0.03), 0.035));
    claw = max(claw, brushSegment(local, vec2(-0.08, 0.03), vec2(0.76, -0.02), 0.022));
    claw = max(claw, brushSegment(local, vec2(-0.78, 0.02), vec2(-0.02, 0.25), 0.032));
    claw = max(claw, brushSegment(local, vec2(-0.02, 0.25), vec2(0.7, 0.3), 0.02));
    claw = max(claw, brushSegment(local, vec2(-0.66, 0.32), vec2(0.02, 0.48), 0.026));
    claw = max(claw, brushSegment(local, vec2(0.02, 0.48), vec2(0.56, 0.58), 0.016));
    return claw;
  }
  if (style == 32) {
    float cross = brushSegment(local, vec2(-0.82, -0.62), vec2(0.78, 0.55), 0.038);
    cross = max(cross, brushSegment(local, vec2(-0.68, 0.62), vec2(0.66, -0.58), 0.032));
    cross = max(cross, brushSegment(local, vec2(-0.72, 0.18), vec2(0.12, -0.42), 0.017));
    cross = max(cross, brushSegment(local, vec2(-0.12, 0.58), vec2(0.52, 0.05), 0.015));
    cross = max(cross, brushCellDot(local, 8.0, 0.2, seed, 0.45) * (1.0 - smoothstep(0.12, 0.54, distanceToCenter)));
    return cross;
  }
  if (style == 33) {
    float crack = brushSegment(local, vec2(-0.72, -0.58), vec2(-0.3, -0.18), 0.031);
    crack = max(crack, brushSegment(local, vec2(-0.3, -0.18), vec2(0.02, -0.02), 0.027));
    crack = max(crack, brushSegment(local, vec2(0.02, -0.02), vec2(0.34, 0.28), 0.022));
    crack = max(crack, brushSegment(local, vec2(0.34, 0.28), vec2(0.72, 0.62), 0.016));
    crack = max(crack, brushSegment(local, vec2(-0.3, -0.18), vec2(-0.56, 0.28), 0.018));
    crack = max(crack, brushSegment(local, vec2(-0.56, 0.28), vec2(-0.78, 0.48), 0.012));
    crack = max(crack, brushSegment(local, vec2(0.02, -0.02), vec2(0.32, -0.5), 0.016));
    crack = max(crack, brushSegment(local, vec2(0.32, -0.5), vec2(0.58, -0.72), 0.01));
    crack = max(crack, brushSegment(local, vec2(0.34, 0.28), vec2(0.72, 0.1), 0.012));
    return crack;
  }
  if (style == 34) {
    float sweep = brushSegment(local, vec2(-0.82, 0.22), vec2(-0.35, -0.18), 0.04);
    sweep = max(sweep, brushSegment(local, vec2(-0.35, -0.18), vec2(0.22, -0.3), 0.035));
    sweep = max(sweep, brushSegment(local, vec2(0.22, -0.3), vec2(0.78, -0.12), 0.021));
    sweep = max(sweep, brushSegment(local, vec2(-0.72, 0.42), vec2(-0.2, 0.06), 0.024));
    sweep = max(sweep, brushSegment(local, vec2(-0.2, 0.06), vec2(0.58, 0.04), 0.017));
    sweep = max(sweep, brushSegment(local, vec2(-0.52, 0.58), vec2(0.1, 0.3), 0.014));
    sweep = max(sweep, brushSegment(local, vec2(0.1, 0.3), vec2(0.64, 0.38), 0.011));
    return sweep;
  }
  if (style == 35) {
    float impact = brushSegment(local, vec2(-0.05, -0.04), vec2(0.8, 0.12), 0.025);
    impact = max(impact, brushSegment(local, vec2(-0.04, -0.03), vec2(0.56, 0.62), 0.022));
    impact = max(impact, brushSegment(local, vec2(-0.04, -0.03), vec2(0.04, -0.78), 0.019));
    impact = max(impact, brushSegment(local, vec2(-0.05, -0.04), vec2(-0.72, -0.48), 0.021));
    impact = max(impact, brushSegment(local, vec2(-0.05, -0.04), vec2(-0.62, 0.48), 0.016));
    impact = max(impact, brushSegment(local, vec2(0.14, 0.02), vec2(0.48, -0.38), 0.012));
    impact = max(impact, brushCellDot(local, 8.5, 0.22, seed, 0.55) * (1.0 - smoothstep(0.18, 0.48, distanceToCenter)));
    return impact;
  }
  if (style == 36) {
    vec2 q = mat2(0.9, 0.44, -0.44, 0.9) * local;
    float edgeNoise = (brushFbm(q * 4.5, seed) - 0.5) * 0.22;
    float envelope = 1.0 - smoothstep(0.86 + edgeNoise, 0.94 + edgeNoise, length(q / vec2(1.18, 0.5)));
    float plates = smoothstep(0.35, 0.6, brushFbm(q * 5.5, seed + 7.0));
    float fracture = smoothstep(0.42, 0.68, brushNoise(q * 18.0, seed + 19.0));
    float score = brushSegment(q, vec2(-0.88, -0.08), vec2(0.78, 0.12), 0.026);
    score = max(score, brushSegment(q, vec2(-0.62, 0.18), vec2(0.48, 0.3), 0.014));
    float chips = brushCellDot(q, 10.0, 0.17, seed + 29.0, 0.8) * envelope;
    return envelope * max(plates * mix(0.38, 1.0, fracture), max(score, chips * 0.72));
  }
  if (style == 37) {
    vec2 q = mat2(0.82, -0.57, 0.57, 0.82) * local;
    float trenchDistance = abs(q.y + sin(q.x * 3.2) * 0.09);
    float trench = 1.0 - smoothstep(0.12, 0.3, trenchDistance);
    float lengthGate = 1.0 - smoothstep(0.7, 0.98, abs(q.x));
    float corrosion = smoothstep(0.25, 0.61, brushFbm(q * 6.0, seed));
    float pores = brushCellDot(q, 8.5, 0.23, seed + 17.0, 0.82);
    float sideCrust = 1.0 - smoothstep(0.025, 0.09, abs(trenchDistance - 0.22));
    float debrisGate = 1.0 - smoothstep(0.3, 0.5, trenchDistance);
    float fragments = brushCellDot(q + vec2(0.1, 0.26), 13.0, 0.14, seed + 31.0, 0.9) * debrisGate;
    return lengthGate * max(trench * mix(0.35, 1.0, corrosion), max(sideCrust * 0.82, max(pores * trench, fragments * 0.58)));
  }
  if (style == 38) {
    vec2 q = mat2(0.96, 0.28, -0.28, 0.96) * local;
    float envelope = (1.0 - smoothstep(0.72, 0.98, abs(q.x))) * (1.0 - smoothstep(0.3, 0.62, abs(q.y)));
    float broad = smoothstep(0.32, 0.57, brushFbm(vec2(q.x * 4.0, q.y * 11.0), seed));
    float streaks = brushLine(q.y * 54.0 + brushNoise(vec2(q.x * 8.0, 1.0), seed + 5.0) * 1.4, 0.25);
    float dropout = smoothstep(0.3, 0.63, brushNoise(vec2(q.x * 9.0, q.y * 2.2), seed + 13.0));
    float dust = brushCellDot(q + vec2(-0.52, 0.0), 14.0, 0.13, seed + 23.0, 0.9)
      * (1.0 - smoothstep(0.18, 0.62, length(q + vec2(-0.52, 0.0))));
    return max(envelope * broad * max(streaks, dropout * 0.52), dust * 0.8);
  }
  if (style == 39) {
    vec2 q = mat2(0.88, -0.48, 0.48, 0.88) * local;
    float taper = clamp((0.92 - q.x) * 0.55, 0.08, 0.88);
    float wedge = (1.0 - smoothstep(taper, taper + 0.08, abs(q.y))) * (1.0 - smoothstep(0.78, 0.96, abs(q.x)));
    float plates = smoothstep(0.34, 0.58, brushFbm(q * 5.0, seed));
    float fibers = brushLine(q.y * 38.0 + q.x * 5.0, 0.23);
    float splits = brushSegment(q, vec2(-0.82, -0.3), vec2(0.7, 0.08), 0.018);
    splits = max(splits, brushSegment(q, vec2(-0.68, 0.32), vec2(0.62, 0.18), 0.014));
    float shards = brushCellDot(q - vec2(0.55, 0.0), 11.0, 0.18, seed + 27.0, 0.85)
      * (1.0 - smoothstep(0.14, 0.5, length(q - vec2(0.55, 0.0))));
    return max(wedge * max(plates * 0.88, max(fibers * 0.76, splits)), shards * 0.72);
  }
  if (style == 40) {
    vec2 q = mat2(0.94, 0.34, -0.34, 0.94) * local;
    float ellipse = length(q / vec2(1.12, 0.62));
    float edgeWarp = (brushFbm(q * 5.0, seed) - 0.5) * 0.16;
    float body = 1.0 - smoothstep(0.82 + edgeWarp, 0.94 + edgeWarp, ellipse);
    float rim = 1.0 - smoothstep(0.035, 0.1, abs(ellipse + edgeWarp - 0.78));
    float mottling = smoothstep(0.3, 0.62, brushFbm(q * 6.5, seed + 9.0));
    float pits = brushCellDot(q, 9.0, 0.22, seed + 21.0, 0.82);
    float scrape = brushSegment(q, vec2(-0.72, -0.12), vec2(0.68, 0.18), 0.02);
    return body * max(mottling * 0.72, max(rim, max(pits * 0.85, scrape)));
  }
  if (style == 41) {
    vec2 q = mat2(0.84, 0.54, -0.54, 0.84) * local;
    float curve = q.y + sin(q.x * 2.8) * 0.075;
    float lengthGate = 1.0 - smoothstep(0.72, 0.98, abs(q.x));
    float trench = 1.0 - smoothstep(0.055, 0.16, abs(curve));
    float burrA = 1.0 - smoothstep(0.018, 0.065, abs(curve - 0.22));
    float burrB = 1.0 - smoothstep(0.018, 0.065, abs(curve + 0.2));
    float breakup = smoothstep(0.28, 0.59, brushFbm(vec2(q.x * 7.0, q.y * 13.0), seed));
    float debris = brushCellDot(q, 12.0, 0.15, seed + 33.0, 0.9)
      * (1.0 - smoothstep(0.15, 0.46, abs(curve)));
    return lengthGate * max(trench * mix(0.45, 1.0, breakup), max(max(burrA, burrB) * 0.9, debris * 0.68));
  }
  return radial;
}
`;

const PAINT_BRUSH_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec3 uColor;
uniform vec4 uDabs[64];
uniform int uDabCount;
uniform int uBrushStyle;
uniform float uBrushSeed;
uniform sampler2D uBrushTexture;
uniform float uUseBrushTexture;
uniform float uEdgeBlend;
uniform float uErase;
uniform float uAlphaLock;
uniform float uForceOpaque;
${BRUSH_PATTERN_GLSL}
float brushEdgeFade(float distanceToCenter) {
  if (uEdgeBlend <= 0.0001) return 1.0;
  float width = mix(0.035, 0.3, clamp(uEdgeBlend, 0.0, 1.0));
  return 1.0 - smoothstep(1.0 - width, 1.0, distanceToCenter);
}
float resolvedBrushStrength(vec2 local, float distanceToCenter) {
  if (uUseBrushTexture > 0.5) {
    vec4 sampleColor = texture(uBrushTexture, clamp(local * 0.5 + 0.5, 0.0, 1.0));
    return dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * sampleColor.a;
  }
  return brushStrength(uBrushStyle, local, distanceToCenter, uBrushSeed);
}
void main() {
  vec4 destination = texture(uSource, vUv);
  vec2 pixel = vUv * uResolution;
  float remaining = 1.0;
  for (int i = 0; i < 64; i++) {
    if (i >= uDabCount) break;
    vec4 dab = uDabs[i];
    vec2 local = (pixel - dab.xy) / dab.z;
    float distanceSquared = dot(local, local);
    float distanceToCenter = uUseBrushTexture > 0.5 ? max(abs(local.x), abs(local.y)) : sqrt(distanceSquared);
    bool insideBrush = uUseBrushTexture > 0.5 ? distanceToCenter <= 1.0 : distanceSquared < 1.0;
    float dabStrength = insideBrush
      ? min(1.0, dab.w * clamp(resolvedBrushStrength(local, distanceToCenter), 0.0, 1.0) * brushEdgeFade(distanceToCenter))
      : 0.0;
    remaining *= 1.0 - dabStrength;
  }
  float strength = 1.0 - remaining;
  if (uForceOpaque > 0.5) {
    float height = uErase > 0.5
      ? mix(destination.r, 0.0, strength)
      : mix(destination.r, uColor.r, strength);
    outColor = vec4(vec3(height), 1.0);
    return;
  }
  if (uErase > 0.5) {
    outColor = vec4(destination.rgb, destination.a * (1.0 - strength));
    return;
  }
  if (uAlphaLock > 0.5 && destination.a <= 0.0) {
    outColor = destination;
    return;
  }
  float alpha = strength + destination.a * (1.0 - strength);
  vec3 color = alpha > 0.0
    ? (uColor * strength + destination.rgb * destination.a * (1.0 - strength)) / alpha
    : vec3(0.0);
  outColor = vec4(color, alpha);
}`;

const PAINT_TRANSFORM_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec2 uAxis;
uniform float uHalfLength;
uniform float uHalfWidth;
uniform float uDirectionMode;
uniform vec3 uColor;
uniform float uOpacity;
uniform int uBrushStyle;
uniform float uBrushSeed;
uniform sampler2D uBrushTexture;
uniform float uUseBrushTexture;
uniform float uEdgeBlend;
uniform float uErase;
uniform float uAlphaLock;
uniform float uForceOpaque;
${BRUSH_PATTERN_GLSL}
float brushEdgeFade(float distanceToCenter) {
  if (uEdgeBlend <= 0.0001) return 1.0;
  float width = mix(0.035, 0.3, clamp(uEdgeBlend, 0.0, 1.0));
  return 1.0 - smoothstep(1.0 - width, 1.0, distanceToCenter);
}
float resolvedBrushStrength(vec2 local, float distanceToCenter) {
  if (uUseBrushTexture > 0.5) {
    vec4 sampleColor = texture(uBrushTexture, clamp(local * 0.5 + 0.5, 0.0, 1.0));
    return dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * sampleColor.a;
  }
  return brushStrength(uBrushStyle, local, distanceToCenter, uBrushSeed);
}
void main() {
  vec4 destination = texture(uSource, vUv);
  vec2 offset = vUv * uResolution - uCenter;
  float localX = dot(offset, uAxis);
  float localY = dot(offset, vec2(-uAxis.y, uAxis.x));
  bool outsideLength = uDirectionMode > 0.5
    ? localX < 0.0 || localX > uHalfLength
    : abs(localX) > uHalfLength;
  if (outsideLength || abs(localY) > uHalfWidth) {
    outColor = destination;
    return;
  }
  float normalizedX = uDirectionMode > 0.5
    ? localX / uHalfLength * 2.0 - 1.0
    : localX / uHalfLength;
  float normalizedY = localY / uHalfWidth;
  float distanceToCenter = uDirectionMode > 0.5
    ? max(abs(normalizedX), abs(normalizedY))
    : length(vec2(normalizedX, normalizedY));
  if (uUseBrushTexture < 0.5 && distanceToCenter > 1.0) {
    outColor = destination;
    return;
  }
  float strength = min(
    1.0,
    uOpacity
      * clamp(resolvedBrushStrength(vec2(normalizedX, normalizedY), distanceToCenter), 0.0, 1.0)
      * brushEdgeFade(distanceToCenter)
  );
  if (uForceOpaque > 0.5) {
    float height = uErase > 0.5
      ? mix(destination.r, 0.0, strength)
      : mix(destination.r, uColor.r, strength);
    outColor = vec4(vec3(height), 1.0);
    return;
  }
  if (uErase > 0.5) {
    outColor = vec4(destination.rgb, destination.a * (1.0 - strength));
    return;
  }
  if (uAlphaLock > 0.5 && destination.a <= 0.0) {
    outColor = destination;
    return;
  }
  float alpha = strength + destination.a * (1.0 - strength);
  vec3 color = alpha > 0.0
    ? (uColor * strength + destination.rgb * destination.a * (1.0 - strength)) / alpha
    : vec3(0.0);
  outColor = vec4(color, alpha);
}`;

const MASK_BRUSH_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMaskSource;
uniform vec2 uResolution;
uniform vec4 uDabs[64];
uniform int uDabCount;
uniform float uTarget;
uniform int uBrushStyle;
uniform float uBrushSeed;
uniform sampler2D uBrushTexture;
uniform float uUseBrushTexture;
uniform float uEdgeBlend;
${BRUSH_PATTERN_GLSL}
float brushEdgeFade(float distanceToCenter) {
  if (uEdgeBlend <= 0.0001) return 1.0;
  float width = mix(0.035, 0.3, clamp(uEdgeBlend, 0.0, 1.0));
  return 1.0 - smoothstep(1.0 - width, 1.0, distanceToCenter);
}
float resolvedBrushStrength(vec2 local, float distanceToCenter) {
  if (uUseBrushTexture > 0.5) {
    vec4 sampleColor = texture(uBrushTexture, clamp(local * 0.5 + 0.5, 0.0, 1.0));
    return dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * sampleColor.a;
  }
  return brushStrength(uBrushStyle, local, distanceToCenter, uBrushSeed);
}
void main() {
  float value = texture(uMaskSource, vUv).r;
  for (int index = 0; index < 64; index += 1) {
    if (index >= uDabCount) break;
    vec4 dab = uDabs[index];
    vec2 local = (vUv * uResolution - dab.xy) / dab.z;
    float distanceSquared = dot(local, local);
    float distanceToCenter = uUseBrushTexture > 0.5 ? max(abs(local.x), abs(local.y)) : sqrt(distanceSquared);
    bool insideBrush = uUseBrushTexture > 0.5 ? distanceToCenter <= 1.0 : distanceSquared < 1.0;
    if (!insideBrush) continue;
    float brushAlpha = clamp(
      resolvedBrushStrength(local, distanceToCenter),
      0.0,
      1.0
    ) * brushEdgeFade(distanceToCenter);
    value = mix(value, uTarget, min(1.0, dab.w * brushAlpha));
  }
  outColor = vec4(value, 0.0, 0.0, 1.0);
}`;

const MASK_TRANSFORM_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMaskSource;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec2 uAxis;
uniform float uHalfLength;
uniform float uHalfWidth;
uniform float uDirectionMode;
uniform float uTarget;
uniform float uOpacity;
uniform int uBrushStyle;
uniform float uBrushSeed;
uniform sampler2D uBrushTexture;
uniform float uUseBrushTexture;
uniform float uEdgeBlend;
${BRUSH_PATTERN_GLSL}
float brushEdgeFade(float distanceToCenter) {
  if (uEdgeBlend <= 0.0001) return 1.0;
  float width = mix(0.035, 0.3, clamp(uEdgeBlend, 0.0, 1.0));
  return 1.0 - smoothstep(1.0 - width, 1.0, distanceToCenter);
}
float resolvedBrushStrength(vec2 local, float distanceToCenter) {
  if (uUseBrushTexture > 0.5) {
    vec4 sampleColor = texture(uBrushTexture, clamp(local * 0.5 + 0.5, 0.0, 1.0));
    return dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * sampleColor.a;
  }
  return brushStrength(uBrushStyle, local, distanceToCenter, uBrushSeed);
}
void main() {
  float value = texture(uMaskSource, vUv).r;
  vec2 offset = vUv * uResolution - uCenter;
  float localX = dot(offset, uAxis);
  float localY = dot(offset, vec2(-uAxis.y, uAxis.x));
  bool outsideLength = uDirectionMode > 0.5
    ? localX < 0.0 || localX > uHalfLength
    : abs(localX) > uHalfLength;
  if (outsideLength || abs(localY) > uHalfWidth) {
    outColor = vec4(value, 0.0, 0.0, 1.0);
    return;
  }
  float normalizedX = uDirectionMode > 0.5
    ? localX / uHalfLength * 2.0 - 1.0
    : localX / uHalfLength;
  float normalizedY = localY / uHalfWidth;
  float distanceToCenter = uDirectionMode > 0.5
    ? max(abs(normalizedX), abs(normalizedY))
    : length(vec2(normalizedX, normalizedY));
  if (uUseBrushTexture < 0.5 && distanceToCenter > 1.0) {
    outColor = vec4(value, 0.0, 0.0, 1.0);
    return;
  }
  float strength = min(
    1.0,
    uOpacity
      * clamp(resolvedBrushStrength(vec2(normalizedX, normalizedY), distanceToCenter), 0.0, 1.0)
      * brushEdgeFade(distanceToCenter)
  );
  outColor = vec4(mix(value, uTarget, strength), 0.0, 0.0, 1.0);
}`;

const FILTER_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform int uType;
uniform vec4 uParams;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
  vec4 src = texture(uSource, vUv);
  vec3 color = src.rgb;
  if (uType == 0) {
    color *= exp2(uParams.x);
    color = (color - 0.5) * (1.0 + uParams.y) + 0.5;
  } else if (uType == 1) {
    vec3 hsv = rgb2hsv(max(color, 0.0));
    hsv.x = fract(hsv.x + uParams.x);
    hsv.y = clamp(hsv.y * (1.0 + uParams.y), 0.0, 1.0);
    color = hsv2rgb(hsv) + uParams.z;
  } else if (uType == 2) {
    vec2 o = uTexel * max(uParams.x, 0.001);
    vec3 blur = texture(uSource, vUv).rgb * 0.2;
    blur += texture(uSource, vUv + vec2(o.x, 0.0)).rgb * 0.12;
    blur += texture(uSource, vUv - vec2(o.x, 0.0)).rgb * 0.12;
    blur += texture(uSource, vUv + vec2(0.0, o.y)).rgb * 0.12;
    blur += texture(uSource, vUv - vec2(0.0, o.y)).rgb * 0.12;
    blur += texture(uSource, vUv + o).rgb * 0.08;
    blur += texture(uSource, vUv - o).rgb * 0.08;
    blur += texture(uSource, vUv + vec2(o.x, -o.y)).rgb * 0.08;
    blur += texture(uSource, vUv + vec2(-o.x, o.y)).rgb * 0.08;
    color = mix(color, blur, uParams.y);
  } else if (uType == 3) {
    float n = hash21(floor(gl_FragCoord.xy / max(uParams.y, 0.25)));
    color += (n - 0.5) * uParams.x;
  } else if (uType == 4) {
    vec2 direction = vec2(cos(uParams.y), sin(uParams.y)) * uTexel * uParams.x;
    color.r = texture(uSource, vUv + direction).r;
    color.b = texture(uSource, vUv - direction).b;
  } else if (uType == 5) {
    float levels = max(2.0, floor(uParams.x));
    vec3 reduced = floor(color * levels + 0.5) / levels;
    color = mix(color, reduced, uParams.y);
  }
  outColor = vec4(max(color, 0.0), src.a);
}`;

const COMPOSITE_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBase;
uniform sampler2D uLayer;
uniform sampler2D uMask;
uniform sampler2D uClip;
uniform float uOpacity;
uniform int uMode;
uniform bool uUseMask;
uniform bool uMaskEnabled;
uniform bool uClipDown;
uniform float uMaskSoftness;
uniform float uMaskOpacity;
uniform float uMaskContrast;
uniform vec2 uMaskTexel;
uniform float uMaskRoughenAmount;
uniform float uMaskRoughenWidth;
uniform float uMaskRoughenScale;
uniform float uMaskRoughenSharpness;

vec3 rgb2hsv(vec3 c) {
  vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, k.wz), vec4(c.gb, k.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

vec3 blendColor(vec3 base, vec3 layer, int mode) {
  if (mode == 1) return base * layer;
  if (mode == 2) return 1.0 - (1.0 - base) * (1.0 - layer);
  if (mode == 3) {
    vec3 low = 2.0 * base * layer;
    vec3 high = 1.0 - 2.0 * (1.0 - base) * (1.0 - layer);
    return mix(low, high, step(vec3(0.5), base));
  }
  if (mode == 4) {
    return (1.0 - 2.0 * layer) * base * base + 2.0 * layer * base;
  }
  if (mode == 5) return min(vec3(1.0), base + layer);
  if (mode == 6) return abs(base - layer);
  if (mode == 7 || mode == 8) {
    vec3 baseHsv = rgb2hsv(clamp(base, 0.0, 1.0));
    vec3 layerHsv = rgb2hsv(clamp(layer, 0.0, 1.0));
    return hsv2rgb(vec3(layerHsv.x, mode == 7 ? baseHsv.y : layerHsv.y, baseHsv.z));
  }
  return layer;
}

float maskHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float maskNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  vec2 curve = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(maskHash(cell), maskHash(cell + vec2(1.0, 0.0)), curve.x),
    mix(maskHash(cell + vec2(0.0, 1.0)), maskHash(cell + vec2(1.0, 1.0)), curve.x),
    curve.y
  );
}

void main() {
  vec4 base = texture(uBase, vUv);
  vec4 layer = texture(uLayer, vUv);
  float maskValue = 1.0;
  if (uUseMask && uMaskEnabled) {
    maskValue = texture(uMask, vUv).r;
    if (uMaskSoftness > 0.0) {
      vec2 blurOffset = uMaskTexel * uMaskSoftness * 12.0;
      maskValue = (
        texture(uMask, vUv).r * 0.25 +
        texture(uMask, vUv + vec2(blurOffset.x, 0.0)).r * 0.125 +
        texture(uMask, vUv - vec2(blurOffset.x, 0.0)).r * 0.125 +
        texture(uMask, vUv + vec2(0.0, blurOffset.y)).r * 0.125 +
        texture(uMask, vUv - vec2(0.0, blurOffset.y)).r * 0.125 +
        texture(uMask, vUv + blurOffset).r * 0.0625 +
        texture(uMask, vUv - blurOffset).r * 0.0625 +
        texture(uMask, vUv + vec2(blurOffset.x, -blurOffset.y)).r * 0.0625 +
        texture(uMask, vUv + vec2(-blurOffset.x, blurOffset.y)).r * 0.0625
      );
    }
    if (uMaskRoughenAmount > 0.0) {
      vec2 field = vec2(
        maskNoise(vUv * uMaskRoughenScale + vec2(2.3, 7.1)),
        maskNoise(vUv * uMaskRoughenScale + vec2(8.6, 3.4))
      ) * 2.0 - 1.0;
      float fieldLength = max(length(field), 1e-4);
      vec2 roughUv = clamp(vUv + field / fieldLength * (uMaskRoughenWidth * uMaskTexel), 0.0, 1.0);
      float roughValue = texture(uMask, roughUv).r;
      maskValue = mix(maskValue, roughValue, uMaskRoughenAmount);
      maskValue = pow(clamp(maskValue, 0.0, 1.0), max(0.01, uMaskRoughenSharpness));
    }
    maskValue = clamp((maskValue - 0.5) * (1.0 + uMaskContrast * 3.0) + 0.5, 0.0, 1.0);
    maskValue *= uMaskOpacity;
  }
  float clipAlpha = uClipDown ? texture(uClip, vUv).a : 1.0;
  float sourceAlpha = clamp(layer.a * maskValue * clipAlpha * uOpacity, 0.0, 1.0);
  vec3 blended = blendColor(base.rgb, layer.rgb, uMode);
  float outAlpha = sourceAlpha + base.a * (1.0 - sourceAlpha);
  vec3 outRgb = outAlpha > 0.0
    ? (blended * sourceAlpha + base.rgb * base.a * (1.0 - sourceAlpha)) / outAlpha
    : vec3(0.0);
  outColor = vec4(outRgb, outAlpha);
}`;

const DISPLAY_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
void main() {
  outColor = texture(uSource, vUv);
}`;

const MATERIAL_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uComposite;
uniform sampler2D uColorMap;
uniform sampler2D uNormalMap;
uniform sampler2D uRoughnessMap;
uniform sampler2D uMetalnessMap;
uniform bool uUseColorMap;
uniform bool uUseNormalMap;
uniform bool uUseRoughnessMap;
uniform bool uUseMetalnessMap;
uniform float uColorStrength;
uniform float uNormalStrength;
uniform float uBaseRoughness;
uniform float uRoughnessMapBlend;
uniform float uBaseMetalness;
uniform float uMetalnessMapBlend;
uniform float uTextureScale;
uniform float uTileEdgeBlend;
uniform vec2 uTextureOffset;
uniform int uLightType;
uniform float uLightIntensity;
uniform vec3 uLightVector;
uniform vec3 uLightColor;
uniform float uAmbient;

float tileHash(vec2 cell) {
  cell = fract(cell * vec2(127.1, 311.7));
  cell += dot(cell, cell + 34.53);
  return fract(cell.x * cell.y);
}

vec2 tileHash2(vec2 cell) {
  return vec2(tileHash(cell + 19.19), tileHash(cell + 73.73));
}

float valueNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  local = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(tileHash(cell), tileHash(cell + vec2(1.0, 0.0)), local.x),
    mix(tileHash(cell + vec2(0.0, 1.0)), tileHash(cell + vec2(1.0)), local.x),
    local.y
  );
}

mat2 tileBasis(vec2 cell) {
  float quarterTurn = floor(tileHash(cell) * 4.0);
  mat2 basis;
  if (quarterTurn < 0.5) basis = mat2(1.0, 0.0, 0.0, 1.0);
  else if (quarterTurn < 1.5) basis = mat2(0.0, 1.0, -1.0, 0.0);
  else if (quarterTurn < 2.5) basis = mat2(-1.0, 0.0, 0.0, -1.0);
  else basis = mat2(0.0, -1.0, 1.0, 0.0);
  if (tileHash(cell + 41.41) > 0.5) basis = mat2(-1.0, 0.0, 0.0, 1.0) * basis;
  return basis;
}

vec2 stochasticTileUv(vec2 localUv, vec2 cell) {
  return fract(tileBasis(cell) * (localUv - 0.5) + 0.5 + (tileHash2(cell) - 0.5) * 0.24);
}

struct StochasticBlend {
  vec2 primaryTile;
  vec2 secondaryTile;
  vec2 tertiaryTile;
  vec2 primaryLocalUv;
  vec2 secondaryLocalUv;
  vec2 tertiaryLocalUv;
  float primaryWeight;
  float secondaryWeight;
  float tertiaryWeight;
};

StochasticBlend buildStochasticBlend(vec2 uv) {
  vec2 cell = floor(uv);
  vec2 localUv = fract(uv);
  float closestDistance = 1000.0;
  float nextClosestDistance = 1000.0;
  float thirdClosestDistance = 1000.0;
  vec2 closestTile = vec2(0.0);
  vec2 nextClosestTile = vec2(0.0);
  vec2 thirdClosestTile = vec2(0.0);
  vec2 closestOffset = vec2(0.0);
  vec2 nextClosestOffset = vec2(0.0);
  vec2 thirdClosestOffset = vec2(0.0);
  for (int y = -1; y <= 1; y += 1) {
    for (int x = -1; x <= 1; x += 1) {
      vec2 offset = vec2(float(x), float(y));
      vec2 tile = cell + offset;
      vec2 feature = offset + 0.12 + tileHash2(tile) * 0.76;
      float distanceToFeature = dot(localUv - feature, localUv - feature);
      if (distanceToFeature < closestDistance) {
        thirdClosestDistance = nextClosestDistance;
        thirdClosestTile = nextClosestTile;
        thirdClosestOffset = nextClosestOffset;
        nextClosestDistance = closestDistance;
        nextClosestTile = closestTile;
        nextClosestOffset = closestOffset;
        closestDistance = distanceToFeature;
        closestTile = tile;
        closestOffset = offset;
      } else if (distanceToFeature < nextClosestDistance) {
        thirdClosestDistance = nextClosestDistance;
        thirdClosestTile = nextClosestTile;
        thirdClosestOffset = nextClosestOffset;
        nextClosestDistance = distanceToFeature;
        nextClosestTile = tile;
        nextClosestOffset = offset;
      } else if (distanceToFeature < thirdClosestDistance) {
        thirdClosestDistance = distanceToFeature;
        thirdClosestTile = tile;
        thirdClosestOffset = offset;
      }
    }
  }

  StochasticBlend blend;
  blend.primaryTile = closestTile;
  blend.secondaryTile = nextClosestTile;
  blend.tertiaryTile = thirdClosestTile;
  blend.primaryLocalUv = localUv - closestOffset;
  blend.secondaryLocalUv = localUv - nextClosestOffset;
  blend.tertiaryLocalUv = localUv - thirdClosestOffset;
  blend.primaryWeight = 1.0;
  blend.secondaryWeight = 0.0;
  blend.tertiaryWeight = 0.0;

  // The variation is evaluated in material space, so both sides of a
  // boundary agree on the same organic edge width.
  float edgeBlendWidth = clamp(uTileEdgeBlend, 0.0, 0.5);
  if (edgeBlendWidth <= 0.0001) return blend;
  float organicWidth = min(edgeBlendWidth * mix(0.78, 1.22, valueNoise(uv * 2.35)), 0.5);
  float secondInfluence = 1.0 - smoothstep(
    0.0,
    organicWidth,
    sqrt(nextClosestDistance) - sqrt(closestDistance)
  );
  float thirdInfluence = 1.0 - smoothstep(
    0.0,
    organicWidth,
    sqrt(thirdClosestDistance) - sqrt(closestDistance)
  );
  float totalInfluence = 1.0 + secondInfluence + thirdInfluence;

  // Compact, normalized F1/F2/F3 weights keep a tile untouched in its
  // interior, become 50/50 at a two-tile edge, and resolve Voronoi junctions
  // continuously instead of switching the second-nearest tile on a line.
  blend.primaryWeight = 1.0 / totalInfluence;
  blend.secondaryWeight = secondInfluence / totalInfluence;
  blend.tertiaryWeight = thirdInfluence / totalInfluence;
  return blend;
}

vec4 sampleStochasticMap(sampler2D map, StochasticBlend blend) {
  vec4 primarySample = texture(map, stochasticTileUv(blend.primaryLocalUv, blend.primaryTile));
  if (blend.secondaryWeight <= 0.00001 && blend.tertiaryWeight <= 0.00001) return primarySample;
  vec4 secondarySample = texture(map, stochasticTileUv(blend.secondaryLocalUv, blend.secondaryTile));
  vec4 blendedSample = primarySample * blend.primaryWeight + secondarySample * blend.secondaryWeight;
  if (blend.tertiaryWeight <= 0.00001) return blendedSample;
  vec4 tertiarySample = texture(map, stochasticTileUv(blend.tertiaryLocalUv, blend.tertiaryTile));
  return blendedSample + tertiarySample * blend.tertiaryWeight;
}

vec3 sampleStochasticNormal(sampler2D map, StochasticBlend blend) {
  vec3 primaryNormal = texture(map, stochasticTileUv(blend.primaryLocalUv, blend.primaryTile)).xyz * 2.0 - 1.0;
  mat2 primaryBasis = tileBasis(blend.primaryTile);
  primaryNormal.xy = vec2(dot(primaryBasis[0], primaryNormal.xy), dot(primaryBasis[1], primaryNormal.xy));
  if (blend.secondaryWeight <= 0.00001 && blend.tertiaryWeight <= 0.00001) return normalize(primaryNormal);

  vec3 secondaryNormal = texture(map, stochasticTileUv(blend.secondaryLocalUv, blend.secondaryTile)).xyz * 2.0 - 1.0;
  mat2 secondaryBasis = tileBasis(blend.secondaryTile);
  secondaryNormal.xy = vec2(dot(secondaryBasis[0], secondaryNormal.xy), dot(secondaryBasis[1], secondaryNormal.xy));
  vec3 blendedNormal = primaryNormal * blend.primaryWeight + secondaryNormal * blend.secondaryWeight;
  if (blend.tertiaryWeight <= 0.00001) return normalize(blendedNormal);
  vec3 tertiaryNormal = texture(map, stochasticTileUv(blend.tertiaryLocalUv, blend.tertiaryTile)).xyz * 2.0 - 1.0;
  mat2 tertiaryBasis = tileBasis(blend.tertiaryTile);
  tertiaryNormal.xy = vec2(dot(tertiaryBasis[0], tertiaryNormal.xy), dot(tertiaryBasis[1], tertiaryNormal.xy));
  return normalize(blendedNormal + tertiaryNormal * blend.tertiaryWeight);
}

const float PI = 3.14159265359;

float distributionGGX(float normalDotHalf, float roughness) {
  float alpha = roughness * roughness;
  float alphaSquared = alpha * alpha;
  float denominator = normalDotHalf * normalDotHalf * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / max(PI * denominator * denominator, 0.00001);
}

float geometrySchlickGGX(float normalDotDirection, float roughness) {
  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  return normalDotDirection / max(normalDotDirection * (1.0 - k) + k, 0.00001);
}

float geometrySmith(float normalDotView, float normalDotLight, float roughness) {
  return geometrySchlickGGX(normalDotView, roughness) * geometrySchlickGGX(normalDotLight, roughness);
}

vec3 fresnelSchlick(float viewDotHalf, vec3 f0) {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - viewDotHalf, 0.0, 1.0), 5.0);
}

void main() {
  vec4 composite = texture(uComposite, vUv);
  vec2 materialUv = vUv * max(uTextureScale, 0.001) + uTextureOffset;
  StochasticBlend mapBlend = buildStochasticBlend(materialUv);
  vec4 colorMap = uUseColorMap ? sampleStochasticMap(uColorMap, mapBlend) : composite;
  vec4 surfaceColor = mix(composite, colorMap, uUseColorMap ? clamp(uColorStrength, 0.0, 1.0) : 1.0);
  vec3 albedo = surfaceColor.rgb;
  vec3 normal = vec3(0.0, 0.0, 1.0);
  if (uUseNormalMap) {
    vec3 mapped = sampleStochasticNormal(uNormalMap, mapBlend);
    normal = normalize(vec3(mapped.xy * uNormalStrength, max(0.001, mapped.z)));
  }
  float baseRoughness = clamp(uBaseRoughness, 0.0, 1.0);
  float roughness = baseRoughness;
  if (uUseRoughnessMap) {
    float mapRoughness = dot(sampleStochasticMap(uRoughnessMap, mapBlend).rgb, vec3(0.299, 0.587, 0.114));
    roughness = mix(baseRoughness, clamp(mapRoughness, 0.0, 1.0), clamp(uRoughnessMapBlend, 0.0, 1.0));
  }
  roughness = clamp(roughness, 0.0, 1.0);
  float shadingRoughness = max(roughness, 0.02);

  float baseMetalness = clamp(uBaseMetalness, 0.0, 1.0);
  float metalness = baseMetalness;
  if (uUseMetalnessMap) {
    float mapMetalness = dot(sampleStochasticMap(uMetalnessMap, mapBlend).rgb, vec3(0.299, 0.587, 0.114));
    metalness = mix(baseMetalness, clamp(mapMetalness, 0.0, 1.0), clamp(uMetalnessMapBlend, 0.0, 1.0));
  }
  vec3 surfacePosition = vec3((vUv - 0.5) * 2.0, 0.0);
  vec3 lightDirection = normalize(uLightVector);
  float attenuation = 1.0;
  if (uLightType == 1) {
    vec3 toLight = uLightVector - surfacePosition;
    float distanceToLight = max(length(toLight), 0.001);
    lightDirection = toLight / distanceToLight;
    attenuation = 1.0 / (1.0 + 0.35 * distanceToLight + 0.18 * distanceToLight * distanceToLight);
  }
  float normalDotLight = max(dot(normal, lightDirection), 0.0);
  vec3 viewDirection = vec3(0.0, 0.0, 1.0);
  vec3 halfDirection = normalize(lightDirection + viewDirection);
  float normalDotView = max(dot(normal, viewDirection), 0.0001);
  float normalDotHalf = max(dot(normal, halfDirection), 0.0);
  float viewDotHalf = max(dot(viewDirection, halfDirection), 0.0);
  vec3 radiance = uLightColor * uLightIntensity * attenuation;
  vec3 f0 = mix(vec3(0.04), albedo, metalness);
  vec3 fresnel = fresnelSchlick(viewDotHalf, f0);
  float distribution = distributionGGX(normalDotHalf, shadingRoughness);
  float geometry = geometrySmith(normalDotView, normalDotLight, shadingRoughness);
  vec3 microfacetSpecular = fresnel * distribution * geometry / max(4.0 * normalDotView * normalDotLight, 0.0001);

  // A finite softbox keeps roughness readable on a flat, front-facing plane:
  // low roughness is a focused, brighter reflection; high roughness is broad
  // but deliberately dimmer. The GGX term remains the physical direct-light term.
  float softboxExponent = mix(48.0, 2.0, roughness * roughness);
  float softboxReflection = pow(normalDotHalf, softboxExponent) * mix(4.0, 0.15, roughness);
  vec3 diffuseColor = albedo * (1.0 - fresnel) * (1.0 - metalness);
  vec3 diffuseLight = diffuseColor * (vec3(uAmbient) + radiance * normalDotLight);
  vec3 directSpecular = (microfacetSpecular + fresnel * softboxReflection) * radiance * normalDotLight;
  vec3 ambientSpecular = f0 * uAmbient * mix(0.72, 0.08, roughness);
  outColor = vec4(diffuseLight + directSpecular + ambientSpecular, surfaceColor.a);
}`;

const HEIGHT_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aUv;
uniform sampler2D uHeightMap;
uniform vec2 uMeshTexel;
uniform float uHeightStrength;
uniform float uAutoSmooth;
uniform float uSmoothAngle;
out vec2 vUv;
out vec3 vNormal;
float rawHeightAt(vec2 uv) {
  vec3 color = texture(uHeightMap, clamp(uv, 0.0, 1.0)).rgb;
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}
float heightAt(vec2 uv) {
  float center = rawHeightAt(uv);
  if (uAutoSmooth < 0.5) return center;
  vec2 xOffset = vec2(uMeshTexel.x, 0.0);
  vec2 yOffset = vec2(0.0, uMeshTexel.y);
  float left = rawHeightAt(uv - xOffset);
  float right = rawHeightAt(uv + xOffset);
  float down = rawHeightAt(uv - yOffset);
  float up = rawHeightAt(uv + yOffset);
  float smoothHeight = (center * 4.0 + left + right + down + up) / 8.0;
  float slope = max(abs(right - left), abs(up - down));
  float crease = mix(0.012, 0.16, clamp(uSmoothAngle / 180.0, 0.0, 1.0));
  float preserveSharpness = smoothstep(crease * 0.5, crease, slope);
  return mix(smoothHeight, center, preserveSharpness);
}
void main() {
  float center = heightAt(aUv);
  float left = heightAt(aUv - vec2(uMeshTexel.x, 0.0));
  float right = heightAt(aUv + vec2(uMeshTexel.x, 0.0));
  float down = heightAt(aUv - vec2(0.0, uMeshTexel.y));
  float up = heightAt(aUv + vec2(0.0, uMeshTexel.y));
  vec3 tangentX = vec3(2.0 * uMeshTexel.x, 0.0, (right - left) * uHeightStrength);
  vec3 tangentY = vec3(0.0, 2.0 * uMeshTexel.y, (up - down) * uHeightStrength);
  vNormal = normalize(cross(tangentX, tangentY));
  vUv = aUv;
  gl_Position = vec4(aPosition, center * uHeightStrength, 1.0);
}`;

const HEIGHT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vNormal;
out vec4 outColor;
uniform sampler2D uComposite;
uniform sampler2D uHeightMap;
uniform vec3 uLightVector;
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform float uAmbient;
uniform float uHeightStrength;
uniform vec3 uMaterialColor;
uniform float uRoughness;
uniform float uMetalness;
void main() {
  vec4 base = texture(uComposite, vUv);
  float height = dot(texture(uHeightMap, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 normal = normalize(vNormal);
  vec3 light = normalize(uLightVector);
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 halfVector = normalize(light + view);
  float diffuse = max(0.0, dot(normal, light));
  float specularPower = mix(128.0, 4.0, uRoughness);
  float specular = pow(max(0.0, dot(normal, halfVector)), specularPower);
  vec3 surfaceColor = base.rgb * uMaterialColor;
  vec3 f0 = mix(vec3(0.04), surfaceColor, uMetalness);
  vec3 directDiffuse = surfaceColor * (1.0 - uMetalness) * diffuse;
  vec3 directSpecular = f0 * specular * diffuse;
  float reliefLift = 1.0 + height * uHeightStrength * 1.5;
  vec3 shaded = (surfaceColor * uAmbient + (directDiffuse + directSpecular) * uLightColor * uLightIntensity) * reliefLift;
  outColor = vec4(shaded, base.a);
}`;

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${detail}`);
  }
  return shader;
}

function createProgram(fragmentSource) {
  return createProgramFromSources(VERTEX_SHADER, fragmentSource);
}

function createProgramFromSources(vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vertex = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Shader linking failed: ${detail}`);
  }
  return program;
}

function createTexture(width, height, data = null, internalFormat = gl.RGBA8, format = gl.RGBA) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.UNSIGNED_BYTE, data);
  return texture;
}

function createTarget(width, height) {
  const texture = createTexture(width, height);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Unable to create a complete WebGL framebuffer.");
  }
  return { texture, framebuffer };
}

function initializeGpu() {
  gpu.compositeProgram = createProgram(COMPOSITE_SHADER);
  gpu.displayProgram = createProgram(DISPLAY_SHADER);
  gpu.materialProgram = createProgram(MATERIAL_SHADER);
  gpu.heightProgram = createProgramFromSources(HEIGHT_VERTEX_SHADER, HEIGHT_FRAGMENT_SHADER);
  gpu.maskBrushProgram = createProgram(MASK_BRUSH_SHADER);
  gpu.maskTransformProgram = createProgram(MASK_TRANSFORM_SHADER);
  gpu.paintBrushProgram = createProgram(PAINT_BRUSH_SHADER);
  gpu.paintTransformProgram = createProgram(PAINT_TRANSFORM_SHADER);
  rebuildDocumentTargets();
  gpu.thumbnailTarget = createTarget(64, 64);
  gpu.whiteMask = createTexture(1, 1, new Uint8Array([255]), gl.R8, gl.RED);
  gpu.transparentTexture = createTexture(1, 1, new Uint8Array([0, 0, 0, 0]));
  gpu.flatNormal = createTexture(1, 1, new Uint8Array([128, 128, 255, 255]));
  gpu.blackRoughness = createTexture(1, 1, new Uint8Array([128, 128, 128, 255]));
  gpu.blackMetalness = createTexture(1, 1, new Uint8Array([0, 0, 0, 255]));
  gl.bindVertexArray(gpu.vao);
}

function destroyTarget(target) {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

function getInteractiveRenderDimensions() {
  const largestSide = Math.max(DOC_WIDTH, DOC_HEIGHT);
  // A transformed stamp can cover most of the document. Keep the entire live
  // composite at an interaction-safe resolution until its native commit.
  const hasInteractiveMaskPreview = state.paintPointerId !== null
    && state.selectionPart === "mask";
  const maxDimension = state.paintTransformStroke || hasInteractiveMaskPreview
    ? TRANSFORM_INTERACTIVE_RENDER_MAX_DIMENSION
    : INTERACTIVE_RENDER_MAX_DIMENSION;
  if (largestSide <= maxDimension) return { width: DOC_WIDTH, height: DOC_HEIGHT };
  const scale = maxDimension / largestSide;
  return {
    width: Math.max(1, Math.round(DOC_WIDTH * scale)),
    height: Math.max(1, Math.round(DOC_HEIGHT * scale)),
  };
}

function rebuildDocumentTargets(dimensions = getInteractiveRenderDimensions()) {
  state.layers.forEach(destroyLayerFilterCache);
  gpu.filterTargets.forEach(destroyTarget);
  destroyTarget(gpu.alphaLockTarget);
  gpu.compositeTargets.forEach(destroyTarget);
  gpu.rangeCompositeTargets.forEach(destroyTarget);
  destroyTarget(gpu.materialTarget);
  destroyTarget(gpu.heightTarget);
  gpu.renderWidth = dimensions.width;
  gpu.renderHeight = dimensions.height;
  gpu.filterTargets = [createTarget(gpu.renderWidth, gpu.renderHeight), createTarget(gpu.renderWidth, gpu.renderHeight)];
  gpu.alphaLockTarget = createTarget(gpu.renderWidth, gpu.renderHeight);
  gpu.compositeTargets = [createTarget(gpu.renderWidth, gpu.renderHeight), createTarget(gpu.renderWidth, gpu.renderHeight)];
  gpu.rangeCompositeTargets = [createTarget(gpu.renderWidth, gpu.renderHeight), createTarget(gpu.renderWidth, gpu.renderHeight)];
  gpu.materialTarget = createTarget(gpu.renderWidth, gpu.renderHeight);
  gpu.heightTarget = createTarget(gpu.renderWidth, gpu.renderHeight);
}

function ensureRenderTargetDimensions(dimensions) {
  if (gpu.renderWidth !== dimensions.width || gpu.renderHeight !== dimensions.height) rebuildDocumentTargets(dimensions);
}

function setDocumentDimensions(width, height) {
  const nextWidth = Math.round(Number(width));
  const nextHeight = Math.round(Number(height));
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth < 1 || nextHeight < 1) {
    throw new Error("The image has invalid dimensions.");
  }
  if (nextWidth > maxTextureSize || nextHeight > maxTextureSize) {
    throw new Error(`This GPU supports documents up to ${maxTextureSize} pixels on either side.`);
  }
  const dimensionsChanged = nextWidth !== DOC_WIDTH || nextHeight !== DOC_HEIGHT;
  DOC_WIDTH = nextWidth;
  DOC_HEIGHT = nextHeight;
  if (dimensionsChanged) rebuildDocumentTargets();
  canvasWrap.style.aspectRatio = `${DOC_WIDTH} / ${DOC_HEIGHT}`;
  syncCanvasPresentation();
  document.getElementById("documentSize").textContent = `${DOC_WIDTH} x ${DOC_HEIGHT}`;
}

function syncCanvasPresentation() {
  const availableWidth = Math.max(1, Math.min(canvasStage.clientWidth * 0.68, canvasStage.clientWidth - 330));
  const availableHeight = Math.max(1, canvasStage.clientHeight - 116);
  const documentRatio = DOC_WIDTH / DOC_HEIGHT;
  const width = Math.min(availableWidth, availableHeight * documentRatio);
  const height = width / documentRatio;
  canvasWrap.style.width = `${Math.round(width)}px`;
  canvasWrap.style.height = `${Math.round(height)}px`;
}

function bindTexture(program, name, texture, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(gl.getUniformLocation(program, name), unit);
}

const externalBrushTextures = new Map();
const externalBrushTextureLoads = new Map();

function isExternalBrushPreset(preset) {
  return Boolean(preset?.externalId);
}

async function ensureExternalBrushTexture(preset) {
  if (!isExternalBrushPreset(preset)) return null;
  if (externalBrushTextures.has(preset.id)) return externalBrushTextures.get(preset.id);
  if (externalBrushTextureLoads.has(preset.id)) return externalBrushTextureLoads.get(preset.id);
  const pending = (async () => {
    if (!preset.imageDataUrl) {
      const payload = await window.shaderPaintDesktop?.loadBrushTexture?.(preset.externalId);
      if (!payload?.dataUrl || payload.id !== preset.externalId) {
        throw new Error(`Could not load the full texture for "${preset.name}".`);
      }
      preset.imageDataUrl = payload.dataUrl;
    }
    return loadImage(preset.imageDataUrl);
  })()
    .then((image) => {
      const texture = textureFromCanvas(image);
      externalBrushTextures.set(preset.id, texture);
      externalBrushTextureLoads.delete(preset.id);
      return texture;
    })
    .catch((error) => {
      externalBrushTextureLoads.delete(preset.id);
      throw error;
    });
  externalBrushTextureLoads.set(preset.id, pending);
  return pending;
}

function bindBrushTexture(program, preset, unit) {
  const texture = isExternalBrushPreset(preset) ? externalBrushTextures.get(preset.id) : null;
  bindTexture(program, "uBrushTexture", texture || gpu.transparentTexture, unit);
  gl.uniform1f(gl.getUniformLocation(program, "uUseBrushTexture"), texture ? 1 : 0);
}

function drawFullscreen() {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function convertFilterShader(source) {
  return `#version 300 es
precision highp float;
out vec4 shaderPaintColor;
${source
    .replace(/\bvarying\b/g, "in")
    .replace(/\btexture2D\b/g, "texture")
    .replace(/\bgl_FragColor\b/g, "shaderPaintColor")}`;
}

function createUniformValue(type, size) {
  if (type === gl.FLOAT_VEC2) return size > 1
    ? Array.from({ length: size }, () => new THREE.Vector2())
    : new THREE.Vector2();
  if (type === gl.FLOAT_VEC3) return size > 1
    ? Array.from({ length: size }, () => new THREE.Vector3())
    : new THREE.Vector3();
  if (type === gl.FLOAT_VEC4) return size > 1
    ? Array.from({ length: size }, () => new THREE.Vector4())
    : new THREE.Vector4();
  return size > 1 ? new Float32Array(size) : 0;
}

function getPassProgram(pass) {
  if (gpu.passPrograms.has(pass.key)) return gpu.passPrograms.get(pass.key);
  const program = createProgram(convertFilterShader(fragmentShaderForPass(pass)));
  const uniforms = {};
  const activeUniforms = [];
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let index = 0; index < count; index += 1) {
    const info = gl.getActiveUniform(program, index);
    const name = info.name.replace(/\[0\]$/, "");
    uniforms[name] = { value: createUniformValue(info.type, info.size) };
    activeUniforms.push({
      name,
      type: info.type,
      size: info.size,
      location: gl.getUniformLocation(program, name),
    });
  }
  const compiled = { program, uniforms, activeUniforms };
  gpu.passPrograms.set(pass.key, compiled);
  return compiled;
}

function flattenUniformValue(value, components) {
  const values = Array.isArray(value) ? value : [value];
  const flat = [];
  values.forEach((entry) => {
    if (entry?.toArray) flat.push(...entry.toArray());
    else if (Array.isArray(entry) || ArrayBuffer.isView(entry)) flat.push(...entry);
    else flat.push(Number(entry) || 0);
  });
  while (flat.length < values.length * components) flat.push(0);
  return flat;
}

function uploadPassUniforms(compiled, sourceTexture) {
  let textureUnit = 0;
  compiled.activeUniforms.forEach(({ name, type, size, location }) => {
    const value = compiled.uniforms[name]?.value;
    if (type === gl.SAMPLER_2D) {
      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, value || sourceTexture);
      gl.uniform1i(location, textureUnit);
      textureUnit += 1;
    } else if (type === gl.FLOAT) {
      if (size > 1) gl.uniform1fv(location, value);
      else gl.uniform1f(location, Number(value) || 0);
    } else if (type === gl.INT || type === gl.BOOL) {
      if (size > 1) gl.uniform1iv(location, value);
      else gl.uniform1i(location, Number(value) || 0);
    } else if (type === gl.FLOAT_VEC2) {
      gl.uniform2fv(location, flattenUniformValue(value, 2));
    } else if (type === gl.FLOAT_VEC3) {
      gl.uniform3fv(location, flattenUniformValue(value, 3));
    } else if (type === gl.FLOAT_VEC4) {
      gl.uniform4fv(location, flattenUniformValue(value, 4));
    } else {
      throw new Error(`Unsupported uniform type ${type} in ${name}.`);
    }
  });
}

function getFilterImageTexture(filter) {
  const url = filter?.params?.image;
  if (!url) {
    if (filter?._imageTexture) gl.deleteTexture(filter._imageTexture);
    if (filter) {
      filter._imageTexture = null;
      filter._imageTextureUrl = null;
    }
    return null;
  }
  if (filter._imageTextureUrl === url) return filter._imageTexture || null;
  if (filter._imageTexture) gl.deleteTexture(filter._imageTexture);
  filter._imageTexture = null;
  filter._imageTextureUrl = url;
  const image = new Image();
  image.onload = () => {
    if (filter._imageTextureUrl !== url) return;
    filter._imageTexture = textureFromCanvas(image);
    requestRender();
  };
  image.onerror = () => {
    if (filter._imageTextureUrl === url) {
      filter._imageTextureUrl = null;
      showToast("Displacement map could not be loaded.");
    }
  };
  image.src = url;
  return null;
}

const DEFAULT_MATERIAL = Object.freeze({
  colorMap: null,
  normalMap: null,
  roughnessMap: null,
  metalnessMap: null,
  colorStrength: 1,
  normalStrength: 1,
  baseRoughness: 0,
  roughnessMapBlend: 1,
  baseMetalness: 0,
  metalnessMapBlend: 1,
  textureScale: 1,
  edgeBlendWidth: 0.08,
  textureOffsetX: 0,
  textureOffsetY: 0,
  lightType: "directional",
  intensity: 0.8,
  directionX: -0.45,
  directionY: 0.55,
  directionZ: 1.25,
  color: "#ffffff",
  ambient: 0.22,
});

const DEFAULT_HEIGHT = Object.freeze({
  heightStrength: 1,
  meshResolution: 160,
  autoSmooth: true,
  smoothAngle: 45,
  intensity: 1.15,
  directionX: -0.45,
  directionY: 0.55,
  directionZ: 1.25,
  color: "#fff4df",
  ambient: 0.18,
  materialColor: "#ffffff",
  roughness: 0.7,
  metalness: 0,
});

function normalizeMaterial(material) {
  const normalized = { ...DEFAULT_MATERIAL, ...(material || {}) };
  if (!Number.isFinite(Number(material?.edgeBlendWidth)) && Number.isFinite(Number(material?.tileBlend))) {
    normalized.edgeBlendWidth = Math.max(0, Number(material.tileBlend) * 0.4);
  }
  if (!Number.isFinite(Number(material?.roughnessMapBlend)) && Number.isFinite(Number(material?.roughnessStrength))) {
    normalized.roughnessMapBlend = Math.max(0, Math.min(1, Number(material.roughnessStrength)));
  }
  normalized.baseRoughness = Math.max(0, Math.min(1, Number(normalized.baseRoughness) || 0));
  normalized.roughnessMapBlend = Math.max(0, Math.min(1, Number(normalized.roughnessMapBlend) || 0));
  normalized.baseMetalness = Math.max(0, Math.min(1, Number(normalized.baseMetalness) || 0));
  normalized.metalnessMapBlend = Math.max(0, Math.min(1, Number(normalized.metalnessMapBlend) || 0));
  return normalized;
}

function normalizeHeight(height) {
  const normalized = { ...DEFAULT_HEIGHT, ...(height || {}) };
  const meshResolution = Number(normalized.meshResolution);
  normalized.meshResolution = [96, 160, 256, 384].includes(meshResolution) ? meshResolution : DEFAULT_HEIGHT.meshResolution;
  normalized.heightStrength = Math.max(0, Math.min(4, Number(normalized.heightStrength) || 0));
  normalized.autoSmooth = normalized.autoSmooth !== false;
  normalized.smoothAngle = Math.max(1, Math.min(180, Number(normalized.smoothAngle) || DEFAULT_HEIGHT.smoothAngle));
  normalized.intensity = Math.max(0, Math.min(4, Number(normalized.intensity) || 0));
  normalized.ambient = Math.max(0, Math.min(1, Number(normalized.ambient) || 0));
  normalized.roughness = Math.max(0, Math.min(1, Number(normalized.roughness) || 0));
  normalized.metalness = Math.max(0, Math.min(1, Number(normalized.metalness) || 0));
  return normalized;
}

function hexToRgb(hex) {
  const value = String(hex || "#ffffff").replace("#", "");
  const normalized = value.length === 3 ? value.split("").map((part) => part + part).join("") : value;
  const number = Number.parseInt(normalized, 16);
  if (!Number.isFinite(number)) return [1, 1, 1];
  return [(number >> 16 & 255) / 255, (number >> 8 & 255) / 255, (number & 255) / 255];
}

function getMaterialMapTexture(layer, key) {
  const url = layer.material?.[key];
  const textureKey = `_${key}Texture`;
  const urlKey = `_${key}TextureUrl`;
  if (!url) {
    if (layer[textureKey]) gl.deleteTexture(layer[textureKey]);
    layer[textureKey] = null;
    layer[urlKey] = null;
    return null;
  }
  if (layer[urlKey] === url) return layer[textureKey] || null;
  if (layer[textureKey]) gl.deleteTexture(layer[textureKey]);
  layer[textureKey] = null;
  layer[urlKey] = url;
  const image = new Image();
  image.onload = () => {
    if (layer[urlKey] !== url) return;
    layer[textureKey] = textureFromCanvas(image);
    requestRender();
  };
  image.onerror = () => {
    if (layer[urlKey] === url) {
      layer[urlKey] = null;
      showToast("Material map could not be loaded.");
    }
  };
  image.src = url;
  return null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read material map."));
    reader.readAsDataURL(file);
  });
}

function materialMapFileParts(file) {
  const name = String(file?.name || "").split(/[\\/]/).pop();
  const extensionStart = name.lastIndexOf(".");
  return {
    directory: String(file?.webkitRelativePath || "").replace(/[\\/][^\\/]*$/, "").toLowerCase(),
    stem: (extensionStart > 0 ? name.slice(0, extensionStart) : name).toLowerCase(),
  };
}

function materialNormalPrefix(file) {
  const stem = materialMapFileParts(file).stem;
  const suffix = "_normalgl";
  return stem.endsWith(suffix) ? stem.slice(0, -suffix.length) : null;
}

function findMaterialMapSibling(files, selectedFile, prefix, suffix) {
  const selectedDirectory = materialMapFileParts(selectedFile).directory;
  const expectedStem = `${prefix}${suffix}`.toLowerCase();
  return files.find((file) => {
    const candidate = materialMapFileParts(file);
    return candidate.stem === expectedStem
      && (!selectedDirectory || !candidate.directory || candidate.directory === selectedDirectory);
  });
}

async function loadMaterialMapFiles(layer, key, selectedFiles) {
  const files = [...selectedFiles];
  const selectedFile = key === "normalMap"
    ? files.find((file) => materialNormalPrefix(file) !== null) || files[0]
    : files[0];
  if (!selectedFile) return;
  const assignments = [[key, selectedFile]];
  const normalPrefix = key === "normalMap" ? materialNormalPrefix(selectedFile) : null;
  if (normalPrefix) {
    [
      ["colorMap", "_Color"],
      ["roughnessMap", "_Roughness"],
      ["metalnessMap", "_Metalness"],
    ].forEach(([mapKey, suffix]) => {
      if (layer.material[mapKey]) return;
      const sibling = findMaterialMapSibling(files, selectedFile, normalPrefix, suffix)
        || (mapKey === "metalnessMap"
          ? findMaterialMapSibling(files, selectedFile, normalPrefix, "_Metallic")
          : null);
      if (sibling) assignments.push([mapKey, sibling]);
    });
  }
  const loadedMaps = await Promise.all(assignments.map(async ([mapKey, file]) => ({
    mapKey,
    name: file.name,
    dataUrl: await readFileAsDataUrl(file),
  })));
  loadedMaps.forEach(({ mapKey, name, dataUrl }) => {
    layer.material[mapKey] = dataUrl;
    layer.material[materialMapNameKey(mapKey)] = name;
    getMaterialMapTexture(layer, mapKey);
  });
  if (loadedMaps.length > 1) showToast("Material map set loaded.");
}

function applyDesktopMaterialMaps(layer, maps) {
  const assignments = Object.entries(maps).filter(([, map]) => map?.dataUrl);
  if (!assignments.length) return false;
  assignments.forEach(([key, map]) => {
    if (key !== "normalMap" && layer.material[key]) return;
    layer.material[key] = map.dataUrl;
    layer.material[materialMapNameKey(key)] = map.name;
    getMaterialMapTexture(layer, key);
  });
  return true;
}

function replaceMaterialMaps(layer, maps) {
  let replaced = false;
  ["colorMap", "normalMap", "roughnessMap", "metalnessMap"].forEach((key) => {
    const map = maps?.[key];
    layer.material[key] = map?.dataUrl || null;
    layer.material[materialMapNameKey(key)] = map?.name || null;
    getMaterialMapTexture(layer, key);
    replaced ||= Boolean(map?.dataUrl);
  });
  return replaced;
}

function renderMaterialLayer(layer, compositeTexture) {
  const material = normalizeMaterial(layer.material);
  layer.material = material;
  const colorMap = getMaterialMapTexture(layer, "colorMap");
  const normalMap = getMaterialMapTexture(layer, "normalMap");
  const roughnessMap = getMaterialMapTexture(layer, "roughnessMap");
  const metalnessMap = getMaterialMapTexture(layer, "metalnessMap");
  const program = gpu.materialProgram;
  const target = gpu.materialTarget;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
  gl.useProgram(program);
  bindTexture(program, "uComposite", compositeTexture, 0);
  bindTexture(program, "uColorMap", colorMap || compositeTexture, 1);
  bindTexture(program, "uNormalMap", normalMap || gpu.flatNormal, 2);
  bindTexture(program, "uRoughnessMap", roughnessMap || gpu.blackRoughness, 3);
  bindTexture(program, "uMetalnessMap", metalnessMap || gpu.blackMetalness, 4);
  gl.uniform1i(gl.getUniformLocation(program, "uUseColorMap"), colorMap ? 1 : 0);
  gl.uniform1i(gl.getUniformLocation(program, "uUseNormalMap"), normalMap ? 1 : 0);
  gl.uniform1i(gl.getUniformLocation(program, "uUseRoughnessMap"), roughnessMap ? 1 : 0);
  gl.uniform1i(gl.getUniformLocation(program, "uUseMetalnessMap"), metalnessMap ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(program, "uColorStrength"), Math.max(0, Number(material.colorStrength) || 0));
  gl.uniform1f(gl.getUniformLocation(program, "uNormalStrength"), Math.max(0, Number(material.normalStrength) || 0));
  gl.uniform1f(gl.getUniformLocation(program, "uBaseRoughness"), material.baseRoughness);
  gl.uniform1f(gl.getUniformLocation(program, "uRoughnessMapBlend"), material.roughnessMapBlend);
  gl.uniform1f(gl.getUniformLocation(program, "uBaseMetalness"), material.baseMetalness);
  gl.uniform1f(gl.getUniformLocation(program, "uMetalnessMapBlend"), material.metalnessMapBlend);
  gl.uniform1f(gl.getUniformLocation(program, "uTextureScale"), Math.max(0.001, Number(material.textureScale) || 1));
  gl.uniform1f(gl.getUniformLocation(program, "uTileEdgeBlend"), Math.max(0, Number(material.edgeBlendWidth) || 0));
  gl.uniform2f(
    gl.getUniformLocation(program, "uTextureOffset"),
    Number(material.textureOffsetX) || 0,
    Number(material.textureOffsetY) || 0,
  );
  gl.uniform1i(gl.getUniformLocation(program, "uLightType"), material.lightType === "point" ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(program, "uLightIntensity"), Math.max(0, Number(material.intensity) || 0));
  gl.uniform3f(
    gl.getUniformLocation(program, "uLightVector"),
    Number(material.directionX) || 0,
    Number(material.directionY) || 0,
    Number(material.directionZ) || 1,
  );
  gl.uniform3fv(gl.getUniformLocation(program, "uLightColor"), hexToRgb(material.color));
  gl.uniform1f(gl.getUniformLocation(program, "uAmbient"), Math.max(0, Number(material.ambient) || 0));
  drawFullscreen();
  return target.texture;
}

function getHeightMesh(resolution) {
  if (gpu.heightMeshes.has(resolution)) return gpu.heightMeshes.get(resolution);
  const vertexCount = (resolution + 1) * (resolution + 1);
  const vertices = new Float32Array(vertexCount * 4);
  let vertexOffset = 0;
  for (let y = 0; y <= resolution; y += 1) {
    const v = y / resolution;
    for (let x = 0; x <= resolution; x += 1) {
      const u = x / resolution;
      vertices[vertexOffset++] = u * 2 - 1;
      vertices[vertexOffset++] = v * 2 - 1;
      vertices[vertexOffset++] = u;
      vertices[vertexOffset++] = v;
    }
  }
  const indices = new Uint32Array(resolution * resolution * 6);
  let indexOffset = 0;
  const row = resolution + 1;
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const topLeft = y * row + x;
      indices[indexOffset++] = topLeft;
      indices[indexOffset++] = topLeft + 1;
      indices[indexOffset++] = topLeft + row;
      indices[indexOffset++] = topLeft + 1;
      indices[indexOffset++] = topLeft + row + 1;
      indices[indexOffset++] = topLeft + row;
    }
  }
  const vao = gl.createVertexArray();
  const vertexBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(gpu.vao);
  const mesh = { vao, vertexBuffer, indexBuffer, indexCount: indices.length };
  gpu.heightMeshes.set(resolution, mesh);
  return mesh;
}

function renderHeightLayer(layer, compositeTexture, heightMapTexture = layer.sourceTexture) {
  const height = normalizeHeight(layer.height);
  layer.height = height;
  const mesh = getHeightMesh(height.meshResolution);
  const program = gpu.heightProgram;
  gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.heightTarget.framebuffer);
  gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  bindTexture(program, "uComposite", compositeTexture, 0);
  bindTexture(program, "uHeightMap", heightMapTexture, 1);
  gl.uniform2f(
    gl.getUniformLocation(program, "uMeshTexel"),
    1 / height.meshResolution,
    1 / height.meshResolution,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uHeightStrength"), height.heightStrength);
  gl.uniform1f(gl.getUniformLocation(program, "uAutoSmooth"), height.autoSmooth ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(program, "uSmoothAngle"), height.smoothAngle);
  gl.uniform3f(
    gl.getUniformLocation(program, "uLightVector"),
    Number(height.directionX) || 0,
    Number(height.directionY) || 0,
    Number(height.directionZ) || 1,
  );
  gl.uniform3fv(gl.getUniformLocation(program, "uLightColor"), hexToRgb(height.color));
  gl.uniform1f(gl.getUniformLocation(program, "uLightIntensity"), height.intensity);
  gl.uniform1f(gl.getUniformLocation(program, "uAmbient"), height.ambient);
  gl.uniform3fv(gl.getUniformLocation(program, "uMaterialColor"), hexToRgb(height.materialColor));
  gl.uniform1f(gl.getUniformLocation(program, "uRoughness"), height.roughness);
  gl.uniform1f(gl.getUniformLocation(program, "uMetalness"), height.metalness);
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(gpu.vao);
  return gpu.heightTarget.texture;
}

const nativeFilterCompositor = {
  getInstanceTexture(filter) {
    return getFilterImageTexture(filter);
  },
};

const generateAlphaLockPass = {
  key: "generate-alpha-lock",
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tAlphaSource;
    varying vec2 vUv;
    void main() {
      vec4 generated = texture2D(tDiffuse, vUv);
      float sourceAlpha = texture2D(tAlphaSource, vUv).a;
      gl_FragColor = vec4(generated.rgb, sourceAlpha);
    }
  `,
};

function renderLayerFilters(layer, timeSeconds, sourceOverride = null, options = {}) {
  let source = sourceOverride || layer.sourceTexture;
  const penetrationSource = options.penetrationSource || gpu.transparentTexture;
  let targetIndex = 0;
  // Cards are stored and displayed top-to-bottom. Apply from the bottom card
  // upward so a newly added filter at the top is the final operation.
  const activeFilters = layer.filtersEnabled !== false
    ? layer.filters.filter((filter) => filter.enabled).reverse()
    : [];
  if (!activeFilters.length) return source;
  const animated = state.paintPointerId === null && activeFilters.some((filter) => filterUsesMotion(filter));
  const cacheable = !sourceOverride && !animated && !options.penetrationSource;
  const stableCacheKey = !sourceOverride ? filterCacheKey(layer, activeFilters) : null;
  if (
    cacheable
    && layer.filterCache?.width === gpu.renderWidth
    && layer.filterCache?.height === gpu.renderHeight
    && layer.filterCacheKey === stableCacheKey
  ) {
    return layer.filterCache.target.texture;
  }

  for (const filter of activeFilters) {
    const def = FILTER_DEFS.find((item) => item.id === filter.defId);
    if (!def) continue;
    const filterInput = source;
    for (const pass of def.passes) {
      const target = gpu.filterTargets[targetIndex];
      const compiled = getPassProgram(pass);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
      gl.useProgram(compiled.program);
      if (compiled.uniforms.tDiffuse) compiled.uniforms.tDiffuse.value = source;
      if (compiled.uniforms.uResolution) compiled.uniforms.uResolution.value.set(gpu.renderWidth, gpu.renderHeight);
      if (compiled.uniforms.uMatchRatio) {
        compiled.uniforms.uMatchRatio.value = def.group === "Generate" && layer.matchFilterRatio ? 1 : 0;
        compiled.uniforms.uAspectRatio.value = DOC_WIDTH / Math.max(1, DOC_HEIGHT);
      }
      pass.updateUniforms(compiled.uniforms, filter.params, timeSeconds, {
        instance: filter,
        compositor: nativeFilterCompositor,
        stack: activeFilters,
        penetrationSource,
      });
      uploadPassUniforms(compiled, source);
      drawFullscreen();
      source = target.texture;
      targetIndex = 1 - targetIndex;
    }
    if (def.group === "Generate" && filter.params.alphaLock === true) {
      const target = [...gpu.filterTargets, gpu.alphaLockTarget].find((candidate) => (
        candidate.texture !== source && candidate.texture !== filterInput
      ));
      if (!target) throw new Error("Unable to reserve a render target for Generate Alpha Lock.");
      const compiled = getPassProgram(generateAlphaLockPass);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
      gl.useProgram(compiled.program);
      compiled.uniforms.tDiffuse.value = source;
      compiled.uniforms.tAlphaSource.value = filterInput;
      uploadPassUniforms(compiled, source);
      drawFullscreen();
      source = target.texture;
      const alphaTargetIndex = gpu.filterTargets.indexOf(target);
      if (alphaTargetIndex !== -1) targetIndex = 1 - alphaTargetIndex;
    }
  }
  if (!sourceOverride) {
    ensureLayerFilterCache(layer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.filterCache.target.framebuffer);
    gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
    gl.useProgram(gpu.displayProgram);
    bindTexture(gpu.displayProgram, "uSource", source, 0);
    drawFullscreen();
    layer.filterCacheKey = stableCacheKey;
    return layer.filterCache.target.texture;
  }
  return source;
}

function layerUsesDerivativeDisplacement(layer) {
  return layer.kind !== "adjustment"
    && layer.filtersEnabled !== false
    && layer.filters.some((filter) => filter.enabled && filter.defId === "derivativeUv" && filter.params.penetrate === true);
}

function filterUsesMotion(filter) {
  const def = FILTER_DEFS.find((item) => item.id === filter.defId);
  if (!def?.passes.some((pass) => /uniform\s+float\s+uTime\b/.test(pass.fragmentShader || ""))) return false;
  if (filter.defId === "chroma") return filter.params.mode === "organic" && Number(filter.params.speed) > 0;
  if (filter.defId === "mirror") {
    return Number(filter.params.seamDrift) > 0 || Number(filter.params.seamNoise) > 0;
  }
  if (filter.defId === "filmEmulation") return Boolean(filter.params.grainAnimated);
  const motionControls = Object.entries(filter.params).filter(([key]) => /(speed|drift|animated)/i.test(key));
  return motionControls.length
    ? motionControls.some(([, value]) => value === true || Number(value) > 0)
    : true;
}

function filterCacheKey(layer, filters) {
  const compactParams = filters.map((filter) => [
    filter.id,
    filter.defId,
    Object.entries(filter.params).map(([key, value]) => [
      key,
      typeof value === "string" && value.startsWith("data:")
        ? `${value.length}:${value.slice(0, 32)}:${value.slice(-16)}`
        : value,
    ]),
  ]);
  const surfaceSettings = layer.kind === "height" ? layer.height : layer.kind === "material" ? layer.material : null;
  return `${gpu.renderWidth}x${gpu.renderHeight}:${layer.sourceRevision || 0}:${layer.matchFilterRatio ? 1 : 0}:${JSON.stringify(surfaceSettings)}:${JSON.stringify(compactParams)}`;
}

function ensureLayerFilterCache(layer) {
  if (layer.filterCache?.width === gpu.renderWidth && layer.filterCache?.height === gpu.renderHeight) return;
  destroyLayerFilterCache(layer);
  layer.filterCache = {
    width: gpu.renderWidth,
    height: gpu.renderHeight,
    target: createTarget(gpu.renderWidth, gpu.renderHeight),
  };
}

function destroyLayerFilterCache(layer) {
  if (layer?.filterCache?.target) destroyTarget(layer.filterCache.target);
  if (layer) {
    layer.filterCache = null;
    layer.filterCacheKey = null;
  }
}

function renderDocument(forcedSize = null) {
  state.renderQueued = false;
  if (state.restoringHistory) return;
  flushPendingPaintDabs();
  flushPendingMaskDabs();
  flushPendingPaintTransformPreview();
  flushPendingMaskTransformPreview();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.disable(gl.SCISSOR_TEST);
  ensureRenderTargetDimensions(forcedSize
    ? { width: DOC_WIDTH, height: DOC_HEIGHT }
    : getInteractiveRenderDimensions());
  if (forcedSize && typeof forcedSize === "object") {
    canvas.width = forcedSize.width;
    canvas.height = forcedSize.height;
  } else {
    resizeCanvas();
  }
  flushPendingMaskUploads();
  let baseTexture = gpu.compositeTargets[0].texture;
  let baseIndex = 0;
  gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.compositeTargets[0].framebuffer);
  gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  let previousLayerTexture = gpu.compositeTargets[0].texture;
  let renderedAnyLayer = false;
  const timeSeconds = state.motionTime;
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    ensureLayerGpuTextures(layer);
    if (!layer.sourceTexture) continue;
    const isAdjustment = layer.kind === "adjustment";
    const isMaterial = layer.kind === "material";
    const isHeight = layer.kind === "height";
    if (isAdjustment && !renderedAnyLayer) continue;
    if ((isMaterial || isHeight) && !renderedAnyLayer) continue;
    const transformPreview = state.paintTransformStroke?.layerId === layer.id
      ? state.paintTransformStroke.previewTexture
      : null;
    const materialTexture = isMaterial ? renderMaterialLayer(layer, baseTexture) : null;
    const heightTexture = isHeight
      ? renderHeightLayer(layer, baseTexture, transformPreview || layer.sourceTexture)
      : null;
    const adjustmentStart = isAdjustment ? getAdjustmentStartLayer(layer) : null;
    const hasCustomRange = isAdjustment && hasCustomAdjustmentStart(layer);
    const adjustmentSource = adjustmentStart && hasCustomRange
      ? renderNormalCompositeBefore(state.layers.indexOf(adjustmentStart) + 1).texture
      : baseTexture;
    const derivativeDisplacement = layerUsesDerivativeDisplacement(layer);
    const layerTexture = renderLayerFilters(
      layer,
      timeSeconds,
      isAdjustment ? adjustmentSource : (materialTexture || heightTexture || transformPreview),
      (isAdjustment || derivativeDisplacement)
        ? { penetrationSource: isAdjustment ? adjustmentSource : baseTexture }
        : undefined,
    );
    const targetIndex = 1 - baseIndex;
    const target = gpu.compositeTargets[targetIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
    gl.useProgram(gpu.compositeProgram);
    bindTexture(gpu.compositeProgram, "uBase", baseTexture, 0);
    bindTexture(gpu.compositeProgram, "uLayer", layerTexture, 1);
    const visibleMask = state.transformStroke?.layerId === layer.id
      ? state.transformStroke.previewMask
      : layer.mask;
    bindTexture(gpu.compositeProgram, "uMask", visibleMask?.texture || gpu.whiteMask, 2);
    bindTexture(gpu.compositeProgram, "uClip", previousLayerTexture, 3);
    gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uOpacity"), layer.opacity);
    const blendModeId = layer.id === state.selectedLayerId && state.blendPreviewMode !== null
      ? state.blendPreviewMode
      : layer.blendMode;
    gl.uniform1i(
      gl.getUniformLocation(gpu.compositeProgram, "uMode"),
      BLEND_MODE_CODES[blendModeId] ?? 0,
    );
    gl.uniform1i(gl.getUniformLocation(gpu.compositeProgram, "uUseMask"), visibleMask ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(gpu.compositeProgram, "uMaskEnabled"), visibleMask?.enabled ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskSoftness"), visibleMask?.softness ?? 0);
    gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskOpacity"), visibleMask?.opacity ?? 1);
    gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskContrast"), visibleMask?.contrast ?? 0);
    gl.uniform2f(gl.getUniformLocation(gpu.compositeProgram, "uMaskTexel"), 1 / DOC_WIDTH, 1 / DOC_HEIGHT);
    gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskRoughenAmount"), visibleMask?.roughenAmount ?? 0);
    gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskRoughenWidth"), visibleMask?.roughenWidth ?? 8);
    gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskRoughenScale"), visibleMask?.roughenScale ?? 24);
    gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskRoughenSharpness"), visibleMask?.roughenSharpness ?? 1);
    gl.uniform1i(gl.getUniformLocation(gpu.compositeProgram, "uClipDown"), layer.clipDown && renderedAnyLayer ? 1 : 0);
    drawFullscreen();
    baseTexture = target.texture;
    baseIndex = targetIndex;
    previousLayerTexture = isAdjustment ? target.texture : layerTexture;
    renderedAnyLayer = true;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(gpu.displayProgram);
  bindTexture(gpu.displayProgram, "uSource", baseTexture, 0);
  drawFullscreen();
}

function requestRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(renderDocument);
}

function clearBlendModePreview() {
  if (state.blendPreviewMode === null) return;
  state.blendPreviewMode = null;
  requestRender();
}

function hasAnimatedFilters() {
  return state.layers.some((layer) => layer.visible && layer.filtersEnabled !== false && layer.filters.some(
    (filter) => filter.enabled && filterUsesMotion(filter),
  ));
}

function animationLoop(timestamp) {
  const elapsed = Math.min(0.1, Math.max(0, (timestamp - state.lastMotionTimestamp) / 1000));
  state.lastMotionTimestamp = timestamp;
  if (!state.effectsPaused) state.motionTime += elapsed;
  if (
    state.paintPointerId === null
    && !state.effectsPaused
    && hasAnimatedFilters()
    && timestamp - state.lastAnimatedRender >= 1000 / 30
  ) {
    state.lastAnimatedRender = timestamp;
    requestRender();
  }
  requestAnimationFrame(animationLoop);
}

function syncMotionButton() {
  motionButton.classList.toggle("active", state.effectsPaused);
  motionButton.title = state.effectsPaused ? "Resume animated filters" : "Pause animated filters";
  motionButtonLabel.textContent = state.effectsPaused ? "Play FX" : "Pause FX";
  motionButtonIcon.innerHTML = state.effectsPaused
    ? '<path d="m7 4.5 7 5.5-7 5.5z"/>'
    : '<path d="M6.5 4.5v11M13.5 4.5v11"/>';
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(2, Math.round(rect.width * ratio));
  const height = Math.max(2, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSelectedLayer() {
  return state.layers.find((layer) => layer.id === state.selectedLayerId) || null;
}

function createMaskFramebuffer(texture) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Unable to create a complete mask framebuffer.");
  }
  return framebuffer;
}

function createMaskGpuTextures(mask, data) {
  if (mask.framebuffer) gl.deleteFramebuffer(mask.framebuffer);
  if (mask.scratchFramebuffer) gl.deleteFramebuffer(mask.scratchFramebuffer);
  mask.texture = createTexture(DOC_WIDTH, DOC_HEIGHT, data, gl.R8, gl.RED);
  mask.scratchTexture = createTexture(DOC_WIDTH, DOC_HEIGHT, data, gl.R8, gl.RED);
  mask.framebuffer = createMaskFramebuffer(mask.texture);
  mask.scratchFramebuffer = createMaskFramebuffer(mask.scratchTexture);
}

function createMask(fillValue = 255) {
  const data = new Uint8Array(DOC_WIDTH * DOC_HEIGHT);
  data.fill(fillValue);
  const mask = {
    enabled: true,
    initialized: false,
    data,
    undo: [],
    redo: [],
    softness: 0,
    opacity: 1,
    contrast: 0,
    roughenAmount: 0,
    roughenWidth: 8,
    roughenScale: 24,
    roughenSharpness: 1,
  };
  createMaskGpuTextures(mask, data);
  return mask;
}

function defaultFilterParams(defId) {
  const def = FILTER_DEFS.find((item) => item.id === defId);
  if (!def) throw new Error(`Unknown filter type: ${defId}`);
  const params = defaultParamsFor(defId);
  if (def.group === "Generate") params.alphaLock = false;
  return params;
}

function createFilter(defId) {
  const def = FILTER_DEFS.find((item) => item.id === defId);
  if (!def) throw new Error(`Unknown filter type: ${defId}`);
  return {
    id: uid("filter"),
    defId,
    enabled: true,
    collapsed: false,
    params: defaultFilterParams(defId),
  };
}

function cloneFilterForPaste(filter) {
  return {
    id: uid("filter"),
    defId: filter.defId,
    enabled: filter.enabled !== false,
    collapsed: false,
    params: cloneHistoryValue(filter.params),
  };
}

function normalizeStoredFilter(stored) {
  const legacyMap = {
    exposure: {
      defId: "basicTone",
      params: {
        brightness: Math.max(-1, Math.min(1, Number(stored.params?.exposure || 0) * 0.25)),
        contrast: Number(stored.params?.contrast || 0),
      },
    },
    hsl: { defId: "hueSaturation", params: stored.params },
    grain: {
      defId: "filmEmulation",
      params: {
        grain: Math.max(0, Math.min(1, Number(stored.params?.amount || 0) * 3)),
        grainSize: Number(stored.params?.scale || 1.4),
      },
    },
    chromatic: {
      defId: "chroma",
      params: {
        amount: Math.max(0, Math.min(0.2, Number(stored.params?.offset || 0) / DOC_WIDTH)),
        direction: Number(stored.params?.angle || 0),
        mode: "linear",
      },
    },
    posterize: {
      defId: "pixelate",
      params: {
        size: Math.max(1, Math.round(26 - Number(stored.params?.levels || 8))),
      },
    },
    roughEdges: {
      defId: "roughenEdges",
      params: {
        amount: Number(stored.params?.roughness ?? 0.45),
        width: Number(stored.params?.radius ?? 8),
        scale: Number(stored.params?.scale ?? 24),
        sharpness: Number(stored.params?.strength ?? 1),
      },
    },
  };
  const migrated = legacyMap[stored.defId] || { defId: stored.defId, params: stored.params };
  const def = FILTER_DEFS.find((item) => item.id === migrated.defId);
  if (!def) return null;
  return {
    id: stored.id || uid("filter"),
    defId: def.id,
    enabled: stored.enabled !== false,
    collapsed: stored.collapsed === true,
    params: { ...defaultFilterParams(def.id), ...migrated.params },
  };
}

function makeSourceCanvas(image) {
  const source = document.createElement("canvas");
  source.width = DOC_WIDTH;
  source.height = DOC_HEIGHT;
  const ctx = source.getContext("2d", { alpha: true, willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, DOC_WIDTH, DOC_HEIGHT);
  const scale = Math.min(DOC_WIDTH / image.naturalWidth, DOC_HEIGHT / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  ctx.drawImage(image, (DOC_WIDTH - width) / 2, (DOC_HEIGHT - height) / 2, width, height);
  return source;
}

function textureFromCanvas(source) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return texture;
}

function createLayerFramebuffer(texture) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Unable to create a complete paint framebuffer.");
  }
  return framebuffer;
}

function ensurePaintLayerGpu(layer) {
  if (layer.paintScratchTexture) return;
  layer.paintFramebuffer = createLayerFramebuffer(layer.sourceTexture);
  layer.paintScratchTexture = createTexture(DOC_WIDTH, DOC_HEIGHT);
  layer.paintScratchFramebuffer = createLayerFramebuffer(layer.paintScratchTexture);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.paintFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.paintScratchFramebuffer);
  gl.blitFramebuffer(
    0, 0, DOC_WIDTH, DOC_HEIGHT,
    0, 0, DOC_WIDTH, DOC_HEIGHT,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
}

function stampPaintLayerGpu(layer, dabs, color, erasing, brushStyle, brushSeed) {
  if (!dabs.length) return;
  ensurePaintLayerGpu(layer);
  const x0 = Math.max(0, Math.floor(Math.min(...dabs.map((dab) => dab.x - dab.radius))));
  const x1 = Math.min(DOC_WIDTH, Math.ceil(Math.max(...dabs.map((dab) => dab.x + dab.radius))));
  const y0 = Math.max(0, Math.floor(Math.min(...dabs.map((dab) => dab.y - dab.radius))));
  const y1 = Math.min(DOC_HEIGHT, Math.ceil(Math.max(...dabs.map((dab) => dab.y + dab.radius))));
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.paintFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.paintScratchFramebuffer);
  gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.paintScratchFramebuffer);
  gl.viewport(0, 0, DOC_WIDTH, DOC_HEIGHT);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(x0, y0, x1 - x0, y1 - y0);
  gl.useProgram(gpu.paintBrushProgram);
  bindTexture(gpu.paintBrushProgram, "uSource", layer.sourceTexture, 0);
  bindBrushTexture(gpu.paintBrushProgram, getBrushPreset(), 1);
  gl.uniform2f(gl.getUniformLocation(gpu.paintBrushProgram, "uResolution"), DOC_WIDTH, DOC_HEIGHT);
  gl.uniform3f(gl.getUniformLocation(gpu.paintBrushProgram, "uColor"), color[0] / 255, color[1] / 255, color[2] / 255);
  gl.uniform4fv(
    gl.getUniformLocation(gpu.paintBrushProgram, "uDabs[0]"),
    new Float32Array(dabs.flatMap((dab) => [dab.x, dab.y, dab.radius, dab.opacity])),
  );
  gl.uniform1i(gl.getUniformLocation(gpu.paintBrushProgram, "uDabCount"), dabs.length);
  gl.uniform1i(gl.getUniformLocation(gpu.paintBrushProgram, "uBrushStyle"), brushStyle);
  gl.uniform1f(gl.getUniformLocation(gpu.paintBrushProgram, "uBrushSeed"), brushSeed);
  gl.uniform1f(gl.getUniformLocation(gpu.paintBrushProgram, "uEdgeBlend"), state.brush.edgeBlend);
  gl.uniform1f(gl.getUniformLocation(gpu.paintBrushProgram, "uErase"), erasing ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(gpu.paintBrushProgram, "uAlphaLock"), layer.alphaLock ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(gpu.paintBrushProgram, "uForceOpaque"), layer.kind === "height" ? 1 : 0);
  drawFullscreen();
  gl.disable(gl.SCISSOR_TEST);
  // Only the dirty rectangle is copied into the scratch target. Copy its result back
  // instead of swapping whole textures, which would expose stale pixels elsewhere.
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.paintScratchFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.paintFramebuffer);
  gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  layer.sourceRevision = (layer.sourceRevision || 0) + 1;
}

function clampPressureSetting(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
}

function pressureOutput(pressure, minimum, response) {
  const normalizedPressure = clampPressureSetting(pressure, 0, 1, 0.5);
  const curvedPressure = Math.pow(normalizedPressure, response);
  return minimum + (1 - minimum) * curvedPressure;
}

function brushRadiusForPressure(pressure) {
  return Math.max(
    1,
    state.brush.size * pressureOutput(pressure, state.pressure.sizeMinimum, state.pressure.sizeResponse) * 0.5,
  );
}

function fixedBrushRadius() {
  return Math.max(1, state.brush.size * 0.5);
}

function brushOpacityForPressure(pressure) {
  return state.brush.opacity * pressureOutput(
    pressure,
    state.pressure.opacityMinimum,
    state.pressure.opacityResponse,
  );
}

function queuePaintPoint(layer, point) {
  const preset = getBrushPreset();
  const heightValue = Math.round(Math.max(0, Math.min(1, state.brush.value)) * 255);
  const color = layer.kind === "height"
    ? [heightValue, heightValue, heightValue]
    : hsvToRgb(state.paintColor.h, state.paintColor.s, state.paintColor.v);
  const brushStyle = BRUSH_STYLE_CODES[preset.style] ?? 0;
  const colorChanged = state.pendingPaintColor
    && state.pendingPaintColor.some((channel, index) => channel !== color[index]);
  if (
    state.pendingPaintDabs.length
    && (
      state.pendingPaintErase !== state.eraserPressed
      || colorChanged
      || state.pendingPaintStyle !== brushStyle
      || state.pendingPaintSeed !== preset.seed
    )
  ) {
    flushPendingPaintDabs();
  }
  const pressure = Math.max(0.08, point.pressure);
  const addDab = (sample) => {
    const samplePressure = Math.max(0.08, sample.pressure);
    const dab = {
      x: sample.x,
      y: sample.y,
      radius: brushRadiusForPressure(samplePressure),
      opacity: brushOpacityForPressure(samplePressure),
    };
    const dirty = {
      x0: Math.max(0, Math.floor(dab.x - dab.radius)),
      y0: Math.max(0, Math.floor(dab.y - dab.radius)),
      x1: Math.min(DOC_WIDTH, Math.ceil(dab.x + dab.radius)),
      y1: Math.min(DOC_HEIGHT, Math.ceil(dab.y + dab.radius)),
    };
    state.paintStrokeDirty = mergeDirty(state.paintStrokeDirty, dirty);
    state.pendingPaintDabs.push(dab);
  };
  if (state.pendingPaintLayerId && state.pendingPaintLayerId !== layer.id) flushPendingPaintDabs();
  state.pendingPaintLayerId = layer.id;
  state.pendingPaintColor = color;
  state.pendingPaintErase = state.eraserPressed;
  state.pendingPaintStyle = brushStyle;
  state.pendingPaintSeed = preset.seed;
  const previous = state.lastPaintPoint;
  if (!previous) {
    addDab(point);
  } else {
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    if (distance < 0.01) return;
    const spacing = Math.max(0.75, state.brush.size * PAINT_BRUSH_SPACING_RATIO);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      addDab({
        x: previous.x + (point.x - previous.x) * t,
        y: previous.y + (point.y - previous.y) * t,
        pressure: previous.pressure + (pressure - previous.pressure) * t,
      });
    }
  }
  state.lastPaintPoint = { ...point, pressure };
  requestRender();
}

function flushPendingPaintDabs() {
  if (!state.pendingPaintDabs.length || !state.pendingPaintLayerId) return;
  const layer = state.layers.find((item) => item.id === state.pendingPaintLayerId);
  if (!layer?.sourceTexture) {
    state.pendingPaintDabs = [];
    state.pendingPaintLayerId = null;
    return;
  }
  while (state.pendingPaintDabs.length) {
    stampPaintLayerGpu(
      layer,
      state.pendingPaintDabs.splice(0, MAX_PAINT_DABS_PER_BATCH),
      state.pendingPaintColor,
      state.pendingPaintErase,
      state.pendingPaintStyle,
      state.pendingPaintSeed,
    );
  }
}

function syncPaintLayerCanvasFromGpu(layer, dirty = null) {
  if (!layer.paintFramebuffer) return;
  const x0 = dirty ? Math.max(0, Math.floor(dirty.x0)) : 0;
  const y0 = dirty ? Math.max(0, Math.floor(dirty.y0)) : 0;
  const x1 = dirty ? Math.min(DOC_WIDTH, Math.ceil(dirty.x1)) : DOC_WIDTH;
  const y1 = dirty ? Math.min(DOC_HEIGHT, Math.ceil(dirty.y1)) : DOC_HEIGHT;
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.paintFramebuffer);
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(x0, y0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const context = layer.sourceCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
  const image = context.createImageData(width, height);
  const rowLength = width * 4;
  for (let y = 0; y < height; y += 1) {
    image.data.set(pixels.subarray((height - 1 - y) * rowLength, (height - y) * rowLength), y * rowLength);
  }
  context.putImageData(image, x0, DOC_HEIGHT - y1);
}

function schedulePaintLayerSerialization(layer) {
  layer.sourceDataUrlDirty = true;
  window.clearTimeout(layer.sourceSerializationTimer);
  const revision = layer.sourceRevision;
  layer.sourceSerializationTimer = window.setTimeout(() => {
    layer.sourceCanvas.toBlob((blob) => {
      if (!blob || layer.sourceRevision !== revision) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (layer.sourceRevision !== revision) return;
        layer.sourceDataUrl = String(reader.result);
        layer.sourceDataUrlDirty = false;
        scheduleSave();
      };
      reader.readAsDataURL(blob);
    }, "image/png");
  }, 1200);
}

function hasDirtyPaintLayerDataUrls() {
  return state.layers.some((layer) => (layer.kind === "paint" || layer.kind === "height") && layer.sourceDataUrlDirty);
}

function flushDirtyPaintLayerDataUrls() {
  state.layers.forEach((layer) => {
    if ((layer.kind !== "paint" && layer.kind !== "height") || !layer.sourceDataUrlDirty) return;
    window.clearTimeout(layer.sourceSerializationTimer);
    layer.sourceDataUrl = canvasToPortableDataUrl(layer.sourceCanvas);
    layer.sourceDataUrlDirty = false;
  });
}

function canvasToPortableDataUrl(source) {
  return source.toDataURL("image/png");
}

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${url.slice(0, 80)}`));
    image.src = url;
  });
}

function createLayerFromSourceCanvas(sourceCanvas, name, options = {}) {
  const layer = {
    id: options.id || uid("layer"),
    name,
    kind: options.kind || "paint",
    visible: options.visible ?? true,
    opacity: options.opacity ?? 1,
    blendMode: options.blendMode || "normal",
    clipDown: options.clipDown ?? false,
    alphaLock: options.alphaLock ?? false,
    filtersEnabled: options.filtersEnabled ?? true,
    matchFilterRatio: options.matchFilterRatio ?? false,
    adjustmentStartLayerId: options.adjustmentStartLayerId ?? null,
    sourceDataUrl: options.sourceDataUrl || sourceCanvas.toDataURL("image/png"),
    sourceCanvas,
    sourceTexture: textureFromCanvas(sourceCanvas),
    sourceRevision: 0,
    thumbnail: options.thumbnail || sourceCanvas.toDataURL("image/png"),
    thumbnailDirty: true,
    mask: options.mask === null ? null : createMask(),
    filters: options.filters || [],
    material: options.kind === "material" ? normalizeMaterial(options.material) : null,
    height: options.kind === "height" ? normalizeHeight(options.height) : null,
  };
  if (options.maskData && layer.mask) {
    layer.mask.data.set(options.maskData);
    layer.mask.initialized = options.maskInitialized ?? true;
    layer.mask.enabled = options.maskEnabled ?? true;
    layer.mask.softness = options.maskSoftness ?? 0;
    layer.mask.opacity = options.maskOpacity ?? 1;
    layer.mask.contrast = options.maskContrast ?? 0;
    layer.mask.roughenAmount = options.maskRoughenAmount ?? 0;
    layer.mask.roughenWidth = options.maskRoughenWidth ?? 8;
    layer.mask.roughenScale = options.maskRoughenScale ?? 24;
    layer.mask.roughenSharpness = options.maskRoughenSharpness ?? 1;
    uploadFullMask(layer.mask);
  }
  return layer;
}

async function createLayerFromImage(url, name, options = {}) {
  const image = await loadImage(url);
  if (options.nativeDimensions) setDocumentDimensions(image.naturalWidth, image.naturalHeight);
  const sourceCanvas = makeSourceCanvas(image);
  return createLayerFromSourceCanvas(sourceCanvas, name, {
    ...options,
    kind: options.kind || "image",
    sourceDataUrl: options.sourceDataUrl || canvasToPortableDataUrl(sourceCanvas),
  });
}

function destroyLayerGpu(layer) {
  window.clearTimeout(layer.sourceSerializationTimer);
  destroyLayerFilterCache(layer);
  if (layer.sourceTexture) gl.deleteTexture(layer.sourceTexture);
  if (layer.paintScratchTexture) gl.deleteTexture(layer.paintScratchTexture);
  if (layer.paintFramebuffer) gl.deleteFramebuffer(layer.paintFramebuffer);
  if (layer.paintScratchFramebuffer) gl.deleteFramebuffer(layer.paintScratchFramebuffer);
  if (layer.mask?.texture) gl.deleteTexture(layer.mask.texture);
  if (layer.mask?.scratchTexture) gl.deleteTexture(layer.mask.scratchTexture);
  if (layer.mask?.framebuffer) gl.deleteFramebuffer(layer.mask.framebuffer);
  if (layer.mask?.scratchFramebuffer) gl.deleteFramebuffer(layer.mask.scratchFramebuffer);
  ["_colorMapTexture", "_normalMapTexture", "_roughnessMapTexture", "_metalnessMapTexture"].forEach((key) => {
    if (layer[key]) gl.deleteTexture(layer[key]);
  });
}

function textureThumbnail(texture) {
  const target = gpu.thumbnailTarget;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, 64, 64);
  gl.useProgram(gpu.displayProgram);
  bindTexture(gpu.displayProgram, "uSource", texture, 0);
  drawFullscreen();
  const pixels = new Uint8Array(64 * 64 * 4);
  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const preview = document.createElement("canvas");
  preview.width = 64;
  preview.height = 64;
  const context = preview.getContext("2d");
  const image = context.createImageData(64, 64);
  for (let y = 0; y < 64; y += 1) {
    const sourceOffset = (63 - y) * 64 * 4;
    const targetOffset = y * 64 * 4;
    image.data.set(pixels.subarray(sourceOffset, sourceOffset + 64 * 4), targetOffset);
  }
  context.putImageData(image, 0, 0);
  return preview.toDataURL("image/png");
}

function refreshLayerThumbnail(layer) {
  if (!layer.thumbnailDirty || !layer.sourceTexture || layer.kind === "adjustment" || layer.kind === "material") return;
  layer.thumbnail = textureThumbnail(renderLayerFilters(layer, state.motionTime));
  layer.thumbnailDirty = false;
}

function invalidateLayerThumbnail(layer) {
  if (layer && layer.kind !== "adjustment" && layer.kind !== "material") layer.thumbnailDirty = true;
}

function uploadFullMask(mask) {
  state.pendingMaskUploads.delete(mask);
  [mask.texture, mask.scratchTexture].forEach((texture) => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DOC_WIDTH, DOC_HEIGHT, gl.RED, gl.UNSIGNED_BYTE, mask.data);
  });
}

function uploadMaskRegion(mask, dirty) {
  const x0 = Math.max(0, Math.floor(dirty.x0));
  const y0 = Math.max(0, Math.floor(dirty.y0));
  const x1 = Math.min(DOC_WIDTH, Math.ceil(dirty.x1));
  const y1 = Math.min(DOC_HEIGHT, Math.ceil(dirty.y1));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return;
  gl.bindTexture(gl.TEXTURE_2D, mask.texture);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, DOC_WIDTH);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, width, height, gl.RED, gl.UNSIGNED_BYTE, mask.data);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
}

function queueMaskUpload(mask, dirty) {
  const regions = state.pendingMaskUploads.get(mask) || [];
  let merged = { ...dirty };
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index];
    const overlaps = merged.x0 <= region.x1 + 8
      && merged.x1 + 8 >= region.x0
      && merged.y0 <= region.y1 + 8
      && merged.y1 + 8 >= region.y0;
    if (!overlaps) continue;
    merged = mergeDirty(merged, region);
    regions.splice(index, 1);
  }
  regions.push(merged);
  state.pendingMaskUploads.set(mask, regions);
  requestRender();
}

function flushPendingMaskUploads() {
  state.pendingMaskUploads.forEach((regions, mask) => {
    regions.forEach((dirty) => uploadMaskRegion(mask, dirty));
  });
  state.pendingMaskUploads.clear();
}

function fillMaskGpu(mask, value) {
  [mask.framebuffer, mask.scratchFramebuffer].forEach((framebuffer) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, DOC_WIDTH, DOC_HEIGHT);
    gl.clearColor(value / 255, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  });
}

function clearMask(mask) {
  state.pendingMaskUploads.delete(mask);
  mask.data.fill(255);
  mask.initialized = false;
  fillMaskGpu(mask, 255);
}

function stampMaskGpu(mask, dabs, target, dirty) {
  if (!dabs.length) return;
  const preset = getBrushPreset();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mask.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, mask.scratchFramebuffer);
  gl.blitFramebuffer(dirty.x0, dirty.y0, dirty.x1, dirty.y1, dirty.x0, dirty.y0, dirty.x1, dirty.y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, mask.scratchFramebuffer);
  gl.viewport(0, 0, DOC_WIDTH, DOC_HEIGHT);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(dirty.x0, dirty.y0, dirty.x1 - dirty.x0, dirty.y1 - dirty.y0);
  gl.useProgram(gpu.maskBrushProgram);
  bindTexture(gpu.maskBrushProgram, "uMaskSource", mask.texture, 0);
  bindBrushTexture(gpu.maskBrushProgram, preset, 1);
  gl.uniform2f(gl.getUniformLocation(gpu.maskBrushProgram, "uResolution"), DOC_WIDTH, DOC_HEIGHT);
  gl.uniform4fv(
    gl.getUniformLocation(gpu.maskBrushProgram, "uDabs[0]"),
    new Float32Array(dabs.flatMap((dab) => [dab.x, dab.y, dab.radius, dab.opacity])),
  );
  gl.uniform1i(gl.getUniformLocation(gpu.maskBrushProgram, "uDabCount"), dabs.length);
  gl.uniform1f(gl.getUniformLocation(gpu.maskBrushProgram, "uTarget"), target / 255);
  gl.uniform1i(gl.getUniformLocation(gpu.maskBrushProgram, "uBrushStyle"), BRUSH_STYLE_CODES[preset.style] ?? 0);
  gl.uniform1f(gl.getUniformLocation(gpu.maskBrushProgram, "uBrushSeed"), preset.seed);
  gl.uniform1f(gl.getUniformLocation(gpu.maskBrushProgram, "uEdgeBlend"), state.brush.edgeBlend);
  drawFullscreen();
  gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mask.scratchFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, mask.framebuffer);
  gl.blitFramebuffer(dirty.x0, dirty.y0, dirty.x1, dirty.y1, dirty.x0, dirty.y0, dirty.x1, dirty.y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
}

function queueMaskDab(layer, mask, point, radius, opacity, target, dirty) {
  if (
    state.pendingMaskDabs.length
    && (state.pendingMaskLayerId !== layer.id || state.pendingMaskTarget !== target)
  ) {
    flushPendingMaskDabs();
  }
  state.pendingMaskLayerId = layer.id;
  state.pendingMaskTarget = target;
  const dab = { x: point.x, y: point.y, radius, opacity, dirty };
  state.pendingMaskDabs.push(dab);
  requestRender();
}

function flushPendingMaskDabs() {
  if (!state.pendingMaskDabs.length || !state.pendingMaskLayerId) return;
  const layer = state.layers.find((item) => item.id === state.pendingMaskLayerId);
  const mask = layer?.mask;
  if (!mask?.enabled) {
    state.pendingMaskDabs = [];
    state.pendingMaskLayerId = null;
    state.pendingMaskTarget = null;
    return;
  }
  while (state.pendingMaskDabs.length) {
    const dabs = state.pendingMaskDabs.splice(0, MAX_PAINT_DABS_PER_BATCH);
    const dirty = dabs.reduce((region, dab) => mergeDirty(region, dab.dirty), null);
    stampMaskGpu(mask, dabs, state.pendingMaskTarget, dirty);
  }
  state.pendingMaskLayerId = null;
  state.pendingMaskTarget = null;
}

function syncMaskTilesFromGpu(mask, tiles) {
  if (!tiles.length) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, mask.framebuffer);
  tiles.forEach((tile) => {
    const pixels = new Uint8Array(tile.width * tile.height);
    gl.readPixels(tile.x, tile.y, tile.width, tile.height, gl.RED, gl.UNSIGNED_BYTE, pixels);
    for (let row = 0; row < tile.height; row += 1) {
      mask.data.set(pixels.subarray(row * tile.width, (row + 1) * tile.width), (tile.y + row) * DOC_WIDTH + tile.x);
    }
  });
}

function syncHistoryButtons() {
  document.getElementById("undoButton").disabled = state.historyIndex <= 0;
  document.getElementById("redoButton").disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
}

function pointerToDocument(event) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width * DOC_WIDTH;
  const y = (1 - (event.clientY - rect.top) / rect.height) * DOC_HEIGHT;
  const reportedPressure = Number.isFinite(event.pressure) ? event.pressure : 0.5;
  const pressure = event.pointerType === "mouse" ? 0.68 : Math.max(0.08, reportedPressure);
  return { x, y, pressure };
}

function mergeDirty(a, b) {
  if (!a) return { ...b };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function brushHash(x, y, seed) {
  const value = Math.sin((x * 12.9898 + y * 78.233 + seed * 37.719) * 0.013) * 43758.5453;
  return value - Math.floor(value);
}

function brushSmoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function brushNoise(x, y, seed) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const tx = brushSmoothstep(0, 1, x - cellX);
  const ty = brushSmoothstep(0, 1, y - cellY);
  const a = brushHash(cellX, cellY, seed);
  const b = brushHash(cellX + 1, cellY, seed);
  const c = brushHash(cellX, cellY + 1, seed);
  const d = brushHash(cellX + 1, cellY + 1, seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function brushFbm(x, y, seed) {
  let value = 0;
  let weight = 0.58;
  for (let octave = 0; octave < 3; octave += 1) {
    value += brushNoise(x, y, seed + octave * 17) * weight;
    [x, y] = [1.72 * x + 1.08 * y + 7.13, -1.08 * x + 1.72 * y + 7.13];
    weight *= 0.5;
  }
  return value / 1.015;
}

function brushLine(phase, width) {
  return 1 - brushSmoothstep(width, width + 0.055, Math.abs(Math.sin(phase)));
}

function brushCellDot(x, y, density, radius, seed, jitter) {
  const gridX = x * density;
  const gridY = y * density;
  const cellX = Math.floor(gridX + 0.5);
  const cellY = Math.floor(gridY + 0.5);
  const offsetX = (brushHash(cellX, cellY, seed) - 0.5) * jitter;
  const offsetY = (brushHash(cellY + 19.7, cellX + 19.7, seed + 11) - 0.5) * jitter;
  return 1 - brushSmoothstep(radius, radius + 0.055, Math.hypot(gridX - cellX - offsetX, gridY - cellY - offsetY));
}

function brushSegment(x, y, ax, ay, bx, by, width) {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const lengthSquared = Math.max(0.0001, bax * bax + bay * bay);
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / lengthSquared));
  const distance = Math.hypot(pax - bax * h, pay - bay * h);
  return 1 - brushSmoothstep(width, width + 0.018, distance);
}

function brushTextureStrength(style, x, y, distance, seed) {
  const angle = Math.atan2(y, x);
  const radial = Math.max(0, 1 - distance);
  const disc = 1 - brushSmoothstep(0.975, 1, distance);
  if (style === "soft") return Math.pow(Math.max(0, 1 - distance * distance), 2);
  if (style === "hard") return disc;
  if (style === "rough") {
    const edge = 0.79 + brushFbm(Math.cos(angle) * 4.5, Math.sin(angle) * 4.5, seed) * 0.2;
    const body = 1 - brushSmoothstep(edge - 0.045, edge + 0.025, distance);
    const abrasion = brushSmoothstep(0.42, 0.69, brushFbm(x * 10, y * 10, seed + 5));
    return body * (0.28 + abrasion * 0.72);
  }
  if (style === "ragged") {
    const edge = 0.68 + brushFbm(Math.cos(angle) * 6.5, Math.sin(angle) * 6.5, seed) * 0.29;
    const shell = 1 - brushSmoothstep(edge - 0.035, edge + 0.02, distance);
    const flakes = brushSmoothstep(0.37, 0.61, brushFbm(x * 6, y * 6, seed + 13));
    const chips = brushSmoothstep(0.54, 0.73, brushNoise(x * 19, y * 19, seed + 3));
    return shell * Math.max(flakes, chips * 0.72);
  }
  if (style === "pencil") {
    const cloud = brushSmoothstep(0.38, 0.64, brushFbm(x * 7, y * 7, seed));
    const particulate = brushSmoothstep(0.56, 0.78, brushNoise(x * 29, y * 29, seed + 7));
    return Math.pow(radial, 0.72) * Math.max(cloud * 0.62, particulate);
  }
  if (style === "charcoal") {
    const deposits = brushSmoothstep(0.28, 0.55, brushFbm(x * 3.3, y * 3.3, seed));
    const breakup = brushSmoothstep(0.38, 0.7, brushFbm(x * 11, y * 11, seed + 9));
    return Math.pow(radial, 0.5) * deposits * (0.55 + breakup * 0.45);
  }
  if (style === "dry") {
    const streaks = brushSmoothstep(0.43, 0.61, brushNoise(x * 1.7, y * 22, seed));
    const breaks = brushSmoothstep(0.35, 0.62, brushFbm(x * 5, y * 1.5, seed + 4));
    return Math.pow(radial, 0.72) * streaks * breaks;
  }
  if (style === "ink") {
    const smear = 0.3 + brushFbm(x * 3, y * 7, seed) * 0.7;
    const pooled = 1 - brushSmoothstep(0.055, 0.12, Math.abs(distance - (0.67 + brushNoise(x * 4, y * 4, seed) * 0.08)));
    return Math.pow(radial, 0.32) * Math.min(1, smear * 0.76 + pooled * 0.55);
  }
  if (style === "spatter") {
    let pits = brushCellDot(x, y, 5, 0.27, seed, 0.68);
    pits = Math.max(pits, brushCellDot(x, y, 11, 0.16, seed + 17, 0.72) * 0.82);
    const gate = brushSmoothstep(0.28, 0.62, brushFbm(x * 3, y * 3, seed + 5));
    return disc * pits * gate;
  }
  if (style === "bristle") {
    const row = Math.floor(y * 15 + 0.5);
    const width = 0.2 + brushHash(row, 3, seed) * 0.22;
    const line = brushLine(y * 47.1, width);
    const broken = brushSmoothstep(0.28, 0.5, brushNoise(x * 8, row * 0.21, seed + 8));
    return Math.pow(radial, 0.58) * line * broken;
  }
  if (style === "marker") {
    const islands = brushSmoothstep(0.31, 0.57, brushFbm(x * 4.8, y * 4.8, seed));
    const fracture = brushSmoothstep(0.4, 0.66, brushNoise(x * 17, y * 17, seed + 5));
    return disc * islands * (0.48 + fracture * 0.52);
  }
  if (style === "scratch") {
    const primary = brushLine(y * 43 + x * 5, 0.26);
    const secondary = brushLine(y * 79 - x * 3.5, 0.16) * 0.7;
    const lengths = brushSmoothstep(0.25, 0.5, brushNoise(x * 7, Math.floor(y * 17), seed));
    return Math.pow(radial, 0.62) * Math.max(primary, secondary) * lengths;
  }
  if (style === "cloud") {
    const body = brushSmoothstep(0.26, 0.66, brushFbm(x * 2.6, y * 2.6, seed));
    const grain = brushNoise(x * 18, y * 18, seed + 9);
    return Math.pow(radial, 0.48) * body * (0.56 + grain * 0.44);
  }
  if (style === "stipple") {
    let pores = brushCellDot(x, y, 7, 0.25, seed, 0.78);
    pores = Math.max(pores, brushCellDot(x, y, 14, 0.13, seed + 23, 0.85) * 0.72);
    return disc * pores;
  }
  if (style === "fur") {
    const fibers = brushLine(y * 58 + x * 9, 0.27);
    const fragments = brushSmoothstep(0.32, 0.55, brushNoise(x * 13, y * 3, seed));
    return Math.pow(radial, 0.68) * fibers * fragments;
  }
  if (style === "square") {
    const warp = brushLine(x * 31, 0.2);
    const weft = brushLine(y * 27, 0.2);
    const overUnder = Math.abs((Math.floor(x * 9.8) + Math.floor(y * 8.6)) % 2);
    return disc * Math.max(warp * (0.5 + overUnder * 0.5), weft * (1 - overUnder * 0.5));
  }
  if (style === "noise") {
    const gridX = x * 7;
    const gridY = y * 7;
    const cellX = Math.floor(gridX + 0.5);
    const cellY = Math.floor(gridY + 0.5);
    const offsetX = (brushHash(cellX, cellY, seed) - 0.5) * 0.48;
    const offsetY = (brushHash(cellY, cellX, seed + 9) - 0.5) * 0.48;
    const pebble = Math.hypot(gridX - cellX - offsetX, gridY - cellY - offsetY);
    const ridge = 1 - brushSmoothstep(0.31, 0.44, Math.abs(pebble - (0.39 + brushHash(cellX, cellY, seed + 2) * 0.12)));
    return disc * (0.22 + ridge * 0.78);
  }
  if (style === "watercolor") {
    const distortion = (brushFbm(x * 4, y * 4, seed) - 0.5) * 0.12;
    const ringA = 1 - brushSmoothstep(0.025, 0.07, Math.abs(distance + distortion - 0.72));
    const ringB = 1 - brushSmoothstep(0.02, 0.055, Math.abs(distance + distortion * 0.7 - 0.48));
    const crystals = brushSmoothstep(0.58, 0.76, brushNoise(x * 24, y * 24, seed + 12));
    return disc * Math.max(ringA, ringB * 0.65, crystals * radial * 0.72);
  }
  if (style === "bloom") {
    const distortion = (brushNoise(angle * 4, distance * 5, seed) - 0.5) * 0.08;
    const bandA = 1 - brushSmoothstep(0.04, 0.095, Math.abs(distance + distortion - 0.38));
    const bandB = 1 - brushSmoothstep(0.04, 0.1, Math.abs(distance - distortion - 0.68));
    const breaks = brushSmoothstep(0.32, 0.6, brushNoise(angle * 3, 1, seed + 7));
    return disc * Math.max(bandA, bandB * 0.82) * (0.3 + breaks * 0.7);
  }
  if (style === "torn") {
    const sheets = brushSmoothstep(0.32, 0.55, brushFbm(x * 3.8, y * 3.8, seed));
    const edgeCrust = brushSmoothstep(0.04, 0.13, Math.abs(brushFbm(x * 8, y * 8, seed + 3) - 0.53));
    return disc * Math.max(sheets, (1 - edgeCrust) * 0.52);
  }
  if (style === "lineFine") {
    return Math.pow(radial, 0.55) * brushLine(y * 67 + brushNoise(x * 4, 1, seed) * 0.7, 0.26);
  }
  if (style === "lineWide") {
    const broad = brushLine(y * 25, 0.38);
    const fine = brushLine(y * 73 + x * 1.7, 0.18) * 0.68;
    const breaks = 0.4 + brushNoise(x * 9, y * 2, seed) * 0.6;
    return Math.pow(radial, 0.5) * Math.max(broad, fine) * breaks;
  }
  if (style === "crosshatch") {
    return disc * Math.max(brushLine((x + y) * 28, 0.19), brushLine((x - y) * 28, 0.19));
  }
  if (style === "gridFine") {
    return disc * Math.max(brushLine(x * 47, 0.16), brushLine(y * 47, 0.16));
  }
  if (style === "gridBold") {
    const forward = brushLine((x + y) * 16, 0.2);
    const backward = brushLine((x - y) * 16, 0.2);
    const segment = brushSmoothstep(0.18, 0.42, Math.abs(Math.sin((x - y) * 8)));
    return disc * Math.max(forward * segment, backward * (1 - segment));
  }
  if (style === "dotMatrix") return disc * brushCellDot(x, y, 6.2, 0.24, seed, 0);
  if (style === "microDots") return disc * brushCellDot(x, y, 11.5, 0.17, seed, 0);
  if (style === "sparseDots" || style === "offsetDots") {
    const density = style === "sparseDots" ? 3.7 : 5.4;
    const row = Math.floor(y * density + 0.5);
    const offset = style === "offsetDots" && Math.abs(row) % 2 === 1 ? 0.5 : 0;
    const gridX = x * density + offset;
    const gridY = y * density;
    const headDistance = Math.hypot(gridX - Math.floor(gridX + 0.5), gridY - Math.floor(gridY + 0.5));
    const head = 1 - brushSmoothstep(0.25, 0.31, headDistance);
    const rim = 1 - brushSmoothstep(0.04, 0.09, Math.abs(headDistance - 0.27));
    return disc * Math.max(head * 0.72, rim);
  }
  if (style === "chevron") {
    const gridX = x * 3.2;
    const gridY = y * 5.4;
    let cellX = gridX - Math.floor(gridX + 0.5);
    const cellY = gridY - Math.floor(gridY + 0.5);
    const row = Math.floor(gridY + 0.5);
    if (Math.abs(row) % 2 === 1) cellX *= -1;
    const lug = Math.abs(cellY - Math.abs(cellX) * 0.48);
    const shape = (1 - brushSmoothstep(0.12, 0.18, lug)) * (1 - brushSmoothstep(0.28, 0.39, Math.abs(cellX)));
    return disc * shape;
  }
  if (style === "scratchGouges") {
    let gouges = brushSegment(x, y, -0.86, -0.48, 0.82, 0.35, 0.052);
    gouges = Math.max(gouges, brushSegment(x, y, -0.78, -0.26, 0.7, 0.46, 0.031));
    gouges = Math.max(gouges, brushSegment(x, y, -0.72, -0.66, 0.55, -0.02, 0.023));
    gouges = Math.max(gouges, brushSegment(x, y, -0.42, 0.18, 0.48, 0.62, 0.018));
    const chipRegion = 1 - brushSmoothstep(0.18, 0.42, Math.hypot(x + 0.58, y + 0.36));
    const chips = brushCellDot(x + 0.58, y + 0.36, 10, 0.19, seed, 0.65) * chipRegion;
    return Math.max(gouges, chips * 0.72);
  }
  if (style === "scratchClaw") {
    let claw = brushSegment(x, y, -0.78, -0.58, -0.12, -0.18, 0.038);
    claw = Math.max(claw, brushSegment(x, y, -0.12, -0.18, 0.68, -0.3, 0.025));
    claw = Math.max(claw, brushSegment(x, y, -0.82, -0.28, -0.08, 0.03, 0.035));
    claw = Math.max(claw, brushSegment(x, y, -0.08, 0.03, 0.76, -0.02, 0.022));
    claw = Math.max(claw, brushSegment(x, y, -0.78, 0.02, -0.02, 0.25, 0.032));
    claw = Math.max(claw, brushSegment(x, y, -0.02, 0.25, 0.7, 0.3, 0.02));
    claw = Math.max(claw, brushSegment(x, y, -0.66, 0.32, 0.02, 0.48, 0.026));
    return Math.max(claw, brushSegment(x, y, 0.02, 0.48, 0.56, 0.58, 0.016));
  }
  if (style === "scratchCross") {
    let cross = brushSegment(x, y, -0.82, -0.62, 0.78, 0.55, 0.038);
    cross = Math.max(cross, brushSegment(x, y, -0.68, 0.62, 0.66, -0.58, 0.032));
    cross = Math.max(cross, brushSegment(x, y, -0.72, 0.18, 0.12, -0.42, 0.017));
    cross = Math.max(cross, brushSegment(x, y, -0.12, 0.58, 0.52, 0.05, 0.015));
    const chips = brushCellDot(x, y, 8, 0.2, seed, 0.45) * (1 - brushSmoothstep(0.12, 0.54, distance));
    return Math.max(cross, chips);
  }
  if (style === "scratchCrack") {
    let crack = brushSegment(x, y, -0.72, -0.58, -0.3, -0.18, 0.031);
    crack = Math.max(crack, brushSegment(x, y, -0.3, -0.18, 0.02, -0.02, 0.027));
    crack = Math.max(crack, brushSegment(x, y, 0.02, -0.02, 0.34, 0.28, 0.022));
    crack = Math.max(crack, brushSegment(x, y, 0.34, 0.28, 0.72, 0.62, 0.016));
    crack = Math.max(crack, brushSegment(x, y, -0.3, -0.18, -0.56, 0.28, 0.018));
    crack = Math.max(crack, brushSegment(x, y, -0.56, 0.28, -0.78, 0.48, 0.012));
    crack = Math.max(crack, brushSegment(x, y, 0.02, -0.02, 0.32, -0.5, 0.016));
    crack = Math.max(crack, brushSegment(x, y, 0.32, -0.5, 0.58, -0.72, 0.01));
    return Math.max(crack, brushSegment(x, y, 0.34, 0.28, 0.72, 0.1, 0.012));
  }
  if (style === "scratchSweep") {
    let sweep = brushSegment(x, y, -0.82, 0.22, -0.35, -0.18, 0.04);
    sweep = Math.max(sweep, brushSegment(x, y, -0.35, -0.18, 0.22, -0.3, 0.035));
    sweep = Math.max(sweep, brushSegment(x, y, 0.22, -0.3, 0.78, -0.12, 0.021));
    sweep = Math.max(sweep, brushSegment(x, y, -0.72, 0.42, -0.2, 0.06, 0.024));
    sweep = Math.max(sweep, brushSegment(x, y, -0.2, 0.06, 0.58, 0.04, 0.017));
    sweep = Math.max(sweep, brushSegment(x, y, -0.52, 0.58, 0.1, 0.3, 0.014));
    return Math.max(sweep, brushSegment(x, y, 0.1, 0.3, 0.64, 0.38, 0.011));
  }
  if (style === "scratchImpact") {
    let impact = brushSegment(x, y, -0.05, -0.04, 0.8, 0.12, 0.025);
    impact = Math.max(impact, brushSegment(x, y, -0.04, -0.03, 0.56, 0.62, 0.022));
    impact = Math.max(impact, brushSegment(x, y, -0.04, -0.03, 0.04, -0.78, 0.019));
    impact = Math.max(impact, brushSegment(x, y, -0.05, -0.04, -0.72, -0.48, 0.021));
    impact = Math.max(impact, brushSegment(x, y, -0.05, -0.04, -0.62, 0.48, 0.016));
    impact = Math.max(impact, brushSegment(x, y, 0.14, 0.02, 0.48, -0.38, 0.012));
    const chips = brushCellDot(x, y, 8.5, 0.22, seed, 0.55) * (1 - brushSmoothstep(0.18, 0.48, distance));
    return Math.max(impact, chips);
  }
  if (style === "texturePaintScrape") {
    const qx = 0.9 * x + 0.44 * y;
    const qy = -0.44 * x + 0.9 * y;
    const edgeNoise = (brushFbm(qx * 4.5, qy * 4.5, seed) - 0.5) * 0.22;
    const envelope = 1 - brushSmoothstep(0.86 + edgeNoise, 0.94 + edgeNoise, Math.hypot(qx / 1.18, qy / 0.5));
    const plates = brushSmoothstep(0.35, 0.6, brushFbm(qx * 5.5, qy * 5.5, seed + 7));
    const fracture = brushSmoothstep(0.42, 0.68, brushNoise(qx * 18, qy * 18, seed + 19));
    let score = brushSegment(qx, qy, -0.88, -0.08, 0.78, 0.12, 0.026);
    score = Math.max(score, brushSegment(qx, qy, -0.62, 0.18, 0.48, 0.3, 0.014));
    const chips = brushCellDot(qx, qy, 10, 0.17, seed + 29, 0.8) * envelope;
    return envelope * Math.max(plates * (0.38 + fracture * 0.62), score, chips * 0.72);
  }
  if (style === "textureRustGouge") {
    const qx = 0.82 * x - 0.57 * y;
    const qy = 0.57 * x + 0.82 * y;
    const trenchDistance = Math.abs(qy + Math.sin(qx * 3.2) * 0.09);
    const trench = 1 - brushSmoothstep(0.12, 0.3, trenchDistance);
    const lengthGate = 1 - brushSmoothstep(0.7, 0.98, Math.abs(qx));
    const corrosion = brushSmoothstep(0.25, 0.61, brushFbm(qx * 6, qy * 6, seed));
    const pores = brushCellDot(qx, qy, 8.5, 0.23, seed + 17, 0.82);
    const sideCrust = 1 - brushSmoothstep(0.025, 0.09, Math.abs(trenchDistance - 0.22));
    const debrisGate = 1 - brushSmoothstep(0.3, 0.5, trenchDistance);
    const fragments = brushCellDot(qx + 0.1, qy + 0.26, 13, 0.14, seed + 31, 0.9) * debrisGate;
    return lengthGate * Math.max(trench * (0.35 + corrosion * 0.65), sideCrust * 0.82, pores * trench, fragments * 0.58);
  }
  if (style === "textureDryDrag") {
    const qx = 0.96 * x + 0.28 * y;
    const qy = -0.28 * x + 0.96 * y;
    const envelope = (1 - brushSmoothstep(0.72, 0.98, Math.abs(qx))) * (1 - brushSmoothstep(0.3, 0.62, Math.abs(qy)));
    const broad = brushSmoothstep(0.32, 0.57, brushFbm(qx * 4, qy * 11, seed));
    const streaks = brushLine(qy * 54 + brushNoise(qx * 8, 1, seed + 5) * 1.4, 0.25);
    const dropout = brushSmoothstep(0.3, 0.63, brushNoise(qx * 9, qy * 2.2, seed + 13));
    const dust = brushCellDot(qx - 0.52, qy, 14, 0.13, seed + 23, 0.9)
      * (1 - brushSmoothstep(0.18, 0.62, Math.hypot(qx + 0.52, qy)));
    return Math.max(envelope * broad * Math.max(streaks, dropout * 0.52), dust * 0.8);
  }
  if (style === "textureSplinterTear") {
    const qx = 0.88 * x - 0.48 * y;
    const qy = 0.48 * x + 0.88 * y;
    const taper = Math.max(0.08, Math.min(0.88, (0.92 - qx) * 0.55));
    const wedge = (1 - brushSmoothstep(taper, taper + 0.08, Math.abs(qy)))
      * (1 - brushSmoothstep(0.78, 0.96, Math.abs(qx)));
    const plates = brushSmoothstep(0.34, 0.58, brushFbm(qx * 5, qy * 5, seed));
    const fibers = brushLine(qy * 38 + qx * 5, 0.23);
    let splits = brushSegment(qx, qy, -0.82, -0.3, 0.7, 0.08, 0.018);
    splits = Math.max(splits, brushSegment(qx, qy, -0.68, 0.32, 0.62, 0.18, 0.014));
    const shards = brushCellDot(qx - 0.55, qy, 11, 0.18, seed + 27, 0.85)
      * (1 - brushSmoothstep(0.14, 0.5, Math.hypot(qx - 0.55, qy)));
    return Math.max(wedge * Math.max(plates * 0.88, fibers * 0.76, splits), shards * 0.72);
  }
  if (style === "textureOxidizedScuff") {
    const qx = 0.94 * x + 0.34 * y;
    const qy = -0.34 * x + 0.94 * y;
    const ellipse = Math.hypot(qx / 1.12, qy / 0.62);
    const edgeWarp = (brushFbm(qx * 5, qy * 5, seed) - 0.5) * 0.16;
    const body = 1 - brushSmoothstep(0.82 + edgeWarp, 0.94 + edgeWarp, ellipse);
    const rim = 1 - brushSmoothstep(0.035, 0.1, Math.abs(ellipse + edgeWarp - 0.78));
    const mottling = brushSmoothstep(0.3, 0.62, brushFbm(qx * 6.5, qy * 6.5, seed + 9));
    const pits = brushCellDot(qx, qy, 9, 0.22, seed + 21, 0.82);
    const scrape = brushSegment(qx, qy, -0.72, -0.12, 0.68, 0.18, 0.02);
    return body * Math.max(mottling * 0.72, rim, pits * 0.85, scrape);
  }
  if (style === "textureHeavyScore") {
    const qx = 0.84 * x + 0.54 * y;
    const qy = -0.54 * x + 0.84 * y;
    const curve = qy + Math.sin(qx * 2.8) * 0.075;
    const lengthGate = 1 - brushSmoothstep(0.72, 0.98, Math.abs(qx));
    const trench = 1 - brushSmoothstep(0.055, 0.16, Math.abs(curve));
    const burrA = 1 - brushSmoothstep(0.018, 0.065, Math.abs(curve - 0.22));
    const burrB = 1 - brushSmoothstep(0.018, 0.065, Math.abs(curve + 0.2));
    const breakup = brushSmoothstep(0.28, 0.59, brushFbm(qx * 7, qy * 13, seed));
    const debris = brushCellDot(qx, qy, 12, 0.15, seed + 33, 0.9)
      * (1 - brushSmoothstep(0.15, 0.46, Math.abs(curve)));
    return lengthGate * Math.max(trench * (0.45 + breakup * 0.55), Math.max(burrA, burrB) * 0.9, debris * 0.68);
  }
  return 1 - distance * distance * (3 - 2 * distance);
}

function brushEdgeFade(distance) {
  const edgeBlend = Math.max(0, Math.min(1, Number(state.brush.edgeBlend) || 0));
  if (edgeBlend <= 0) return 1;
  const width = 0.035 + (0.3 - 0.035) * edgeBlend;
  return 1 - brushSmoothstep(1 - width, 1, distance);
}

function stampMask(mask, point, erasing = state.eraserPressed) {
  const layer = getSelectedLayer();
  const pressure = Math.max(0.08, point.pressure);
  const radius = brushRadiusForPressure(pressure);
  const opacity = brushOpacityForPressure(pressure);
  const target = erasing ? 0 : state.brush.value * 255;
  const x0 = Math.max(0, Math.floor(point.x - radius));
  const x1 = Math.min(DOC_WIDTH - 1, Math.ceil(point.x + radius));
  const y0 = Math.max(0, Math.floor(point.y - radius));
  const y1 = Math.min(DOC_HEIGHT - 1, Math.ceil(point.y + radius));
  const dirty = { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  captureStrokeHistoryTiles(mask, dirty);
  queueMaskDab(layer, mask, point, radius, opacity, target, dirty);
  state.gpuMaskStrokeLayerId = layer?.id || null;
  return dirty;
}

function captureStrokeHistoryTiles(mask, dirty) {
  const history = state.strokeHistory;
  const layer = getSelectedLayer();
  if (!history || history.layerId !== layer?.id || layer.mask !== mask) return;
  if (!history.baseFramebuffer) {
    history.baseTexture = createTexture(DOC_WIDTH, DOC_HEIGHT, null, gl.R8, gl.RED);
    history.baseFramebuffer = createLayerFramebuffer(history.baseTexture);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mask.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, history.baseFramebuffer);
    gl.blitFramebuffer(
      0,
      0,
      DOC_WIDTH,
      DOC_HEIGHT,
      0,
      0,
      DOC_WIDTH,
      DOC_HEIGHT,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
  }
  const x0 = Math.max(0, Math.floor(dirty.x0 / MASK_HISTORY_TILE_SIZE) * MASK_HISTORY_TILE_SIZE);
  const y0 = Math.max(0, Math.floor(dirty.y0 / MASK_HISTORY_TILE_SIZE) * MASK_HISTORY_TILE_SIZE);
  const x1 = Math.min(DOC_WIDTH, Math.ceil(dirty.x1 / MASK_HISTORY_TILE_SIZE) * MASK_HISTORY_TILE_SIZE);
  const y1 = Math.min(DOC_HEIGHT, Math.ceil(dirty.y1 / MASK_HISTORY_TILE_SIZE) * MASK_HISTORY_TILE_SIZE);
  for (let y = y0; y < y1; y += MASK_HISTORY_TILE_SIZE) {
    for (let x = x0; x < x1; x += MASK_HISTORY_TILE_SIZE) {
      const width = Math.min(MASK_HISTORY_TILE_SIZE, DOC_WIDTH - x);
      const height = Math.min(MASK_HISTORY_TILE_SIZE, DOC_HEIGHT - y);
      const key = `${x}:${y}`;
      if (history.tiles.has(key)) continue;
      history.tiles.set(key, { x, y, width, height });
    }
  }
}

function disposeMaskStrokeHistory(history) {
  if (!history?.baseFramebuffer) return;
  gl.deleteFramebuffer(history.baseFramebuffer);
  gl.deleteTexture(history.baseTexture);
  history.baseFramebuffer = null;
  history.baseTexture = null;
}

function readMaskHistoryTiles(framebuffer, tiles) {
  const pixelsByTile = new Map();
  if (!framebuffer) return pixelsByTile;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  tiles.forEach((tile) => {
    const pixels = new Uint8Array(tile.width * tile.height);
    gl.readPixels(tile.x, tile.y, tile.width, tile.height, gl.RED, gl.UNSIGNED_BYTE, pixels);
    pixelsByTile.set(`${tile.x}:${tile.y}`, pixels);
  });
  return pixelsByTile;
}

function sampleQuadratic(p0, p1, p2, spacing, callback) {
  const length = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const steps = Math.max(1, Math.ceil(length / spacing));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    callback({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
      pressure: mt * mt * p0.pressure + 2 * mt * t * p1.pressure + t * t * p2.pressure,
    });
  }
}

function paintSamples(events) {
  const layer = getSelectedLayer();
  const mask = layer?.mask;
  if (!mask || !mask.enabled || state.selectionPart !== "mask") return;
  let dirty = null;
  for (const event of events) {
    const point = pointerToDocument(event);
    state.strokePoints.push(point);
    const points = state.strokePoints;
    const spacing = Math.max(1.5, state.brush.size * 0.12);
    if (points.length === 1) {
      dirty = mergeDirty(dirty, stampMask(mask, point));
    } else if (points.length === 2) {
      sampleQuadratic(points[0], points[0], points[1], spacing, (sample) => {
        dirty = mergeDirty(dirty, stampMask(mask, sample));
      });
    } else {
      const a = points[points.length - 3];
      const b = points[points.length - 2];
      const c = points[points.length - 1];
      const p0 = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, pressure: (a.pressure + b.pressure) * 0.5 };
      const p2 = { x: (b.x + c.x) * 0.5, y: (b.y + c.y) * 0.5, pressure: (b.pressure + c.pressure) * 0.5 };
      sampleQuadratic(p0, b, p2, spacing, (sample) => {
        dirty = mergeDirty(dirty, stampMask(mask, sample));
      });
      if (points.length > 4) points.shift();
    }
  }
  if (dirty) {
    if (state.gpuMaskStrokeLayerId === layer.id) requestRender();
    else queueMaskUpload(mask, dirty);
  }
}

function uploadPaintLayerSource(layer) {
  gl.bindTexture(gl.TEXTURE_2D, layer.sourceTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, layer.sourceCanvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  layer.sourceRevision = (layer.sourceRevision || 0) + 1;
  requestRender();
}

function blendPaintPixel(layer, pixels, x, y, strength, color, erasing = state.eraserPressed) {
  const canvasY = DOC_HEIGHT - 1 - y;
  const index = (canvasY * DOC_WIDTH + x) * 4;
  const destinationAlpha = pixels.data[index + 3] / 255;
  const sourceAlpha = Math.min(1, strength);
  if (erasing) {
    const outputAlpha = destinationAlpha * (1 - sourceAlpha);
    if (outputAlpha <= 0) {
      pixels.data[index] = 0;
      pixels.data[index + 1] = 0;
      pixels.data[index + 2] = 0;
      pixels.data[index + 3] = 0;
    } else {
      pixels.data[index + 3] = Math.round(outputAlpha * 255);
    }
    return;
  }
  if (layer.alphaLock && destinationAlpha === 0) return;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (!outputAlpha) return;
  for (let channel = 0; channel < 3; channel += 1) {
    pixels.data[index + channel] = Math.round(
      (color[channel] * sourceAlpha + pixels.data[index + channel] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
    );
  }
  pixels.data[index + 3] = Math.round(outputAlpha * 255);
}

function paintLayerStamp(layer, point, erasing = state.eraserPressed) {
  queuePaintPoint(layer, point);
}

function getPaintTransformGeometry(center, endpoint, directionMode) {
  const deltaX = endpoint.x - center.x;
  const deltaY = endpoint.y - center.y;
  const dragLength = Math.hypot(deltaX, deltaY);
  const angle = dragLength > 3 ? Math.atan2(deltaY, deltaX) : 0;
  const axisX = Math.cos(angle);
  const axisY = Math.sin(angle);
  const baseRadius = fixedBrushRadius();
  const halfLength = directionMode ? Math.max(baseRadius, dragLength) : Math.max(1, dragLength);
  const halfWidth = directionMode ? baseRadius : halfLength;
  const shapeCenter = directionMode
    ? { x: center.x + axisX * halfLength * 0.5, y: center.y + axisY * halfLength * 0.5 }
    : center;
  const extent = Math.ceil(Math.hypot(directionMode ? halfLength * 0.5 : halfLength, halfWidth));
  const x0 = Math.max(0, Math.floor(shapeCenter.x - extent));
  const y0 = Math.max(0, Math.floor(shapeCenter.y - extent));
  return {
    axisX,
    axisY,
    halfLength,
    halfWidth,
    x0,
    y0,
    x1: Math.min(DOC_WIDTH, Math.ceil(shapeCenter.x + extent)),
    y1: Math.min(DOC_HEIGHT, Math.ceil(shapeCenter.y + extent)),
  };
}

function createPaintTransformStroke(layer, center, directionMode, erasing) {
  ensurePaintLayerGpu(layer);
  const baseTexture = createTexture(DOC_WIDTH, DOC_HEIGHT);
  const baseFramebuffer = createLayerFramebuffer(baseTexture);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.paintFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, baseFramebuffer);
  gl.blitFramebuffer(
    0,
    0,
    DOC_WIDTH,
    DOC_HEIGHT,
    0,
    0,
    DOC_WIDTH,
    DOC_HEIGHT,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  const largestSide = Math.max(DOC_WIDTH, DOC_HEIGHT);
  const previewScale = Math.min(1, TRANSFORM_PREVIEW_MAX_DIMENSION / largestSide);
  const previewWidth = Math.max(1, Math.round(DOC_WIDTH * previewScale));
  const previewHeight = Math.max(1, Math.round(DOC_HEIGHT * previewScale));
  const previewBaseTexture = createTexture(previewWidth, previewHeight);
  const previewBaseFramebuffer = createLayerFramebuffer(previewBaseTexture);
  const previewTexture = createTexture(previewWidth, previewHeight);
  const previewFramebuffer = createLayerFramebuffer(previewTexture);
  gl.bindFramebuffer(gl.FRAMEBUFFER, previewBaseFramebuffer);
  gl.viewport(0, 0, previewWidth, previewHeight);
  gl.useProgram(gpu.displayProgram);
  bindTexture(gpu.displayProgram, "uSource", baseTexture, 0);
  drawFullscreen();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previewBaseFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previewFramebuffer);
  gl.blitFramebuffer(
    0,
    0,
    previewWidth,
    previewHeight,
    0,
    0,
    previewWidth,
    previewHeight,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  return {
    layerId: layer.id,
    center,
    endpoint: center,
    directionMode,
    erasing,
    baseTexture,
    baseFramebuffer,
    previewTexture,
    previewFramebuffer,
    previewBaseTexture,
    previewBaseFramebuffer,
    previewWidth,
    previewHeight,
    previewDirty: null,
    previewPending: false,
  };
}

function createMaskTransformStroke(layer, mask, center, directionMode, erasing) {
  const largestSide = Math.max(DOC_WIDTH, DOC_HEIGHT);
  const previewScale = Math.min(1, TRANSFORM_PREVIEW_MAX_DIMENSION / largestSide);
  const previewWidth = Math.max(1, Math.round(DOC_WIDTH * previewScale));
  const previewHeight = Math.max(1, Math.round(DOC_HEIGHT * previewScale));
  const previewBaseTexture = createTexture(previewWidth, previewHeight, null, gl.R8, gl.RED);
  const previewBaseFramebuffer = createLayerFramebuffer(previewBaseTexture);
  const previewTexture = createTexture(previewWidth, previewHeight, null, gl.R8, gl.RED);
  const previewFramebuffer = createLayerFramebuffer(previewTexture);
  gl.bindFramebuffer(gl.FRAMEBUFFER, previewBaseFramebuffer);
  gl.viewport(0, 0, previewWidth, previewHeight);
  gl.useProgram(gpu.displayProgram);
  bindTexture(gpu.displayProgram, "uSource", mask.texture, 0);
  drawFullscreen();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previewBaseFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previewFramebuffer);
  gl.blitFramebuffer(
    0,
    0,
    previewWidth,
    previewHeight,
    0,
    0,
    previewWidth,
    previewHeight,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  return {
    layerId: layer.id,
    center,
    endpoint: center,
    directionMode,
    erasing,
    sourceMask: mask,
    previewMask: { ...mask, texture: previewTexture },
    previewTexture,
    previewFramebuffer,
    previewBaseTexture,
    previewBaseFramebuffer,
    previewWidth,
    previewHeight,
    previewDirty: null,
    previewPending: false,
  };
}

function disposeMaskTransformStroke(transform) {
  if (!transform) return;
  gl.deleteFramebuffer(transform.previewFramebuffer);
  gl.deleteTexture(transform.previewTexture);
  gl.deleteFramebuffer(transform.previewBaseFramebuffer);
  gl.deleteTexture(transform.previewBaseTexture);
}

function disposePaintTransformStroke(transform) {
  if (!transform) return;
  gl.deleteFramebuffer(transform.baseFramebuffer);
  gl.deleteTexture(transform.baseTexture);
  gl.deleteFramebuffer(transform.previewFramebuffer);
  gl.deleteTexture(transform.previewTexture);
  gl.deleteFramebuffer(transform.previewBaseFramebuffer);
  gl.deleteTexture(transform.previewBaseTexture);
}

function scaleTransformDirty(dirty, transform) {
  return {
    x0: Math.max(0, Math.floor(dirty.x0 * transform.previewWidth / DOC_WIDTH)),
    y0: Math.max(0, Math.floor(dirty.y0 * transform.previewHeight / DOC_HEIGHT)),
    x1: Math.min(transform.previewWidth, Math.ceil(dirty.x1 * transform.previewWidth / DOC_WIDTH)),
    y1: Math.min(transform.previewHeight, Math.ceil(dirty.y1 * transform.previewHeight / DOC_HEIGHT)),
  };
}

function drawPaintTransformBrush(layer, targetFramebuffer, sourceTexture, targetWidth, targetHeight, transform, geometry, dirty) {
  const opacity = brushOpacityForPressure(transform.center.pressure);
  const preset = getBrushPreset();
  const heightValue = Math.round(Math.max(0, Math.min(1, state.brush.value)) * 255);
  const color = layer.kind === "height"
    ? [heightValue, heightValue, heightValue]
    : hsvToRgb(state.paintColor.h, state.paintColor.s, state.paintColor.v);
  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
  gl.viewport(0, 0, targetWidth, targetHeight);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(dirty.x0, dirty.y0, dirty.x1 - dirty.x0, dirty.y1 - dirty.y0);
  gl.useProgram(gpu.paintTransformProgram);
  bindTexture(gpu.paintTransformProgram, "uSource", sourceTexture, 0);
  bindBrushTexture(gpu.paintTransformProgram, preset, 1);
  gl.uniform2f(gl.getUniformLocation(gpu.paintTransformProgram, "uResolution"), DOC_WIDTH, DOC_HEIGHT);
  gl.uniform2f(gl.getUniformLocation(gpu.paintTransformProgram, "uCenter"), transform.center.x, transform.center.y);
  gl.uniform2f(gl.getUniformLocation(gpu.paintTransformProgram, "uAxis"), geometry.axisX, geometry.axisY);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uHalfLength"), geometry.halfLength);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uHalfWidth"), geometry.halfWidth);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uDirectionMode"), transform.directionMode ? 1 : 0);
  gl.uniform3f(gl.getUniformLocation(gpu.paintTransformProgram, "uColor"), color[0] / 255, color[1] / 255, color[2] / 255);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uOpacity"), opacity);
  gl.uniform1i(gl.getUniformLocation(gpu.paintTransformProgram, "uBrushStyle"), BRUSH_STYLE_CODES[preset.style] ?? 0);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uBrushSeed"), preset.seed);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uEdgeBlend"), state.brush.edgeBlend);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uErase"), transform.erasing ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uAlphaLock"), layer.alphaLock ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(gpu.paintTransformProgram, "uForceOpaque"), layer.kind === "height" ? 1 : 0);
  drawFullscreen();
  gl.disable(gl.SCISSOR_TEST);
}

function drawMaskTransformBrush(targetFramebuffer, sourceTexture, targetWidth, targetHeight, transform, geometry, dirty) {
  const opacity = brushOpacityForPressure(transform.center.pressure);
  const target = transform.erasing ? 0 : state.brush.value;
  const preset = getBrushPreset();
  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
  gl.viewport(0, 0, targetWidth, targetHeight);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(dirty.x0, dirty.y0, dirty.x1 - dirty.x0, dirty.y1 - dirty.y0);
  gl.useProgram(gpu.maskTransformProgram);
  bindTexture(gpu.maskTransformProgram, "uMaskSource", sourceTexture, 0);
  bindBrushTexture(gpu.maskTransformProgram, preset, 1);
  gl.uniform2f(gl.getUniformLocation(gpu.maskTransformProgram, "uResolution"), DOC_WIDTH, DOC_HEIGHT);
  gl.uniform2f(gl.getUniformLocation(gpu.maskTransformProgram, "uCenter"), transform.center.x, transform.center.y);
  gl.uniform2f(gl.getUniformLocation(gpu.maskTransformProgram, "uAxis"), geometry.axisX, geometry.axisY);
  gl.uniform1f(gl.getUniformLocation(gpu.maskTransformProgram, "uHalfLength"), geometry.halfLength);
  gl.uniform1f(gl.getUniformLocation(gpu.maskTransformProgram, "uHalfWidth"), geometry.halfWidth);
  gl.uniform1f(gl.getUniformLocation(gpu.maskTransformProgram, "uDirectionMode"), transform.directionMode ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(gpu.maskTransformProgram, "uTarget"), target);
  gl.uniform1f(gl.getUniformLocation(gpu.maskTransformProgram, "uOpacity"), opacity);
  gl.uniform1i(gl.getUniformLocation(gpu.maskTransformProgram, "uBrushStyle"), BRUSH_STYLE_CODES[preset.style] ?? 0);
  gl.uniform1f(gl.getUniformLocation(gpu.maskTransformProgram, "uBrushSeed"), preset.seed);
  gl.uniform1f(gl.getUniformLocation(gpu.maskTransformProgram, "uEdgeBlend"), state.brush.edgeBlend);
  drawFullscreen();
  gl.disable(gl.SCISSOR_TEST);
}

function paintLayerTransformedBrush(layer, transform) {
  const geometry = getPaintTransformGeometry(
    transform.center,
    transform.endpoint,
    transform.directionMode,
  );
  const dirty = {
    x0: geometry.x0,
    y0: geometry.y0,
    x1: geometry.x1,
    y1: geometry.y1,
  };
  const previewDirty = scaleTransformDirty(dirty, transform);
  const resetDirty = scaleTransformDirty(mergeDirty(transform.previewDirty, dirty), transform);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, transform.previewBaseFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, transform.previewFramebuffer);
  gl.blitFramebuffer(
    resetDirty.x0,
    resetDirty.y0,
    resetDirty.x1,
    resetDirty.y1,
    resetDirty.x0,
    resetDirty.y0,
    resetDirty.x1,
    resetDirty.y1,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  drawPaintTransformBrush(
    layer,
    transform.previewFramebuffer,
    transform.previewBaseTexture,
    transform.previewWidth,
    transform.previewHeight,
    transform,
    geometry,
    previewDirty,
  );
  transform.previewDirty = dirty;
}

function flushPendingPaintTransformPreview() {
  const transform = state.paintTransformStroke;
  if (!transform?.previewPending) return;
  const layer = state.layers.find((item) => item.id === transform.layerId);
  transform.previewPending = false;
  if (layer?.kind === "paint" || layer?.kind === "height") paintLayerTransformedBrush(layer, transform);
}

function updateMaskTransformPreview(transform) {
  const geometry = getPaintTransformGeometry(
    transform.center,
    transform.endpoint,
    transform.directionMode,
  );
  const dirty = { x0: geometry.x0, y0: geometry.y0, x1: geometry.x1, y1: geometry.y1 };
  const previewDirty = scaleTransformDirty(dirty, transform);
  const resetDirty = scaleTransformDirty(mergeDirty(transform.previewDirty, dirty), transform);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, transform.previewBaseFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, transform.previewFramebuffer);
  gl.blitFramebuffer(
    resetDirty.x0,
    resetDirty.y0,
    resetDirty.x1,
    resetDirty.y1,
    resetDirty.x0,
    resetDirty.y0,
    resetDirty.x1,
    resetDirty.y1,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  drawMaskTransformBrush(
    transform.previewFramebuffer,
    transform.previewBaseTexture,
    transform.previewWidth,
    transform.previewHeight,
    transform,
    geometry,
    previewDirty,
  );
  transform.previewDirty = dirty;
}

function flushPendingMaskTransformPreview() {
  const transform = state.transformStroke;
  if (!transform?.previewPending) return;
  transform.previewPending = false;
  updateMaskTransformPreview(transform);
}

function commitMaskTransformedBrush(mask, transform) {
  const geometry = getPaintTransformGeometry(
    transform.center,
    transform.endpoint,
    transform.directionMode,
  );
  const dirty = { x0: geometry.x0, y0: geometry.y0, x1: geometry.x1, y1: geometry.y1 };
  captureStrokeHistoryTiles(mask, dirty);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mask.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, mask.scratchFramebuffer);
  gl.blitFramebuffer(
    dirty.x0,
    dirty.y0,
    dirty.x1,
    dirty.y1,
    dirty.x0,
    dirty.y0,
    dirty.x1,
    dirty.y1,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  drawMaskTransformBrush(
    mask.scratchFramebuffer,
    mask.texture,
    DOC_WIDTH,
    DOC_HEIGHT,
    transform,
    geometry,
    dirty,
  );
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mask.scratchFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, mask.framebuffer);
  gl.blitFramebuffer(
    dirty.x0,
    dirty.y0,
    dirty.x1,
    dirty.y1,
    dirty.x0,
    dirty.y0,
    dirty.x1,
    dirty.y1,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  return dirty;
}

function commitPaintLayerTransformedBrush(layer, transform) {
  const geometry = getPaintTransformGeometry(
    transform.center,
    transform.endpoint,
    transform.directionMode,
  );
  const dirty = {
    x0: geometry.x0,
    y0: geometry.y0,
    x1: geometry.x1,
    y1: geometry.y1,
  };
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, transform.baseFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.paintFramebuffer);
  gl.blitFramebuffer(
    dirty.x0,
    dirty.y0,
    dirty.x1,
    dirty.y1,
    dirty.x0,
    dirty.y0,
    dirty.x1,
    dirty.y1,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  drawPaintTransformBrush(
    layer,
    layer.paintFramebuffer,
    transform.baseTexture,
    DOC_WIDTH,
    DOC_HEIGHT,
    transform,
    geometry,
    dirty,
  );
  state.paintStrokeDirty = dirty;
  layer.sourceRevision = (layer.sourceRevision || 0) + 1;
}

function beginStroke(event) {
  const layer = getSelectedLayer();
  if (layer) ensureLayerGpuTextures(layer);
  const mask = layer?.mask;
  const paintContent = (layer?.kind === "paint" || layer?.kind === "height") && state.selectionPart === "content";
  if (event.button !== 0 || (!paintContent && (!mask || !mask.enabled || state.selectionPart !== "mask"))) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  state.paintPointerId = event.pointerId;
  state.strokePoints = [];
  state.pendingMaskDabs = [];
  state.pendingMaskLayerId = null;
  state.pendingMaskTarget = null;
  state.pendingPaintDabs = [];
  state.pendingPaintLayerId = null;
  state.pendingPaintColor = null;
  state.pendingPaintErase = false;
  state.lastPaintPoint = null;
  state.paintStrokeDirty = null;
  state.paintStrokeHistory = paintContent ? { layerId: layer.id } : null;
  state.gpuMaskStrokeLayerId = null;
  state.paintingLayerContent = paintContent;
  state.strokeHistory = paintContent ? null : {
    layerId: layer.id,
    initializedBefore: mask.initialized,
    initializedFillValue: null,
    tiles: new Map(),
  };
  if (paintContent) {
    const center = pointerToDocument(event);
    if (state.brush.mode === "normal") {
      paintLayerStamp(layer, center);
    } else {
      state.paintTransformStroke = createPaintTransformStroke(
        layer,
        center,
        state.brush.mode === "direction",
        state.eraserPressed,
      );
      paintLayerTransformedBrush(layer, state.paintTransformStroke);
      requestRender();
    }
    return;
  }
  if (!mask.initialized) {
    const reveal = state.brush.value >= 0.5;
    state.strokeHistory.initializedFillValue = reveal ? 0 : 255;
    mask.data.fill(reveal ? 0 : 255);
    mask.initialized = true;
    fillMaskGpu(mask, reveal ? 0 : 255);
    showToast(reveal ? "Mask initialized to black, then revealed." : "Mask initialized to white, then hidden.");
  }

  if (state.brush.mode === "normal") {
    paintSamples([event]);
  } else {
    const center = pointerToDocument(event);
    state.transformStroke = createMaskTransformStroke(
      layer,
      mask,
      center,
      state.brush.mode === "direction",
      state.eraserPressed,
    );
    brushCursor.style.opacity = "0";
    updateTransformMaskPreview(state.transformStroke);
  }
}

function updateTransformMaskPreview(transform) {
  transform.previewPending = true;
  requestRender();
}

function continueStroke(event) {
  updateBrushCursor(event);
  if (state.paintPointerId !== event.pointerId) return;
  event.preventDefault();
  if (state.transformStroke) {
    state.transformStroke.endpoint = pointerToDocument(event);
    updateTransformMaskPreview(state.transformStroke);
    return;
  }
  if (state.paintingLayerContent) {
    const layer = getSelectedLayer();
    if (state.paintTransformStroke) {
      const transform = state.paintTransformStroke;
      transform.endpoint = pointerToDocument(event);
      transform.previewPending = true;
      requestRender();
      return;
    }
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const samples = coalesced.length ? coalesced : [event];
    samples.forEach((sample) => paintLayerStamp(layer, pointerToDocument(sample)));
    return;
  }
  const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
  paintSamples(events.length ? events : [event]);
}

function endStroke(event) {
  if (state.paintPointerId !== event.pointerId) return;
  let recordedPaintHistory = false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (state.transformStroke) {
    const layer = getSelectedLayer();
    const mask = layer?.mask;
    const transform = state.transformStroke;
    if (mask) {
      transform.endpoint = pointerToDocument(event);
      transform.previewPending = false;
      commitMaskTransformedBrush(mask, transform);
    }
    disposeMaskTransformStroke(transform);
    state.transformStroke = null;
    requestRender();
  }
  flushPendingMaskDabs();
  if (state.paintingLayerContent) {
    const layer = getSelectedLayer();
    if (layer) {
      if (state.brush.mode === "normal") {
        paintLayerStamp(layer, pointerToDocument(event));
        flushPendingPaintDabs();
      } else if (state.paintTransformStroke) {
        state.paintTransformStroke.endpoint = pointerToDocument(event);
        state.paintTransformStroke.previewPending = false;
        commitPaintLayerTransformedBrush(layer, state.paintTransformStroke);
      }
      const paintHistory = state.paintStrokeHistory;
      const dirty = state.paintStrokeDirty && {
        x: Math.max(0, Math.floor(state.paintStrokeDirty.x0)),
        y: Math.max(0, Math.floor(state.paintStrokeDirty.y0)),
        width: Math.min(DOC_WIDTH, Math.ceil(state.paintStrokeDirty.x1))
          - Math.max(0, Math.floor(state.paintStrokeDirty.x0)),
        height: Math.min(DOC_HEIGHT, Math.ceil(state.paintStrokeDirty.y1))
          - Math.max(0, Math.floor(state.paintStrokeDirty.y0)),
      };
      if (dirty) dirty.canvasY = DOC_HEIGHT - dirty.y - dirty.height;
      const context = layer.sourceCanvas.getContext("2d", { alpha: true });
      const before = dirty
        ? new Uint8Array(context.getImageData(dirty.x, dirty.canvasY, dirty.width, dirty.height).data)
        : null;
      syncPaintLayerCanvasFromGpu(layer, state.paintStrokeDirty);
      if (paintHistory && dirty && before) {
        const after = new Uint8Array(context.getImageData(dirty.x, dirty.canvasY, dirty.width, dirty.height).data);
        recordPaintRegionHistoryAction(layer.id, dirty, before, after);
        recordedPaintHistory = true;
      }
      schedulePaintLayerSerialization(layer);
      invalidateLayerThumbnail(layer);
      refreshLayerThumbnail(layer);
    }
    disposePaintTransformStroke(state.paintTransformStroke);
    state.paintingLayerContent = false;
    state.paintTransformStroke = null;
    state.pendingPaintDabs = [];
    state.pendingPaintLayerId = null;
    state.pendingPaintColor = null;
    state.pendingPaintErase = false;
    state.lastPaintPoint = null;
    state.paintStrokeDirty = null;
    state.paintStrokeHistory = null;
    requestRender();
  }
  state.paintPointerId = null;
  state.strokePoints = [];
  const strokeHistory = state.strokeHistory;
  state.strokeHistory = null;
  if (strokeHistory) {
    const layer = state.layers.find((item) => item.id === strokeHistory.layerId);
    if (layer?.mask && strokeHistory.tiles.size) {
      const tilesBefore = [...strokeHistory.tiles.values()];
      const beforePixels = readMaskHistoryTiles(strokeHistory.baseFramebuffer, tilesBefore);
      syncMaskTilesFromGpu(layer.mask, tilesBefore);
      renderLayers();
      const tiles = tilesBefore.map((tile) => {
        const after = new Uint8Array(tile.width * tile.height);
        for (let row = 0; row < tile.height; row += 1) {
          after.set(
            layer.mask.data.subarray(
              (tile.y + row) * DOC_WIDTH + tile.x,
              (tile.y + row) * DOC_WIDTH + tile.x + tile.width,
            ),
            row * tile.width,
          );
        }
        return { ...tile, before: beforePixels.get(`${tile.x}:${tile.y}`), after };
      });
      recordMaskTileHistoryAction(
        strokeHistory.layerId,
        tiles,
        strokeHistory.initializedBefore,
        layer.mask.initialized,
        strokeHistory.initializedFillValue,
      );
      disposeMaskStrokeHistory(strokeHistory);
      state.gpuMaskStrokeLayerId = null;
      return;
    }
    disposeMaskStrokeHistory(strokeHistory);
  }
  state.gpuMaskStrokeLayerId = null;
  state.pendingMaskDabs = [];
  state.pendingMaskLayerId = null;
  state.pendingMaskTarget = null;
  renderLayers();
  if (!recordedPaintHistory) commitDocumentAction();
}

function beginPan(event) {
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  state.panPointerId = event.pointerId;
  state.panStart = {
    x: event.clientX,
    y: event.clientY,
    viewportX: state.viewport.x,
    viewportY: state.viewport.y,
  };
  brushCursor.style.opacity = "0";
  canvas.classList.add("is-panning");
}

function beginBrushSizeAdjust(event) {
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  state.sizeAdjustPointerId = event.pointerId;
  state.sizeAdjustStart = {
    x: event.clientX,
    size: state.brush.size,
    cursorX: event.clientX,
    cursorY: event.clientY,
  };
  brushCursor.classList.add("is-sizing");
  updateBrushCursor(event);
  canvas.classList.add("is-adjusting-brush-size");
}

function continueBrushSizeAdjust(event) {
  if (state.sizeAdjustPointerId !== event.pointerId || !state.sizeAdjustStart) return;
  event.preventDefault();
  state.brush.size = Math.max(1, Math.round(state.sizeAdjustStart.size + (event.clientX - state.sizeAdjustStart.x) * 1.5));
  syncBrushUi();
  updateBrushCursor(event);
}

function endBrushSizeAdjust(event) {
  if (state.sizeAdjustPointerId !== event.pointerId) return;
  const changed = state.sizeAdjustStart && state.brush.size !== state.sizeAdjustStart.size;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  state.sizeAdjustPointerId = null;
  state.sizeAdjustStart = null;
  canvas.classList.remove("is-adjusting-brush-size");
  brushCursor.classList.remove("is-sizing");
  updateBrushCursor(event);
  if (changed) commitDocumentAction();
}

function continuePan(event) {
  if (state.panPointerId !== event.pointerId || !state.panStart) return;
  event.preventDefault();
  state.viewport.x = state.panStart.viewportX + event.clientX - state.panStart.x;
  state.viewport.y = state.panStart.viewportY + event.clientY - state.panStart.y;
  syncViewport();
}

function endPan(event) {
  if (state.panPointerId !== event.pointerId) return;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  state.panPointerId = null;
  state.panStart = null;
  canvas.classList.remove("is-panning");
  scheduleViewportSave();
}

function touchGestureMetrics() {
  const points = [...state.touchPointers.values()];
  if (points.length < 2) return null;
  const [first, second] = points;
  return {
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}

function beginTouchGesture(event) {
  const metrics = touchGestureMetrics();
  if (!metrics) return;
  state.touchBrushAdjust = null;
  if (state.paintPointerId !== null) {
    endStroke({
      pointerId: state.paintPointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }
  state.touchGesture = {
    fingers: state.touchPointers.size,
    metrics,
    zoom: state.zoom,
    viewport: { ...state.viewport },
    moved: false,
  };
  brushCursor.style.opacity = "0";
}

function updateTouchGesture() {
  const gesture = state.touchGesture;
  const metrics = touchGestureMetrics();
  if (!gesture || !metrics) return;
  const distanceRatio = metrics.distance / Math.max(1, gesture.metrics.distance);
  const deltaX = metrics.centerX - gesture.metrics.centerX;
  const deltaY = metrics.centerY - gesture.metrics.centerY;
  gesture.moved ||= Math.hypot(deltaX, deltaY) > 8 || Math.abs(distanceRatio - 1) > 0.06;
  setZoom(gesture.zoom * distanceRatio);
  state.viewport.x = gesture.viewport.x + deltaX;
  state.viewport.y = gesture.viewport.y + deltaY;
  syncViewport();
}

function finishTouchGesture() {
  const gesture = state.touchGesture;
  if (!gesture || state.touchPointers.size) return;
  state.touchGesture = null;
  if (!gesture.moved) {
    if (gesture.fingers === 2) void undoDocument();
    else if (gesture.fingers >= 3) void redoDocument();
  }
  scheduleViewportSave();
}

function handleCanvasPointerDown(event) {
  canvas.focus({ preventScroll: true });
  if (event.pointerType === "touch") {
    state.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.touchPointers.size >= 2) {
      event.preventDefault();
      beginTouchGesture(event);
      return;
    }
    if (state.pencilHover && performance.now() - state.pencilHover.timestamp < 900) {
      event.preventDefault();
      state.touchBrushAdjust = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        size: state.brush.size,
        value: state.brush.value,
        adjustsValue: state.selectionPart === "mask",
      };
      return;
    }
    if (state.ipad.ignoreTouchDraw) return;
  }
  if (event.pointerType === "pen" && (event.button === 2 || event.button === 5 || (event.buttons & 2))) {
    event.preventDefault();
    sampleCanvasColor(event);
    return;
  }
  if (event.altKey) {
    event.preventDefault();
    sampleCanvasColor(event);
    return;
  }
  if (event.button === 0 && state.sizeAdjustPressed) {
    return;
  }
  if (event.button === 1 || (event.button === 0 && state.spacePressed)) {
    beginPan(event);
    return;
  }
  beginStroke(event);
}

function handleCanvasPointerMove(event) {
  if (event.pointerType === "pen" && event.buttons === 0) {
    state.pencilHover = { timestamp: performance.now(), x: event.clientX, y: event.clientY };
  }
  if (event.pointerType === "touch" && state.touchPointers.has(event.pointerId)) {
    state.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.touchGesture) {
      event.preventDefault();
      updateTouchGesture();
      return;
    }
    if (state.touchBrushAdjust?.pointerId === event.pointerId) {
      event.preventDefault();
      const adjust = state.touchBrushAdjust;
      state.brush.size = Math.max(1, Math.round(adjust.size - (event.clientY - adjust.y) * 0.9));
      if (adjust.adjustsValue) state.brush.value = Math.max(0, Math.min(1, adjust.value + (event.clientX - adjust.x) / 240));
      syncBrushUi();
      return;
    }
    if (state.ipad.ignoreTouchDraw) return;
  }
  if (state.sizeAdjustPointerId === event.pointerId) {
    continueBrushSizeAdjust(event);
    return;
  }
  if (state.panPointerId === event.pointerId) {
    continuePan(event);
    return;
  }
  continueStroke(event);
}

function handleCanvasPointerEnd(event) {
  if (event.pointerType === "touch" && state.touchPointers.has(event.pointerId)) {
    state.touchPointers.delete(event.pointerId);
    if (state.touchGesture) {
      event.preventDefault();
      finishTouchGesture();
      return;
    }
    if (state.touchBrushAdjust?.pointerId === event.pointerId) {
      event.preventDefault();
      state.touchBrushAdjust = null;
      scheduleSave();
      return;
    }
    if (state.ipad.ignoreTouchDraw) return;
  }
  if (state.sizeAdjustPointerId === event.pointerId) {
    endBrushSizeAdjust(event);
    return;
  }
  if (state.panPointerId === event.pointerId) {
    endPan(event);
    return;
  }
  endStroke(event);
}

function handleCanvasWheel(event) {
  event.preventDefault();
  const scale = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  setZoom(state.zoom * scale);
}

function syncCanvasCursor() {
  const layer = getSelectedLayer();
  const painting = (state.selectionPart === "mask" && layer?.mask?.enabled)
    || (state.selectionPart === "content" && (layer?.kind === "paint" || layer?.kind === "height"));
  canvas.classList.toggle("is-mask-painting", Boolean(painting));
  canvas.classList.toggle("is-erasing", state.eraserPressed);
  if (!painting) brushCursor.style.opacity = "0";
}

function updateBrushCursor(event) {
  if (event.altKey) {
    brushCursor.style.opacity = "0";
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside || !canvas.classList.contains("is-mask-painting")) {
    brushCursor.style.opacity = "0";
    return;
  }
  const zoomScale = state.zoom / 80;
  const displaySize = state.brush.size / DOC_WIDTH * rect.width / zoomScale;
  brushCursor.style.width = `${displaySize}px`;
  brushCursor.style.height = `${displaySize}px`;
  const cursorClientX = state.sizeAdjustPressed && state.sizeAdjustStart ? state.sizeAdjustStart.cursorX : event.clientX;
  const cursorClientY = state.sizeAdjustPressed && state.sizeAdjustStart ? state.sizeAdjustStart.cursorY : event.clientY;
  brushCursor.style.left = `${(cursorClientX - rect.left) / zoomScale}px`;
  brushCursor.style.top = `${(cursorClientY - rect.top) / zoomScale}px`;
  brushCursor.classList.toggle("is-erasing", state.eraserPressed);
  if (state.sizeAdjustPressed) brushCursor.dataset.size = `${Math.round(state.brush.size)} px`;
  else delete brushCursor.dataset.size;
  brushCursor.style.opacity = "1";
}

function eyeSvg(visible) {
  return visible
    ? '<svg viewBox="0 0 20 20"><path d="M2.2 10s2.7-4.8 7.8-4.8 7.8 4.8 7.8 4.8-2.7 4.8-7.8 4.8S2.2 10 2.2 10Z"/><circle cx="10" cy="10" r="2.2"/></svg>'
    : '<svg viewBox="0 0 20 20"><path d="M3.1 7.4A9 9 0 0 0 2.2 10s2.7 4.8 7.8 4.8c1.4 0 2.6-.3 3.6-.8M6.2 5.9A8.5 8.5 0 0 1 10 5.2c5.1 0 7.8 4.8 7.8 4.8a10 10 0 0 1-1.4 2.1M3 3l14 14"/></svg>';
}

function maskThumbnail(mask) {
  const size = 32;
  const preview = document.createElement("canvas");
  preview.width = size;
  preview.height = size;
  const ctx = preview.getContext("2d");
  const image = ctx.createImageData(size, size);
  const readMask = (x, y) => {
    const sampleX = Math.max(0, Math.min(DOC_WIDTH - 1, Math.round(x)));
    const sampleY = Math.max(0, Math.min(DOC_HEIGHT - 1, Math.round(y)));
    return mask.data[sampleY * DOC_WIDTH + sampleX] / 255;
  };
  const blurOffset = mask.softness * 12;
  const noise = (x, y, seed) => {
    const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
    return value - Math.floor(value);
  };
  for (let y = 0; y < size; y += 1) {
    const sourceY = DOC_HEIGHT - 1 - Math.floor((y + 0.5) / size * DOC_HEIGHT);
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(DOC_WIDTH - 1, Math.floor((x + 0.5) / size * DOC_WIDTH));
      const rawValue = blurOffset > 0
        ? (
          readMask(sourceX, sourceY) * 0.4
          + readMask(sourceX - blurOffset, sourceY) * 0.15
          + readMask(sourceX + blurOffset, sourceY) * 0.15
          + readMask(sourceX, sourceY - blurOffset) * 0.15
          + readMask(sourceX, sourceY + blurOffset) * 0.15
        )
        : readMask(sourceX, sourceY);
      const roughAmount = mask.roughenAmount || 0;
      const roughValue = roughAmount > 0
        ? readMask(
          sourceX + (noise(sourceX / (mask.roughenScale || 24), sourceY / (mask.roughenScale || 24), 1) * 2 - 1) * (mask.roughenWidth || 8),
          sourceY + (noise(sourceX / (mask.roughenScale || 24), sourceY / (mask.roughenScale || 24), 2) * 2 - 1) * (mask.roughenWidth || 8),
        )
        : rawValue;
      const roughenedValue = Math.pow(Math.max(0, Math.min(1, rawValue * (1 - roughAmount) + roughValue * roughAmount)), mask.roughenSharpness || 1);
      const adjustedValue = Math.max(0, Math.min(1, (roughenedValue - 0.5) * (1 + mask.contrast * 3) + 0.5)) * mask.opacity;
      const value = Math.round(adjustedValue * 255);
      const index = (y * size + x) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return preview.toDataURL("image/png");
}

function renderLayers() {
  state.layers.forEach(refreshLayerThumbnail);
  const displayLayers = [...state.layers].reverse();
  const selectedAdjustment = state.layers.find((layer) => layer.id === state.selectedLayerId && layer.kind === "adjustment");
  const linkedAdjustment = selectedAdjustment
    || state.layers.find((layer) => layer.id === state.hoveredAdjustmentLayerId && layer.kind === "adjustment");
  const linkedTargetId = linkedAdjustment && hasCustomAdjustmentStart(linkedAdjustment)
    ? linkedAdjustment.adjustmentStartLayerId
    : null;
  layerList.innerHTML = displayLayers.map((layer) => {
    const selected = layer.id === state.selectedLayerId;
    const maskActive = selected && state.selectionPart === "mask";
    const selectionPart = (layer.kind === "image" || layer.kind === "adjustment" || layer.kind === "material") && layer.mask ? "mask" : "content";
    const maskAdjusted = layer.mask && (
      layer.mask.softness !== 0
      || layer.mask.opacity !== 1
      || layer.mask.contrast !== 0
      || layer.mask.roughenAmount !== 0
    );
    const maskDisabled = layer.mask && !layer.mask.enabled;
    const maskMarkup = layer.mask
      ? `<button class="mask-thumb ${maskActive ? "active" : ""} ${maskAdjusted ? "adjusted" : ""} ${maskDisabled ? "disabled" : ""}" data-select-part="mask" style="background-image:url('${maskThumbnail(layer.mask)}')" title="${maskDisabled ? "Mask disabled — click to select" : "Paint layer mask"}"></button>`
      : "";
    return `
      <article class="layer-row ${selected ? "selected" : ""} ${layer.visible ? "visible" : ""} ${layer.clipDown ? "clipped-down" : ""} ${layer.id === linkedTargetId ? "adjustment-target" : ""}" draggable="true" data-layer-id="${layer.id}">
        ${layer.clipDown ? '<span class="clip-down-indicator" aria-hidden="true"></span>' : ""}
        <button class="eye-button" data-layer-action="visibility" title="${layer.visible ? "Hide layer" : "Show layer"}">${eyeSvg(layer.visible)}</button>
        <div class="layer-thumb-stack">
          ${layer.kind === "adjustment"
    ? `<button class="layer-thumb adjustment-thumb ${hasCustomAdjustmentStart(layer) ? "custom-range" : ""}" data-select-part="${selectionPart}" title="${hasCustomAdjustmentStart(layer) ? "Adjustment layer with custom influence start" : "Adjustment layer filters"}"><svg viewBox="0 0 20 20"><path d="M4 4h12M4 10h12M4 16h12"/><circle cx="8" cy="4" r="1.8"/><circle cx="13" cy="10" r="1.8"/><circle cx="6" cy="16" r="1.8"/></svg></button>`
    : layer.kind === "material"
      ? `<button class="layer-thumb material-thumb" data-select-part="${selectionPart}" title="3D material settings"><svg viewBox="0 0 20 20"><path d="m10 2.8 6 3.4v7.2l-6 3.4-6-3.4V6.2z"/><path d="m4 6.2 6 3.4 6-3.4M10 9.6v7.2"/><path d="m7.5 11 2.5 1.4 2.5-1.4"/></svg></button>`
    : layer.kind === "height"
      ? `<button class="layer-thumb material-thumb" data-select-part="${selectionPart}" title="Height layer settings"><svg viewBox="0 0 20 20"><path d="M3 15h14M4 13l3-4 3 2 3-5 3 7"/><path d="M4 17h12"/></svg></button>`
    : `<button class="layer-thumb" data-select-part="${selectionPart}" style="background-image:url('${layer.thumbnail}')" title="${selectionPart === "mask" ? "Paint layer mask" : "Select layer"}"></button>`}
          ${maskMarkup}
        </div>
        <div class="layer-copy" data-select-part="${selectionPart}">
          <span class="layer-name">${escapeHtml(layer.name)}</span>
          ${selected ? `<div class="layer-badges">
            <button class="layer-badge ${layer.clipDown ? "active" : ""}" data-layer-status="clip" title="Toggle clip down">Clip</button>
            <button class="layer-badge ${layer.alphaLock ? "active" : ""}" data-layer-status="alpha" title="Toggle alpha lock">Alpha</button>
            ${layer.mask ? `<button class="layer-badge ${layer.mask.enabled ? "active" : "disabled"}" data-layer-status="mask" title="${layer.mask.enabled ? "Disable mask" : "Enable mask"}">${layer.mask.enabled ? "Mask" : "Mask off"}</button>` : ""}
            ${layer.filters.length ? `<button class="layer-badge ${layer.filtersEnabled !== false ? "active" : ""}" data-layer-status="filters" title="${layer.filtersEnabled !== false ? "Disable filters for this layer" : "Enable filters for this layer"}">${layer.filters.length} FX</button>` : ""}
          </div>` : ""}
        </div>
        ${selected ? '<button class="layer-action-button" data-layer-action="menu" title="Layer actions">•••</button>' : ""}
      </article>`;
  }).join("");
  syncLayerControls();
  syncHistoryButtons();
  syncMaskBadge();
  syncCanvasCursor();
}

function syncFilterPreviewControl() {
  const layer = getSelectedLayer();
  const count = layer?.filters.length || 0;
  const enabled = Boolean(layer && count && layer.filtersEnabled !== false);
  filterPreview.checked = enabled;
  filterPreview.disabled = !layer || count === 0;
  filterPreview.closest(".master-toggle").title = enabled ? "Disable filters for this layer" : "Enable filters for this layer";
}

function syncLayerControls() {
  const layer = getSelectedLayer();
  blendMode.disabled = !layer;
  blendSelectTrigger.disabled = !layer;
  layerOpacity.disabled = !layer;
  layerOpacityNumber.disabled = !layer;
  if (!layer) return;
  blendMode.value = layer.blendMode;
  blendSelectLabel.textContent = BLEND_MODE_LABELS[layer.blendMode] || "Normal";
  blendSelectMenu.querySelectorAll("[data-blend-mode]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.blendMode === layer.blendMode);
  });
  layerOpacity.value = String(layer.opacity);
  layerOpacityNumber.value = Number(layer.opacity).toFixed(2);
}

function syncMaskBadge() {
  const layer = getSelectedLayer();
  const active = layer?.mask && state.selectionPart === "mask";
  maskModeBadge.classList.toggle("inactive", !active);
  if (active) {
    maskModeBadge.querySelector("b").textContent = `${layer.name} mask`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);
}

function selectLayer(layerId, part = "content") {
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer) return;
  state.selectedLayerId = layerId;
  if (state.maskSettingsLayerId && state.maskSettingsLayerId !== layerId) state.maskSettingsLayerId = null;
  state.selectionPart = (layer.kind === "image" || layer.kind === "adjustment" || layer.kind === "material") && layer.mask
    ? "mask"
    : part === "mask" && layer.mask ? "mask" : "content";
  if (layer.kind === "material") {
    ["colorMap", "normalMap", "roughnessMap", "metalnessMap"].forEach((key) => getMaterialMapTexture(layer, key));
  }
  syncCanvasCursor();
  syncBrushUi();
  renderLayers();
  renderFilters();
  requestRender();
}

function showLayerMenu(row, layer) {
  document.querySelectorAll(".layer-actions-menu").forEach((menu) => menu.remove());
  const menu = document.createElement("div");
  menu.className = "layer-actions-menu";
  menu.innerHTML = `
    <button data-menu-action="rename">Rename layer</button>
    <button data-menu-action="duplicate">Duplicate layer</button>
    <div class="layer-actions-divider"></div>
    <button data-menu-action="filters-copy">Copy filters</button>
    <button data-menu-action="filters-paste" ${state.filterClipboard?.length ? "" : "disabled"}>Paste filters</button>
    <div class="layer-actions-divider"></div>
    <button data-menu-action="clip">${layer.clipDown ? "Disable" : "Enable"} clip down</button>
    <button data-menu-action="alpha">${layer.alphaLock ? "Unlock" : "Lock"} alpha</button>
    <div class="layer-actions-divider"></div>
    ${layer.mask ? `
      <button data-menu-action="mask-toggle">${layer.mask.enabled ? "Disable" : "Enable"} mask</button>
      <button data-menu-action="mask-settings">Mask settings</button>
      <button data-menu-action="mask-copy">Copy mask</button>
      ${state.maskClipboard ? '<button data-menu-action="mask-paste">Paste mask</button>' : ""}
      <button data-menu-action="mask-clear">Clear mask</button>
      <button data-menu-action="mask-delete">Delete mask</button>
    ` : '<button data-menu-action="mask-add">Add mask</button>'}
    <div class="layer-actions-divider"></div>
    <button data-menu-action="delete" class="danger">Delete layer</button>`;
  row.appendChild(menu);
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-menu-action]");
    if (!button) return;
    handleLayerMenuAction(layer, button.dataset.menuAction);
    menu.remove();
  });
}

function startLayerRename(layerId) {
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer) return;
  selectLayer(layer.id, layer.mask && state.selectionPart === "mask" ? "mask" : "content");
  const name = layerList.querySelector(`[data-layer-id="${layer.id}"] .layer-name`);
  if (!name) return;

  const input = document.createElement("input");
  input.className = "layer-name-input";
  input.type = "text";
  input.value = layer.name;
  input.setAttribute("aria-label", "Layer name");
  name.replaceWith(input);

  let finalized = false;
  let cancelled = false;
  const finish = () => {
    if (finalized) return;
    finalized = true;
    const nextName = cancelled ? layer.name : input.value.trim() || layer.name;
    if (nextName !== layer.name) {
      layer.name = nextName;
      commitDocumentAction();
    }
    renderLayers();
    renderFilters();
  };

  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      cancelled = true;
      input.blur();
    }
  });
  input.addEventListener("blur", finish, { once: true });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function showMaskMenu(row, layer, clientX, clientY) {
  document.querySelectorAll(".layer-actions-menu").forEach((menu) => menu.remove());
  if (!layer.mask) return;
  const menu = document.createElement("div");
  menu.className = "layer-actions-menu context-menu";
  menu.style.setProperty("--menu-x", `${Math.min(clientX, window.innerWidth - 160)}px`);
  menu.style.setProperty("--menu-y", `${Math.min(clientY, window.innerHeight - 100)}px`);
  menu.innerHTML = `
    <button data-menu-action="mask-toggle">${layer.mask.enabled ? "Disable" : "Enable"} mask</button>
    <button data-menu-action="mask-settings">Mask settings</button>
    <button data-menu-action="mask-copy">Copy mask</button>
    ${state.maskClipboard ? '<button data-menu-action="mask-paste">Paste mask</button>' : ""}
    <button data-menu-action="mask-clear">Clear mask</button>
    <button data-menu-action="mask-delete" class="danger">Delete mask</button>`;
  row.appendChild(menu);
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-menu-action]");
    if (!button) return;
    handleLayerMenuAction(layer, button.dataset.menuAction);
    menu.remove();
  });
}

async function duplicateLayer(layer) {
  const maskData = layer.mask?.data.slice();
  const copy = await createLayerFromImage(layer.sourceDataUrl, `${layer.name} copy`, {
    kind: layer.kind,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    clipDown: layer.clipDown,
    alphaLock: layer.alphaLock,
    adjustmentStartLayerId: layer.adjustmentStartLayerId,
    filtersEnabled: layer.filtersEnabled !== false,
    matchFilterRatio: layer.matchFilterRatio === true,
    sourceDataUrl: layer.sourceDataUrl,
    material: layer.material ? { ...layer.material } : null,
    height: layer.height ? { ...layer.height } : null,
    mask: layer.mask ? {} : null,
    maskData,
    maskInitialized: layer.mask?.initialized,
    maskEnabled: layer.mask?.enabled,
    maskSoftness: layer.mask?.softness,
    maskOpacity: layer.mask?.opacity,
    maskContrast: layer.mask?.contrast,
    maskRoughenAmount: layer.mask?.roughenAmount,
    maskRoughenWidth: layer.mask?.roughenWidth,
    maskRoughenScale: layer.mask?.roughenScale,
    maskRoughenSharpness: layer.mask?.roughenSharpness,
    filters: layer.filters.map((filter) => ({
      ...filter,
      id: uid("filter"),
      params: { ...filter.params },
    })),
  });
  const index = state.layers.indexOf(layer);
  state.layers.splice(index + 1, 0, copy);
  selectLayer(copy.id, layer.mask ? "mask" : "content");
  renderFilters();
  requestRender();
  commitDocumentAction();
}

function insertLayerAboveSelection(layer, selectedLayerId = state.selectedLayerId) {
  const selectedIndex = state.layers.findIndex((item) => item.id === selectedLayerId);
  state.layers.splice(selectedIndex >= 0 ? selectedIndex + 1 : state.layers.length, 0, layer);
}

async function createBaseCopyLayer() {
  const base = state.layers[0];
  if (!base) return;
  const selectedLayerId = state.selectedLayerId;
  const copy = await createLayerFromImage(base.sourceDataUrl, `${base.name} copy`, {
    kind: "image",
    filters: [],
    opacity: 1,
    blendMode: "normal",
  });
  insertLayerAboveSelection(copy, selectedLayerId);
  selectLayer(copy.id, "mask");
  requestRender();
  commitDocumentAction();
  showToast("Clean base pixels copied to a new layer.");
}

function createPaintLayer() {
  const source = document.createElement("canvas");
  source.width = DOC_WIDTH;
  source.height = DOC_HEIGHT;
  source.getContext("2d", { alpha: true, willReadFrequently: true });
  const layer = createLayerFromSourceCanvas(source, "Paint layer", {
    sourceDataUrl: EMPTY_IMAGE_DATA_URL,
    thumbnail: EMPTY_IMAGE_DATA_URL,
  });
  ensurePaintLayerGpu(layer);
  insertLayerAboveSelection(layer);
  selectLayer(layer.id, "content");
  requestRender();
  commitDocumentAction();
  showToast("Empty paint layer created.");
}

function createAdjustmentLayer() {
  const source = document.createElement("canvas");
  source.width = DOC_WIDTH;
  source.height = DOC_HEIGHT;
  const layer = createLayerFromSourceCanvas(source, "Adjustment layer", { kind: "adjustment" });
  insertLayerAboveSelection(layer);
  selectLayer(layer.id, "mask");
  requestRender();
  commitDocumentAction();
  showToast("Adjustment layer created. Its filters affect layers below.");
}

function createMaterialLayer() {
  const source = document.createElement("canvas");
  source.width = DOC_WIDTH;
  source.height = DOC_HEIGHT;
  const layer = createLayerFromSourceCanvas(source, "3D Material", {
    kind: "material",
    material: DEFAULT_MATERIAL,
  });
  insertLayerAboveSelection(layer);
  selectLayer(layer.id, "mask");
  requestRender();
  commitDocumentAction();
  showToast("3D Material created. It shades the composite below.");
}

function createHeightLayer() {
  const source = document.createElement("canvas");
  source.width = DOC_WIDTH;
  source.height = DOC_HEIGHT;
  const context = source.getContext("2d", { alpha: true, willReadFrequently: true });
  context.fillStyle = "#000000";
  context.fillRect(0, 0, DOC_WIDTH, DOC_HEIGHT);
  const layer = createLayerFromSourceCanvas(source, "Height Layer", {
    kind: "height",
    height: DEFAULT_HEIGHT,
  });
  ensurePaintLayerGpu(layer);
  insertLayerAboveSelection(layer);
  selectLayer(layer.id, "content");
  requestRender();
  commitDocumentAction();
  showToast("Height Layer created. Paint grayscale height directly on the layer.");
}

function deleteLayer(layer) {
  if (state.layers.length === 1) {
    showToast("Keep at least one layer in the document.");
    return;
  }
  const index = state.layers.indexOf(layer);
  destroyLayerGpu(layer);
  state.layers.splice(index, 1);
  normalizeAdjustmentStarts();
  const next = state.layers[Math.min(index, state.layers.length - 1)];
  selectLayer(next.id, next.mask ? "mask" : "content");
  requestRender();
  commitDocumentAction();
}

function handleLayerMenuAction(layer, action) {
  let documentChanged = false;
  if (action === "rename") {
    startLayerRename(layer.id);
    return;
  } else if (action === "duplicate") {
    duplicateLayer(layer).catch(reportError);
    return;
  } else if (action === "filters-copy") {
    if (!layer.filters.length) {
      showToast("This layer has no filters to copy.");
      return;
    }
    state.filterClipboard = layer.filters.map(cloneFilterForPaste);
    showToast(`${layer.filters.length} filter${layer.filters.length === 1 ? "" : "s"} copied.`);
    return;
  } else if (action === "filters-paste") {
    if (!state.filterClipboard?.length) {
      showToast("Copy filters from a layer before pasting.");
      return;
    }
    const pasted = state.filterClipboard.map(cloneFilterForPaste);
    layer.filters.unshift(...pasted);
    invalidateLayerThumbnail(layer);
    documentChanged = true;
    showToast(`${pasted.length} filter${pasted.length === 1 ? "" : "s"} added to this layer.`);
  } else if (action === "clip") {
    layer.clipDown = !layer.clipDown;
    documentChanged = true;
  } else if (action === "alpha") {
    layer.alphaLock = !layer.alphaLock;
    documentChanged = true;
  } else if (action === "mask-toggle" && layer.mask) {
    layer.mask.enabled = !layer.mask.enabled;
    documentChanged = true;
  } else if (action === "mask-settings" && layer.mask) {
    state.selectedLayerId = layer.id;
    state.selectionPart = "mask";
    state.maskSettingsLayerId = layer.id;
  } else if (action === "mask-copy" && layer.mask) {
    const source = layer.mask;
    state.maskClipboard = {
      data: source.data.slice(),
      initialized: source.initialized,
      enabled: source.enabled,
      softness: source.softness,
      opacity: source.opacity,
      contrast: source.contrast,
    };
    showToast("Mask copied.");
  } else if (action === "mask-paste" && state.maskClipboard) {
    const source = state.maskClipboard;
    const pasted = createMask();
    pasted.data.set(source.data);
    pasted.initialized = source.initialized;
    pasted.enabled = source.enabled;
    pasted.softness = source.softness;
    pasted.opacity = source.opacity;
    pasted.contrast = source.contrast;
    uploadFullMask(pasted);
    if (layer.mask) gl.deleteTexture(layer.mask.texture);
    layer.mask = pasted;
    state.selectionPart = "mask";
    documentChanged = true;
    showToast("Mask pasted.");
  } else if (action === "mask-clear" && layer.mask) {
    clearMask(layer.mask);
    state.selectedLayerId = layer.id;
    state.selectionPart = "mask";
    documentChanged = true;
    showToast("Mask cleared. The first brush stroke will choose its black or white base.");
  } else if (action === "mask-delete" && layer.mask) {
    gl.deleteTexture(layer.mask.texture);
    layer.mask = null;
    state.selectionPart = "content";
    documentChanged = true;
  } else if (action === "mask-add" && !layer.mask) {
    layer.mask = createMask();
    state.selectionPart = "mask";
    documentChanged = true;
  } else if (action === "delete") {
    deleteLayer(layer);
    return;
  }
  renderLayers();
  renderFilters();
  requestRender();
  if (documentChanged) commitDocumentAction();
  else scheduleSave();
}

function renderFilterMenu() {
  const groups = getOrderedFilterGroups();
  const categories = ["All filters", ...groups];
  if (!categories.includes(state.filterMenuCategory)) state.filterMenuCategory = "All filters";
  const visibleGroups = state.filterMenuCategory === "All filters"
    ? groups
    : [state.filterMenuCategory];
  filterMenu.innerHTML = `
    <div class="filter-menu-tabs" role="tablist" aria-label="Filter categories">
      ${categories.map((category) => `
        <button type="button" class="filter-menu-tab${category === state.filterMenuCategory ? " active" : ""}"
          role="tab" aria-selected="${category === state.filterMenuCategory}" data-filter-category="${escapeHtml(category)}"
          ${category === "All filters" ? "" : `data-filter-menu-item="category" title="Hold and drag to reorder categories"`}>
          <span class="filter-menu-tab-icon">${FILTER_CATEGORY_ICONS[category] || ""}</span>${escapeHtml(category)}
        </button>`).join("")}
    </div>
    ${visibleGroups.map((group) => {
    const filters = getOrderedFiltersForGroup(group);
    return `
      <section class="filter-menu-group">
        <h3>${group}</h3>
        <div class="filter-menu-grid">
          ${filters.map((def) => `
            <button data-add-filter="${def.id}" data-filter-menu-filter="${def.id}" data-filter-menu-item="filter"
              title="Hold and drag to reorder filters in ${escapeHtml(group)}">
              <span class="filter-menu-icon">${def.icon || ""}</span>
              <b>${escapeHtml(def.label)}</b>
            </button>`).join("")}
        </div>
      </section>`;
  }).join("")}`;
}

function normalizeMenuOrder(items, savedOrder) {
  const validSaved = Array.isArray(savedOrder)
    ? savedOrder.filter((item, index) => items.includes(item) && savedOrder.indexOf(item) === index)
    : [];
  return [...validSaved, ...items.filter((item) => !validSaved.includes(item))];
}

function getOrderedFilterGroups() {
  const available = [...new Set(FILTER_DEFS.map((def) => def.group))];
  const defaults = [
    ...FILTER_MENU_DEFAULT_CATEGORY_ORDER.filter((group) => available.includes(group)),
    ...available.filter((group) => !FILTER_MENU_DEFAULT_CATEGORY_ORDER.includes(group)),
  ];
  return normalizeMenuOrder(defaults, state.filterMenuCategoryOrder);
}

function getOrderedFiltersForGroup(group) {
  const definitions = FILTER_DEFS.filter((def) => def.group === group);
  const ids = normalizeMenuOrder(definitions.map((def) => def.id), state.filterMenuFilterOrders[group]);
  return ids.map((id) => definitions.find((def) => def.id === id));
}

function reorderMenuItems(items, item, target, insertAfter) {
  const fromIndex = items.indexOf(item);
  const targetIndex = items.indexOf(target);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return null;
  const reordered = [...items];
  reordered.splice(fromIndex, 1);
  const destinationIndex = reordered.indexOf(target) + (insertAfter ? 1 : 0);
  reordered.splice(destinationIndex, 0, item);
  return reordered;
}

function clearFilterMenuDropTargets() {
  filterMenu.querySelectorAll(".filter-menu-dragging, .filter-menu-drop-before, .filter-menu-drop-after, .filter-menu-shift-before, .filter-menu-shift-after").forEach((item) => {
    item.classList.remove("filter-menu-dragging", "filter-menu-drop-before", "filter-menu-drop-after", "filter-menu-shift-before", "filter-menu-shift-after");
  });
}

function removeFilterMenuDragGhost() {
  state.filterMenuDrag?.ghost?.remove();
}

function activateFilterMenuDrag(drag) {
  drag.held = true;
  const source = drag.source;
  source.classList.add("filter-menu-dragging");
  const ghost = document.createElement("div");
  ghost.className = "filter-menu-drag-ghost";
  const label = source.querySelector("b")?.textContent || source.textContent.trim();
  const icon = source.querySelector(".filter-menu-icon")?.innerHTML || source.querySelector(".filter-menu-tab-icon")?.innerHTML || "";
  ghost.innerHTML = `${icon ? `<span class="filter-menu-drag-ghost-icon">${icon}</span>` : ""}<span>${escapeHtml(label)}</span>`;
  ghost.setAttribute("aria-hidden", "true");
  const rect = source.getBoundingClientRect();
  ghost.style.left = "0";
  ghost.style.top = "0";
  ghost.style.transform = `translate3d(${drag.startX + 12}px, ${drag.startY + 12}px, 0)`;
  document.body.append(ghost);
  drag.ghost = ghost;
  drag.parent = source.parentElement;
  drag.originalNextSibling = source.nextElementSibling;
  filterMenu.setPointerCapture(drag.pointerId);
}

function updateFilterMenuDragGhost(drag, event) {
  if (!drag.ghost) return;
  drag.ghost.style.transform = `translate3d(${event.clientX + 12}px, ${event.clientY + 12}px, 0)`;
}

function activateFilterMenuItem(type, id) {
  if (type === "category") {
    state.filterMenuCategory = id;
    renderFilterMenu();
    return;
  }
  addFilter(id);
  filterMenu.hidden = true;
}

function previewFilterMenuReorder(drag, target, insertAfter) {
  if (!target || target === drag.source || target.parentElement !== drag.parent) return;
  const nextSibling = insertAfter ? target.nextElementSibling : target;
  if (nextSibling === drag.source) return;
  const items = [...drag.parent.children];
  const before = new Map(items.map((item) => [item, item.getBoundingClientRect()]));
  drag.parent.insertBefore(drag.source, nextSibling);
  items.forEach((item) => {
    const initial = before.get(item);
    const final = item.getBoundingClientRect();
    const deltaX = initial.left - final.left;
    const deltaY = initial.top - final.top;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
    item.animate([
      { transform: `translate(${deltaX}px, ${deltaY}px)` },
      { transform: "translate(0, 0)" },
    ], { duration: 150, easing: "cubic-bezier(.2,.7,.2,1)" });
  });
  drag.previewMoved = true;
}

function finishFilterMenuDrag(event, cancelled = false) {
  const drag = state.filterMenuDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  window.clearTimeout(drag.timer);
  if (filterMenu.hasPointerCapture(event.pointerId)) filterMenu.releasePointerCapture(event.pointerId);
  if (!drag.held) {
    state.filterMenuDrag = null;
    if (!cancelled) {
      activateFilterMenuItem(drag.type, drag.id);
      state.filterMenuIgnoreClick = true;
    }
    return;
  }
  if (cancelled && drag.previewMoved) {
    drag.parent.insertBefore(drag.source, drag.originalNextSibling);
  }
  if (!cancelled && drag.previewMoved) {
    if (drag.type === "category") {
      state.filterMenuCategoryOrder = [...drag.parent.querySelectorAll("[data-filter-category]")]
        .map((item) => item.dataset.filterCategory)
        .filter((category) => category !== "All filters");
    } else {
      state.filterMenuFilterOrders[drag.group] = [...drag.parent.querySelectorAll("[data-filter-menu-filter]")]
        .map((item) => item.dataset.filterMenuFilter);
    }
    saveProjectSettings();
    state.filterMenuIgnoreClick = true;
    renderFilterMenu();
  } else {
    clearFilterMenuDropTargets();
  }
  removeFilterMenuDragGhost();
  state.filterMenuDrag = null;
}

function renderBlendModeMenu() {
  blendSelectMenu.innerHTML = Object.entries(BLEND_MODE_LABELS).map(([value, label]) => `
    <button type="button" role="option" data-blend-mode="${value}">${label}</button>
  `).join("");
}

function openNewLayerMenu(trigger) {
  const rect = trigger.getBoundingClientRect();
  newLayerMenu.hidden = false;
  const left = Math.min(rect.right - newLayerMenu.offsetWidth, window.innerWidth - newLayerMenu.offsetWidth - 8);
  const top = Math.min(rect.bottom + 6, window.innerHeight - newLayerMenu.offsetHeight - 8);
  newLayerMenu.style.left = `${Math.max(8, left)}px`;
  newLayerMenu.style.top = `${Math.max(8, top)}px`;
}

function shouldShowFilterParam(param, params) {
  if (!param.showIf) return true;
  if (typeof param.showIf === "function") return Boolean(param.showIf(params));
  return Boolean(params[param.showIf]);
}

function renderLevelsGraph(filter, param) {
  const black = Number(filter.params[param.blackKey || "blackPoint"] || 0);
  const white = Number(filter.params[param.whiteKey || "whitePoint"] || 1);
  const gamma = Math.max(0.001, Number(filter.params[param.gammaKey || "gamma"] || 1));
  const points = [];
  for (let index = 0; index <= 24; index += 1) {
    const input = index / 24;
    const normalized = Math.max(0, Math.min(1, (input - black) / Math.max(0.001, white - black)));
    const output = Math.pow(normalized, 1 / gamma);
    points.push(`${(input * 100).toFixed(2)},${((1 - output) * 52).toFixed(2)}`);
  }
  return `
    <div class="filter-graph-field">
      <label>${escapeHtml(param.label)}</label>
      <svg viewBox="0 0 100 52" preserveAspectRatio="none" aria-label="Levels response curve">
        <path class="filter-graph-grid" d="M0 26H100M50 0V52"/>
        <polyline points="${points.join(" ")}"/>
      </svg>
    </div>`;
}

function renderGradientEditor(filter, param) {
  const gradient = normalizeGradientValue(filter.params[param.key] || param.default);
  const stops = gradient.stops;
  const css = stops
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((stop) => `${stop.color} ${Math.round(stop.t * 100)}%`)
    .join(", ");
  return `
    <div class="filter-special-field">
      <label>${escapeHtml(param.label)}</label>
      <div class="gradient-rail" data-gradient-add="${param.key}" title="Click to add a color stop">
        <div class="gradient-preview" style="background:linear-gradient(90deg, ${css})"></div>
        <div class="gradient-stop-handles">
          ${stops.map((stop, index) => `
            <button type="button" class="gradient-stop-handle" data-gradient-handle="${param.key}" data-stop-index="${index}"
              style="left:${(stop.t * 100).toFixed(2)}%" aria-label="Drag color stop ${index + 1}"></button>`).join("")}
        </div>
      </div>
      <div class="gradient-stops">
        ${stops.map((stop, index) => `
          <div class="gradient-stop-row">
            <input type="color" value="${escapeHtml(stop.color)}" data-gradient-param="${param.key}" data-stop-index="${index}" data-stop-property="color" aria-label="Gradient stop color" />
            <input type="number" min="0" max="1" step="0.01" value="${Number(stop.t).toFixed(2)}" data-gradient-param="${param.key}" data-stop-index="${index}" data-stop-property="t" aria-label="Gradient stop position" />
            <button type="button" class="gradient-stop-remove" data-gradient-remove="${param.key}" data-stop-index="${index}" aria-label="Remove color stop" ${stops.length <= 2 ? "disabled" : ""}>×</button>
          </div>`).join("")}
      </div>
    </div>`;
}

function renderCurveEditor(filter, param) {
  const points = Array.isArray(filter.params[param.key]?.points) ? filter.params[param.key].points : [];
  const polyline = points
    .slice()
    .sort((a, b) => a.x - b.x)
    .map((point) => `${(point.x * 100).toFixed(2)},${((1 - point.y) * 52).toFixed(2)}`)
    .join(" ");
  return `
    <div class="filter-special-field">
      <label>${escapeHtml(param.label)}</label>
      <svg class="curve-preview" viewBox="0 0 100 52" preserveAspectRatio="none" aria-label="Curve preview">
        <path class="filter-graph-grid" d="M0 26H100M50 0V52"/>
        <polyline points="${polyline}"/>
      </svg>
      <div class="curve-points">
        ${points.map((point, index) => `
          <div class="curve-point-row">
            <span>${index + 1}</span>
            <input type="number" min="0" max="1" step="0.01" value="${Number(point.x).toFixed(2)}" data-curve-param="${param.key}" data-point-index="${index}" data-point-property="x" aria-label="Curve point X" />
            <input type="number" min="0" max="1" step="0.01" value="${Number(point.y).toFixed(2)}" data-curve-param="${param.key}" data-point-index="${index}" data-point-property="y" aria-label="Curve point Y" />
          </div>`).join("")}
      </div>
    </div>`;
}

function renderFilterParam(filter, param) {
  if (!shouldShowFilterParam(param, filter.params)) return "";
  const value = filter.params[param.key];
  if (param.type === "levelsGraph") return renderLevelsGraph(filter, param);
  if (param.type === "gradient") return renderGradientEditor(filter, param);
  if (param.type === "curve") return renderCurveEditor(filter, param);
  if (param.type === "select") {
    return `
      <div class="control-row filter-select-row">
        <label>${escapeHtml(param.label)}</label>
        <select data-filter-value="${param.key}">
          ${(param.options || []).map((option) => `
            <option value="${escapeHtml(option.value)}" ${option.value === value ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
        </select>
      </div>`;
  }
  if (param.type === "toggle") {
    return renderFilterToggle(filter, param);
  }
  if (param.type === "color") {
    return `
      <div class="control-row filter-color-row">
        <label>${escapeHtml(param.label)}</label>
        <input type="color" value="${escapeHtml(value)}" data-filter-value="${param.key}" />
        <code>${escapeHtml(value)}</code>
      </div>`;
  }
  if (param.type === "image") {
    return `
      <div class="filter-image-row">
        <label>${escapeHtml(param.label)}</label>
        <label class="filter-image-button">
          ${value ? "Replace map" : "Choose map"}
          <input type="file" accept="image/*" data-filter-image="${param.key}" />
        </label>
        ${value ? `<button type="button" data-filter-clear-image="${param.key}">Clear</button>` : ""}
      </div>`;
  }
  return `
    <div class="control-row">
      <label>${escapeHtml(param.label)}</label>
      <input type="range" min="${param.min}" max="${param.max}" step="${param.step}" value="${value}" data-filter-param="${param.key}" />
      <input type="number" min="${param.min}" max="${param.max}" step="${param.step}" value="${value}" data-filter-number="${param.key}" />
    </div>`;
}

function renderFilterToggle(filter, param) {
  return `
    <label class="filter-toggle-row">
      <span>${escapeHtml(param.label)}</span>
      <input type="checkbox" data-filter-value="${param.key}" ${filter.params[param.key] ? "checked" : ""} />
      <i></i>
    </label>`;
}

function renderFilterCards(layer) {
  return layer.filters.map((filter) => {
    const def = FILTER_DEFS.find((item) => item.id === filter.defId);
    if (!def) return "";
    const generatorToggles = def.group === "Generate"
      ? [
        ...def.params.filter((param) => param.type === "toggle"),
        { key: "alphaLock", label: "Alpha Lock", type: "toggle" },
      ]
      : [];
    const params = [
      ...(def.group === "Generate"
        ? def.params.filter((param) => param.type !== "toggle")
        : def.params
      ).map((param) => renderFilterParam(filter, param)),
      generatorToggles.length
        ? `<div class="filter-toggle-group">${generatorToggles.map((param) => renderFilterToggle(filter, param)).join("")}</div>`
        : "",
    ].join("");
    return `
      <article class="filter-card ${filter.enabled ? "" : "disabled"} ${filter.collapsed ? "collapsed" : ""}" data-filter-id="${filter.id}">
        <div class="filter-head">
          <button class="filter-icon-button" data-filter-action="toggle" title="${filter.enabled ? "Disable" : "Enable"}">${eyeSvg(filter.enabled)}</button>
          <button class="filter-icon-button filter-collapse-button" data-filter-action="collapse" title="${filter.collapsed ? "Expand filter" : "Collapse filter"}" aria-label="${filter.collapsed ? "Expand filter" : "Collapse filter"}">
            <svg viewBox="0 0 20 20"><path d="${filter.collapsed ? "m6.5 8 3.5 3.5L13.5 8" : "m6.5 12 3.5-3.5 3.5 3.5"}"/></svg>
          </button>
          <span class="filter-title" draggable="true" data-filter-drag title="Drag title to reorder">${def.label}</span>
          <button class="filter-icon-button" data-filter-action="delete" title="Delete filter">
            <svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5 5 15"/></svg>
          </button>
        </div>
        <div class="filter-params">${params}</div>
      </article>`;
  }).join("");
}

function materialMapNameKey(key) {
  return `${key}Name`;
}

function renderMaterialMap(label, key, material, fallback, strengthKey, strengthMax = 1) {
  const mapName = materialMapNameKey(key);
  if (!material[key]) {
    const isDesktopNormalMap = key === "normalMap" && window.shaderPaintDesktop?.isDesktop;
    const uploadControl = isDesktopNormalMap
      ? '<button type="button" class="filter-image-button" data-material-open-map-set>Upload set</button>'
      : `<label class="filter-image-button">${key === "normalMap" ? "Upload set" : "Upload"}<input type="file" accept="image/*" ${key === "normalMap" ? "multiple" : ""} data-material-map="${key}" /></label>`;
    return `
      <div class="material-map-row material-map-upload">
        <span class="material-map-label">${escapeHtml(label)}</span>
        ${uploadControl}
        ${fallback ? `<i>${escapeHtml(fallback)}</i>` : ""}
      </div>`;
  }
  const filename = material[mapName] || "Loaded map";
  const strengthControls = strengthKey ? `
       <input type="range" min="0" max="${strengthMax}" step="0.01" value="${material[strengthKey]}" data-material-param="${strengthKey}" aria-label="${escapeHtml(label)} strength" />
       <input type="number" min="0" max="${strengthMax}" step="0.01" value="${material[strengthKey]}" data-material-number="${strengthKey}" aria-label="${escapeHtml(label)} strength value" />` : "";
  return `
    <div class="material-map-row material-map-loaded">
      <span class="material-map-label" title="${escapeHtml(filename)}">${escapeHtml(label)}</span>
      ${strengthControls}
      <div class="material-map-actions">
        <button type="button" class="material-map-overflow" data-material-map-menu aria-label="${escapeHtml(label)} map actions" aria-expanded="false" title="${escapeHtml(filename)}">•••</button>
        <div class="material-map-menu" hidden>
          <label>Replace<input type="file" accept="image/*" ${key === "normalMap" ? "multiple" : ""} data-material-map="${key}" /></label>
          <button type="button" data-material-clear-map="${key}">Clear</button>
        </div>
      </div>
    </div>`;
}

function renderMaterialControl(label, key, value, min, max, step) {
  return `
    <div class="control-row">
      <label>${label}</label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-material-param="${key}" />
      <input type="number" min="${min}" max="${max}" step="${step}" value="${value}" data-material-number="${key}" />
    </div>`;
}

function renderMaterialPanel(layer) {
  const material = normalizeMaterial(layer.material);
  layer.material = material;
  return `
    <section class="material-panel-content">
      <p class="material-intro">GPU-lit plane. Without a color map, it shades the composite beneath this layer.</p>
      <div class="material-section">
        <div class="material-section-heading">
          <span class="material-section-label">Surface maps</span>
          <button type="button" class="material-library-button" data-material-open-library title="Open material library" aria-label="Open material library">
            <svg viewBox="0 0 20 20"><path d="M3.5 5.5h4l1.4 1.7h7.6v8.3H3.5z"/><path d="M3.5 5.5V4h4.2l1.3 1.5"/></svg>
          </button>
        </div>
        ${renderMaterialMap("Color", "colorMap", material, "Uses composite", "colorStrength", 1)}
        ${renderMaterialMap("Normal", "normalMap", material, "Flat normal", "normalStrength", 1)}
        ${renderMaterialMap("Roughness", "roughnessMap", material, "", "roughnessMapBlend", 1)}
        ${renderMaterialMap("Metalness", "metalnessMap", material, "", "metalnessMapBlend", 1)}
      </div>
      <div class="material-section">
        <span class="material-section-label">Original Material</span>
        ${renderMaterialControl("Roughness", "baseRoughness", material.baseRoughness, 0, 1, 0.01)}
        ${renderMaterialControl("Metalness", "baseMetalness", material.baseMetalness, 0, 1, 0.01)}
      </div>
      <div class="material-section">
        <span class="material-section-label">Texture Tiling</span>
        ${renderMaterialControl("Scale", "textureScale", material.textureScale, 0.05, 16, 0.01)}
        ${renderMaterialControl("Edge blend width", "edgeBlendWidth", material.edgeBlendWidth, 0, 0.5, 0.01)}
        ${renderMaterialControl("Offset X", "textureOffsetX", material.textureOffsetX, -4, 4, 0.01)}
        ${renderMaterialControl("Offset Y", "textureOffsetY", material.textureOffsetY, -4, 4, 0.01)}
        <p class="material-tile-note">Scale, offset, and irregular edge blending are shared by all surface maps.</p>
      </div>
      <div class="material-section">
        <div class="material-section-heading">
          <span class="material-section-label">Light</span>
          <button type="button" class="material-reset-button" data-material-reset-light>Reset all</button>
        </div>
        <div class="control-row material-select-row">
          <label>Type</label>
          <select data-material-select="lightType">
            <option value="directional" ${material.lightType === "directional" ? "selected" : ""}>Directional</option>
            <option value="point" ${material.lightType === "point" ? "selected" : ""}>Point</option>
          </select>
        </div>
        <div class="control-row material-color-row">
          <label>Color</label>
          <input type="color" value="${escapeHtml(material.color)}" data-material-color="color" />
          <code>${escapeHtml(material.color)}</code>
        </div>
        ${renderMaterialControl("Intensity", "intensity", material.intensity, 0, 8, 0.01)}
        ${renderMaterialControl("Light X", "directionX", material.directionX, -4, 4, 0.01)}
        ${renderMaterialControl("Light Y", "directionY", material.directionY, -4, 4, 0.01)}
        ${renderMaterialControl("Light Z", "directionZ", material.directionZ, 0.01, 8, 0.01)}
        ${renderMaterialControl("Ambient", "ambient", material.ambient, 0, 1, 0.01)}
      </div>
    </section>`;
}

function renderHeightPanel(layer) {
  const height = normalizeHeight(layer.height);
  layer.height = height;
  return `
    <section class="material-panel-content">
      <p class="material-intro">Paint bright values to raise and light the surface. Its mask controls only the final pixels, not the displaced grid.</p>
      <div class="material-section">
        <span class="material-section-label height-displacement-label">Displacement</span>
        ${renderMaterialControl("Height strength", "heightStrength", height.heightStrength, 0, 4, 0.01)}
        <div class="control-row height-auto-smooth-row">
          <label>Auto smooth</label>
          <input type="checkbox" data-height-toggle="autoSmooth" ${height.autoSmooth ? "checked" : ""} />
        </div>
        ${renderMaterialControl("Smooth angle", "smoothAngle", height.smoothAngle, 1, 180, 1)}
        <div class="control-row material-select-row">
          <label>Mesh detail</label>
          <select data-height-select="meshResolution">
            <option value="96" ${height.meshResolution === 96 ? "selected" : ""}>Low · 96 × 96</option>
            <option value="160" ${height.meshResolution === 160 ? "selected" : ""}>Medium · 160 × 160</option>
            <option value="256" ${height.meshResolution === 256 ? "selected" : ""}>High · 256 × 256</option>
            <option value="384" ${height.meshResolution === 384 ? "selected" : ""}>Ultra · 384 × 384</option>
          </select>
        </div>
        <p class="material-tile-note">Ultra uses about 148,000 vertices. Use High for the most responsive large-stamp previews.</p>
      </div>
      <div class="material-section">
        <span class="material-section-label">Surface material</span>
        <div class="control-row material-color-row">
          <label>Base color</label>
          <input type="color" value="${escapeHtml(height.materialColor)}" data-height-color="materialColor" />
          <code>${escapeHtml(height.materialColor)}</code>
        </div>
        ${renderMaterialControl("Roughness", "roughness", height.roughness, 0, 1, 0.01)}
        ${renderMaterialControl("Metalness", "metalness", height.metalness, 0, 1, 0.01)}
      </div>
      <div class="material-section">
        <span class="material-section-label">Light</span>
        <div class="control-row material-color-row">
          <label>Color</label>
          <input type="color" value="${escapeHtml(height.color)}" data-height-color="color" />
          <code>${escapeHtml(height.color)}</code>
        </div>
        ${renderMaterialControl("Intensity", "intensity", height.intensity, 0, 4, 0.01)}
        ${renderMaterialControl("Light X", "directionX", height.directionX, -4, 4, 0.01)}
        ${renderMaterialControl("Light Y", "directionY", height.directionY, -4, 4, 0.01)}
        ${renderMaterialControl("Light Z", "directionZ", height.directionZ, 0.01, 8, 0.01)}
        ${renderMaterialControl("Ambient", "ambient", height.ambient, 0, 1, 0.01)}
      </div>
    </section>`;
}

function renderAdjustmentRangeSettings(layer) {
  const adjustmentIndex = state.layers.indexOf(layer);
  const choices = state.layers
    .slice(0, Math.max(0, adjustmentIndex - 1))
    .reverse()
    .map((candidate) => `
      <button type="button" data-adjustment-start-layer="${candidate.id}" ${candidate.id === layer.adjustmentStartLayerId ? 'class="selected"' : ""}>
        ${escapeHtml(candidate.name)}
      </button>`)
    .join("");
  const hasCustomRange = hasCustomAdjustmentStart(layer);
  const selectedLabel = hasCustomRange
    ? escapeHtml(getAdjustmentStartLayer(layer)?.name || "Default")
    : "Default";
  adjustmentRangeSettings.hidden = false;
  adjustmentRangeSettings.classList.toggle("custom-range", hasCustomRange);
  adjustmentRangeSettings.innerHTML = `
    <div class="adjustment-range-row">
      <span>Influence</span>
      <div class="blend-select influence-select">
        <button class="blend-select-trigger" type="button" data-adjustment-start-trigger aria-haspopup="listbox" aria-expanded="false">
          <span>${selectedLabel}</span>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>
        </button>
        <div class="blend-select-menu influence-select-menu glass-panel" data-adjustment-start-menu role="listbox" hidden>
          <button type="button" data-adjustment-start-layer="" ${hasCustomRange ? "" : 'class="selected"'}>Default</button>
          ${choices}
        </div>
      </div>
      <button type="button" class="adjustment-range-help" title="Default starts with the immediately lower layer. Choosing a lower layer skips the layers in between, then composites this filtered result above them." aria-label="Explain adjustment influence">?</button>
    </div>`;
}

function renderFilters() {
  const layer = getSelectedLayer();
  const addFilterButton = document.getElementById("addFilterButton");
  const filterHint = document.querySelector(".filter-hint");
  if (!layer) {
    filterList.innerHTML = "";
    filterRatioToggle.hidden = true;
    adjustmentRangeSettings.hidden = true;
    syncFilterPreviewControl();
    return;
  }
  syncFilterPreviewControl();
  const mask = layer.mask;
  const showMaskSettings = state.maskSettingsLayerId === layer.id && mask;
  const isMaterial = layer.kind === "material";
  const isHeight = layer.kind === "height";
  const isSurfaceLayer = isMaterial || isHeight;
  const isAdjustment = layer.kind === "adjustment";
  const showMaterialTabs = isSurfaceLayer && !showMaskSettings;
  materialPanelTabs.hidden = !showMaterialTabs;
  const materialTab = materialPanelTabs.querySelector('[data-material-panel-tab="material"]');
  materialTab.textContent = isHeight ? "Height" : "Material";
  if (state.materialPanelTab === "surface") state.materialPanelTab = "material";
  materialPanelTabs.querySelectorAll("[data-material-panel-tab]").forEach((button) => {
    const active = button.dataset.materialPanelTab === state.materialPanelTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  filterPanelTitle.textContent = showMaskSettings ? "Mask settings" : isHeight ? "Height Layer" : isMaterial ? "3D Material" : "Filters";
  filterAddWrap.hidden = Boolean(showMaskSettings) || (isSurfaceLayer && state.materialPanelTab !== "filters");
  addFilterButton.innerHTML = isSurfaceLayer ? "<span>+</span> Add post filter" : "<span>+</span> Add filter";
  filterPreview.hidden = Boolean(showMaskSettings) || (isSurfaceLayer && state.materialPanelTab !== "filters");
  filterHint.hidden = Boolean(showMaskSettings) || (isSurfaceLayer && state.materialPanelTab !== "filters");
  filterRatioToggle.hidden = Boolean(showMaskSettings) || (isSurfaceLayer && state.materialPanelTab !== "filters");
  if (isAdjustment && !showMaskSettings) renderAdjustmentRangeSettings(layer);
  else adjustmentRangeSettings.hidden = true;
  filterMatchRatio.checked = Boolean(layer.matchFilterRatio);
  filterHint.textContent = isSurfaceLayer
    ? "Post filters run after material lighting, from bottom to top. Drag to reorder."
    : "Filters run from bottom to top. Drag to reorder.";
  if (showMaskSettings) {
    filterList.innerHTML = `
      <section class="mask-settings-card">
        <p>Controls the selected layer mask without changing its painted pixels.</p>
        ${renderMaskSetting("Softness", "softness", mask.softness, 0, 1, 0.01)}
        ${renderMaskSetting("Opacity", "opacity", mask.opacity, 0, 1, 0.01)}
        ${renderMaskSetting("Contrast", "contrast", mask.contrast, -1, 1, 0.01)}
        <div class="mask-settings-divider"></div>
        <p class="mask-settings-section-label">Roughen edges</p>
        ${renderMaskSetting("Amount", "roughenAmount", mask.roughenAmount, 0, 1, 0.01)}
        ${renderMaskSetting("Edge Width", "roughenWidth", mask.roughenWidth, 0, 64, 0.5)}
        ${renderMaskSetting("Rough Scale", "roughenScale", mask.roughenScale, 1, 400, 1)}
        ${renderMaskSetting("Edge Sharpness", "roughenSharpness", mask.roughenSharpness, 0.25, 4, 0.05)}
      </section>`;
    return;
  }
  filterList.innerHTML = isSurfaceLayer && state.materialPanelTab === "material"
    ? (isHeight ? renderHeightPanel(layer) : renderMaterialPanel(layer))
    : renderFilterCards(layer) || (isSurfaceLayer ? '<p class="material-empty-filters">No post filters applied.</p>' : "");
}

function renderMaskSetting(label, key, value, min, max, step) {
  return `
    <div class="control-row">
      <label>${label}</label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-mask-setting="${key}" />
      <input type="number" min="${min}" max="${max}" step="${step}" value="${value}" data-mask-setting="${key}" />
    </div>`;
}

function addFilter(defId) {
  const layer = getSelectedLayer();
  if (!layer) return;
  layer.filters.unshift(createFilter(defId));
  invalidateLayerThumbnail(layer);
  renderFilters();
  renderLayers();
  requestRender();
  commitDocumentAction();
}

function reorderByIds(items, draggedId, targetId, insertAfter = null) {
  const fromIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return false;
  const movingDown = fromIndex < targetIndex;
  const [item] = items.splice(fromIndex, 1);
  const adjustedTargetIndex = items.findIndex((entry) => entry.id === targetId);
  const destination = adjustedTargetIndex + (insertAfter === null ? (movingDown ? 1 : 0) : Number(insertAfter));
  items.splice(Math.max(0, Math.min(items.length, destination)), 0, item);
  return true;
}

function setPairedControl(range, number, value, onChange, onCommit = commitDocumentAction) {
  let valueBeforeEdit = Number(value);
  let dirty = false;
  const beginEdit = () => {
    valueBeforeEdit = Number(range.value);
    dirty = false;
  };
  const apply = (input) => {
    const numeric = Number(input.value);
    if (!Number.isFinite(numeric)) return;
    range.value = String(numeric);
    number.value = String(numeric);
    onChange(numeric);
    dirty ||= numeric !== valueBeforeEdit;
  };
  const commit = () => {
    if (!dirty) return;
    dirty = false;
    onCommit();
  };
  range.addEventListener("pointerdown", beginEdit);
  range.addEventListener("focus", beginEdit);
  range.addEventListener("input", () => apply(range));
  range.addEventListener("change", commit);
  number.addEventListener("focus", beginEdit);
  number.addEventListener("change", () => {
    apply(number);
    commit();
  });
  number.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    number.blur();
  });
}

function syncBrushUi() {
  brushSize.value = String(state.brush.size);
  brushSizeNumber.value = String(state.brush.size);
  brushOpacity.value = String(state.brush.opacity);
  brushOpacityNumber.value = String(state.brush.opacity);
  state.brush.edgeBlend = Math.max(0, Math.min(1, Number(state.brush.edgeBlend) || 0));
  brushEdgeBlend.value = String(state.brush.edgeBlend);
  brushEdgeBlendNumber.value = String(state.brush.edgeBlend);
  brushValue.value = String(state.brush.value);
  brushValueNumber.value = String(state.brush.value);
  state.brush.mode = ["normal", "stamp", "direction"].includes(state.brush.mode) ? state.brush.mode : "normal";
  brushModeButtons.querySelectorAll("[data-brush-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.brushMode === state.brush.mode);
  });
  const eraserToggle = document.getElementById("eraserToggle");
  eraserToggle.classList.toggle("active", state.eraserPressed);
  eraserToggle.setAttribute("aria-pressed", String(state.eraserPressed));
  const previewSize = Math.max(8, Math.min(52, state.brush.size * 0.45));
  brushPreviewDot.style.width = `${previewSize}px`;
  brushPreviewDot.style.height = `${previewSize}px`;
  const preset = getBrushPreset();
  if (!preset) {
    brushPreviewDot.removeAttribute("data-brush-style");
    brushPreviewDot.style.removeProperty("--brush-seed");
    brushPreviewDot.style.background = "#050607";
    brushPreview.setAttribute("aria-label", "No brush texture is available");
    document.querySelector("#brushPanel .panel-heading strong").textContent = "No brush texture";
    return;
  }
  brushPreviewDot.dataset.brushStyle = preset.style;
  brushPreviewDot.style.setProperty("--brush-seed", preset.seed);
  brushPreviewDot.style.background = `#050607 url("${brushThumbnailDataUrl(preset, 96)}") center / contain no-repeat`;
  brushPreview.setAttribute("aria-label", `Choose mask brush. Current brush: ${preset.name}`);
  document.querySelector("#brushPanel .panel-heading strong").textContent = preset.name;
  const selectedLayer = getSelectedLayer();
  const isPaintContent = selectedLayer?.kind === "paint" && state.selectionPart === "content";
  const isHeightContent = selectedLayer?.kind === "height" && state.selectionPart === "content";
  document.querySelector(".brush-value-row").hidden = isPaintContent;
  paintColorPanel.hidden = !isPaintContent;
  document.querySelector("#brushPanel .panel-heading .eyebrow").textContent = isHeightContent ? "Height brush" : "Mask brush";
  if (!state.colorPickerFloating) resetPaintColorPanelPlacement();
  if (isPaintContent) renderPaintColorPicker();
}

function resetPaintColorPanelPlacement() {
  if (paintColorPanel.parentElement !== paintColorPanelHome.parent) {
    paintColorPanelHome.parent.insertBefore(paintColorPanel, paintColorPanelHome.nextSibling);
  }
  paintColorPanel.style.position = "";
  paintColorPanel.style.left = "";
  paintColorPanel.style.top = "";
  paintColorPanel.style.margin = "";
}

function hideFloatingColorPicker() {
  if (!state.colorPickerFloating) return;
  state.colorPickerFloating = false;
  resetPaintColorPanelPlacement();
  syncBrushUi();
}

function isPointerInCanvas(event) {
  const rect = canvas.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

function hsvToRgb(h, s, v) {
  const chroma = v * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - chroma;
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r, g, b) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn); const delta = max - min;
  let h = 0;
  if (delta) h = max === rn ? 60 * (((gn - bn) / delta + 6) % 6) : max === gn ? 60 * ((bn - rn) / delta + 2) : 60 * ((rn - gn) / delta + 4);
  return { h, s: max ? delta / max : 0, v: max };
}

function paintColorCss() {
  const [r, g, b] = hsvToRgb(state.paintColor.h, state.paintColor.s, state.paintColor.v);
  return `rgb(${r}, ${g}, ${b})`;
}

function renderPaintColorPicker() {
  const wheel = paintHueWheel.getContext("2d");
  const cx = paintHueWheel.width / 2; const cy = paintHueWheel.height / 2; const radius = cx - 3;
  wheel.clearRect(0, 0, paintHueWheel.width, paintHueWheel.height);
  for (let angle = 0; angle < 360; angle += 1) {
    wheel.beginPath(); wheel.moveTo(cx, cy); wheel.arc(cx, cy, radius, (angle - 1) * Math.PI / 180, (angle + 1) * Math.PI / 180); wheel.closePath();
    wheel.fillStyle = `hsl(${angle} 100% 50%)`; wheel.fill();
  }
  const innerRadius = radius * 0.73;
  wheel.globalCompositeOperation = "destination-out"; wheel.beginPath(); wheel.arc(cx, cy, innerRadius, 0, Math.PI * 2); wheel.fill(); wheel.globalCompositeOperation = "source-over";
  const hueAngle = state.paintColor.h * Math.PI / 180;
  const hueRadius = (radius + innerRadius) * 0.5;
  drawPickerMarker(wheel, cx + Math.cos(hueAngle) * hueRadius, cy + Math.sin(hueAngle) * hueRadius);
  const square = paintColorSquare.getContext("2d");
  const base = `hsl(${state.paintColor.h} 100% 50%)`;
  square.fillStyle = base; square.fillRect(0, 0, square.canvas.width, square.canvas.height);
  const white = square.createLinearGradient(0, 0, square.canvas.width, 0); white.addColorStop(0, "#fff"); white.addColorStop(1, "transparent"); square.fillStyle = white; square.fillRect(0, 0, square.canvas.width, square.canvas.height);
  const black = square.createLinearGradient(0, 0, 0, square.canvas.height); black.addColorStop(0, "transparent"); black.addColorStop(1, "#000"); square.fillStyle = black; square.fillRect(0, 0, square.canvas.width, square.canvas.height);
  drawPickerMarker(square, state.paintColor.s * square.canvas.width, (1 - state.paintColor.v) * square.canvas.height);
}

function drawPickerMarker(context, x, y) {
  context.save();
  context.beginPath();
  context.arc(x, y, 4.5, 0, Math.PI * 2);
  context.fillStyle = "#111";
  context.fill();
  context.lineWidth = 1.5;
  context.strokeStyle = "#f2f4ef";
  context.stroke();
  context.restore();
}

function setPaintColorFromCanvas(event, type) {
  const target = type === "hue" ? paintHueWheel : paintColorSquare;
  const rect = target.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left)) / rect.width;
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top)) / rect.height;
  if (type === "hue") state.paintColor.h = (Math.atan2(y - 0.5, x - 0.5) * 180 / Math.PI + 360) % 360;
  else { state.paintColor.s = x; state.paintColor.v = 1 - y; }
  renderPaintColorPicker();
  scheduleSave();
}

function sampleCanvasColor(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - rect.left) / rect.width * canvas.width)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((rect.bottom - event.clientY) / rect.height * canvas.height)));
  const pixel = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  state.paintColor = rgbToHsv(pixel[0], pixel[1], pixel[2]);
  renderPaintColorPicker();
  eyedropperIndicator.style.left = `${event.clientX}px`;
  eyedropperIndicator.style.top = `${event.clientY}px`;
  eyedropperIndicator.querySelector("i").style.background = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
  eyedropperIndicator.querySelector("span").textContent = `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  eyedropperIndicator.hidden = false;
}

function setZoom(value) {
  state.zoom = Math.max(25, Math.min(200, Number(value) || 80));
  document.getElementById("zoomRange").value = String(state.zoom);
  document.getElementById("zoomLabel").textContent = `${Math.round(state.zoom)}%`;
  canvasWrap.style.setProperty("--zoom-scale", state.zoom / 80);
  scheduleViewportSave();
}

function syncViewport() {
  canvasWrap.style.setProperty("--pan-x", `${state.viewport.x}px`);
  canvasWrap.style.setProperty("--pan-y", `${state.viewport.y}px`);
}

function isEditingTextField() {
  const activeElement = document.activeElement;
  return Boolean(
    activeElement?.matches?.("input, select, textarea, [contenteditable]:not([contenteditable='false'])")
    || activeElement?.closest?.("[contenteditable]:not([contenteditable='false'])"),
  );
}

function consumeCanvasShortcut(event) {
  event.preventDefault();
  event.stopPropagation();
}

function setTemporaryEraser(active) {
  const next = active || state.eraserToggled;
  if (state.eraserPressed === next) return;
  state.eraserPressed = next;
  canvas.classList.toggle("is-erasing", next);
  brushCursor.classList.toggle("is-erasing", next);
  const eraserToggle = document.getElementById("eraserToggle");
  eraserToggle.classList.toggle("active", next);
  eraserToggle.setAttribute("aria-pressed", String(next));
  updateBrushCursor({ clientX: state.lastPointer.x, clientY: state.lastPointer.y, altKey: false });
}

function clearHeldCanvasShortcuts() {
  const sizeChanged = state.sizeAdjustStart && state.brush.size !== state.sizeAdjustStart.size;
  heldCanvasShortcutCodes.clear();
  state.spacePressed = false;
  state.sizeAdjustPressed = false;
  state.sizeAdjustStart = null;
  setTemporaryEraser(false);
  canvas.classList.remove("pan-ready", "is-eyedropping");
  brushCursor.classList.remove("is-sizing");
  delete brushCursor.dataset.size;
  eyedropperIndicator.hidden = true;
  if (state.dPicker.downAt && !state.dPicker.wasOpen) hideFloatingColorPicker();
  state.dPicker = { downAt: 0, wasOpen: state.colorPickerFloating };
  if (sizeChanged) commitDocumentAction();
}

function getBrushPreset() {
  return BRUSH_PRESETS.find((preset) => preset.id === state.brush.presetId) || BRUSH_PRESETS[0];
}

const brushThumbnailCache = new Map();

function brushThumbnailDataUrl(preset, size = 64) {
  if (preset.thumbnailDataUrl || preset.imageDataUrl) return preset.thumbnailDataUrl || preset.imageDataUrl;
  const cacheKey = `${preset.id}:${size}`;
  if (brushThumbnailCache.has(cacheKey)) return brushThumbnailCache.get(cacheKey);
  const thumbnail = document.createElement("canvas");
  thumbnail.width = size;
  thumbnail.height = size;
  const context = thumbnail.getContext("2d");
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const normalizedX = (x + 0.5) / size * 2 - 1;
      const normalizedY = (y + 0.5) / size * 2 - 1;
      const distance = Math.hypot(normalizedX, normalizedY);
      const alpha = distance <= 1
        ? Math.max(0, Math.min(1, brushTextureStrength(preset.style, normalizedX, normalizedY, distance, preset.seed)))
        : 0;
      const value = Math.round(alpha * 255);
      const index = (y * size + x) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const dataUrl = thumbnail.toDataURL("image/png");
  brushThumbnailCache.set(cacheKey, dataUrl);
  return dataUrl;
}

function brushPreviewSwatch(preset) {
  return `<canvas class="brush-swatch brush-thumbnail" width="96" height="96" data-brush-thumbnail="${preset.id}" aria-label="${escapeHtml(preset.name)} brush alpha"></canvas>`;
}

function renderBrushThumbnails(root) {
  root.querySelectorAll("[data-brush-thumbnail]").forEach((thumbnail) => {
    const preset = BRUSH_PRESETS.find((entry) => entry.id === thumbnail.dataset.brushThumbnail);
    if (!preset) return;
    const context = thumbnail.getContext("2d");
    const image = new Image();
    image.onload = () => context.drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
    image.src = brushThumbnailDataUrl(preset, thumbnail.width);
  });
}

function brushDisplayName(fileName) {
  return String(fileName || "Imported brush")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyBrushTextureLibrary(library) {
  const groups = Array.isArray(library?.groups) ? library.groups : [];
  const existingPresets = new Map(BRUSH_PRESETS.map((preset) => [preset.id, preset]));
  const nextGroups = groups
    .filter((group) => Array.isArray(group.brushes) && group.brushes.length)
    .map((group) => ({ id: group.id, label: group.name }));
  const nextPresets = nextGroups.flatMap((group) => {
    const source = groups.find((entry) => entry.id === group.id);
    return source.brushes.map((brush) => {
      const id = `texture:${brush.id}`;
      const previous = existingPresets.get(id);
      const unchanged = previous?.sourceVersion === brush.version;
      if (!unchanged && externalBrushTextures.has(id)) {
        gl.deleteTexture(externalBrushTextures.get(id));
        externalBrushTextures.delete(id);
      }
      return {
        id,
        externalId: brush.id,
        group: group.id,
        name: brushDisplayName(brush.name),
        description: `Imported black-to-alpha texture from ${group.label}.`,
        style: "soft",
        seed: 1,
        sourceVersion: brush.version,
        thumbnailDataUrl: brush.preview?.dataUrl || "",
        imageDataUrl: unchanged ? previous.imageDataUrl : brush.imageUrl || null,
      };
    });
  });
  const knownIds = new Set(nextPresets.map((preset) => preset.id));
  externalBrushTextures.forEach((texture, id) => {
    if (knownIds.has(id)) return;
    gl.deleteTexture(texture);
    externalBrushTextures.delete(id);
  });
  BRUSH_GROUPS = nextGroups;
  BRUSH_PRESETS = nextPresets;
  if (!BRUSH_PRESETS.length) {
    state.brush.presetId = "";
    renderBrushLibrary();
    syncBrushUi();
    showToast("Texture is empty. Add a black-and-white image inside a group folder.");
    return;
  }
  if (!knownIds.has(state.brush.presetId)) state.brush.presetId = BRUSH_PRESETS[0].id;
  brushThumbnailCache.clear();
  void ensureExternalBrushTexture(getBrushPreset()).catch((error) => {
    console.error(`Could not load selected brush texture "${getBrushPreset()?.name || ""}".`, error);
  });
  syncBrushUi();
  renderBrushLibrary();
}

function legacyBrushTextureFiles() {
  return LEGACY_BRUSH_PRESETS.map((preset) => {
    const group = BRUSH_GROUPS.find((entry) => entry.id === preset.group)?.label || "Imported";
    const safeName = preset.name.replace(/[\\/:*?"<>|]/g, "-");
    return {
      group,
      name: `${safeName}.png`,
      dataUrl: brushThumbnailDataUrl(preset, 512),
    };
  });
}

async function bundledBrushTextureLibrary() {
  const manifestUrl = new URL("./brushes/brush-library.json", window.location.href);
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Could not load the bundled brush library (${response.status}).`);
  const manifest = await response.json();
  if (!Array.isArray(manifest.groups)) throw new Error("The bundled brush library is invalid.");
  return {
    groups: manifest.groups.map((group) => ({
      id: group.id,
      name: group.name,
      brushes: group.files.map((name) => {
        const imageUrl = new URL(
          `./brushes/${encodeURIComponent(group.directory)}/${encodeURIComponent(name)}`,
          window.location.href,
        ).href;
        return {
          id: `${group.id}:${name}`,
          name,
          imageUrl,
          preview: { dataUrl: imageUrl },
          version: "bundled-v1",
        };
      }),
    })),
  };
}

async function initializeBrushTextureLibrary() {
  const desktop = window.shaderPaintDesktop;
  if (!desktop?.isDesktop) {
    try {
      applyBrushTextureLibrary(await bundledBrushTextureLibrary());
    } catch (error) {
      console.error("Shader Paint could not load the bundled brush library.", error);
      showToast("Bundled brush library could not be loaded. Using built-in brushes.");
    }
    return;
  }
  try {
    const library = await desktop.initializeBrushTextureLibrary(legacyBrushTextureFiles());
    applyBrushTextureLibrary(library);
    desktop.onBrushTextureLibraryChanged((updatedLibrary) => {
      const selectedId = state.brush.presetId;
      applyBrushTextureLibrary(updatedLibrary);
      if (selectedId !== state.brush.presetId) showToast("Selected brush was removed; switched to the first available texture.");
    });
  } catch (error) {
    console.error("Shader Paint could not load the Texture folder.", error);
    showToast("Texture folder could not be loaded. Using the built-in brushes.");
  }
}

function renderBrushLibrary() {
  if (!BRUSH_PRESETS.length) {
    brushGrid.innerHTML = '<p class="brush-library-empty">No brush images found. Add a black-and-white image to a group inside Texture.</p>';
    brushLibraryPreview.innerHTML = "";
    brushLibraryName.textContent = "No brush texture";
    brushLibraryDescription.textContent = "Create a group folder in Texture, then add PNG, JPG, WEBP, GIF, or AVIF images.";
    return;
  }
  brushGrid.innerHTML = BRUSH_GROUPS.map((group) => {
    const presets = BRUSH_PRESETS.filter((preset) => preset.group === group.id);
    return `<section class="brush-group" aria-label="${group.label} brushes">
      <div class="brush-group-heading"><span>${group.label}</span><i>${presets.length}</i></div>
      <div class="brush-group-grid">${presets.map((preset) => `
        <button type="button" class="brush-preset ${preset.id === state.brush.presetId ? "selected" : ""}" data-brush-preset="${preset.id}" title="${escapeHtml(preset.name)}">
          ${brushPreviewSwatch(preset)}
          <span class="brush-preset-name">${escapeHtml(preset.name)}</span>
        </button>`).join("")}</div>
    </section>`;
  }).join("");
  const selected = getBrushPreset();
  brushLibraryPreview.innerHTML = brushPreviewSwatch(selected);
  renderBrushThumbnails(brushGrid);
  renderBrushThumbnails(brushLibraryPreview);
  brushLibraryName.textContent = selected.name;
  brushLibraryDescription.textContent = selected.description;
}

async function setBrushPreset(id) {
  if (!BRUSH_PRESETS.some((preset) => preset.id === id) || state.brush.presetId === id) return;
  const nextPreset = BRUSH_PRESETS.find((preset) => preset.id === id);
  try {
    await ensureExternalBrushTexture(nextPreset);
  } catch (error) {
    reportError(error);
    return;
  }
  flushPendingPaintDabs();
  flushPendingMaskDabs();
  state.brush.presetId = id;
  syncBrushUi();
  renderBrushLibrary();
  commitDocumentAction();
}

function setBrushLibraryOpen(open) {
  brushLibrary.hidden = !open;
  brushPreview.setAttribute("aria-expanded", String(open));
  if (open) renderBrushLibrary();
}

const MATERIAL_MAP_LABELS = {
  colorMap: "Color",
  normalMap: "Normal",
  roughnessMap: "Roughness",
  metalnessMap: "Metalness",
};

function renderMaterialLibrary() {
  const materials = state.materialLibrary;
  materialLibraryTitle.textContent = materials.length
    ? `${materials.length} material folder${materials.length === 1 ? "" : "s"}`
    : "Material folders";
  materialLibraryEmpty.textContent = state.materialLibraryMessage
    || "No supported image sets were found in this library. Choose a folder in settings.";
  materialLibraryEmpty.hidden = materials.length > 0;
  materialLibraryGrid.innerHTML = materials.map((material) => {
    const availability = (material.availableMaps || [])
      .map((key) => `<span>${MATERIAL_MAP_LABELS[key] || key}</span>`)
      .join("");
    const loading = material.id === state.materialLibraryLoadingItemId;
    return `<button type="button" class="material-library-card ${loading ? "loading" : ""}" data-material-library-id="${escapeHtml(material.id)}" title="Load ${escapeHtml(material.name)}" ${loading ? 'disabled aria-busy="true"' : ""}>
      <img src="${material.preview?.dataUrl || ""}" alt="" />
      <strong>${loading ? "Loading…" : escapeHtml(material.name)}</strong>
      <span class="material-library-maps">${availability || "<span>Image</span>"}</span>
    </button>`;
  }).join("");
}

function setMaterialLibraryOpen(open) {
  materialLibrary.hidden = !open;
  if (open) renderMaterialLibrary();
}

function formatRecentProjectDate(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "Recently opened";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function renderRecentProjects() {
  const projects = state.recentProjects;
  recentProjectsEmpty.hidden = projects.length > 0;
  recentProjectsGrid.innerHTML = projects.map((project) => {
    const dimensions = project.width && project.height ? `${project.width} x ${project.height}` : "Shader Paint project";
    const preview = project.thumbnail
      ? `<img src="${project.thumbnail}" alt="" />`
      : '<span class="recent-project-placeholder">No preview</span>';
    return `<button type="button" class="recent-project-card" data-recent-project-path="${escapeHtml(project.filePath)}" title="Open ${escapeHtml(project.name)}">
      <span class="recent-project-preview">${preview}</span>
      <strong>${escapeHtml(project.name)}</strong>
      <span>${dimensions}</span>
      <small>${formatRecentProjectDate(project.openedAt)}</small>
    </button>`;
  }).join("");
}

function syncSaveStatus() {
  const status = state.projectSaveStatus;
  const labels = {
    unsaved: "Unsaved changes — save project",
    saving: "Saving project",
    saved: "Project saved — save again",
  };
  const icons = {
    unsaved: '<path d="M4 4.5h9l3 3v8H4z"/><circle cx="10" cy="12" r="2.1"/>',
    saving: '<path d="M16.2 8.2A6.5 6.5 0 1 0 16 12.5"/><path d="M16.2 4.5v3.8h-3.8"/>',
    saved: '<path d="M4 4.5h9l3 3v8H4z"/><path d="m7.2 12 1.9 1.9 4-4.1"/>',
  };
  saveStatusButton.dataset.saveStatus = status;
  saveStatusButton.title = labels[status];
  saveStatusButton.setAttribute("aria-label", labels[status]);
  saveStatusButton.querySelector("svg").innerHTML = icons[status];
  saveStatusButton.disabled = status === "saving";
}

function markProjectUnsaved() {
  if (state.projectSaveStatus === "saving") return;
  if (state.projectSaveStatus !== "unsaved") {
    state.projectSaveStatus = "unsaved";
    syncSaveStatus();
  }
}

function loadProjectSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROJECT_SETTINGS_KEY) || "{}");
    state.projectAutosave.enabled = stored.projectAutosave?.enabled === true;
    state.projectAutosave.intervalSeconds = Math.max(15, Math.min(3600, Number(stored.projectAutosave?.intervalSeconds) || 60));
    state.ipad.ignoreTouchDraw = stored.ipad?.ignoreTouchDraw === true;
    state.ipad.layersCollapsed = stored.ipad?.layersCollapsed === true;
    state.ipad.filtersCollapsed = stored.ipad?.filtersCollapsed === true;
    state.ipad.brushPanelPosition = stored.ipad?.brushPanelPosition
      && Number.isFinite(stored.ipad.brushPanelPosition.x)
      && Number.isFinite(stored.ipad.brushPanelPosition.y)
      ? stored.ipad.brushPanelPosition
      : null;
    state.pressure.sizeMinimum = clampPressureSetting(stored.pressure?.sizeMinimum, 0, 1, 0.32);
    state.pressure.sizeResponse = clampPressureSetting(stored.pressure?.sizeResponse, 0.25, 3, 1);
    state.pressure.opacityMinimum = clampPressureSetting(stored.pressure?.opacityMinimum, 0, 1, 0.2);
    state.pressure.opacityResponse = clampPressureSetting(stored.pressure?.opacityResponse, 0.25, 3, 1);
    state.pressure.sizeCurveExpanded = stored.pressure?.sizeCurveExpanded === true;
    state.pressure.opacityCurveExpanded = stored.pressure?.opacityCurveExpanded === true;
    state.filterMenuCategoryOrder = Array.isArray(stored.filterMenuCategoryOrder) ? stored.filterMenuCategoryOrder : [];
    state.filterMenuFilterOrders = stored.filterMenuFilterOrders && typeof stored.filterMenuFilterOrders === "object"
      ? stored.filterMenuFilterOrders
      : {};
  } catch (error) {
    console.warn("Shader Paint could not load application settings.", error);
  }
}

function saveProjectSettings() {
  localStorage.setItem(PROJECT_SETTINGS_KEY, JSON.stringify({
    version: 1,
    projectAutosave: state.projectAutosave,
    pressure: state.pressure,
    ipad: state.ipad,
    filterMenuCategoryOrder: state.filterMenuCategoryOrder,
    filterMenuFilterOrders: state.filterMenuFilterOrders,
  }));
}

function pressureCurvePoints(minimum, response) {
  return Array.from({ length: 25 }, (_, index) => {
    const pressure = index / 24;
    const x = pressure * 100;
    const y = 50 - pressureOutput(pressure, minimum, response) * 48;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function syncPressureSettings() {
  pressureSizeMinimum.value = String(Math.round(state.pressure.sizeMinimum * 100));
  pressureSizeMinimumNumber.value = pressureSizeMinimum.value;
  pressureSizeResponse.value = String(state.pressure.sizeResponse);
  pressureSizeResponseNumber.value = pressureSizeResponse.value;
  pressureOpacityMinimum.value = String(Math.round(state.pressure.opacityMinimum * 100));
  pressureOpacityMinimumNumber.value = pressureOpacityMinimum.value;
  pressureOpacityResponse.value = String(state.pressure.opacityResponse);
  pressureOpacityResponseNumber.value = pressureOpacityResponse.value;
  pressureSizeCurve.hidden = !state.pressure.sizeCurveExpanded;
  pressureSizeCurveToggle.setAttribute("aria-expanded", String(state.pressure.sizeCurveExpanded));
  pressureOpacityCurve.hidden = !state.pressure.opacityCurveExpanded;
  pressureOpacityCurveToggle.setAttribute("aria-expanded", String(state.pressure.opacityCurveExpanded));
  pressureSizeCurvePreview.setAttribute(
    "points",
    pressureCurvePoints(state.pressure.sizeMinimum, state.pressure.sizeResponse),
  );
  pressureOpacityCurvePreview.setAttribute(
    "points",
    pressureCurvePoints(state.pressure.opacityMinimum, state.pressure.opacityResponse),
  );
}

function syncSettingsPanel() {
  projectAutosaveEnabled.checked = state.projectAutosave.enabled;
  projectAutosaveInterval.value = String(state.projectAutosave.intervalSeconds);
  projectAutosaveEnabled.disabled = !window.shaderPaintDesktop?.isDesktop;
  projectAutosaveInterval.disabled = !window.shaderPaintDesktop?.isDesktop || !state.projectAutosave.enabled;
  ignoreTouchDraw.checked = state.ipad.ignoreTouchDraw;
  syncPressureSettings();
}

function bindPressureSettingControl(range, number, key, scale, minimum, maximum) {
  const apply = (input) => {
    const value = clampPressureSetting(Number(input.value) / scale, minimum, maximum, state.pressure[key]);
    state.pressure[key] = value;
    saveProjectSettings();
    syncPressureSettings();
  };
  range.addEventListener("input", () => apply(range));
  number.addEventListener("change", () => apply(number));
  number.addEventListener("keydown", (event) => {
    if (event.key === "Enter") number.blur();
  });
}

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  if (open) syncSettingsPanel();
}

function syncDockPanels() {
  const rightDock = document.getElementById("rightDock");
  const layersCollapsed = state.ipad.layersCollapsed;
  const filtersCollapsed = state.ipad.filtersCollapsed;
  document.getElementById("layersPanel").classList.toggle("is-collapsed", layersCollapsed);
  document.getElementById("filtersPanel").classList.toggle("is-collapsed", filtersCollapsed);
  rightDock.classList.toggle("layers-collapsed", layersCollapsed);
  rightDock.classList.toggle("filters-collapsed", filtersCollapsed);
  document.getElementById("collapseLayers").setAttribute("aria-expanded", String(!layersCollapsed));
  document.getElementById("collapseFilters").setAttribute("aria-expanded", String(!filtersCollapsed));
  document.getElementById("collapseLayers").textContent = layersCollapsed ? "‹" : "›";
  document.getElementById("collapseFilters").textContent = filtersCollapsed ? "‹" : "›";
  document.getElementById("collapseLayers").dataset.collapsed = String(layersCollapsed);
  document.getElementById("collapseFilters").dataset.collapsed = String(filtersCollapsed);
  syncCanvasPresentation();
}

function syncBrushPanelPosition() {
  const position = state.ipad.brushPanelPosition;
  if (!position) return;
  const brushPanel = document.getElementById("brushPanel");
  brushPanel.style.left = `${position.x}px`;
  brushPanel.style.top = `${position.y}px`;
  brushPanel.style.transform = "none";
}

function scheduleProjectFileAutosave() {
  window.clearTimeout(state.projectAutosaveTimer);
  state.projectAutosaveTimer = 0;
  if (
    !state.projectAutosave.enabled
    || !window.shaderPaintDesktop?.isDesktop
    || !state.projectFilePath
  ) return;
  state.projectAutosaveTimer = window.setTimeout(() => {
    state.projectAutosaveTimer = 0;
    if (state.paintPointerId !== null || hasDirtyPaintLayerDataUrls()) {
      scheduleProjectFileAutosave();
      return;
    }
    saveProject(false);
  }, state.projectAutosave.intervalSeconds * 1000);
}

async function captureRecentProjectThumbnail() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const longestSide = 360;
  const scale = Math.min(1, longestSide / Math.max(canvas.width, canvas.height));
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(canvas.width * scale));
  preview.height = Math.max(1, Math.round(canvas.height * scale));
  const context = preview.getContext("2d");
  context.drawImage(canvas, 0, 0, preview.width, preview.height);
  return preview.toDataURL("image/jpeg", 0.72);
}

async function recordCurrentProjectAsRecent() {
  const desktop = window.shaderPaintDesktop;
  if (!desktop?.isDesktop || !desktop.recordRecentProject || !state.projectFilePath) return;
  try {
    const thumbnail = await captureRecentProjectThumbnail();
    state.recentProjects = await desktop.recordRecentProject({
      filePath: state.projectFilePath,
      thumbnail,
      width: DOC_WIDTH,
      height: DOC_HEIGHT,
    });
    if (!projectLibrary.hidden) renderRecentProjects();
  } catch (error) {
    console.warn("Shader Paint could not update the recent project preview.", error);
  }
}

async function setProjectLibraryOpen(open) {
  projectLibrary.hidden = !open;
  projectLibraryTrigger.setAttribute("aria-expanded", String(open));
  if (!open) return;
  const desktop = window.shaderPaintDesktop;
  if (!desktop?.isDesktop || !desktop.loadRecentProjects) {
    state.recentProjects = [];
    renderRecentProjects();
    return;
  }
  state.recentProjects = await desktop.loadRecentProjects();
  renderRecentProjects();
}

async function openRecentProject(filePath) {
  const desktop = window.shaderPaintDesktop;
  if (!desktop?.isDesktop || !desktop.openRecentProject) return;
  const result = await desktop.openRecentProject(filePath);
  await openProjectText(result.contents, result.filePath);
  setProjectLibraryOpen(false);
}

function applyMaterialLibraryResult(result) {
  state.materialLibrary = Array.isArray(result?.materials) ? result.materials : [];
  state.materialLibraryMessage = typeof result?.message === "string" ? result.message : "";
  state.materialLibraryLoadingItemId = null;
}

async function openMaterialLibrary() {
  const desktop = window.shaderPaintDesktop;
  if (!desktop?.isDesktop || !desktop.loadMaterialLibrary) {
    state.materialLibrary = [];
    state.materialLibraryMessage = "Material libraries are available in Shader Paint desktop. Choose a folder from the settings button when using the desktop app.";
    setMaterialLibraryOpen(true);
    return;
  }
  state.materialLibrary = [];
  state.materialLibraryMessage = "Loading material folders…";
  setMaterialLibraryOpen(true);
  try {
    const result = await desktop.loadMaterialLibrary();
    applyMaterialLibraryResult(result);
  } catch (error) {
    state.materialLibrary = [];
    state.materialLibraryMessage = "The material library could not be loaded. Check the folder in settings and try again.";
    throw error;
  } finally {
    setMaterialLibraryOpen(true);
  }
}

async function chooseMaterialLibrary() {
  const desktop = window.shaderPaintDesktop;
  if (!desktop?.isDesktop || !desktop.chooseMaterialLibrary) {
    state.materialLibraryMessage = "Material libraries are available in Shader Paint desktop.";
    setMaterialLibraryOpen(true);
    return;
  }
  const result = await desktop.chooseMaterialLibrary();
  if (result?.canceled) return;
  applyMaterialLibraryResult(result);
  setMaterialLibraryOpen(true);
}

async function loadMaterialLibraryItem(id) {
  const layer = getSelectedLayer();
  const material = state.materialLibrary.find((item) => item.id === id);
  const desktop = window.shaderPaintDesktop;
  if (!layer || layer.kind !== "material" || !material || !desktop?.loadMaterialLibraryItem) return;
  state.materialLibraryLoadingItemId = id;
  renderMaterialLibrary();
  try {
    const result = await desktop.loadMaterialLibraryItem(id);
    if (result?.canceled || !replaceMaterialMaps(layer, result?.maps)) {
      showToast("The selected material has no readable maps.");
      return;
    }
    layer.name = result.name || material.name || layer.name;
    setMaterialLibraryOpen(false);
    renderLayers();
    renderFilters();
    requestRender();
    commitDocumentAction();
    showToast(`${layer.name} material loaded.`);
  } finally {
    state.materialLibraryLoadingItemId = null;
    if (!materialLibrary.hidden) renderMaterialLibrary();
  }
}

function encodeMask(mask) {
  if (!mask) return null;
  const output = document.createElement("canvas");
  output.width = DOC_WIDTH;
  output.height = DOC_HEIGHT;
  const ctx = output.getContext("2d");
  const image = ctx.createImageData(DOC_WIDTH, DOC_HEIGHT);
  for (let y = 0; y < DOC_HEIGHT; y += 1) {
    const sourceY = DOC_HEIGHT - 1 - y;
    for (let x = 0; x < DOC_WIDTH; x += 1) {
      const value = mask.data[sourceY * DOC_WIDTH + x];
      const index = (y * DOC_WIDTH + x) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return output.toDataURL("image/png");
}

async function decodeMask(dataUrl) {
  if (!dataUrl) return null;
  const image = await loadImage(dataUrl);
  const source = document.createElement("canvas");
  source.width = DOC_WIDTH;
  source.height = DOC_HEIGHT;
  const ctx = source.getContext("2d");
  ctx.drawImage(image, 0, 0, DOC_WIDTH, DOC_HEIGHT);
  const pixels = ctx.getImageData(0, 0, DOC_WIDTH, DOC_HEIGHT).data;
  const data = new Uint8Array(DOC_WIDTH * DOC_HEIGHT);
  for (let y = 0; y < DOC_HEIGHT; y += 1) {
    const targetY = DOC_HEIGHT - 1 - y;
    for (let x = 0; x < DOC_WIDTH; x += 1) {
      data[targetY * DOC_WIDTH + x] = pixels[(y * DOC_WIDTH + x) * 4];
    }
  }
  return data;
}

function cloneHistoryValue(value) {
  if (Array.isArray(value)) return value.map(cloneHistoryValue);
  if (ArrayBuffer.isView(value)) {
    return typeof value.slice === "function"
      ? value.slice()
      : new value.constructor(value.buffer.slice(0));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneHistoryValue(item)]));
}

function collectDataUrlReferences(value, references, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (value.startsWith("data:")) references.add(value);
    return;
  }
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || seen.has(value)) return;
  seen.add(value);
  Object.values(value).forEach((item) => collectDataUrlReferences(item, references, seen));
}

function estimateHistoryValueBytes(value, seen = new WeakSet()) {
  if (typeof value === "string") return value.startsWith("data:") ? 16 : 16 + value.length * 2;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 4;
  if (!value || typeof value !== "object") return 0;
  if (ArrayBuffer.isView(value)) return 32 + value.byteLength;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return 32 + value.reduce((total, item) => total + estimateHistoryValueBytes(item, seen), 0);
  }
  return 48 + Object.entries(value).reduce(
    (total, [key, item]) => total + key.length * 2 + estimateHistoryValueBytes(item, seen),
    0,
  );
}

function createHistorySnapshotMetadata(snapshot) {
  const references = new Set();
  snapshot.layers.forEach((layer) => {
    collectDataUrlReferences(layer.sourceDataUrl, references);
    collectDataUrlReferences(layer.material, references);
    layer.filters.forEach((filter) => collectDataUrlReferences(filter.params, references));
  });
  Object.defineProperties(snapshot, {
    type: { value: "snapshot", enumerable: false },
    assetDataUrls: { value: Object.freeze([...references]), enumerable: false },
    estimatedBytes: { value: estimateHistoryValueBytes(snapshot), enumerable: false },
  });
  return snapshot;
}

function createHistoryActionMetadata(action, estimatedBytes) {
  Object.defineProperties(action, {
    type: { value: "action", enumerable: false },
    assetDataUrls: { value: Object.freeze([]), enumerable: false },
    estimatedBytes: { value: estimatedBytes, enumerable: false },
  });
  return action;
}

function collectLiveDocumentDataUrls() {
  const references = new Set();
  state.layers.forEach((layer) => {
    collectDataUrlReferences(layer.sourceDataUrl, references);
    collectDataUrlReferences(layer.material, references);
    layer.filters.forEach((filter) => collectDataUrlReferences(filter.params, references));
  });
  return references;
}

function estimateHistoryBytes(snapshots = state.history) {
  const liveAssets = collectLiveDocumentDataUrls();
  const historyAssets = new Set();
  let bytes = 0;
  snapshots.forEach((snapshot) => {
    bytes += snapshot.estimatedBytes;
    snapshot.assetDataUrls.forEach((asset) => historyAssets.add(asset));
  });
  historyAssets.forEach((asset) => {
    if (!liveAssets.has(asset)) bytes += asset.length * 2;
  });
  return bytes;
}

function trimHistoryToBudget() {
  let bytes = estimateHistoryBytes();
  const latestSnapshotsFitBudget = estimateHistoryBytes(state.history.slice(-MIN_HISTORY_SNAPSHOTS)) <= MAX_HISTORY_BYTES;
  const minimumToKeep = state.historyIndex === state.history.length - 1 && latestSnapshotsFitBudget
    ? Math.min(MIN_HISTORY_SNAPSHOTS, state.history.length)
    : 1;
  while (
    state.history.length > minimumToKeep
    && (state.history.length > MAX_HISTORY_SNAPSHOTS || bytes > MAX_HISTORY_BYTES)
  ) {
    if (state.historyIndex > 0) {
      state.history.shift();
      state.historyIndex -= 1;
    } else {
      state.history.splice(1, 1);
    }
    bytes = estimateHistoryBytes();
  }
  state.historyBytes = bytes;
}

function captureHistorySnapshot() {
  flushDirtyPaintLayerDataUrls();
  const snapshot = {
    width: DOC_WIDTH,
    height: DOC_HEIGHT,
    documentName: state.documentName,
    selectedLayerId: state.selectedLayerId,
    selectionPart: state.selectionPart,
    effectsPaused: state.effectsPaused,
    brush: { ...state.brush },
    layers: state.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      clipDown: layer.clipDown,
      alphaLock: layer.alphaLock,
      adjustmentStartLayerId: layer.adjustmentStartLayerId,
      matchFilterRatio: layer.matchFilterRatio === true,
      filtersEnabled: layer.filtersEnabled !== false,
      sourceDataUrl: layer.sourceDataUrl,
      material: layer.material ? cloneHistoryValue(layer.material) : null,
      height: layer.height ? cloneHistoryValue(layer.height) : null,
      mask: layer.mask ? {
        data: layer.mask.data.slice(),
        enabled: layer.mask.enabled,
        initialized: layer.mask.initialized,
        softness: layer.mask.softness,
        opacity: layer.mask.opacity,
        contrast: layer.mask.contrast,
        roughenAmount: layer.mask.roughenAmount,
        roughenWidth: layer.mask.roughenWidth,
        roughenScale: layer.mask.roughenScale,
        roughenSharpness: layer.mask.roughenSharpness,
      } : null,
      filters: layer.filters.map((filter) => ({
        id: filter.id,
        defId: filter.defId,
        enabled: filter.enabled,
        collapsed: filter.collapsed,
        params: cloneHistoryValue(filter.params),
      })),
    })),
  };
  return createHistorySnapshotMetadata(snapshot);
}

function recordHistorySnapshot() {
  if (state.restoringHistory) return;
  const snapshot = captureHistorySnapshot();
  recordHistoryEntry(snapshot);
}

function recordHistoryEntry(entry) {
  if (state.restoringHistory) return;
  state.history.splice(state.historyIndex + 1);
  state.history.push(entry);
  state.historyIndex = state.history.length - 1;
  trimHistoryToBudget();
  state.historyIndex = state.history.length - 1;
  syncHistoryButtons();
}

function recordFilterHistoryAction(layerId, filterId, before, after) {
  if (state.restoringHistory || JSON.stringify(before) === JSON.stringify(after)) return;
  const action = createHistoryActionMetadata({
    kind: "filter",
    layerId,
    filterId,
    before: cloneHistoryValue(before),
    after: cloneHistoryValue(after),
  }, estimateHistoryValueBytes(before) + estimateHistoryValueBytes(after) + 128);
  recordHistoryEntry(action);
  scheduleSave();
}

function recordMaskHistoryAction(layerId, before, after, initializedBefore, initializedAfter) {
  if (state.restoringHistory) return;
  const action = createHistoryActionMetadata({
    kind: "mask",
    layerId,
    before,
    after,
    initializedBefore,
    initializedAfter,
  }, before.byteLength + after.byteLength + 160);
  recordHistoryEntry(action);
  scheduleSave();
}

function recordMaskTileHistoryAction(layerId, tiles, initializedBefore, initializedAfter, initializedFillValue) {
  if (state.restoringHistory) return;
  const bytes = tiles.reduce((total, tile) => total + tile.before.byteLength + tile.after.byteLength, 0);
  const action = createHistoryActionMetadata({
    kind: "mask-tiles",
    layerId,
    tiles,
    initializedBefore,
    initializedAfter,
    initializedFillValue,
  }, bytes + 160);
  recordHistoryEntry(action);
  scheduleSave();
}

function recordPaintRegionHistoryAction(layerId, region, before, after) {
  if (state.restoringHistory) return;
  recordHistoryEntry(createHistoryActionMetadata({
    kind: "paint-region",
    layerId,
    region,
    before,
    after,
  }, before.byteLength + after.byteLength + 160));
  scheduleSave();
}

function commitDocumentAction() {
  if (state.restoringHistory) return;
  recordHistorySnapshot();
  scheduleSave();
}

function resetDocumentHistory() {
  state.history = [captureHistorySnapshot()];
  state.historyIndex = 0;
  state.historyBytes = estimateHistoryBytes();
  syncHistoryButtons();
}

async function restoreHistorySnapshot(snapshot) {
  state.restoringHistory = true;
  try {
    state.layers.forEach(destroyLayerGpu);
    setDocumentDimensions(snapshot.width, snapshot.height);
    const restoredLayers = [];
    for (const item of snapshot.layers) {
      const layer = await createLayerFromImage(item.sourceDataUrl, item.name, {
        id: item.id,
        kind: item.kind,
        visible: item.visible,
        opacity: item.opacity,
        blendMode: item.blendMode,
        clipDown: item.clipDown,
        alphaLock: item.alphaLock,
        adjustmentStartLayerId: item.adjustmentStartLayerId,
        matchFilterRatio: item.matchFilterRatio === true,
        filtersEnabled: item.filtersEnabled !== false,
        sourceDataUrl: item.sourceDataUrl,
        material: item.material,
        height: item.height,
        mask: item.mask ? {} : null,
        maskData: item.mask?.data,
        maskInitialized: item.mask?.initialized,
        maskEnabled: item.mask?.enabled,
        maskSoftness: item.mask?.softness,
        maskOpacity: item.mask?.opacity,
        maskContrast: item.mask?.contrast,
        maskRoughenAmount: item.mask?.roughenAmount,
        maskRoughenWidth: item.mask?.roughenWidth,
        maskRoughenScale: item.mask?.roughenScale,
        maskRoughenSharpness: item.mask?.roughenSharpness,
        filters: item.filters.map((filter) => ({
          ...filter,
          params: cloneHistoryValue(filter.params),
        })),
      });
      restoredLayers.push(layer);
    }
    state.layers = restoredLayers;
    state.documentName = snapshot.documentName;
    state.selectedLayerId = snapshot.selectedLayerId;
    state.selectionPart = snapshot.selectionPart;
    state.effectsPaused = snapshot.effectsPaused;
    state.brush = { ...snapshot.brush };
    state.maskSettingsLayerId = null;
    trimHistoryToBudget();
    syncDocumentMeta();
    syncMotionButton();
    syncBrushUi();
    syncCanvasPresentation();
    renderLayers();
    renderFilters();
    requestRender();
    saveDocument();
  } finally {
    state.restoringHistory = false;
  }
}

async function restoreHistoryPosition(index) {
  let snapshotIndex = index;
  while (snapshotIndex >= 0 && state.history[snapshotIndex].type !== "snapshot") snapshotIndex -= 1;
  if (snapshotIndex < 0) return;
  await restoreHistorySnapshot(state.history[snapshotIndex]);
  for (let actionIndex = snapshotIndex + 1; actionIndex <= index; actionIndex += 1) {
    const entry = state.history[actionIndex];
    if (entry.type === "action" && !applyHistoryAction(entry, "redo")) break;
  }
}

function applyHistoryAction(action, direction) {
  const layer = state.layers.find((item) => item.id === action.layerId);
  if (!layer) return false;
  const value = direction === "undo" ? action.before : action.after;
  if (action.kind === "filter") {
    const filter = layer.filters.find((item) => item.id === action.filterId);
    if (!filter) return false;
    filter.params = cloneHistoryValue(value);
    renderFilters();
    renderLayers();
    requestRender();
    return true;
  }
  if (action.kind === "mask" && layer.mask) {
    layer.mask.data.set(value);
    layer.mask.initialized = direction === "undo" ? action.initializedBefore : action.initializedAfter;
    uploadFullMask(layer.mask);
    requestRender();
    return true;
  }
  if (action.kind === "mask-tiles" && layer.mask) {
    const mask = layer.mask;
    if (direction === "undo" && !action.initializedBefore) {
      mask.data.fill(255);
      mask.initialized = false;
    } else {
      if (direction === "redo" && action.initializedFillValue !== null) {
        mask.data.fill(action.initializedFillValue);
      }
      action.tiles.forEach((tile) => {
        const pixels = direction === "undo" ? tile.before : tile.after;
        for (let row = 0; row < tile.height; row += 1) {
          mask.data.set(pixels.subarray(row * tile.width, (row + 1) * tile.width), (tile.y + row) * DOC_WIDTH + tile.x);
        }
      });
      mask.initialized = direction === "undo" ? action.initializedBefore : action.initializedAfter;
    }
    uploadFullMask(mask);
    requestRender();
    return true;
  }
  if (action.kind === "paint-region" && (layer.kind === "paint" || layer.kind === "height")) {
    ensureLayerGpuTextures(layer);
    ensurePaintLayerGpu(layer);
    const context = layer.sourceCanvas.getContext("2d", { alpha: true });
    const region = action.region;
    const pixels = direction === "undo" ? action.before : action.after;
    const image = new ImageData(new Uint8ClampedArray(pixels), region.width, region.height);
    context.putImageData(image, region.x, region.canvasY);
    const flipped = new Uint8Array(pixels.length);
    const rowLength = region.width * 4;
    for (let row = 0; row < region.height; row += 1) {
      flipped.set(
        pixels.subarray((region.height - 1 - row) * rowLength, (region.height - row) * rowLength),
        row * rowLength,
      );
    }
    [layer.sourceTexture, layer.paintScratchTexture].forEach((texture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        region.x,
        region.y,
        region.width,
        region.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        flipped,
      );
    });
    layer.sourceRevision = (layer.sourceRevision || 0) + 1;
    schedulePaintLayerSerialization(layer);
    invalidateLayerThumbnail(layer);
    refreshLayerThumbnail(layer);
    renderLayers();
    requestRender();
    return true;
  }
  return false;
}

async function undoDocument() {
  if (state.historyIndex <= 0) return;
  const current = state.history[state.historyIndex];
  state.historyIndex -= 1;
  if (current.type === "action") {
    applyHistoryAction(current, "undo");
    scheduleSave();
  } else {
    await restoreHistoryPosition(state.historyIndex);
  }
  syncHistoryButtons();
}

async function redoDocument() {
  if (state.historyIndex < 0 || state.historyIndex >= state.history.length - 1) return;
  state.historyIndex += 1;
  const next = state.history[state.historyIndex];
  if (next.type === "action") {
    applyHistoryAction(next, "redo");
    scheduleSave();
  } else {
    await restoreHistorySnapshot(next);
  }
  syncHistoryButtons();
}

function stripEmbeddedDataUrls(value) {
  if (Array.isArray(value)) return value.map(stripEmbeddedDataUrls);
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.startsWith("data:") ? null : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripEmbeddedDataUrls(item)]));
}

function countEmbeddedDataUrlCharacters(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countEmbeddedDataUrlCharacters(item), 0);
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.startsWith("data:") ? value.length : 0;
  }
  return Object.values(value).reduce((total, item) => total + countEmbeddedDataUrlCharacters(item), 0);
}

function estimateMaskAutosaveCharacters(mask) {
  const data = mask?.data;
  if (!data?.length) return 0;
  const firstValue = data[0];
  const step = Math.max(1, Math.floor(data.length / 2048));
  for (let index = step; index < data.length; index += step) {
    if (data[index] !== firstValue) return Math.ceil(data.byteLength * 4 / 3);
  }
  return 4096;
}

function estimateLocalAutosaveCharacters() {
  return state.layers.reduce((total, layer) => {
    const source = String(layer.sourceDataUrl || "").length;
    const material = countEmbeddedDataUrlCharacters(layer.material);
    const filters = countEmbeddedDataUrlCharacters(layer.filters.map((filter) => filter.params));
    // Uniform masks encode compactly. Varied masks use the conservative raw-data estimate
    // so a complex paint stroke never causes a speculative quota write.
    const mask = estimateMaskAutosaveCharacters(layer.mask);
    return total + source + material + filters + mask + 2048;
  }, 512);
}

function serializeDocument({ includeBinary = true } = {}) {
  return {
    version: 1,
    width: DOC_WIDTH,
    height: DOC_HEIGHT,
    documentName: state.documentName,
    selectedLayerId: state.selectedLayerId,
    selectionPart: state.selectionPart,
    effectsPaused: state.effectsPaused,
    brush: { ...state.brush },
    zoom: state.zoom,
    viewport: { ...state.viewport },
    layers: state.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      clipDown: layer.clipDown,
      alphaLock: layer.alphaLock,
      adjustmentStartLayerId: layer.adjustmentStartLayerId,
      sourceDataUrl: includeBinary ? layer.sourceDataUrl : null,
      material: layer.material
        ? (includeBinary ? { ...layer.material } : stripEmbeddedDataUrls(layer.material))
        : null,
      height: layer.height ? { ...layer.height } : null,
      mask: layer.mask ? {
        enabled: layer.mask.enabled,
        initialized: layer.mask.initialized,
        softness: layer.mask.softness,
        opacity: layer.mask.opacity,
        contrast: layer.mask.contrast,
        roughenAmount: layer.mask.roughenAmount,
        roughenWidth: layer.mask.roughenWidth,
        roughenScale: layer.mask.roughenScale,
        roughenSharpness: layer.mask.roughenSharpness,
        image: includeBinary ? encodeMask(layer.mask) : null,
      } : null,
      filters: layer.filters.map((filter) => ({
        id: filter.id,
        defId: filter.defId,
        enabled: filter.enabled,
        collapsed: filter.collapsed,
        params: includeBinary ? { ...filter.params } : stripEmbeddedDataUrls(filter.params),
      })),
    })),
  };
}

function projectPayload() {
  return {
    format: "shader-paint-document",
    version: 1,
    document: serializeDocument(),
  };
}

function isDesktopAutosaveAvailable() {
  const desktop = window.shaderPaintDesktop;
  return Boolean(desktop?.isDesktop && desktop.saveAutosave);
}

function startDesktopAutosaveWriter() {
  if (state.desktopAutosaveWriting || !isDesktopAutosaveAvailable()) return state.desktopAutosavePromise;
  state.desktopAutosaveWriting = true;
  state.desktopAutosavePromise = (async () => {
    try {
      while (state.desktopAutosaveSavedVersion < state.desktopAutosaveRequestedVersion) {
        const version = state.desktopAutosaveRequestedVersion;
        const contents = JSON.stringify(projectPayload());
        await window.shaderPaintDesktop.saveAutosave(contents);
        state.desktopAutosaveSavedVersion = version;
        state.desktopAutosaveWarningShown = false;
      }
    } catch (error) {
      console.error("Shader Paint could not write the desktop autosave.", error);
      if (!state.desktopAutosaveWarningShown) {
        state.desktopAutosaveWarningShown = true;
        showToast("Desktop autosave failed. Use Save to keep an editable project copy.");
      }
    } finally {
      state.desktopAutosaveWriting = false;
    }
  })();
  return state.desktopAutosavePromise;
}

function requestDesktopAutosave() {
  if (!isDesktopAutosaveAvailable()) return Promise.resolve();
  state.desktopAutosaveRequestedVersion += 1;
  return startDesktopAutosaveWriter();
}

function flushDocumentAutosave() {
  window.clearTimeout(state.saveTimer);
  window.clearTimeout(state.viewportSaveTimer);
  state.saveTimer = 0;
  state.viewportSaveTimer = 0;
  flushDirtyPaintLayerDataUrls();
  if (isDesktopAutosaveAvailable()) return requestDesktopAutosave();
  saveDocument();
  return Promise.resolve();
}

function storeAutosaveMetadata() {
  const metadata = {
    version: 1,
    mode: "metadata-only",
    savedAt: new Date().toISOString(),
    documentName: state.documentName,
    width: DOC_WIDTH,
    height: DOC_HEIGHT,
    layerCount: state.layers.length,
    message: "The current document was too large for browser local storage. Its image, material-map, and mask data were not stored.",
  };
  try {
    localStorage.setItem(STORAGE_METADATA_KEY, JSON.stringify(metadata));
  } catch (error) {
    console.error("Shader Paint could not store autosave status.", error);
  }
}

function pauseLocalAutosave(retryLimit, message) {
  state.localAutosaveDisabled = true;
  state.localAutosaveRetryLimit = Math.max(0, Number(retryLimit) || 0);
  storeAutosaveMetadata();
  if (!state.localAutosaveWarningShown) {
    state.localAutosaveWarningShown = true;
    showToast(message);
  }
}

function resumeLocalAutosave() {
  state.localAutosaveDisabled = false;
  state.localAutosaveRetryLimit = MAX_LOCAL_AUTOSAVE_CHARACTERS;
  state.localAutosaveWarningShown = false;
  try {
    localStorage.removeItem(STORAGE_METADATA_KEY);
  } catch (error) {
    console.error("Shader Paint could not clear autosave status.", error);
  }
}

function saveDocument() {
  state.saveTimer = 0;
  state.viewportSaveTimer = 0;
  if (state.paintPointerId !== null || hasDirtyPaintLayerDataUrls()) {
    scheduleSave();
    return;
  }
  if (isDesktopAutosaveAvailable()) {
    void requestDesktopAutosave();
    return;
  }

  const estimatedCharacters = estimateLocalAutosaveCharacters();
  if (state.localAutosaveDisabled && estimatedCharacters > state.localAutosaveRetryLimit) return;

  if (estimatedCharacters > MAX_LOCAL_AUTOSAVE_CHARACTERS) {
    pauseLocalAutosave(
      Math.floor(MAX_LOCAL_AUTOSAVE_CHARACTERS / 2),
      "Browser autosave paused for this large document. It remains open; use Save to keep a .shaderpaint copy before closing.",
    );
    return;
  }

  let serialized;
  try {
    serialized = JSON.stringify(serializeDocument());
  } catch (error) {
    console.error("Shader Paint could not serialize the document for local save.", error);
    pauseLocalAutosave(
      Math.floor(estimatedCharacters / 2),
      "Browser autosave paused for this document. It remains open; use Save to keep a .shaderpaint copy before closing.",
    );
    return;
  }

  if (serialized.length > MAX_LOCAL_AUTOSAVE_CHARACTERS) {
    pauseLocalAutosave(
      Math.floor(MAX_LOCAL_AUTOSAVE_CHARACTERS / 2),
      "Browser autosave paused for this large document. It remains open; use Save to keep a .shaderpaint copy before closing.",
    );
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, serialized);
    resumeLocalAutosave();
  } catch (error) {
    console.error("Shader Paint could not save the document.", error);
    pauseLocalAutosave(
      Math.floor(serialized.length / 2),
      "Browser autosave is full and has been paused. Your document remains open; use Save to keep a .shaderpaint copy before closing.",
    );
  }
}

function scheduleSave() {
  markProjectUnsaved();
  scheduleProjectFileAutosave();
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(saveDocument, AUTOSAVE_IDLE_DELAY_MS);
}

function scheduleViewportSave() {
  window.clearTimeout(state.viewportSaveTimer);
  state.viewportSaveTimer = window.setTimeout(saveDocument, AUTOSAVE_IDLE_DELAY_MS);
}

function syncDocumentMeta() {
  documentName.textContent = state.documentName;
  document.title = `${state.documentName} - Shader Paint`;
  syncSaveStatus();
}

function normalizeProjectName(name) {
  const cleaned = String(name || "Untitled").replace(/[\\/:*?"<>|]/g, "-").trim();
  return cleaned || "Untitled";
}

function filenameWithoutExtension(filePath) {
  return String(filePath || "Untitled").split(/[\\/]/).pop().replace(/\.shaderpaint$/i, "") || "Untitled";
}

function downloadProjectFile(contents) {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${normalizeProjectName(state.documentName)}.shaderpaint`;
  link.click();
  URL.revokeObjectURL(url);
}

async function saveProject(saveAs = false) {
  flushDirtyPaintLayerDataUrls();
  const contents = JSON.stringify(projectPayload(), null, 2);
  const desktop = window.shaderPaintDesktop;
  state.projectSaveStatus = "saving";
  syncSaveStatus();
  try {
    if (desktop?.isDesktop) {
      const result = await desktop.saveProject(
        contents,
        saveAs ? null : state.projectFilePath,
        `${normalizeProjectName(state.documentName)}.shaderpaint`,
      );
      if (result?.canceled) {
        state.projectSaveStatus = "unsaved";
        syncSaveStatus();
        return;
      }
      state.projectFilePath = result.filePath;
      state.documentName = filenameWithoutExtension(result.filePath);
      state.projectSaveStatus = "saved";
      syncDocumentMeta();
      void flushDocumentAutosave();
      void recordCurrentProjectAsRecent();
      showToast("Editable project saved.");
      return;
    }
    downloadProjectFile(contents);
    state.projectSaveStatus = "saved";
    syncSaveStatus();
    showToast("Editable project downloaded. Use Open project to continue editing it.");
  } catch (error) {
    state.projectSaveStatus = "unsaved";
    syncSaveStatus();
    reportError(error);
  }
}

async function applyStoredDocument(stored) {
  if (!stored?.layers?.length) return false;
  setDocumentDimensions(stored.width || 1200, stored.height || 900);
  const restoredLayers = [];
  for (const item of stored.layers) {
    try {
      const maskData = item.mask ? await decodeMask(item.mask.image) : null;
      const layer = await createLayerFromImage(item.sourceDataUrl, item.name, {
        id: item.id,
        kind: item.kind || (item.name === "Paint layer" ? "paint" : "image"),
        visible: item.visible,
        opacity: item.opacity,
        blendMode: item.blendMode,
        clipDown: item.clipDown,
        alphaLock: item.alphaLock,
        adjustmentStartLayerId: item.adjustmentStartLayerId,
        filtersEnabled: item.filtersEnabled !== false,
        matchFilterRatio: item.matchFilterRatio === true,
        sourceDataUrl: item.sourceDataUrl,
        material: item.material,
        height: item.height,
        mask: item.mask,
        maskData,
        maskInitialized: item.mask?.initialized,
        maskEnabled: item.mask?.enabled,
        maskSoftness: item.mask?.softness,
        maskOpacity: item.mask?.opacity,
        maskContrast: item.mask?.contrast,
        maskRoughenAmount: item.mask?.roughenAmount,
        maskRoughenWidth: item.mask?.roughenWidth,
        maskRoughenScale: item.mask?.roughenScale,
        maskRoughenSharpness: item.mask?.roughenSharpness,
        filters: Array.isArray(item.filters)
          ? item.filters.map(normalizeStoredFilter).filter(Boolean)
          : [],
      });
      restoredLayers.push(layer);
    } catch (error) {
      console.error(`Could not restore layer "${item.name}".`, error);
    }
  }
  if (!restoredLayers.length) return false;
  state.layers.forEach(destroyLayerGpu);
  state.layers = restoredLayers;
  state.selectedLayerId = restoredLayers.some((layer) => layer.id === stored.selectedLayerId)
    ? stored.selectedLayerId
    : restoredLayers[restoredLayers.length - 1].id;
  state.selectionPart = stored.selectionPart === "mask" ? "mask" : "content";
  state.effectsPaused = stored.effectsPaused !== false;
  state.brush = { ...state.brush, ...stored.brush };
  state.documentName = normalizeProjectName(stored.documentName || state.documentName);
  state.viewport = { ...state.viewport, ...stored.viewport };
  setZoom(stored.zoom || 80);
  syncDocumentMeta();
  return true;
}

function parseStoredDocument(raw) {
  const parsed = JSON.parse(raw);
  if (parsed?.format === "shader-paint-document" && parsed.version === 1) return parsed.document;
  return parsed;
}

async function restoreDesktopAutosave() {
  const desktop = window.shaderPaintDesktop;
  if (!desktop?.isDesktop || !desktop.loadAutosave) return false;
  try {
    const result = await desktop.loadAutosave();
    if (!result?.contents) return false;
    const restored = await applyStoredDocument(parseStoredDocument(result.contents));
    if (!restored) throw new Error("The desktop autosave has no readable layers.");
    return true;
  } catch (error) {
    console.error("Desktop Shader Paint autosave could not be restored.", error);
    showToast("Desktop autosave could not be read; checking browser recovery.");
    return false;
  }
}

async function restoreBrowserDocument() {
  let raw;
  let metadata = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    const metadataRaw = localStorage.getItem(STORAGE_METADATA_KEY);
    metadata = metadataRaw ? JSON.parse(metadataRaw) : null;
  } catch (error) {
    console.error("Stored Shader Paint data could not be read.", error);
    return false;
  }
  if (!raw) {
    if (metadata?.mode === "metadata-only") {
      showToast("The last large document was not stored in browser autosave. Open its .shaderpaint file.");
    }
    return false;
  }
  let stored;
  try {
    stored = parseStoredDocument(raw);
  } catch (error) {
    console.error("Stored Shader Paint data is invalid.", error);
    showToast("Saved document could not be read; loading the starter.");
    return false;
  }
  const restored = await applyStoredDocument(stored);
  if (restored && metadata?.mode === "metadata-only") {
    state.localAutosaveWarningShown = true;
    showToast("Restored the last complete local save. A newer large document must be reopened from its .shaderpaint file.");
  }
  return restored;
}

async function restoreDocument() {
  if (await restoreDesktopAutosave()) return true;
  return restoreBrowserDocument();
}

async function loadStarter() {
  const base = await createLayerFromImage(DEFAULT_IMAGE_URL, "Botanical base", {
    filters: [createFilter("basicTone"), createFilter("filmEmulation")],
  });
  const texture = await createLayerFromImage(DEFAULT_IMAGE_URL, "Botanical texture", {
    opacity: 0.86,
    blendMode: "softlight",
    filters: [createFilter("chroma"), createFilter("oilPaint")],
  });
  state.layers = [base, texture];
  state.selectedLayerId = texture.id;
  state.selectionPart = "mask";
  state.documentName = "Shader Paint";
  state.projectFilePath = null;
  state.projectSaveStatus = "unsaved";
  syncDocumentMeta();
}

async function openProjectText(contents, filePath = null) {
  let payload;
  try {
    payload = JSON.parse(contents);
  } catch (error) {
    throw new Error("This file is not valid JSON.");
  }
  if (payload?.format !== "shader-paint-document" || payload.version !== 1 || !payload.document?.layers?.length) {
    throw new Error("This is not a Shader Paint project file.");
  }
  const restored = await applyStoredDocument(payload.document);
  if (!restored) throw new Error("The project has no readable layers.");
  state.projectFilePath = filePath;
  state.projectSaveStatus = filePath ? "saved" : "unsaved";
  if (filePath) {
    state.documentName = filenameWithoutExtension(filePath);
    syncDocumentMeta();
  }
  renderLayers();
  renderFilters();
  syncBrushUi();
  syncViewport();
  requestRender();
  resetDocumentHistory();
  saveDocument();
  void recordCurrentProjectAsRecent();
  showToast("Editable project opened.");
}

async function openProject() {
  const desktop = window.shaderPaintDesktop;
  try {
    if (desktop?.isDesktop) {
      const result = await desktop.openProject();
      if (result?.canceled) return;
      await openProjectText(result.contents, result.filePath);
      return;
    }
    projectInput.click();
  } catch (error) {
    reportError(error);
  }
}

async function createNewDocument() {
  state.newDocumentPending = true;
  imageInput.click();
  showToast("Choose an image to start the new document.");
}

function exportPng() {
  renderDocument({ width: DOC_WIDTH, height: DOC_HEIGHT });
  const link = document.createElement("a");
  link.download = `shader-paint-${new Date().toISOString().slice(0, 10)}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  requestRender();
  showToast("PNG exported.");
}

function clearCompositeTarget(index, targets = gpu.compositeTargets) {
  const target = targets[index];
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return target;
}

function compositeNormalLayer(baseTexture, layerTexture, layer, target) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
  gl.useProgram(gpu.compositeProgram);
  bindTexture(gpu.compositeProgram, "uBase", baseTexture, 0);
  bindTexture(gpu.compositeProgram, "uLayer", layerTexture, 1);
  bindTexture(gpu.compositeProgram, "uMask", layer.mask?.texture || gpu.whiteMask, 2);
  bindTexture(gpu.compositeProgram, "uClip", gpu.whiteMask, 3);
  gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uOpacity"), layer.opacity);
  gl.uniform1i(gl.getUniformLocation(gpu.compositeProgram, "uMode"), BLEND_MODE_CODES[layer.blendMode] ?? 0);
  gl.uniform1i(gl.getUniformLocation(gpu.compositeProgram, "uUseMask"), layer.mask ? 1 : 0);
  gl.uniform1i(gl.getUniformLocation(gpu.compositeProgram, "uMaskEnabled"), layer.mask?.enabled ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskSoftness"), layer.mask?.softness ?? 0);
  gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskOpacity"), layer.mask?.opacity ?? 1);
  gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskContrast"), layer.mask?.contrast ?? 0);
  gl.uniform2f(gl.getUniformLocation(gpu.compositeProgram, "uMaskTexel"), 1 / DOC_WIDTH, 1 / DOC_HEIGHT);
  gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskRoughenAmount"), layer.mask?.roughenAmount ?? 0);
  gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskRoughenWidth"), layer.mask?.roughenWidth ?? 8);
  gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskRoughenScale"), layer.mask?.roughenScale ?? 24);
  gl.uniform1f(gl.getUniformLocation(gpu.compositeProgram, "uMaskRoughenSharpness"), layer.mask?.roughenSharpness ?? 1);
  gl.uniform1i(gl.getUniformLocation(gpu.compositeProgram, "uClipDown"), 0);
  drawFullscreen();
  return target;
}

function renderNormalCompositeBefore(endIndex, targets = gpu.rangeCompositeTargets) {
  let base = clearCompositeTarget(0, targets);
  let baseIndex = 0;
  for (let index = 0; index < endIndex; index += 1) {
    const layer = state.layers[index];
    if (!layer.visible) continue;
    ensureLayerGpuTextures(layer);
    if (!layer.sourceTexture) continue;
    const isAdjustment = layer.kind === "adjustment";
    const isMaterial = layer.kind === "material";
    const isHeight = layer.kind === "height";
    const materialTexture = isMaterial ? renderMaterialLayer(layer, base.texture) : null;
    const heightTexture = isHeight ? renderHeightLayer(layer, base.texture) : null;
    const layerTexture = renderLayerFilters(
      layer,
      state.motionTime,
      isAdjustment ? base.texture : (materialTexture || heightTexture),
      (isAdjustment || layerUsesDerivativeDisplacement(layer))
        ? { penetrationSource: base.texture }
        : undefined,
    );
    const targetIndex = 1 - baseIndex;
    base = compositeNormalLayer(base.texture, layerTexture, layer, targets[targetIndex]);
    baseIndex = targetIndex;
  }
  return base;
}

function renderLayerExportTarget(layerIndex) {
  const layer = state.layers[layerIndex];
  ensureLayerGpuTextures(layer);
  const background = renderNormalCompositeBefore(layerIndex);
  const isAdjustment = layer.kind === "adjustment";
  const isMaterial = layer.kind === "material";
  const isHeight = layer.kind === "height";
  const materialTexture = isMaterial ? renderMaterialLayer(layer, background.texture) : null;
  const heightTexture = isHeight ? renderHeightLayer(layer, background.texture) : null;
  const adjustmentStart = isAdjustment ? getAdjustmentStartLayer(layer) : null;
  const adjustmentSource = adjustmentStart && hasCustomAdjustmentStart(layer)
    ? renderNormalCompositeBefore(state.layers.indexOf(adjustmentStart) + 1)
    : background;
  const derivativeDisplacement = layerUsesDerivativeDisplacement(layer);
  const layerTexture = renderLayerFilters(
    layer,
    state.motionTime,
    isAdjustment ? adjustmentSource.texture : (materialTexture || heightTexture),
    (isAdjustment || derivativeDisplacement)
      ? { penetrationSource: isAdjustment ? adjustmentSource.texture : background.texture }
      : undefined,
  );
  const transparentIndex = background === gpu.compositeTargets[0] ? 1 : 0;
  const transparent = clearCompositeTarget(transparentIndex);
  return compositeNormalLayer(transparent.texture, layerTexture, layer, background);
}

function targetToPngDataUrl(target) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, DOC_WIDTH, DOC_HEIGHT);
  const pixels = new Uint8Array(DOC_WIDTH * DOC_HEIGHT * 4);
  gl.readPixels(0, 0, DOC_WIDTH, DOC_HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const output = document.createElement("canvas");
  output.width = DOC_WIDTH;
  output.height = DOC_HEIGHT;
  const context = output.getContext("2d");
  const image = context.createImageData(DOC_WIDTH, DOC_HEIGHT);
  const rowLength = DOC_WIDTH * 4;
  for (let y = 0; y < DOC_HEIGHT; y += 1) {
    image.data.set(pixels.subarray((DOC_HEIGHT - 1 - y) * rowLength, (DOC_HEIGHT - y) * rowLength), y * rowLength);
  }
  context.putImageData(image, 0, 0);
  return output.toDataURL("image/png");
}

async function exportLayersPng() {
  if (!state.layers.length) return;
  ensureRenderTargetDimensions({ width: DOC_WIDTH, height: DOC_HEIGHT });
  const date = new Date().toISOString().slice(0, 10);
  const files = state.layers.map((layer, index) => {
    const target = renderLayerExportTarget(index);
    const safeName = layer.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").trim() || `Layer ${index + 1}`;
    return {
      name: `${String(index + 1).padStart(2, "0")} - ${safeName} - ${date}.png`,
      dataUrl: targetToPngDataUrl(target),
    };
  });
  const desktop = window.shaderPaintDesktop;
  if (desktop?.isDesktop && desktop.exportLayerPngs) {
    const result = await desktop.exportLayerPngs(files);
    requestRender();
    if (!result?.canceled) showToast(`${result.count} layer PNGs exported to the selected folder.`);
    return;
  }
  files.forEach((file) => {
    const link = document.createElement("a");
    link.download = file.name;
    link.href = file.dataUrl;
    link.click();
  });
  requestRender();
  showToast(`${files.length} layer PNGs exported.`);
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function reportError(error) {
  console.error(error);
  showToast(error instanceof Error ? error.message : "Something went wrong.");
}

function wireEvents() {
  const desktop = window.shaderPaintDesktop;
  if (desktop?.isDesktop) {
    document.getElementById("desktopTools").hidden = false;
    document.getElementById("reloadButton").addEventListener("click", () => desktop.reload());
    document.getElementById("settingsButton").addEventListener("click", () => setSettingsOpen(settingsPanel.hidden));
    desktop.onAutosaveFlush?.(() => {
      void flushDocumentAutosave().finally(() => desktop.autosaveFlushComplete?.());
    });
  }
  document.getElementById("webSettingsButton").addEventListener("click", () => setSettingsOpen(settingsPanel.hidden));

  canvas.addEventListener("pointerdown", handleCanvasPointerDown);
  canvas.addEventListener("pointermove", handleCanvasPointerMove);
  canvas.addEventListener("pointerup", handleCanvasPointerEnd);
  canvas.addEventListener("pointercancel", handleCanvasPointerEnd);
  canvas.addEventListener("wheel", handleCanvasWheel, { passive: false });
  canvas.addEventListener("pointerleave", (event) => {
    if (state.paintPointerId === null) brushCursor.style.opacity = "0";
    else updateBrushCursor(event);
  });
  window.addEventListener("pointermove", (event) => {
    state.lastPointer = { x: event.clientX, y: event.clientY };
    if (state.panPointerId === event.pointerId) continuePan(event);
    const samplingCanvas = event.altKey && isPointerInCanvas(event);
    canvas.classList.toggle("is-eyedropping", samplingCanvas);
    if (samplingCanvas) sampleCanvasColor(event);
    else eyedropperIndicator.hidden = true;
    if (state.sizeAdjustPressed && state.sizeAdjustStart) {
      state.brush.size = Math.max(1, Math.round(state.sizeAdjustStart.size + (event.clientX - state.sizeAdjustStart.x) * 1.5));
      syncBrushUi();
    }
    updateBrushCursor(event);
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 1 || state.panPointerId !== null) return;
    beginPan(event);
  });
  ["pointerup", "pointercancel"].forEach((eventName) => window.addEventListener(eventName, (event) => {
    if (state.panPointerId === event.pointerId) endPan(event);
  }));
  let paintColorPointerId = null;
  const wirePaintColorPicker = (target, type) => {
    target.addEventListener("pointerdown", (event) => {
      paintColorPointerId = event.pointerId;
      target.setPointerCapture(event.pointerId);
      setPaintColorFromCanvas(event, type);
    });
    target.addEventListener("pointermove", (event) => {
      if (event.pointerId === paintColorPointerId && event.buttons) setPaintColorFromCanvas(event, type);
    });
    ["pointerup", "pointercancel"].forEach((eventName) => target.addEventListener(eventName, (event) => {
      if (event.pointerId !== paintColorPointerId) return;
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      paintColorPointerId = null;
      commitDocumentAction();
    }));
  };
  wirePaintColorPicker(paintHueWheel, "hue");
  wirePaintColorPicker(paintColorSquare, "square");
  window.addEventListener("resize", () => {
    syncCanvasPresentation();
    requestRender();
  });

  setPairedControl(brushSize, brushSizeNumber, state.brush.size, (value) => {
    state.brush.size = Math.max(1, value);
    syncBrushUi();
    scheduleSave();
  });
  setPairedControl(brushOpacity, brushOpacityNumber, state.brush.opacity, (value) => {
    state.brush.opacity = Math.max(0, Math.min(1, value));
    syncBrushUi();
    scheduleSave();
  });
  setPairedControl(brushEdgeBlend, brushEdgeBlendNumber, state.brush.edgeBlend, (value) => {
    state.brush.edgeBlend = Math.max(0, Math.min(1, value));
    syncBrushUi();
    scheduleSave();
  });
  setPairedControl(layerOpacity, layerOpacityNumber, 1, (value) => {
    const layer = getSelectedLayer();
    if (!layer) return;
    layer.opacity = Math.max(0, Math.min(1, value));
    requestRender();
    scheduleSave();
  });
  setPairedControl(brushValue, brushValueNumber, state.brush.value, (value) => {
    state.brush.value = Math.max(0, Math.min(1, value));
    scheduleSave();
  });
  brushModeButtons.addEventListener("click", (event) => {
    const mode = event.target.closest("[data-brush-mode]")?.dataset.brushMode;
    if (!["normal", "stamp", "direction"].includes(mode) || state.brush.mode === mode) return;
    if (state.paintPointerId !== null) return;
    flushPendingPaintDabs();
    flushPendingMaskDabs();
    state.pendingPaintDabs = [];
    state.pendingPaintLayerId = null;
    state.pendingMaskDabs = [];
    state.pendingMaskLayerId = null;
    state.pendingMaskTarget = null;
    state.brush.mode = mode;
    syncBrushUi();
    requestRender();
    scheduleSave();
  });
  document.getElementById("eraserToggle").addEventListener("click", () => {
    if (state.paintPointerId !== null) return;
    state.eraserToggled = !state.eraserToggled;
    setTemporaryEraser(heldCanvasShortcutCodes.has("KeyE"));
    syncBrushUi();
  });
  document.getElementById("collapseLayers").addEventListener("click", () => {
    state.ipad.layersCollapsed = !state.ipad.layersCollapsed;
    saveProjectSettings();
    syncDockPanels();
  });
  document.getElementById("collapseFilters").addEventListener("click", () => {
    state.ipad.filtersCollapsed = !state.ipad.filtersCollapsed;
    saveProjectSettings();
    syncDockPanels();
  });

  brushPreview.addEventListener("click", () => {
    setBrushLibraryOpen(brushLibrary.hidden);
  });
  const brushPanel = document.getElementById("brushPanel");
  const brushPanelHandle = brushPanel.querySelector(".panel-heading");
  let brushPanelDrag = null;
  brushPanelHandle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const stageRect = canvasStage.getBoundingClientRect();
    const panelRect = brushPanel.getBoundingClientRect();
    brushPanelDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - panelRect.left,
      offsetY: event.clientY - panelRect.top,
      stageRect,
      baseX: panelRect.left - stageRect.left,
      baseY: panelRect.top - stageRect.top,
      x: panelRect.left - stageRect.left,
      y: panelRect.top - stageRect.top,
    };
    brushPanel.style.left = `${brushPanelDrag.baseX}px`;
    brushPanel.style.top = `${brushPanelDrag.baseY}px`;
    brushPanel.classList.add("is-dragging");
    brushPanelHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  brushPanelHandle.addEventListener("pointermove", (event) => {
    if (!brushPanelDrag || brushPanelDrag.pointerId !== event.pointerId) return;
    const { stageRect, offsetX, offsetY } = brushPanelDrag;
    const panelWidth = brushPanel.offsetWidth;
    const panelHeight = brushPanel.offsetHeight;
    const x = Math.max(8, Math.min(stageRect.width - panelWidth - 8, event.clientX - stageRect.left - offsetX));
    const y = Math.max(8, Math.min(stageRect.height - panelHeight - 8, event.clientY - stageRect.top - offsetY));
    brushPanelDrag.x = x;
    brushPanelDrag.y = y;
    brushPanel.style.transform = `translate3d(${x - brushPanelDrag.baseX}px, ${y - brushPanelDrag.baseY}px, 0)`;
  });
  ["pointerup", "pointercancel"].forEach((eventName) => brushPanelHandle.addEventListener(eventName, (event) => {
    if (!brushPanelDrag || brushPanelDrag.pointerId !== event.pointerId) return;
    if (brushPanelHandle.hasPointerCapture(event.pointerId)) brushPanelHandle.releasePointerCapture(event.pointerId);
    const changed = eventName === "pointerup";
    if (changed) {
      state.ipad.brushPanelPosition = { x: brushPanelDrag.x, y: brushPanelDrag.y };
      syncBrushPanelPosition();
    }
    brushPanel.classList.remove("is-dragging");
    brushPanelDrag = null;
    if (changed) saveProjectSettings();
  }));
  document.getElementById("closeBrushLibrary").addEventListener("click", () => setBrushLibraryOpen(false));
  document.getElementById("openBrushTextureFolder").addEventListener("click", () => {
    desktop?.openBrushTextureFolder?.().catch(reportError);
  });
  brushGrid.addEventListener("click", (event) => {
    const preset = event.target.closest("[data-brush-preset]")?.dataset.brushPreset;
    if (!preset) return;
    void setBrushPreset(preset);
  });
  document.getElementById("closeMaterialLibrary").addEventListener("click", () => setMaterialLibraryOpen(false));
  document.getElementById("closeProjectLibrary").addEventListener("click", () => setProjectLibraryOpen(false));
  document.getElementById("closeSettings").addEventListener("click", () => setSettingsOpen(false));
  projectAutosaveEnabled.addEventListener("change", () => {
    state.projectAutosave.enabled = projectAutosaveEnabled.checked;
    saveProjectSettings();
    syncSettingsPanel();
    scheduleProjectFileAutosave();
  });
  projectAutosaveInterval.addEventListener("change", () => {
    state.projectAutosave.intervalSeconds = Math.max(15, Math.min(3600, Number(projectAutosaveInterval.value) || 60));
    saveProjectSettings();
    syncSettingsPanel();
    scheduleProjectFileAutosave();
  });
  ignoreTouchDraw.addEventListener("change", () => {
    state.ipad.ignoreTouchDraw = ignoreTouchDraw.checked;
    saveProjectSettings();
  });
  bindPressureSettingControl(
    pressureSizeMinimum,
    pressureSizeMinimumNumber,
    "sizeMinimum",
    100,
    0,
    1,
  );
  bindPressureSettingControl(
    pressureSizeResponse,
    pressureSizeResponseNumber,
    "sizeResponse",
    1,
    0.25,
    3,
  );
  bindPressureSettingControl(
    pressureOpacityMinimum,
    pressureOpacityMinimumNumber,
    "opacityMinimum",
    100,
    0,
    1,
  );
  bindPressureSettingControl(
    pressureOpacityResponse,
    pressureOpacityResponseNumber,
    "opacityResponse",
    1,
    0.25,
    3,
  );
  pressureSizeCurveToggle.addEventListener("click", () => {
    state.pressure.sizeCurveExpanded = !state.pressure.sizeCurveExpanded;
    saveProjectSettings();
    syncPressureSettings();
  });
  pressureOpacityCurveToggle.addEventListener("click", () => {
    state.pressure.opacityCurveExpanded = !state.pressure.opacityCurveExpanded;
    saveProjectSettings();
    syncPressureSettings();
  });
  document.getElementById("chooseMaterialLibrary").addEventListener("click", () => {
    chooseMaterialLibrary().catch(reportError);
  });
  materialLibraryGrid.addEventListener("click", (event) => {
    const id = event.target.closest("[data-material-library-id]")?.dataset.materialLibraryId;
    if (id) loadMaterialLibraryItem(id).catch(reportError);
  });

  projectLibraryTrigger.addEventListener("click", () => {
    setProjectLibraryOpen(projectLibrary.hidden).catch(reportError);
  });
  projectLibrary.addEventListener("click", (event) => {
    const action = event.target.closest("[data-project-library-action]")?.dataset.projectLibraryAction;
    if (!action) return;
    if (action === "new") {
      setProjectLibraryOpen(false);
      createNewDocument().catch(reportError);
    } else if (action === "open") {
      setProjectLibraryOpen(false);
      openProject().catch(reportError);
    } else if (action === "save") saveProject(false).catch(reportError);
    else if (action === "save-as") saveProject(true).catch(reportError);
  });
  recentProjectsGrid.addEventListener("click", (event) => {
    const filePath = event.target.closest("[data-recent-project-path]")?.dataset.recentProjectPath;
    if (filePath) openRecentProject(filePath).catch(reportError);
  });
  saveStatusButton.addEventListener("click", () => saveProject(false));
  exportMenuTrigger.addEventListener("click", () => {
    const willOpen = exportMenuPanel.hidden;
    exportMenuPanel.hidden = !willOpen;
    exportMenuTrigger.setAttribute("aria-expanded", String(willOpen));
  });
  exportMenuPanel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-export-action]")?.dataset.exportAction;
    if (!action) return;
    exportMenuPanel.hidden = true;
    exportMenuTrigger.setAttribute("aria-expanded", "false");
    if (action === "png") exportPng();
    else if (action === "layers") exportLayersPng().catch(reportError);
  });
  projectInput.addEventListener("change", async () => {
    const file = projectInput.files?.[0];
    if (!file) return;
    try {
      await openProjectText(await file.text());
    } catch (error) {
      reportError(error);
    } finally {
      projectInput.value = "";
    }
  });

  blendMode.addEventListener("change", () => {
    const layer = getSelectedLayer();
    if (!layer) return;
    layer.blendMode = blendMode.value;
    renderLayers();
    requestRender();
    commitDocumentAction();
  });

  blendSelectTrigger.addEventListener("click", () => {
    const willOpen = blendSelectMenu.hidden;
    blendSelectMenu.hidden = !willOpen;
    blendSelectTrigger.setAttribute("aria-expanded", String(willOpen));
    if (!willOpen) clearBlendModePreview();
  });
  blendSelectMenu.addEventListener("pointerover", (event) => {
    const button = event.target.closest("[data-blend-mode]");
    if (!button || state.blendPreviewMode === button.dataset.blendMode) return;
    state.blendPreviewMode = button.dataset.blendMode;
    requestRender();
  });
  blendSelectMenu.addEventListener("pointerleave", clearBlendModePreview);
  blendSelectMenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-blend-mode]");
    const layer = getSelectedLayer();
    if (!button || !layer) return;
    layer.blendMode = button.dataset.blendMode;
    blendMode.value = layer.blendMode;
    state.blendPreviewMode = null;
    blendSelectMenu.hidden = true;
    blendSelectTrigger.setAttribute("aria-expanded", "false");
    syncLayerControls();
    requestRender();
    commitDocumentAction();
  });

  filterPreview.addEventListener("change", () => {
    const layer = getSelectedLayer();
    if (!layer) return;
    layer.filtersEnabled = layer.filtersEnabled === false;
    syncFilterPreviewControl();
    renderLayers();
    requestRender();
    commitDocumentAction();
  });
  filterMatchRatio.addEventListener("change", () => {
    const layer = getSelectedLayer();
    if (!layer) return;
    layer.matchFilterRatio = filterMatchRatio.checked;
    invalidateLayerThumbnail(layer);
    requestRender();
    commitDocumentAction();
  });
  adjustmentRangeSettings.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-adjustment-start-trigger]");
    if (trigger) {
      const menu = adjustmentRangeSettings.querySelector("[data-adjustment-start-menu]");
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      trigger.setAttribute("aria-expanded", String(willOpen));
      return;
    }
    const option = event.target.closest("[data-adjustment-start-layer]");
    if (!option) return;
    const layer = getSelectedLayer();
    if (!layer || layer.kind !== "adjustment") return;
    const requestedTarget = state.layers.find((item) => item.id === option.dataset.adjustmentStartLayer);
    const adjustmentIndex = state.layers.indexOf(layer);
    layer.adjustmentStartLayerId = requestedTarget && state.layers.indexOf(requestedTarget) < adjustmentIndex - 1
      ? requestedTarget.id
      : null;
    renderFilters();
    renderLayers();
    requestRender();
    commitDocumentAction();
  });
  motionButton.addEventListener("click", () => {
    state.effectsPaused = !state.effectsPaused;
    syncMotionButton();
    requestRender();
    commitDocumentAction();
  });

  let suppressLayerClickUntil = 0;
  layerList.addEventListener("click", (event) => {
    if (performance.now() < suppressLayerClickUntil) return;
    const row = event.target.closest(".layer-row");
    if (!row) return;
    const layer = state.layers.find((item) => item.id === row.dataset.layerId);
    if (!layer) return;
    const action = event.target.closest("[data-layer-action]")?.dataset.layerAction;
    const status = event.target.closest("[data-layer-status]")?.dataset.layerStatus;
    const part = event.target.closest("[data-select-part]")?.dataset.selectPart;
    const name = event.target.closest(".layer-name");
    if (name && event.detail === 2) {
      return;
    } else if (event.detail === 2 && part === "mask" && layer.mask) {
      state.selectedLayerId = layer.id;
      state.selectionPart = "mask";
      state.maskSettingsLayerId = layer.id;
      renderLayers();
      renderFilters();
    } else if (action === "visibility") {
      layer.visible = !layer.visible;
      if (!layer.visible) releaseHiddenLayerTextures(layer);
      renderLayers();
      requestRender();
      commitDocumentAction();
    } else if (action === "menu") {
      selectLayer(layer.id, state.selectionPart);
      const activeRow = layerList.querySelector(`[data-layer-id="${layer.id}"]`);
      if (activeRow) showLayerMenu(activeRow, layer);
    } else if (status === "clip") {
      layer.clipDown = !layer.clipDown;
      renderLayers();
      requestRender();
      commitDocumentAction();
    } else if (status === "alpha") {
      layer.alphaLock = !layer.alphaLock;
      renderLayers();
      commitDocumentAction();
    } else if (status === "mask" && layer.mask) {
      layer.mask.enabled = !layer.mask.enabled;
      renderLayers();
      requestRender();
      commitDocumentAction();
    } else if (status === "filters" && layer.filters.length) {
      layer.filtersEnabled = layer.filtersEnabled === false;
      renderLayers();
      if (layer.id === state.selectedLayerId) renderFilters();
      requestRender();
      commitDocumentAction();
    } else if (part) {
      selectLayer(layer.id, part);
    } else {
      selectLayer(layer.id, "content");
    }
  });
  layerList.addEventListener("pointerover", (event) => {
    const row = event.target.closest(".layer-row");
    const layer = state.layers.find((item) => item.id === row?.dataset.layerId);
    if (!layer || layer.kind !== "adjustment" || state.hoveredAdjustmentLayerId === layer.id) return;
    state.hoveredAdjustmentLayerId = layer.id;
    renderLayers();
  });
  layerList.addEventListener("pointerleave", () => {
    if (!state.hoveredAdjustmentLayerId) return;
    state.hoveredAdjustmentLayerId = null;
    renderLayers();
  });
  layerList.addEventListener("contextmenu", (event) => {
    const mask = event.target.closest(".mask-thumb");
    const row = event.target.closest(".layer-row");
    if (!mask || !row) return;
    event.preventDefault();
    const layer = state.layers.find((item) => item.id === row.dataset.layerId);
    if (!layer?.mask) return;
    selectLayer(layer.id, "mask");
    const activeRow = layerList.querySelector(`[data-layer-id="${layer.id}"]`);
    if (activeRow) showMaskMenu(activeRow, layer, event.clientX, event.clientY);
  });
  layerList.addEventListener("dblclick", (event) => {
    const name = event.target.closest(".layer-name");
    const mask = event.target.closest(".mask-thumb");
    const row = event.target.closest(".layer-row");
    if (!row) return;
    if (name) {
      event.preventDefault();
      event.stopPropagation();
      startLayerRename(row.dataset.layerId);
      return;
    }
    if (!mask) return;
    const layer = state.layers.find((item) => item.id === row.dataset.layerId);
    if (!layer?.mask) return;
    state.maskSettingsLayerId = layer.id;
    selectLayer(layer.id, "mask");
    renderFilters();
  });

  let draggedLayerId = null;
  let layerDropAfter = false;
  let layerPress = null;
  const clearLayerPress = () => {
    if (layerPress?.timer) window.clearTimeout(layerPress.timer);
    layerList.querySelectorAll(".touch-dragging, .drop-before, .drop-after").forEach((item) => {
      item.classList.remove("touch-dragging", "drop-before", "drop-after");
    });
    layerPress = null;
  };
  layerList.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || event.target.closest("button, input, .layer-name")) return;
    const row = event.target.closest(".layer-row");
    if (!row) return;
    layerPress = { pointerId: event.pointerId, layerId: row.dataset.layerId, active: false };
    layerPress.timer = window.setTimeout(() => {
      if (!layerPress || layerPress.pointerId !== event.pointerId) return;
      layerPress.active = true;
      row.classList.add("touch-dragging");
      layerList.setPointerCapture(event.pointerId);
      if (navigator.vibrate) navigator.vibrate(12);
    }, 420);
  });
  layerList.addEventListener("pointermove", (event) => {
    if (!layerPress?.active || layerPress.pointerId !== event.pointerId) return;
    event.preventDefault();
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest(".layer-row");
    if (!row) return;
    layerDropAfter = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    layerList.querySelectorAll(".drop-before, .drop-after").forEach((item) => item.classList.remove("drop-before", "drop-after"));
    row.classList.add(layerDropAfter ? "drop-after" : "drop-before");
  });
  layerList.addEventListener("pointerup", (event) => {
    if (!layerPress || layerPress.pointerId !== event.pointerId) return;
    const press = layerPress;
    if (!press.active) {
      clearLayerPress();
      return;
    }
    event.preventDefault();
    suppressLayerClickUntil = performance.now() + 350;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest(".layer-row");
    const display = [...state.layers].reverse();
    const reordered = row && reorderByIds(display, press.layerId, row.dataset.layerId, layerDropAfter);
    if (reordered) {
      state.layers = display.reverse();
      normalizeAdjustmentStarts();
      renderLayers();
      requestRender();
      commitDocumentAction();
    }
    clearLayerPress();
  });
  layerList.addEventListener("pointercancel", clearLayerPress);
  layerList.addEventListener("dragstart", (event) => {
    const row = event.target.closest(".layer-row");
    draggedLayerId = row?.dataset.layerId || null;
    if (draggedLayerId) event.dataTransfer.effectAllowed = "move";
  });
  layerList.addEventListener("dragover", (event) => {
    const row = event.target.closest(".layer-row");
    if (!row || !draggedLayerId) return;
    event.preventDefault();
    layerDropAfter = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    layerList.querySelectorAll(".drop-before, .drop-after").forEach((item) => {
      item.classList.remove("drop-before", "drop-after");
    });
    row.classList.add(layerDropAfter ? "drop-after" : "drop-before");
  });
  layerList.addEventListener("drop", (event) => {
    const row = event.target.closest(".layer-row");
    event.preventDefault();
    layerList.querySelectorAll(".drop-before, .drop-after").forEach((item) => {
      item.classList.remove("drop-before", "drop-after");
    });
    if (!row || !draggedLayerId) return;
    const display = [...state.layers].reverse();
    const reordered = reorderByIds(display, draggedLayerId, row.dataset.layerId, layerDropAfter);
    state.layers = display.reverse();
    normalizeAdjustmentStarts();
    draggedLayerId = null;
    renderLayers();
    requestRender();
    if (reordered) commitDocumentAction();
  });
  layerList.addEventListener("dragend", () => {
    draggedLayerId = null;
    layerList.querySelectorAll(".drop-before, .drop-after").forEach((item) => {
      item.classList.remove("drop-before", "drop-after");
    });
  });

  document.querySelector(".layer-toolbar").addEventListener("click", (event) => {
    const action = event.target.closest("[data-layer-action]")?.dataset.layerAction;
    const layer = getSelectedLayer();
    if (!action) return;
    if (action === "new") openNewLayerMenu(event.target.closest("[data-layer-action]"));
    else if (action === "duplicate" && layer) duplicateLayer(layer).catch(reportError);
    else if (action === "delete" && layer) deleteLayer(layer);
    else if (action === "mask" && layer) {
      const created = !layer.mask;
      if (created) layer.mask = createMask();
      state.selectionPart = "mask";
      renderLayers();
      requestRender();
      if (created) commitDocumentAction();
      else scheduleSave();
    }
  });

  document.getElementById("addLayerButton").addEventListener("click", (event) => openNewLayerMenu(event.currentTarget));
  newLayerMenu.addEventListener("click", (event) => {
    const action = event.target.closest("[data-new-layer]")?.dataset.newLayer;
    if (!action) return;
    newLayerMenu.hidden = true;
    if (action === "base-copy") createBaseCopyLayer().catch(reportError);
    else if (action === "paint") createPaintLayer();
    else if (action === "adjustment") createAdjustmentLayer();
    else if (action === "material") createMaterialLayer();
    else if (action === "height") createHeightLayer();
  });
  imageInput.addEventListener("change", async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    const isNewDocument = state.newDocumentPending;
    const selectedLayerId = state.selectedLayerId;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("The selected image could not be read."));
        reader.readAsDataURL(file);
      });
      const layer = await createLayerFromImage(dataUrl, file.name.replace(/\.[^.]+$/, ""), { nativeDimensions: isNewDocument });
      if (isNewDocument) {
        state.layers.forEach(destroyLayerGpu);
        state.layers = [layer];
        state.documentName = normalizeProjectName(file.name.replace(/\.[^.]+$/, ""));
        state.projectFilePath = null;
        state.viewport = { x: 0, y: 0 };
        setZoom(80);
        syncDocumentMeta();
        syncViewport();
        renderFilters();
        resetDocumentHistory();
      } else {
        insertLayerAboveSelection(layer, selectedLayerId);
      }
      state.newDocumentPending = false;
      selectLayer(layer.id, "mask");
      requestRender();
      if (isNewDocument) scheduleSave();
      else commitDocumentAction();
      showToast(isNewDocument ? "Image opened as an editable document." : "Image added as a new layer.");
    } catch (error) {
      reportError(error);
    } finally {
      state.newDocumentPending = false;
      imageInput.value = "";
    }
  });
  imageInput.addEventListener("cancel", () => {
    state.newDocumentPending = false;
  });

  document.getElementById("addFilterButton").addEventListener("click", () => {
    filterMenu.hidden = !filterMenu.hidden;
  });
  materialPanelTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-material-panel-tab]")?.dataset.materialPanelTab;
    const selectedLayer = getSelectedLayer();
    if (!["material", "filters"].includes(tab) || !["material", "height"].includes(selectedLayer?.kind)) return;
    state.materialPanelTab = tab;
    filterMenu.hidden = true;
    renderFilters();
  });
  filterMenu.addEventListener("click", (event) => {
    if (state.filterMenuIgnoreClick) {
      state.filterMenuIgnoreClick = false;
      return;
    }
    const category = event.target.closest("[data-filter-category]")?.dataset.filterCategory;
    if (category) {
      state.filterMenuCategory = category;
      renderFilterMenu();
      return;
    }
    const button = event.target.closest("[data-add-filter]");
    if (!button) return;
    addFilter(button.dataset.addFilter);
    filterMenu.hidden = true;
  });
  filterMenu.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const item = event.target.closest("[data-filter-menu-item]");
    if (!item) return;
    const type = item.dataset.filterMenuItem;
    const id = type === "category" ? item.dataset.filterCategory : item.dataset.filterMenuFilter;
    const group = type === "filter" ? FILTER_DEFS.find((def) => def.id === id)?.group : null;
    if (!id || (type === "filter" && !group)) return;
    const timer = window.setTimeout(() => {
      const drag = state.filterMenuDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      activateFilterMenuDrag(drag);
    }, FILTER_MENU_DRAG_DELAY_MS);
    state.filterMenuDrag = {
      type, id, group, pointerId: event.pointerId, timer, held: false, insertAfter: false, source: item, ghost: null,
      startX: event.clientX, startY: event.clientY, parent: null, originalNextSibling: null, previewMoved: false,
    };
    filterMenu.setPointerCapture(event.pointerId);
  });
  filterMenu.addEventListener("pointermove", (event) => {
    const drag = state.filterMenuDrag;
    if (!drag || event.pointerId !== drag.pointerId || !drag.held) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-filter-menu-item]");
    const targetId = drag.type === "category"
      ? target?.dataset.filterCategory
      : target?.dataset.filterMenuFilter;
    const targetGroup = targetId ? FILTER_DEFS.find((def) => def.id === targetId)?.group : null;
    clearFilterMenuDropTargets();
    const draggedElement = drag.type === "category"
      ? filterMenu.querySelector(`[data-filter-category="${drag.id}"]`)
      : filterMenu.querySelector(`[data-filter-menu-filter="${drag.id}"]`);
    draggedElement?.classList.add("filter-menu-dragging");
    updateFilterMenuDragGhost(drag, event);
    if (!targetId || targetId === drag.id || (drag.type === "filter" && targetGroup !== drag.group)) return;
    const rect = target.getBoundingClientRect();
    drag.insertAfter = drag.type === "category"
      ? event.clientX > rect.left + rect.width / 2
      : event.clientX > rect.left + rect.width / 2;
    previewFilterMenuReorder(drag, target, drag.insertAfter);
    event.preventDefault();
  });
  filterMenu.addEventListener("pointerup", (event) => finishFilterMenuDrag(event));
  filterMenu.addEventListener("pointercancel", (event) => finishFilterMenuDrag(event, true));
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".filter-add-wrap")) filterMenu.hidden = true;
    if (!event.target.closest(".blend-select")) {
      blendSelectMenu.hidden = true;
      blendSelectTrigger.setAttribute("aria-expanded", "false");
      clearBlendModePreview();
    }
    if (!event.target.closest(".export-menu")) {
      exportMenuPanel.hidden = true;
      exportMenuTrigger.setAttribute("aria-expanded", "false");
    }
    if (!event.target.closest(".material-map-actions")) {
      filterList.querySelectorAll(".material-map-menu").forEach((menu) => {
        menu.hidden = true;
      });
      filterList.querySelectorAll("[data-material-map-menu]").forEach((button) => {
        button.setAttribute("aria-expanded", "false");
      });
    }
    if (!event.target.closest("#materialLibrary") && !event.target.closest("[data-material-open-library]")) {
      setMaterialLibraryOpen(false);
    }
    if (!event.target.closest("#projectLibrary") && !event.target.closest("#projectLibraryTrigger")) {
      setProjectLibraryOpen(false);
    }
    if (!event.target.closest("#settingsPanel") && !event.target.closest("#settingsButton")) {
      setSettingsOpen(false);
    }
    if (!event.target.closest("#newLayerMenu") && !event.target.closest('[data-layer-action="new"]') && event.target !== document.getElementById("addLayerButton")) {
      newLayerMenu.hidden = true;
    }
    if (!event.target.closest(".layer-row")) document.querySelectorAll(".layer-actions-menu").forEach((menu) => menu.remove());
  });

  filterList.addEventListener("click", async (event) => {
    const card = event.target.closest(".filter-card");
    const gradientRail = event.target.closest("[data-gradient-add]");
    const gradientRemove = event.target.closest("[data-gradient-remove]");
    const clearImageKey = event.target.closest("[data-filter-clear-image]")?.dataset.filterClearImage;
    const clearMaterialMap = event.target.closest("[data-material-clear-map]")?.dataset.materialClearMap;
    const materialMapMenuButton = event.target.closest("[data-material-map-menu]");
    const openMaterialMapSet = event.target.closest("[data-material-open-map-set]");
    const openMaterialLibraryButton = event.target.closest("[data-material-open-library]");
    const resetMaterialLight = event.target.closest("[data-material-reset-light]");
    const action = event.target.closest("[data-filter-action]")?.dataset.filterAction;
    const layer = getSelectedLayer();
    const filter = layer?.filters.find((item) => item.id === card?.dataset.filterId);
    if (gradientRail && !event.target.closest("[data-gradient-handle]") && filter) {
      const def = FILTER_DEFS.find((item) => item.id === filter.defId);
      const param = def?.params.find((item) => item.key === gradientRail.dataset.gradientAdd);
      const current = normalizeGradientValue(filter.params[param?.key] || param?.default);
      if (current.stops.length >= 16) {
        showToast("A gradient supports up to 16 color stops.");
        return;
      }
      const rect = gradientRail.getBoundingClientRect();
      const position = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      filter.params[param.key] = {
        stops: [...current.stops, { t: position, color: evalGradientAt(current, position) }],
      };
      invalidateLayerThumbnail(layer);
      renderFilters();
      requestRender();
      commitDocumentAction();
      return;
    }
    if (gradientRemove && filter) {
      const def = FILTER_DEFS.find((item) => item.id === filter.defId);
      const param = def?.params.find((item) => item.key === gradientRemove.dataset.gradientRemove);
      const current = normalizeGradientValue(filter.params[param?.key] || param?.default);
      const index = Number(gradientRemove.dataset.stopIndex);
      if (current.stops.length <= 2 || !Number.isInteger(index)) return;
      current.stops.splice(index, 1);
      filter.params[param.key] = current;
      invalidateLayerThumbnail(layer);
      renderFilters();
      requestRender();
      commitDocumentAction();
      return;
    }
    if (openMaterialLibraryButton) {
      await openMaterialLibrary();
      return;
    }
    if (openMaterialMapSet && layer?.kind === "material") {
      const result = await window.shaderPaintDesktop?.openMaterialMapSet?.();
      if (result?.canceled || !result?.maps) return;
      if (applyDesktopMaterialMaps(layer, result.maps)) {
        renderFilters();
        requestRender();
        commitDocumentAction();
        showToast("Material map set loaded.");
      }
      return;
    }
    if (materialMapMenuButton) {
      const menu = materialMapMenuButton.parentElement.querySelector(".material-map-menu");
      const open = menu.hidden;
      filterList.querySelectorAll(".material-map-menu").forEach((item) => {
        item.hidden = true;
      });
      filterList.querySelectorAll("[data-material-map-menu]").forEach((button) => {
        button.setAttribute("aria-expanded", "false");
      });
      menu.hidden = !open;
      materialMapMenuButton.setAttribute("aria-expanded", String(open));
      return;
    }
    if (resetMaterialLight && layer?.kind === "material") {
      ["lightType", "intensity", "directionX", "directionY", "directionZ", "color", "ambient"].forEach((key) => {
        layer.material[key] = DEFAULT_MATERIAL[key];
      });
      renderFilters();
      requestRender();
      commitDocumentAction();
      return;
    }
    if (clearMaterialMap && layer?.kind === "material") {
      layer.material[clearMaterialMap] = null;
      layer.material[materialMapNameKey(clearMaterialMap)] = null;
      getMaterialMapTexture(layer, clearMaterialMap);
      renderFilters();
      requestRender();
      commitDocumentAction();
      return;
    }

    if (!filter) return;
    if (clearImageKey) {
      filter.params[clearImageKey] = null;
      invalidateLayerThumbnail(layer);
      getFilterImageTexture(filter);
      renderFilters();
      renderLayers();
      requestRender();
      commitDocumentAction();
      return;
    }
    if (!action) return;
    if (action === "toggle") filter.enabled = !filter.enabled;
    else if (action === "collapse") filter.collapsed = !filter.collapsed;
    else if (action === "delete") layer.filters = layer.filters.filter((item) => item.id !== filter.id);
    invalidateLayerThumbnail(layer);
    renderFilters();
    renderLayers();
    requestRender();
    commitDocumentAction();
  });

  const beginFilterControlEdit = (target) => {
    const card = target.closest(".filter-card");
    const layer = getSelectedLayer();
    const filter = layer?.filters.find((item) => item.id === card?.dataset.filterId);
    if (!filter || state.filterEditOrigins.has(target)) return;
    if (!(
      target.dataset.filterParam
      || target.dataset.filterNumber
      || target.dataset.filterValue
      || target.dataset.gradientParam
      || target.dataset.curveParam
    )) return;
    state.filterEditOrigins.set(target, {
      layerId: layer.id,
      filterId: filter.id,
      params: cloneHistoryValue(filter.params),
    });
  };
  filterList.addEventListener("pointerdown", (event) => beginFilterControlEdit(event.target));
  filterList.addEventListener("focusin", (event) => beginFilterControlEdit(event.target));
  filterList.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-gradient-handle]");
    const card = handle?.closest(".filter-card");
    const layer = getSelectedLayer();
    const filter = layer?.filters.find((item) => item.id === card?.dataset.filterId);
    if (!handle || !filter) return;
    const def = FILTER_DEFS.find((item) => item.id === filter.defId);
    const key = handle.dataset.gradientHandle;
    const param = def?.params.find((item) => item.key === key);
    filter.params[key] = normalizeGradientValue(filter.params[key] || param?.default);
    const stop = filter.params[key].stops[Number(handle.dataset.stopIndex)];
    const rail = handle.closest(".gradient-rail");
    if (!stop || !rail) return;
    state.gradientStopDrag = {
      pointerId: event.pointerId, layerId: layer.id, filterId: filter.id, key, stop, rail,
    };
    filterList.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  filterList.addEventListener("pointermove", (event) => {
    const drag = state.gradientStopDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const layer = state.layers.find((item) => item.id === drag.layerId);
    const filter = layer?.filters.find((item) => item.id === drag.filterId);
    if (!filter) return;
    const rect = drag.rail.getBoundingClientRect();
    drag.stop.t = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const stops = filter.params[drag.key].stops;
    const css = stops.slice().sort((a, b) => a.t - b.t).map((stop) => `${stop.color} ${(stop.t * 100).toFixed(2)}%`).join(", ");
    drag.rail.querySelector(".gradient-preview").style.background = `linear-gradient(90deg, ${css})`;
    drag.rail.querySelectorAll("[data-gradient-handle]").forEach((handle) => {
      const index = Number(handle.dataset.stopIndex);
      handle.style.left = `${(stops[index].t * 100).toFixed(2)}%`;
    });
    invalidateLayerThumbnail(layer);
    requestRender();
  });
  const finishGradientStopDrag = (event, cancelled = false) => {
    const drag = state.gradientStopDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (filterList.hasPointerCapture(event.pointerId)) filterList.releasePointerCapture(event.pointerId);
    state.gradientStopDrag = null;
    if (cancelled) return;
    const layer = state.layers.find((item) => item.id === drag.layerId);
    const filter = layer?.filters.find((item) => item.id === drag.filterId);
    if (!filter) return;
    filter.params[drag.key] = normalizeGradientValue(filter.params[drag.key]);
    renderFilters();
    renderLayers();
    requestRender();
    commitDocumentAction();
  };
  filterList.addEventListener("pointerup", finishGradientStopDrag);
  filterList.addEventListener("pointercancel", (event) => finishGradientStopDrag(event, true));

  filterList.addEventListener("input", (event) => {
    const materialKey = event.target.dataset.materialParam || event.target.dataset.materialNumber;
    const materialSelect = event.target.dataset.materialSelect;
    const materialColor = event.target.dataset.materialColor;
    const heightSelect = event.target.dataset.heightSelect;
    const heightColor = event.target.dataset.heightColor;
    const heightToggle = event.target.dataset.heightToggle;
    if (materialKey || materialSelect || materialColor || heightSelect || heightColor || heightToggle) {
      const layer = getSelectedLayer();
      const isMaterial = layer?.kind === "material";
      const isHeight = layer?.kind === "height";
      if (!isMaterial && !isHeight) return;
      const key = materialKey || materialSelect || materialColor || heightSelect || heightColor || heightToggle;
      const value = heightToggle ? event.target.checked : materialKey ? Number(event.target.value) : event.target.value;
      if (materialKey && !Number.isFinite(value)) return;
      const settings = isMaterial ? layer.material : layer.height;
      settings[key] = value;
      if (materialKey) {
        const peer = filterList.querySelector(event.target.dataset.materialParam
          ? `[data-material-number="${key}"]`
          : `[data-material-param="${key}"]`);
        if (peer) peer.value = String(value);
      }
      if (materialSelect || heightSelect) renderFilters();
      if (materialColor || heightColor) {
        const valueLabel = event.target.parentElement?.querySelector("code");
        if (valueLabel) valueLabel.textContent = value;
      }
      requestRender();
      scheduleSave();
      return;
    }
    const maskSetting = event.target.dataset.maskSetting;
    if (maskSetting) {
      const layer = getSelectedLayer();
      const value = Number(event.target.value);
      if (!layer?.mask || !Number.isFinite(value)) return;
      layer.mask[maskSetting] = value;
      const peers = filterList.querySelectorAll(`[data-mask-setting="${maskSetting}"]`);
      peers.forEach((peer) => {
        if (peer !== event.target) peer.value = String(value);
      });
      renderLayers();
      requestRender();
      scheduleSave();
      return;
    }
    const card = event.target.closest(".filter-card");
    const layer = getSelectedLayer();
    const filter = layer?.filters.find((item) => item.id === card?.dataset.filterId);
    const key = event.target.dataset.filterParam
      || event.target.dataset.filterNumber
      || event.target.dataset.filterValue
      || event.target.dataset.gradientParam
      || event.target.dataset.curveParam;
    if (!filter || !key) return;
    let rerender = false;
    if (event.target.dataset.gradientParam) {
      const def = FILTER_DEFS.find((item) => item.id === filter.defId);
      const param = def?.params.find((item) => item.key === key);
      filter.params[key] = normalizeGradientValue(filter.params[key] || param?.default);
      const stop = filter.params[key]?.stops?.[Number(event.target.dataset.stopIndex)];
      if (!stop) return;
      stop[event.target.dataset.stopProperty] = event.target.dataset.stopProperty === "t"
        ? Math.max(0, Math.min(1, Number(event.target.value)))
        : event.target.value;
    } else if (event.target.dataset.curveParam) {
      const point = filter.params[key]?.points?.[Number(event.target.dataset.pointIndex)];
      const value = Number(event.target.value);
      if (!point || !Number.isFinite(value)) return;
      point[event.target.dataset.pointProperty] = Math.max(0, Math.min(1, value));
    } else if (event.target.dataset.filterValue) {
      const def = FILTER_DEFS.find((item) => item.id === filter.defId);
      const param = def?.params.find((item) => item.key === key);
      const isGenerateAlphaLock = key === "alphaLock" && def?.group === "Generate";
      filter.params[key] = param?.type === "toggle" || isGenerateAlphaLock
        ? event.target.checked
        : event.target.value;
      rerender = param?.type === "select" || param?.type === "toggle" || isGenerateAlphaLock;
    } else {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      filter.params[key] = value;
      const peer = card.querySelector(event.target.dataset.filterParam
        ? `[data-filter-number="${key}"]`
        : `[data-filter-param="${key}"]`);
      if (peer) peer.value = String(value);
    }
    invalidateLayerThumbnail(layer);
    if (rerender) {
      renderFilters();
      renderLayers();
    }
    requestRender();
    // Toggle/select controls are replaced immediately, so their later change event cannot fire.
    if (rerender) {
      const origin = state.filterEditOrigins.get(event.target);
      if (origin) {
        state.filterEditOrigins.delete(event.target);
        recordFilterHistoryAction(origin.layerId, origin.filterId, origin.params, filter.params);
      } else {
        commitDocumentAction();
      }
    }
    else scheduleSave();
  });

  filterList.addEventListener("change", async (event) => {
    const materialSelect = event.target.dataset.materialSelect;
    const heightSelect = event.target.dataset.heightSelect;
    if (materialSelect || heightSelect) {
      const layer = getSelectedLayer();
      if (materialSelect && layer?.kind !== "material") return;
      if (heightSelect && layer?.kind !== "height") return;
      const settings = layer.kind === "material" ? layer.material : layer.height;
      settings[materialSelect || heightSelect] = materialSelect ? event.target.value : Number(event.target.value);
      renderFilters();
      requestRender();
      commitDocumentAction();
      return;
    }
    const materialKey = event.target.dataset.materialMap;
    const materialFiles = event.target.files;
    if (materialKey && materialFiles?.length) {
      const layer = getSelectedLayer();
      if (layer?.kind !== "material") return;
      try {
        await loadMaterialMapFiles(layer, materialKey, materialFiles);
        renderFilters();
        requestRender();
        commitDocumentAction();
      } catch (error) {
        reportError(error);
      }
      return;
    }
    const key = event.target.dataset.filterImage;
    const file = event.target.files?.[0];
    if (!key || !file) return;
    const card = event.target.closest(".filter-card");
    const layer = getSelectedLayer();
    const filter = layer?.filters.find((item) => item.id === card?.dataset.filterId);
    if (!filter) return;
    filter.params[key] = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read displacement map."));
      reader.readAsDataURL(file);
    });
    getFilterImageTexture(filter);
    invalidateLayerThumbnail(layer);
    renderFilters();
    renderLayers();
    requestRender();
    commitDocumentAction();
  });

  filterList.addEventListener("change", (event) => {
    const origin = state.filterEditOrigins.get(event.target);
    if (origin) {
      const layer = state.layers.find((item) => item.id === origin.layerId);
      const filter = layer?.filters.find((item) => item.id === origin.filterId);
      state.filterEditOrigins.delete(event.target);
      if (filter) {
        invalidateLayerThumbnail(layer);
        renderLayers();
        recordFilterHistoryAction(origin.layerId, origin.filterId, origin.params, filter.params);
      }
      return;
    }
    const controlKeys = [
      "materialParam",
      "materialNumber",
      "materialColor",
      "maskSetting",
      "filterParam",
      "filterNumber",
      "filterValue",
      "gradientParam",
      "curveParam",
    ];
    if (controlKeys.some((key) => key in event.target.dataset)
      || "heightColor" in event.target.dataset
      || "heightToggle" in event.target.dataset
      || "heightSelect" in event.target.dataset) commitDocumentAction();
  });
  filterList.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches('input[type="number"]')) event.target.blur();
  });

  let draggedFilterId = null;
  let filterDropAfter = false;
  let filterPress = null;
  const clearFilterPress = () => {
    if (filterPress?.timer) window.clearTimeout(filterPress.timer);
    filterList.querySelectorAll(".touch-dragging, .filter-drop-before, .filter-drop-after").forEach((item) => {
      item.classList.remove("touch-dragging", "filter-drop-before", "filter-drop-after");
    });
    filterPress = null;
  };
  filterList.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || event.target.closest("button, input, select, label")) return;
    const card = event.target.closest(".filter-card");
    if (!card) return;
    filterPress = { pointerId: event.pointerId, filterId: card.dataset.filterId, active: false };
    filterPress.timer = window.setTimeout(() => {
      if (!filterPress || filterPress.pointerId !== event.pointerId) return;
      filterPress.active = true;
      card.classList.add("touch-dragging");
      filterList.setPointerCapture(event.pointerId);
      if (navigator.vibrate) navigator.vibrate(12);
    }, 420);
  });
  filterList.addEventListener("pointermove", (event) => {
    if (!filterPress?.active || filterPress.pointerId !== event.pointerId) return;
    event.preventDefault();
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest(".filter-card");
    if (!card) return;
    filterDropAfter = event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2;
    filterList.querySelectorAll(".filter-drop-before, .filter-drop-after").forEach((item) => item.classList.remove("filter-drop-before", "filter-drop-after"));
    card.classList.add(filterDropAfter ? "filter-drop-after" : "filter-drop-before");
  });
  filterList.addEventListener("pointerup", (event) => {
    if (!filterPress || filterPress.pointerId !== event.pointerId) return;
    const press = filterPress;
    if (!press.active) {
      clearFilterPress();
      return;
    }
    event.preventDefault();
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest(".filter-card");
    const layer = getSelectedLayer();
    const reordered = card && layer && reorderByIds(layer.filters, press.filterId, card.dataset.filterId, filterDropAfter);
    if (reordered) {
      invalidateLayerThumbnail(layer);
      renderLayers();
      renderFilters();
      requestRender();
      commitDocumentAction();
    }
    clearFilterPress();
  });
  filterList.addEventListener("pointercancel", clearFilterPress);
  filterList.addEventListener("dragstart", (event) => {
    const handle = event.target.closest("[data-filter-drag]");
    if (!handle) {
      event.preventDefault();
      return;
    }
    const card = event.target.closest(".filter-card");
    draggedFilterId = card?.dataset.filterId || null;
    if (draggedFilterId && event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedFilterId);
    }
  });
  filterList.addEventListener("dragover", (event) => {
    const card = event.target.closest(".filter-card");
    if (!card || !draggedFilterId) return;
    event.preventDefault();
    filterDropAfter = event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2;
    filterList.querySelectorAll(".filter-drop-before, .filter-drop-after").forEach((item) => item.classList.remove("filter-drop-before", "filter-drop-after"));
    card.classList.add(filterDropAfter ? "filter-drop-after" : "filter-drop-before");
  });
  filterList.addEventListener("drop", (event) => {
    const card = event.target.closest(".filter-card");
    event.preventDefault();
    filterList.querySelectorAll(".filter-drop-before, .filter-drop-after").forEach((item) => item.classList.remove("filter-drop-before", "filter-drop-after"));
    const layer = getSelectedLayer();
    if (!card || !draggedFilterId || !layer) return;
    const reordered = reorderByIds(layer.filters, draggedFilterId, card.dataset.filterId, filterDropAfter);
    draggedFilterId = null;
    filterDropAfter = false;
    if (reordered) {
      invalidateLayerThumbnail(layer);
      renderLayers();
    }
    renderFilters();
    requestRender();
    if (reordered) commitDocumentAction();
  });
  filterList.addEventListener("dragend", () => {
    draggedFilterId = null;
    filterDropAfter = false;
    filterList.querySelectorAll(".filter-drop-before, .filter-drop-after").forEach((item) => item.classList.remove("filter-drop-before", "filter-drop-after"));
  });

  document.getElementById("undoButton").addEventListener("click", () => void undoDocument());
  document.getElementById("redoButton").addEventListener("click", () => void redoDocument());
  document.getElementById("collapseBrush").addEventListener("click", () => {
    document.getElementById("brushPanel").classList.add("is-collapsed");
    document.getElementById("brushReopen").hidden = false;
  });
  document.getElementById("brushReopen").addEventListener("click", () => {
    document.getElementById("brushPanel").classList.remove("is-collapsed");
    document.getElementById("brushReopen").hidden = true;
  });

  const zoomRange = document.getElementById("zoomRange");
  zoomRange.addEventListener("input", () => setZoom(zoomRange.value));
  document.getElementById("zoomIn").addEventListener("click", () => setZoom(state.zoom + 10));
  document.getElementById("zoomOut").addEventListener("click", () => setZoom(state.zoom - 10));
  document.getElementById("fitButton").addEventListener("click", () => {
    state.viewport = { x: 0, y: 0 };
    syncViewport();
    setZoom(80);
  });

  window.addEventListener("keydown", (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    const plainShortcut = !modifier && !event.altKey && !event.shiftKey;
    if (event.code === "KeyQ" && plainShortcut) {
      consumeCanvasShortcut(event);
      if (!event.repeat) void undoDocument();
      return;
    }
    if (event.code === "KeyW" && plainShortcut) {
      consumeCanvasShortcut(event);
      if (!event.repeat) void redoDocument();
      return;
    }
    if (isEditingTextField()) return;
    if (event.code === "Space" && plainShortcut) {
      consumeCanvasShortcut(event);
      heldCanvasShortcutCodes.add(event.code);
      if (!event.repeat) {
        state.spacePressed = true;
        canvas.classList.add("pan-ready");
      }
      return;
    }
    if (event.code === "KeyS" && plainShortcut) {
      consumeCanvasShortcut(event);
      heldCanvasShortcutCodes.add(event.code);
      if (!event.repeat) {
        state.sizeAdjustPressed = true;
        state.sizeAdjustStart = {
          x: state.lastPointer.x,
          size: state.brush.size,
          cursorX: state.lastPointer.x,
          cursorY: state.lastPointer.y,
        };
        brushCursor.classList.add("is-sizing");
        brushCursor.dataset.size = `${Math.round(state.brush.size)} px`;
        updateBrushCursor({ clientX: state.lastPointer.x, clientY: state.lastPointer.y, altKey: false });
      }
      return;
    }
    if (event.key === "Alt") {
      consumeCanvasShortcut(event);
      heldCanvasShortcutCodes.add(event.code);
      canvas.classList.add("is-eyedropping");
      brushCursor.style.opacity = "0";
      return;
    }
    if (event.code === "KeyE" && plainShortcut) {
      consumeCanvasShortcut(event);
      heldCanvasShortcutCodes.add(event.code);
      if (!event.repeat) setTemporaryEraser(true);
      return;
    }
    if (event.code === "KeyF" && plainShortcut) {
      consumeCanvasShortcut(event);
      heldCanvasShortcutCodes.add(event.code);
      if (!event.repeat) {
        state.dPicker = { downAt: performance.now(), wasOpen: state.colorPickerFloating };
        if (!state.colorPickerFloating && getSelectedLayer()?.kind === "paint") {
          state.colorPickerFloating = true;
          document.body.append(paintColorPanel);
          paintColorPanel.hidden = false;
          renderPaintColorPicker();
          paintColorPanel.style.position = "fixed";
          paintColorPanel.style.margin = "0";
          anchorFloatingColorPicker(state.lastPointer.x, state.lastPointer.y);
        }
      }
      return;
    }
    if (event.code === "KeyD" && plainShortcut) {
      consumeCanvasShortcut(event);
      return;
    }
    if (event.code === "KeyX" && plainShortcut) {
      consumeCanvasShortcut(event);
      if (event.repeat) return;
      const layer = getSelectedLayer();
      if (state.selectionPart !== "mask" || !layer?.mask) return;
      state.brush.value = 1 - state.brush.value;
      syncBrushUi();
      syncDockPanels();
      syncBrushPanelPosition();
      updateBrushCursor({ clientX: state.lastPointer.x, clientY: state.lastPointer.y, altKey: false });
      commitDocumentAction();
      return;
    }
    if (modifier && event.key.toLowerCase() === "n") {
      consumeCanvasShortcut(event);
      createNewDocument().catch(reportError);
      return;
    }
    if (modifier && event.key.toLowerCase() === "o") {
      consumeCanvasShortcut(event);
      openProject().catch(reportError);
      return;
    }
    if (modifier && event.key.toLowerCase() === "s") {
      consumeCanvasShortcut(event);
      saveProject(event.shiftKey).catch(reportError);
      return;
    }
    if (modifier && event.key.toLowerCase() === "z") {
      consumeCanvasShortcut(event);
      if (event.shiftKey) void redoDocument();
      else void undoDocument();
      return;
    }
    if (modifier && event.key.toLowerCase() === "y") {
      consumeCanvasShortcut(event);
      void redoDocument();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (!heldCanvasShortcutCodes.has(event.code)) return;
    consumeCanvasShortcut(event);
    heldCanvasShortcutCodes.delete(event.code);
    if (event.code === "Space") {
      state.spacePressed = false;
      canvas.classList.remove("pan-ready");
    }
    if (event.code === "KeyS") {
      const sizeChanged = state.sizeAdjustStart && state.brush.size !== state.sizeAdjustStart.size;
      state.sizeAdjustPressed = false;
      state.sizeAdjustStart = null;
      brushCursor.classList.remove("is-sizing");
      delete brushCursor.dataset.size;
      if (sizeChanged) commitDocumentAction();
    }
    if (event.code === "KeyE") {
      setTemporaryEraser(false);
    }
    if (event.key === "Alt") {
      canvas.classList.remove("is-eyedropping");
      eyedropperIndicator.hidden = true;
      updateBrushCursor({ clientX: state.lastPointer.x, clientY: state.lastPointer.y, altKey: false });
    }
    if (event.code === "KeyF") {
      const heldLong = performance.now() - state.dPicker.downAt >= 220;
      if ((heldLong && !state.dPicker.wasOpen) || (!heldLong && state.dPicker.wasOpen)) hideFloatingColorPicker();
    }
  });
  window.addEventListener("blur", () => {
    clearHeldCanvasShortcuts();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#brushLibrary") && !event.target.closest("#brushPreview")) setBrushLibraryOpen(false);
    if (state.colorPickerFloating && !event.target.closest("#paintColorPanel")) hideFloatingColorPicker();
    if (state.maskSettingsLayerId && !event.target.closest(".filters-panel")) {
      state.maskSettingsLayerId = null;
      renderFilters();
    }
  }, true);
  window.addEventListener("beforeunload", () => {
    void flushDocumentAutosave();
  });
}

async function start() {
  initializeGpu();
  loadProjectSettings();
  renderFilterMenu();
  renderBlendModeMenu();
  wireEvents();
  const restored = await restoreDocument();
  if (!restored) await loadStarter();
  canvasEmpty.hidden = true;
  document.getElementById("documentSize").textContent = `${DOC_WIDTH} x ${DOC_HEIGHT}`;
  syncFilterPreviewControl();
  syncMotionButton();
  syncBrushUi();
  syncDocumentMeta();
  setZoom(state.zoom);
  syncViewport();
  syncCanvasPresentation();
  syncCanvasCursor();
  renderLayers();
  renderFilters();
  requestRender();
  resetDocumentHistory();
  await initializeBrushTextureLibrary();
  if (isDesktopAutosaveAvailable()) scheduleSave();
  requestAnimationFrame(animationLoop);
}

start().catch((error) => {
  console.error(error);
  canvasEmpty.hidden = false;
  canvasEmpty.innerHTML = `<strong>Shader Paint could not start</strong><span>${escapeHtml(error.message)}</span>`;
});
