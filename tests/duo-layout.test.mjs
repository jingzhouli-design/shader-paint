import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function helpers(extra = {}) {
  const context = vm.createContext({
    phoneLayout: { matches: false },
    dualScreenLayout: null,
    horizontalSegments: { matches: false },
    verticalSegments: { matches: false },
    state: { workspace: { dualScreenMode: "auto" } },
    ...extra,
    window: { innerWidth: 1114, innerHeight: 720, ...extra.window },
  });
  for (const name of ["dualScreenGeometry", "manualDualScreenSegments", "readViewportSegments", "usesTouchWorkspace", "syncDualScreenStatus"]) {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
    assert.ok(match, `Missing application helper: ${name}`);
    vm.runInContext(match[0], context);
  }
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function layerGestures(duo = true) {
  const listeners = {};
  const timers = new Map();
  const calls = [];
  let nextTimer = 1;
  let captured = null;
  const row = (id, top) => {
    const classes = new Set();
    return {
      dataset: { layerId: id },
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
      },
      getBoundingClientRect: () => ({ top, height: 48 }),
      closest: () => rows.find((item) => item.dataset.layerId === id),
    };
  };
  const rows = [row("top", 0), row("bottom", 52)];
  const context = vm.createContext({
    dualScreenLayout: duo ? {} : null,
    suppressLayerClickUntil: 0,
    TOUCH_REORDER_DELAY_MS: 260,
    performance: { now: () => 1000 },
    navigator: {},
    state: { layers: [{ id: "bottom" }, { id: "top" }] },
    window: {
      setTimeout(handler) { const id = nextTimer++; timers.set(id, handler); return id; },
      clearTimeout: (id) => timers.delete(id),
    },
    layerList: {
      scrollTop: 100,
      addEventListener: (type, handler) => { listeners[type] = handler; },
      querySelectorAll: () => rows,
      setPointerCapture: (id) => { captured = id; },
      hasPointerCapture: (id) => captured === id,
      releasePointerCapture: () => { captured = null; },
    },
    document: { elementFromPoint: () => rows[1] },
    normalizeAdjustmentStarts: () => calls.push("normalize"),
    renderLayers: () => calls.push("layers"),
    requestRender: () => calls.push("render"),
    commitDocumentAction: () => calls.push("history"),
    setPanel: () => calls.push("panel"),
  });
  const reorder = source.match(/^function reorderByIds\([^]*?^}/m);
  const gestures = source.match(/^  let draggedLayerId = null;[^]*?(?=^  document\.querySelector\("\.layer-toolbar"\))/m);
  const capture = source.match(/layerList\.addEventListener\("click", \(\) => \{[^]*?\}, true\);/);
  assert.ok(reorder && gestures && capture, "Missing layer gesture wiring");
  vm.runInContext(`${reorder[0]}\n${gestures[0]}\n${capture[0]}`, context);
  const event = (kind = "thumbnail", extra = {}) => ({
    pointerId: 7, pointerType: "touch", button: 0, buttons: 1, clientX: 20, clientY: 100,
    target: {
      setPointerCapture: (id) => { captured = id; },
      hasPointerCapture: (id) => captured === id,
      releasePointerCapture: () => { captured = null; },
      closest(selector) {
        if (selector === ".layer-row") return rows[0];
        if (selector === ".layer-thumb") return kind === "thumbnail" ? this : null;
        if (selector === "button, input, .layer-name") return kind === "background" ? null : this;
        return null;
      },
    },
    preventDefault() { this.defaultPrevented = true; },
    ...extra,
  });
  return {
    context, rows, calls, listeners, timers, event,
    captured: () => captured,
    hold() { const handlers = [...timers.values()]; timers.clear(); handlers.forEach((handler) => handler()); },
  };
}

test("Duo thumbnail taps stay clicks; settings buttons and ordinary phone thumbnails never start a reorder", () => {
  const h = layerGestures();
  h.listeners.pointerdown(h.event());
  assert.equal(h.timers.size, 1);
  h.listeners.pointerup(h.event());
  assert.equal(h.context.suppressLayerClickUntil, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.captured(), null);
  h.listeners.pointerdown(h.event("settings"));
  assert.equal(h.timers.size, 0);
  const phone = layerGestures(false);
  phone.listeners.pointerdown(phone.event());
  assert.equal(phone.timers.size, 0);
});

test("a short thumbnail swipe scrolls the rail without reordering or a trailing click changing panels", () => {
  const h = layerGestures();
  h.listeners.pointerdown(h.event());
  h.listeners.pointermove(h.event("thumbnail", { clientY: 40 }));
  assert.equal(h.context.layerList.scrollTop, 160);
  assert.equal(h.timers.size, 0);
  assert.equal(h.captured(), 7);
  h.hold();
  assert.equal(h.rows[0].classList.contains("touch-dragging"), false);
  h.listeners.pointerup(h.event("thumbnail", { clientY: 40 }));
  h.listeners.click();
  assert.equal(h.captured(), null);
  assert.equal(h.context.suppressLayerClickUntil, 1350);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(plain(h.context.state.layers).map((layer) => layer.id), ["bottom", "top"]);
});

test("holding a thumbnail reorders directly, records history and suppresses the release click", () => {
  const h = layerGestures();
  h.listeners.pointerdown(h.event());
  h.hold();
  assert.equal(h.rows[0].classList.contains("touch-dragging"), true);
  h.listeners.pointermove(h.event("thumbnail", { clientY: 90 }));
  h.listeners.pointerup(h.event("thumbnail", { clientY: 90 }));
  h.listeners.click();
  assert.deepEqual(plain(h.context.state.layers).map((layer) => layer.id), ["top", "bottom"]);
  assert.deepEqual(h.calls, ["normalize", "layers", "render", "history"]);
  assert.equal(h.captured(), null);
});

test("cancelling a thumbnail hold releases capture and never reorders or records history", () => {
  const h = layerGestures();
  h.listeners.pointerdown(h.event());
  h.hold();
  h.listeners.pointercancel(h.event());
  assert.equal(h.captured(), null);
  assert.equal(h.rows[0].classList.contains("touch-dragging"), false);
  assert.deepEqual(h.calls, []);
});

test("Duo mouse thumbnails reorder immediately on movement without a touch hold or native button drag", () => {
  const h = layerGestures();
  const mouse = h.event("thumbnail", { pointerType: "mouse" });
  h.listeners.pointerdown(mouse);
  assert.equal(mouse.defaultPrevented, true);
  assert.equal(h.captured(), 7);
  assert.equal(h.timers.size, 0);
  h.listeners.pointermove(h.event("thumbnail", { pointerType: "mouse", clientY: 90 }));
  assert.equal(h.rows[0].classList.contains("touch-dragging"), false);
  h.listeners.pointermove(h.event("thumbnail", { pointerType: "mouse", clientY: 80 }));
  h.listeners.pointerup(h.event("thumbnail", { pointerType: "mouse", clientY: 90 }));
  h.listeners.click();
  assert.deepEqual(plain(h.context.state.layers).map((layer) => layer.id), ["top", "bottom"]);
  assert.deepEqual(h.calls, ["normalize", "layers", "render", "history"]);
  assert.equal(h.captured(), null);
});

test("desktop keeps native mouse drag-and-drop ordering", () => {
  const h = layerGestures(false);
  const mouse = h.event("thumbnail", { pointerType: "mouse", clientY: 90, dataTransfer: {} });
  h.listeners.pointerdown(mouse);
  assert.equal(h.timers.size, 0);
  h.listeners.dragstart(mouse);
  const target = { closest: () => h.rows[1] };
  h.listeners.dragover({ ...mouse, target });
  h.listeners.drop({ ...mouse, target });
  assert.deepEqual(plain(h.context.state.layers).map((layer) => layer.id), ["top", "bottom"]);
  assert.ok(h.calls.includes("history"));
});

test("released mouse gestures cannot reorder layers when returning to the rail or clicking settings", () => {
  for (const active of [false, true]) {
    const h = layerGestures();
    h.listeners.pointerdown(h.event("thumbnail", { pointerType: "mouse" }));
    if (active) h.listeners.pointermove(h.event("thumbnail", { pointerType: "mouse", clientY: 80 }));
    h.listeners.pointermove(h.event("thumbnail", { pointerType: "mouse", buttons: 0, clientY: 150 }));
    h.listeners.pointerdown(h.event("settings", { pointerType: "mouse" }));
    h.listeners.pointerup(h.event("settings", { pointerType: "mouse", buttons: 0, clientY: 90 }));
    assert.deepEqual(plain(h.context.state.layers).map((layer) => layer.id), ["bottom", "top"]);
    assert.deepEqual(h.calls, []);
    assert.equal(h.captured(), null);
    assert.equal(h.context.suppressLayerClickUntil, 0);
  }
});

test("visibility actions preserve transform, GPU cleanup and undo behavior after moving into settings", () => {
  const layer = { id: "top", visible: true };
  const calls = [];
  const context = vm.createContext({
    state: { layerTransform: { layerId: "top" } },
    commitLayerTransform: () => calls.push("transform"),
    releaseHiddenLayerTextures: () => calls.push("release"),
    renderLayers: () => calls.push("layers"),
    requestRender: () => calls.push("render"),
    commitDocumentAction: () => calls.push("history"),
  });
  const helper = source.match(/^function toggleLayerVisibility\([^]*?^}/m);
  assert.ok(helper);
  vm.runInContext(helper[0], context);
  context.toggleLayerVisibility(layer);
  assert.equal(layer.visible, false);
  assert.deepEqual(calls, ["transform", "release", "layers", "render", "history"]);
  calls.length = 0;
  context.state.layerTransform = null;
  context.toggleLayerVisibility(layer);
  assert.equal(layer.visible, true);
  assert.deepEqual(calls, ["layers", "render", "history"]);
});

test("Duo capture listener ignores synthesized clicks after touch reorder without closing Brush", () => {
  const registration = source.match(/layerList\.addEventListener\("click", \(\) => \{[^]*?\}, true\);/);
  assert.ok(registration, "Missing Duo layer capture listener");
  const panels = [];
  let capture;
  const context = vm.createContext({
    dualScreenLayout: {},
    suppressLayerClickUntil: 350,
    performance: { now: () => context.time },
    time: 349,
    setPanel: (name) => panels.push(name),
    layerList: {
      addEventListener(type, handler, useCapture) {
        assert.equal(type, "click");
        assert.equal(useCapture, true);
        capture = handler;
      },
    },
  });
  vm.runInContext(registration[0], context);
  capture();
  assert.deepEqual(panels, []);
  context.time = 350;
  capture();
  assert.deepEqual(panels, ["effects"]);
  context.dualScreenLayout = null;
  capture();
  assert.deepEqual(panels, ["effects"]);
});

function layerUi() {
  const element = () => ({
    hidden: true, dataset: {}, value: "", textContent: "", attributes: {},
    classList: { remove() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    setCustomValidity(value) { this.validationMessage = value; },
    replaceChildren() { this.cleared = true; },
    focus() { this.focused = true; },
  });
  const ids = ["duoLayerSettings", "duoLayerActions", "duoLayerName", "phoneSheetTitle"];
  const nodes = Object.fromEntries(ids.map((id) => [id, element()]));
  const trigger = element();
  const selectedAction = element();
  const context = vm.createContext({
    dualScreenLayout: {}, activePhonePanel: "effects",
    selectedLayer: { id: "paint", name: "Paint layer" },
    filterPanelTitle: { textContent: "Filters" },
    layerList: { querySelector: () => selectedAction },
    blendSelectMenu: element(), blendSelectTrigger: element(),
    previewClears: 0,
    document: {
      activeElement: null,
      getElementById: (id) => nodes[id],
      querySelector: () => trigger,
    },
  });
  vm.runInContext("function getSelectedLayer() { return selectedLayer; } function clearBlendModePreview() { previewClears++; }", context);
  for (const name of ["closeDuoLayerSettings", "syncDuoLayerUi"]) {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
    assert.ok(match, `Missing application helper: ${name}`);
    vm.runInContext(match[0], context);
  }
  return { context, nodes, trigger, selectedAction };
}

test("Duo header follows the selected layer and current filter or mask context", () => {
  const { context: h, nodes } = layerUi();
  h.syncDuoLayerUi();
  assert.equal(nodes.phoneSheetTitle.textContent, "Filters · Paint layer");
  h.selectedLayer = { id: "base", name: "Long image name" };
  h.filterPanelTitle.textContent = "Mask settings";
  h.syncDuoLayerUi();
  assert.equal(nodes.phoneSheetTitle.textContent, "Mask settings · Long image name");
  assert.equal(nodes.phoneSheetTitle.title, nodes.phoneSheetTitle.textContent);
  h.activePhonePanel = "brush";
  h.syncDuoLayerUi();
  assert.equal(nodes.phoneSheetTitle.textContent, "Brush · Long image name");
});

test("Duo switching or deleting a layer dismisses settings owned by the previous layer", () => {
  for (const selectedLayer of [{ id: "other", name: "Other" }, null]) {
    const { context: h, nodes, trigger } = layerUi();
    nodes.duoLayerSettings.hidden = false;
    nodes.duoLayerSettings.dataset.layerId = "paint";
    h.selectedLayer = selectedLayer;
    h.syncDuoLayerUi();
    assert.equal(nodes.duoLayerSettings.hidden, true);
    assert.equal(nodes.duoLayerSettings.dataset.layerId, undefined);
    assert.equal(nodes.duoLayerActions.cleared, true);
    assert.equal(trigger.attributes["aria-expanded"], "false");
    if (!selectedLayer) assert.equal(nodes.phoneSheetTitle.textContent, "Filters · No layer");
  }
});

test("Duo updates preserve open settings and a name currently being edited", () => {
  const { context: h, nodes } = layerUi();
  nodes.duoLayerSettings.hidden = false;
  nodes.duoLayerSettings.dataset.layerId = "paint";
  nodes.duoLayerName.value = "Unfinished rename";
  h.document.activeElement = nodes.duoLayerName;
  h.syncDuoLayerUi();
  assert.equal(nodes.duoLayerSettings.hidden, false);
  assert.equal(nodes.duoLayerName.value, "Unfinished rename");
  h.document.activeElement = null;
  nodes.duoLayerName.validationMessage = "Old invalid input";
  h.syncDuoLayerUi();
  assert.equal(nodes.duoLayerName.value, "Paint layer");
  assert.equal(nodes.duoLayerName.validationMessage, "");
});

test("closing layer settings dismisses blend previews and can restore rail focus", () => {
  const { context: h, nodes, selectedAction } = layerUi();
  h.blendSelectMenu.hidden = false;
  h.closeDuoLayerSettings(true);
  assert.equal(nodes.duoLayerSettings.hidden, true);
  assert.equal(h.blendSelectMenu.hidden, true);
  assert.equal(h.blendSelectTrigger.attributes["aria-expanded"], "false");
  assert.equal(h.previewClears, 1);
  assert.equal(selectedAction.focused, true);
});

test("Duo UI updates do not alter phone or desktop headers and controls", () => {
  const { context: h, nodes } = layerUi();
  h.dualScreenLayout = null;
  nodes.phoneSheetTitle.textContent = "Layers";
  nodes.duoLayerName.value = "Do not touch";
  h.syncDuoLayerUi();
  assert.equal(nodes.phoneSheetTitle.textContent, "Layers");
  assert.equal(nodes.duoLayerName.value, "Do not touch");
  assert.equal(h.previewClears, 0);
});

const sideBySide = [
  { x: 0, y: 0, width: 540, height: 720 },
  { x: 574, y: 0, width: 540, height: 720 },
];
const stacked = [
  { x: 0, y: 0, width: 720, height: 540 },
  { x: 0, y: 574, width: 720, height: 540 },
];

test("Duo landscape excludes the hinge and sorts reversed native screen order", () => {
  const h = helpers();
  for (const segments of [sideBySide, [...sideBySide].reverse()]) {
    assert.deepEqual(plain(h.dualScreenGeometry(segments, 1114, 720)), {
      axis: "horizontal", canvas: sideBySide[0], controls: sideBySide[1],
    });
  }
});

test("rotated stacked screens keep canvas above controls across the horizontal hinge", () => {
  const h = helpers();
  assert.deepEqual(plain(h.dualScreenGeometry([...stacked].reverse(), 720, 1114)), {
    axis: "vertical", canvas: stacked[0], controls: stacked[1],
  });
});

test("native segment positions and unequal screen widths are preserved", () => {
  const h = helpers();
  const segments = [
    { left: 12, top: 20, width: 480.5, height: 650 },
    { left: 526.5, top: 20, width: 560, height: 650 },
  ];
  const layout = h.dualScreenGeometry(segments, 1114, 720);
  assert.equal(layout.canvas.x, 12);
  assert.equal(layout.canvas.width, 480.5);
  assert.equal(layout.controls.x, 526.5);
  assert.equal(layout.controls.width, 560);
});

test("side-by-side native screens preserve unequal heights and toolbar offsets without moving the hinge", () => {
  const h = helpers();
  const segments = [
    { x: 0, y: 56, width: 540, height: 664 },
    { x: 574, y: 0, width: 504, height: 688 },
  ];
  for (const pair of [segments, [...segments].reverse()]) {
    const layout = h.dualScreenGeometry(pair, 1078, 720);
    assert.deepEqual(plain(layout), { axis: "horizontal", canvas: segments[0], controls: segments[1] });
    assert.equal(layout.controls.x - layout.canvas.width, 34);
  }
});

test("stacked native screens preserve unequal widths and left navigation insets even when x order is reversed", () => {
  const h = helpers();
  const segments = [
    { x: 24, y: 0, width: 696, height: 480 },
    { x: 0, y: 514, width: 688, height: 540 },
  ];
  for (const pair of [segments, [...segments].reverse()]) {
    assert.deepEqual(plain(h.dualScreenGeometry(pair, 720, 1054)), {
      axis: "vertical", canvas: segments[0], controls: segments[1],
    });
  }
});

test("unsupported, folded, overlapping, off-viewport or invalid segments do not activate Duo", () => {
  const h = helpers();
  for (const segments of [
    undefined, [], [sideBySide[0]], [...sideBySide, sideBySide[0]],
    [sideBySide[0], { ...sideBySide[1], x: 500 }],
    [sideBySide[0], { ...sideBySide[1], y: 30 }],
    [sideBySide[0], { ...sideBySide[1], width: 900 }],
    [sideBySide[0], { ...sideBySide[1], x: NaN }],
    [sideBySide[0], { ...sideBySide[1], height: 0 }],
    [{ x: 0, y: 0, width: 500, height: 300 }, { x: 574, y: 400, width: 500, height: 300 }],
    [{ x: 0, y: 0, width: 500, height: 300 }, { x: 574, y: 300, width: 500, height: 300 }],
  ]) assert.equal(h.dualScreenGeometry(segments, 1114, 720), null);
});

test("manual compatibility mode follows rotation, uses the configured gap and suspends when folded", () => {
  const h = helpers();
  assert.deepEqual(plain(h.manualDualScreenSegments(1114, 720, 34)), sideBySide);
  assert.deepEqual(plain(h.manualDualScreenSegments(720, 1114, 34)), stacked);
  for (const [width, height] of [[540, 720], [720, 540], [393, 852], [899, 500], [900, 499], [499, 900], [500, 899]]) {
    assert.deepEqual(plain(h.manualDualScreenSegments(width, height, 34)), []);
  }
  for (const [width, height] of [[900, 500], [500, 900]]) {
    const layout = h.dualScreenGeometry(h.manualDualScreenSegments(width, height, 0), width, height);
    assert.ok(layout);
    assert.equal(layout.axis, width > height ? "horizontal" : "vertical");
  }
  for (const gap of [0, 60, 200]) {
    const pair = h.manualDualScreenSegments(1114, 720, gap);
    assert.equal(pair[1].x - pair[0].width, gap);
    assert.equal(pair[1].x + pair[1].width, 1114);
    const rotated = h.manualDualScreenSegments(720, 1114, gap);
    assert.equal(rotated[1].y - rotated[0].height, gap);
    assert.equal(rotated[1].y + rotated[1].height, 1114);
  }
});

test("automatic detection prioritizes the current API and accepts both earlier APIs", () => {
  const h = helpers({
    window: {
      viewport: { segments: sideBySide },
      visualViewport: { segments: stacked },
      getWindowSegments: () => [],
    },
  });
  assert.deepEqual(plain(h.readViewportSegments()), sideBySide);
  delete h.window.viewport;
  h.window.innerWidth = 720;
  h.window.innerHeight = 1114;
  assert.deepEqual(plain(h.readViewportSegments()), stacked);
  delete h.window.visualViewport;
  h.window.innerWidth = 1114;
  h.window.innerHeight = 720;
  h.window.getWindowSegments = () => sideBySide;
  assert.deepEqual(plain(h.readViewportSegments()), sideBySide);
  h.window.getWindowSegments = () => [sideBySide[0]];
  assert.equal(h.readViewportSegments().length, 1);
  delete h.window.getWindowSegments;
  assert.deepEqual(plain(h.readViewportSegments()), []);
});

test("empty, single-screen or invalid newer APIs do not hide valid older dual-screen boundaries", () => {
  for (const segments of [[], [sideBySide[0]], [sideBySide[0], { ...sideBySide[1], x: 500 }]]) {
    const h = helpers({
      window: { viewport: { segments }, visualViewport: { segments: sideBySide } },
    });
    assert.deepEqual(plain(h.readViewportSegments()), sideBySide);
    h.window.visualViewport.segments = [];
    h.window.getWindowSegments = () => sideBySide;
    assert.deepEqual(plain(h.readViewportSegments()), sideBySide);
  }
});

test("fixed manual arrangements bypass portrait ratios and conservative automatic size thresholds", () => {
  const h = helpers();
  assert.deepEqual(plain(h.manualDualScreenSegments(1114, 460, 34)), []);
  for (const [width, height, arrangement] of [
    [1114, 460, "horizontal"], [720, 1114, "horizontal"], [1114, 720, "vertical"],
    [674, 320, "horizontal"], [320, 674, "vertical"],
  ]) {
    const layout = h.dualScreenGeometry(h.manualDualScreenSegments(width, height, 34, arrangement), width, height);
    assert.equal(layout.axis, arrangement);
    for (const rect of [layout.canvas, layout.controls]) {
      assert.ok(rect.width >= 320 && rect.height >= 320);
    }
  }
  assert.deepEqual(plain(h.manualDualScreenSegments(673, 320, 34, "horizontal")), []);
  assert.deepEqual(plain(h.manualDualScreenSegments(320, 673, 34, "vertical")), []);
  assert.deepEqual(plain(h.manualDualScreenSegments(540, 720, 34)), []);
});

test("settings report actual viewport size, detected asymmetric bounds and inactive compatibility reasons", () => {
  const status = { textContent: "" };
  const h = helpers({ document: { getElementById: () => status } });
  h.dualScreenLayout = h.dualScreenGeometry([
    { x: 0, y: 0, width: 540, height: 720 },
    { x: 574, y: 24, width: 504, height: 696 },
  ], 1078, 720);
  h.window.innerWidth = 1078;
  h.syncDualScreenStatus();
  assert.match(status.textContent, /1078 x 720 CSS px/);
  assert.match(status.textContent, /Side-by-side screens \(detected\)/);
  assert.match(status.textContent, /controls: 504 x 696/);
  h.dualScreenLayout = null;
  h.syncDualScreenStatus();
  assert.match(status.textContent, /No usable dual-screen boundaries/);
  h.state.workspace.dualScreenMode = "manual";
  h.syncDualScreenStatus();
  assert.match(status.textContent, /900 x 500 or 500 x 900/);
  h.state.workspace.dualScreenMode = "manual-horizontal";
  h.syncDualScreenStatus();
  assert.match(status.textContent, /at least 320 CSS px/);
});

test("CSS-only segment detection measures both orientations and removes its probes", () => {
  for (const [horizontal, rects] of [[true, sideBySide], [false, stacked]]) {
    let created = 0;
    let removed = 0;
    const styles = [];
    const h = helpers({
      horizontalSegments: { matches: horizontal },
      verticalSegments: { matches: !horizontal },
      window: { viewport: { segments: [] } },
      document: {
        body: { append() {} },
        createElement() {
          const index = created++;
          return {
            style: {},
            getBoundingClientRect() { styles.push(this.style.cssText); return rects[index]; },
            remove() { removed += 1; },
          };
        },
      },
    });
    assert.deepEqual(plain(h.readViewportSegments()), rects);
    assert.ok(styles[0].includes("viewport-segment-left 0 0"));
    assert.ok(styles[1].includes(`viewport-segment-left ${horizontal ? "1 0" : "0 1"}`));
    assert.equal(created, 2);
    assert.equal(removed, 2);
  }
});

test("wide Duo uses the shared touch workspace; a folded desktop does not inherit it", () => {
  const h = helpers();
  assert.equal(h.usesTouchWorkspace(), false);
  h.dualScreenLayout = h.dualScreenGeometry(sideBySide, 1114, 720);
  assert.equal(h.usesTouchWorkspace(), true);
  h.dualScreenLayout = null;
  assert.equal(h.usesTouchWorkspace(), false);
  h.phoneLayout.matches = true;
  assert.equal(h.usesTouchWorkspace(), true);
});
