import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function loadHelper(name, context) {
  context.usesTouchWorkspace = () => context.phoneLayout.matches;
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `Missing application helper: ${name}`);
  vm.runInContext(match[0], context);
}

function presentation(phone, stageWidth, stageHeight, { fraction = 0.68, clearance = 330, duo = false } = {}) {
  let renders = 0;
  const context = vm.createContext({
    phoneLayout: { matches: phone },
    dualScreenLayout: duo ? {} : null,
    getComputedStyle: () => ({
      getPropertyValue: (key) => key === "--canvas-width-fraction" ? String(fraction) : `${clearance}px`,
    }),
    canvasStage: { clientWidth: stageWidth, clientHeight: stageHeight },
    canvasWrap: { style: {} },
    DOC_WIDTH: 1200,
    DOC_HEIGHT: 900,
    drawManualEditingOverlay() {},
    requestRender() { renders += 1; },
  });
  loadHelper("syncCanvasPresentation", context);
  context.syncCanvasPresentation();
  return { context, renders: () => renders };
}

test("phone canvas fills available width without desktop panel reservation", () => {
  const { context } = presentation(true, 320, 455);
  assert.equal(context.canvasWrap.style.width, "288px");
  assert.equal(context.canvasWrap.style.height, "216px");
});

test("small-phone canvas remains usable above an open control sheet", () => {
  const { context } = presentation(true, 320, 217);
  assert.equal(context.canvasWrap.style.width, "119px");
  assert.equal(context.canvasWrap.style.height, "89px");
});

test("landscape canvas reserves space for tools and quick actions", () => {
  const { context } = presentation(true, 460, 296);
  assert.equal(context.canvasWrap.style.width, "224px");
  assert.equal(context.canvasWrap.style.height, "168px");
});

test("desktop canvas sizing retains the original panel and height allowance", () => {
  const { context } = presentation(false, 870, 846);
  assert.equal(context.canvasWrap.style.width, "540px");
  assert.equal(context.canvasWrap.style.height, "405px");
});

test("narrow desktop canvas follows responsive clearances instead of reserving 330px", () => {
  const narrow = presentation(false, 444, 846, { fraction: 0.66, clearance: 210 });
  assert.equal(narrow.context.canvasWrap.style.width, "234px");
  assert.equal(narrow.context.canvasWrap.style.height, "176px");
  const medium = presentation(false, 710, 846, { fraction: 0.66, clearance: 250 });
  assert.equal(medium.context.canvasWrap.style.width, "460px");
});

test("collapsing the desktop brush uses the freed canvas width", () => {
  const { context } = presentation(false, 444, 846, { fraction: 1, clearance: 32 });
  assert.equal(context.canvasWrap.style.width, "412px");
  assert.equal(context.canvasWrap.style.height, "309px");
});

test("Duo uses more of its own screen without crossing the hinge", () => {
  const { context } = presentation(true, 540, 664, { duo: true });
  assert.equal(context.canvasWrap.style.width, "524px");
  assert.equal(context.canvasWrap.style.height, "393px");
});

test("actual size changes request a fresh render without repeated observer work", () => {
  const { context, renders } = presentation(true, 393, 739);
  assert.equal(renders(), 1);
  context.syncCanvasPresentation();
  assert.equal(renders(), 1);
  context.canvasStage.clientHeight = 381;
  context.syncCanvasPresentation();
  assert.equal(renders(), 2);
});

test("phone docking temporarily expands panels without changing desktop preferences", () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      classes: new Map(),
      attributes: new Map(),
      dataset: {},
      classList: { toggle(name, value) { elements.get(id).classes.set(name, value); } },
      setAttribute(name, value) { this.attributes.set(name, value); },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    phoneLayout: { matches: true },
    state: { ipad: { layersCollapsed: true, filtersCollapsed: true } },
    document: { getElementById: element },
    syncCanvasPresentation() {},
  });
  loadHelper("syncDockPanels", context);
  context.syncDockPanels();
  assert.equal(element("layersPanel").classes.get("is-collapsed"), false);
  assert.equal(element("filtersPanel").classes.get("is-collapsed"), false);
  assert.equal(context.state.ipad.layersCollapsed, true);
  assert.equal(context.state.ipad.filtersCollapsed, true);
  context.phoneLayout.matches = false;
  context.syncDockPanels();
  assert.equal(element("layersPanel").classes.get("is-collapsed"), true);
  assert.equal(element("filtersPanel").classes.get("is-collapsed"), true);
  assert.equal(element("collapseLayers").attributes.get("aria-expanded"), "false");
});

test("phone transform handles have larger touch targets and prefer the nearest handle", () => {
  const context = vm.createContext({
    phoneLayout: { matches: true },
    state: { layerTransform: {} },
    DOC_WIDTH: 100,
    DOC_HEIGHT: 80,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 80 }) },
    transformHandlePoints: () => [{ x: 20, y: 60 }, { x: 40, y: 60 }],
    transformRotationHandle: () => ({ handle: { x: 80, y: 0 } }),
  });
  loadHelper("transformHandleAt", context);
  assert.equal(context.transformHandleAt({ clientX: 20, clientY: 41, pointerType: "touch" }), 0);
  assert.equal(context.transformHandleAt({ clientX: 36, clientY: 20, pointerType: "touch" }), 1);
  assert.equal(context.transformHandleAt({ clientX: 20, clientY: 43, pointerType: "touch" }), -1);
  assert.equal(context.transformHandleAt({ clientX: 20, clientY: 41, pointerType: "mouse" }), -1);
  context.phoneLayout.matches = false;
  assert.equal(context.transformHandleAt({ clientX: 20, clientY: 41, pointerType: "touch" }), -1);
});
