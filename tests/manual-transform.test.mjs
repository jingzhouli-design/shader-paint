import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const helperNames = [
  "sourceContentBounds", "layerContentBounds", "selectionBounds",
  "unionTransformBounds", "transformSourceExtent", "overlayPoint",
  "serializeOffCanvasSource",
  "hasLayerTransformChanges", "syncHistoryButtons", "undoDocument", "redoDocument",
  "isImageImportFile", "isFileDrag", "importDroppedImageFiles",
];

function helpers(extra = {}) {
  const context = vm.createContext({ DOC_WIDTH: 100, DOC_HEIGHT: 80, ...extra });
  for (const name of helperNames) {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
    assert.ok(match, `Missing application helper: ${name}`);
    vm.runInContext(match[0], context);
  }
  return context;
}

function pixelSource(x = 0, canvasY = 0) {
  const pixels = new Uint8ClampedArray(100 * 80 * 4);
  for (let row = 15; row < 45; row += 1) {
    for (let column = 20; column < 60; column += 1) {
      pixels[(row * 100 + column) * 4 + 3] = 255;
    }
  }
  return {
    x, canvasY,
    canvas: { width: 100, height: 80, getContext: () => ({ getImageData: () => ({ data: pixels }) }) },
    pixels,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("Base and Paint bounds exclude transparent margins and share revision caching", () => {
  const h = helpers();
  for (const kind of ["image", "paint"]) {
    const source = pixelSource();
    const layer = { kind, sourceRevision: 0, sourceCanvas: source.canvas };
    assert.deepEqual(plain(h.layerContentBounds(layer)), {
      x0: 20, y0: 35, x1: 60, y1: 65, width: 40, height: 30, canvasY: 15,
    });
    source.pixels.fill(0);
    assert.equal(h.layerContentBounds(layer).width, 40);
    layer.sourceRevision += 1;
    assert.equal(h.layerContentBounds(layer), null);
  }
});

test("content bounds retain negative and fully off-canvas coordinates", () => {
  const h = helpers();
  for (const [x, y] of [[160, 120], [-160, -120]]) {
    const bounds = h.sourceContentBounds(pixelSource(x, y));
    assert.equal(bounds.x0, x + 20);
    assert.equal(bounds.canvasY, y + 15);
    assert.equal(bounds.y1, 80 - y - 15);
    assert.equal(bounds.width, 40);
    assert.equal(bounds.height, 30);
  }
});

test("alpha bounds include even faint nonzero edge pixels", () => {
  const h = helpers();
  const source = pixelSource();
  source.pixels[3] = 1;
  const bounds = h.sourceContentBounds(source);
  assert.equal(bounds.x0, 0);
  assert.equal(bounds.canvasY, 0);
});

test("empty layers have no fictitious full-document bounds", () => {
  const h = helpers();
  const source = pixelSource();
  source.pixels.fill(0);
  assert.equal(h.sourceContentBounds(source), null);
});

test("brush selection is canvas-clipped but transform selection is not", () => {
  const h = helpers();
  const selection = { points: [{ x: 90, y: 65 }, { x: 130, y: 65 }, { x: 130, y: 35 }, { x: 90, y: 35 }] };
  assert.equal(h.selectionBounds(selection).width, 10);
  assert.equal(h.selectionBounds(selection, false).width, 40);
  selection.points = selection.points.map((point) => ({ x: point.x + 100, y: point.y }));
  assert.equal(h.selectionBounds(selection), null);
  assert.equal(h.selectionBounds(selection, false).width, 40);
});

test("visible history regions stay valid for wholly off-canvas transforms", () => {
  const h = helpers();
  for (const offset of [-300, 300]) {
    const transform = {
      bounds: { x0: offset, x1: offset + 40, y0: offset, y1: offset + 30 },
      corners: [{ x: offset + 10, y: offset + 10 }, { x: offset + 50, y: offset + 40 }],
    };
    const region = h.unionTransformBounds(transform);
    assert.equal(region.width, 0);
    assert.equal(region.height, 0);
    assert.ok(region.x0 >= 0 && region.x0 <= 100);
    assert.ok(region.canvasY >= 0 && region.canvasY <= 80);
  }
});

test("complete transform extent includes old source and new off-canvas corners", () => {
  const h = helpers();
  const extent = h.transformSourceExtent({
    background: { x: 0, canvasY: 0, canvas: { width: 100, height: 80 } },
    corners: [{ x: -20, y: 100 }, { x: 130, y: 100 }, { x: 130, y: -10 }, { x: -20, y: -10 }],
  });
  assert.deepEqual(plain(extent), { x: -20, canvasY: -20, width: 150, height: 110 });
});

test("overlay uses stage space and rendered zoom/pan, without clipping coordinates", () => {
  const h = helpers({
    canvas: { getBoundingClientRect: () => ({ left: 200, top: 150, width: 300, height: 240 }) },
    canvasStage: { getBoundingClientRect: () => ({ left: 20, top: 50 }) },
  });
  assert.deepEqual(plain(h.overlayPoint({ x: 130, y: 100 })), { x: 570, y: 40 });
});

test("project overflow metadata omits runtime canvas objects", () => {
  const h = helpers();
  assert.equal(h.serializeOffCanvasSource(null), null);
  assert.deepEqual(plain(h.serializeOffCanvasSource({
    x: -40, canvasY: 120, dataUrl: "data:image/png;base64,test", canvas: {},
  })), { x: -40, canvasY: 120, dataUrl: "data:image/png;base64,test" });
});

function pendingTransform(changed = true) {
  return {
    bounds: { x0: 0, x1: 40, y0: 0, y1: 30 },
    corners: [{ x: 0, y: 30 }, { x: 40, y: 30 }, { x: 40, y: 0 }, { x: 0, y: 0 }]
      .map((point) => ({ x: point.x + (changed ? 70 : 0), y: point.y })),
  };
}

test("undo records an unconfirmed transform so redo can restore it", async () => {
  const state = { layerTransform: pendingTransform(), history: [{ type: "snapshot" }], historyIndex: 0 };
  const calls = [];
  const h = helpers({
    state,
    commitLayerTransform() {
      calls.push("commit");
      state.history.push({ type: "action" });
      state.historyIndex = 1;
      state.layerTransform = null;
    },
    applyHistoryAction: (_, direction) => calls.push(direction),
    scheduleSave: () => {},
  });
  h.syncHistoryButtons = () => {};
  await h.undoDocument();
  assert.equal(state.historyIndex, 0);
  assert.deepEqual(calls, ["commit", "undo"]);
  await h.redoDocument();
  assert.equal(state.historyIndex, 1);
  assert.deepEqual(calls, ["commit", "undo", "redo"]);
});

test("redo after reopening Transform dismisses its unchanged preview and still redoes", async () => {
  const state = {
    layerTransform: pendingTransform(false),
    history: [{ type: "snapshot" }, { type: "action" }],
    historyIndex: 0,
  };
  const calls = [];
  const h = helpers({
    state,
    cancelLayerTransform: () => { calls.push("cancel"); state.layerTransform = null; },
    applyHistoryAction: (_, direction) => calls.push(direction),
    scheduleSave: () => {},
  });
  h.syncHistoryButtons = () => {};
  await h.redoDocument();
  assert.equal(state.historyIndex, 1);
  assert.deepEqual(calls, ["cancel", "redo"]);
});

test("a new changed transform starts a branch rather than replaying stale redo", async () => {
  const state = {
    layerTransform: pendingTransform(),
    history: [{ type: "snapshot" }, { type: "action" }],
    historyIndex: 0,
  };
  const calls = [];
  const h = helpers({
    state,
    commitLayerTransform: () => calls.push("commit"),
    applyHistoryAction: () => calls.push("unexpected redo"),
  });
  await h.redoDocument();
  assert.deepEqual(calls, ["commit"]);
});

test("undo button includes a pending first transform before any recorded history", () => {
  const state = { layerTransform: pendingTransform(), historyIndex: 0, history: [{}] };
  const buttons = { undoButton: {}, redoButton: {} };
  const h = helpers({ state, document: { getElementById: (id) => buttons[id] } });
  h.syncHistoryButtons();
  assert.equal(buttons.undoButton.disabled, false);
  assert.equal(buttons.redoButton.disabled, true);
  state.layerTransform = pendingTransform(false);
  h.syncHistoryButtons();
  assert.equal(buttons.undoButton.disabled, true);
});

test("drop import accepts browser images and extension fallback, not arbitrary files", () => {
  const h = helpers();
  for (const file of [
    { name: "photo.png", type: "image/png" },
    { name: "photo.JPG", type: "" },
    { name: "vector.svg", type: "application/octet-stream" },
    { name: "photo.heic", type: "image/heic" },
  ]) assert.equal(h.isImageImportFile(file), true);
  for (const file of [
    { name: "notes.txt", type: "text/plain" },
    { name: "project.shaderpaint", type: "" },
    { name: "not-image.png", type: "text/plain" },
  ]) assert.equal(h.isImageImportFile(file), false);
});

test("file drag detection does not intercept layer/filter reordering", () => {
  const h = helpers();
  assert.equal(h.isFileDrag({ dataTransfer: { types: ["Files"] } }), true);
  assert.equal(h.isFileDrag({ dataTransfer: { types: ["text/plain"] } }), false);
  assert.equal(h.isFileDrag({}), false);
});

test("multiple dropped files import in order and report failures without losing valid files", async () => {
  const imported = [];
  const errors = [];
  const messages = [];
  const h = helpers({
    importImageFile: async (file) => {
      imported.push(file.name);
      if (file.name === "bad.txt") throw new Error("Unsupported file");
    },
    reportError: (error) => errors.push(error.message),
    showToast: (message) => messages.push(message),
  });
  await h.importDroppedImageFiles([{ name: "first.png" }, { name: "bad.txt" }, { name: "second.png" }]);
  assert.deepEqual(imported, ["first.png", "bad.txt", "second.png"]);
  assert.deepEqual(errors, ["Unsupported file"]);
  assert.match(messages.at(-1), /Imported 2.*bad\.txt/);
  await h.importDroppedImageFiles([]);
  assert.match(messages.at(-1), /not folders/);
});
