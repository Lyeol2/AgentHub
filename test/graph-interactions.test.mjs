import test from "node:test";
import assert from "node:assert/strict";
import { createGraphController } from "../public/features/graph/controller.js";
import { layoutGraph, edgePath, CARD_SIZE, CMD_SIZE } from "../public/features/graph/model.js";

function setup() {
  const nodes = new Map(), calls = [], alerts = [];
  globalThis.document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, open: false, value: "" });
      return nodes.get(id);
    },
    querySelector: () => null,
    addEventListener() {},
  };
  globalThis.alert = (text) => alerts.push(text);
  const data = { sessions: [{ id: "from", projectPath: "C:/repo", role: '마지막 줄에 "통과" 또는 "수정"을 쓴다.' }], commands: [], commandsProject: "C:/repo", links: [] };
  const navigation = { view: "project", project: "C:/repo" };
  const controller = createGraphController({
    data, navigation,
    sessionById: (id) => data.sessions.find((session) => session.id === id),
    commandById: (id) => data.commands.find((command) => command.id === id),
    api: async (...args) => { calls.push(args); if (args[0] === "GET") throw Error("fixture refresh unavailable"); return {}; },
    cancelNodeCreation: () => calls.push(["cancelCreation"]),
  });
  return { data, navigation, controller, calls, alerts };
}

test("graph: auto-connect uses unused source keywords and permits same-project command sources", async () => {
  const h = setup();
  h.data.links.push({ from: "from", when: "keyword", keyword: "통과" });
  await h.controller.connectCreatedGraphNode({ projectPath: "C:/repo", connectFrom: "from" }, "new", "C:/repo");
  assert.deepEqual(h.calls[0], ["POST", "/api/links", { from: "from", to: "new", when: "keyword", keyword: "수정", enabled: true }]);
  h.calls.length = 0;
  h.data.commands.push({ id: "cmd-from", projectPath: "C:/repo" });
  await h.controller.connectCreatedGraphNode({ projectPath: "C:/repo", connectFrom: "cmd-from" }, "new", "C:/repo");
  assert.equal(h.calls[0][2].when, "success");
});

test("graph: auto-connect rejects canceled, missing, stale, and cross-project sources", async () => {
  const h = setup();
  const context = { projectPath: "C:/repo", connectFrom: "from" };
  await h.controller.connectCreatedGraphNode({ ...context, cancelled: true }, "new", "C:/repo");
  await h.controller.connectCreatedGraphNode(context, "new", "C:/other");
  h.navigation.project = "C:/other";
  await h.controller.connectCreatedGraphNode(context, "new", "C:/repo");
  h.navigation.project = "C:/repo";
  h.navigation.view = "session";
  await h.controller.connectCreatedGraphNode(context, "new", "C:/repo");
  h.navigation.view = "project"; h.data.sessions = [];
  await h.controller.connectCreatedGraphNode(context, "new", "C:/repo");
  h.data.commands.push({ id: "cmd-from", projectPath: "C:/other" });
  await h.controller.connectCreatedGraphNode({ ...context, connectFrom: "cmd-from" }, "new", "C:/repo");
  assert.equal(h.calls.length, 0);
});

test("graph: changing views cancels pending node creation through its controller", () => {
  const h = setup();
  h.controller.clearGraphTransientState();
  assert.deepEqual(h.calls, [["cancelCreation"]]);
});

test("graph: layout handles cycles, command nodes, and persisted positions", () => {
  const sessions = [{ id: "a" }, { id: "cmd-b" }, { id: "c", graphPos: { x: 900, y: 700 } }];
  const positions = layoutGraph(sessions, [{ from: "a", to: "cmd-b" }, { from: "cmd-b", to: "c" }, { from: "c", to: "a" }]);
  assert.ok(positions.get("cmd-b").x > positions.get("a").x);
  assert.deepEqual(positions.get("c"), { x: 900, y: 700 });
  const command = layoutGraph([{ id: "cmd-a", pos: { x: 44, y: 88 } }], []);
  assert.deepEqual(command.get("cmd-a"), { x: 44, y: 88 });
});

test("graph: edges attach to the different card heights and route backward links below the cards", () => {
  const forward = edgePath({ x: 20, y: 30 }, { x: 400, y: 40 }, CARD_SIZE, CMD_SIZE);
  assert.ok(forward.d.startsWith("M250,94"));
  assert.ok(forward.d.endsWith("400,94"));
  const backward = edgePath({ x: 400, y: 50 }, { x: 20, y: 30 }, CMD_SIZE, CARD_SIZE);
  assert.ok(backward.mid.y > Math.max(50 + CMD_SIZE.h, 30 + CARD_SIZE.h));
});
