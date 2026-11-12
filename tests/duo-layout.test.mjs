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
    window: {},
    ...extra,
  });
  for (const name of ["dualScreenGeometry", "manualDualScreenSegments", "readViewportSegments", "usesTouchWorkspace"]) {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
    assert.ok(match, `Missing application helper: ${name}`);
    vm.runInContext(match[0], context);
  }
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

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

test("unsupported, folded, overlapping, off-viewport or invalid segments do not activate Duo", () => {
  const h = helpers();
  for (const segments of [
    undefined, [], [sideBySide[0]], [...sideBySide, sideBySide[0]],
    [sideBySide[0], { ...sideBySide[1], x: 500 }],
    [sideBySide[0], { ...sideBySide[1], y: 30 }],
    [sideBySide[0], { ...sideBySide[1], width: 900 }],
    [sideBySide[0], { ...sideBySide[1], x: NaN }],
    [sideBySide[0], { ...sideBySide[1], height: 0 }],
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
  assert.deepEqual(plain(h.readViewportSegments()), stacked);
  delete h.window.visualViewport;
  h.window.getWindowSegments = () => sideBySide;
  assert.deepEqual(plain(h.readViewportSegments()), sideBySide);
  h.window.getWindowSegments = () => [sideBySide[0]];
  assert.equal(h.readViewportSegments().length, 1);
  delete h.window.getWindowSegments;
  assert.deepEqual(plain(h.readViewportSegments()), []);
});

test("CSS-only segment detection measures both orientations and removes its probes", () => {
  for (const [horizontal, rects] of [[true, sideBySide], [false, stacked]]) {
    let created = 0;
    let removed = 0;
    const styles = [];
    const h = helpers({
      horizontalSegments: { matches: horizontal },
      verticalSegments: { matches: !horizontal },
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
