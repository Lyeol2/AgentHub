import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function source(name) {
  const found = app.match(new RegExp("^(?:async )?function " + name + "\\(", "m"));
  assert.ok(found, name);
  return app.slice(found.index, app.indexOf("\n}", found.index) + 2);
}
function listener(id, event) {
  const start = app.indexOf('$("' + id + '").addEventListener("' + event + '",');
  assert.ok(start >= 0, id + " " + event);
  return app.slice(start, app.indexOf(event === "wheel" ? "}, { passive: false });" : "\n});", start) + (event === "wheel" ? 23 : 4));
}
function element() {
  const classes = new Set();
  return {
    style: {}, value: "", open: false, children: [], handlers: {}, isConnected: true,
    clientWidth: 600, clientHeight: 300, scrollLeft: 0, scrollTop: 0,
    classList: { add: (n) => classes.add(n), remove: (n) => classes.delete(n), contains: (n) => classes.has(n), toggle: (n, on) => on ? classes.add(n) : classes.delete(n) },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    append(child) { this.children.push(child); },
    remove() { this.removed = true; },
    focus() { this.focused = true; },
    close() { this.open = false; this.handlers.close?.(); },
    getBoundingClientRect() { return { left: 100, top: 50 }; },
  };
}
function setup(names = []) {
  const elements = new Map();
  const calls = [];
  const events = new Map();
  const state = { view: "project", project: "C:/repo", sessions: [], commands: [], commandsProject: "C:/repo", links: [], graphSelected: new Set() };
  const get = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const context = vm.createContext({
    state, console, Set, Map, Math, Promise,
    $: get,
    samePath: (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(),
    sessionById: (id) => state.sessions.find((s) => s.id === id),
    commandById: (id) => state.commands.find((s) => s.id === id),
    isCommandNode: (id) => id.startsWith("cmd-"),
    nodeSize: () => ({ w: 80, h: 50 }),
    ZOOM_MIN: 0.3, ZOOM_MAX: 2, PAD: 20,
    saveGraphZoom: () => {}, renderZoomLabel: () => {},
    closeContextMenu: () => calls.push(["closeMenu"]),
    openSessionWindow: () => { throw Error("middle click opened a session"); },
    confirm: (message) => { calls.push(["confirm", message]); return true; },
    alert: (message) => calls.push(["alert", message]),
    api: async (...args) => { calls.push(args); return { id: "created" }; },
    loadSessions: async () => calls.push(["loadSessions"]),
    loadCommands: async () => calls.push(["loadCommands"]),
    loadProjects: async () => calls.push(["loadProjects"]),
    loadLinks: async () => calls.push(["loadLinks"]),
    defaultLinkCondition: () => ({ when: "success", keyword: "" }),
    el: () => element(),
    window: {
      addEventListener: (type, fn) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
      removeEventListener: (type, fn) => events.get(type)?.delete(fn),
    },
    document: { querySelector: () => null },
  });
  for (const name of names) vm.runInContext(source(name), context);
  return { state, calls, events, get, context, run: (code) => vm.runInContext(code, context), emit: (type, event = {}) => [...(events.get(type) ?? [])].forEach((fn) => fn(event)) };
}
function graph(h) {
  h.state.graph = { canvas: element(), sizer: element(), cards: new Map(), pos: new Map(), size: { width: 350, height: 180 }, zoom: 1, pan: { x: 40, y: -20 } };
  return h.state.graph;
}

test("graph: ordinary wheel zoom keeps the point under the cursor fixed after panning", () => {
  const h = setup(["applyGraphZoom", "setGraphZoom"]);
  const g = graph(h);
  h.run(listener("p-graph", "wheel"));
  let prevented = false;
  h.get("p-graph").handlers.wheel({ deltaY: -120, deltaMode: 0, clientX: 330, clientY: 180, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(g.zoom, 1.2);
  assert.equal(190 * g.zoom + g.pan.x, 230);
  assert.equal(150 * g.zoom + g.pan.y, 130);
  assert.equal(g.canvas.style.left, "2px");
  g.dragging = true;
  h.get("p-graph").handlers.wheel({ deltaY: 100, preventDefault() {} });
  assert.equal(g.zoom, 1.2);
});

test("graph: middle drag pans a small canvas both ways and pointer cancellation removes listeners", () => {
  const h = setup(["applyGraphZoom", "trackGraphGesture", "startGraphPan", "onGraphPointerDown"]);
  const g = graph(h);
  h.run('onGraphPointerDown({ button: 1, pointerId: 7, clientX: 150, clientY: 100, preventDefault() {} })');
  h.emit("pointermove", { pointerId: 8, clientX: 500, clientY: 500 });
  assert.equal(g.pan.x, 40);
  h.emit("pointermove", { pointerId: 7, clientX: 250, clientY: 150 });
  assert.equal(g.pan.x, 140);
  assert.equal(g.pan.y, 30);
  h.emit("pointermove", { pointerId: 7, clientX: 50, clientY: 10 });
  assert.equal(g.pan.x, -60);
  assert.equal(g.pan.y, -110);
  h.emit("pointercancel", { pointerId: 7 });
  assert.equal(g.dragging, false);
  assert.equal(h.get("p-graph").classList.contains("panning"), false);
  assert.equal(h.state.graphGesture, null);
  for (const handlers of h.events.values()) assert.equal(handlers.size, 0);
});

test("graph: drag selection supports a mixed group and blur restores the preceding selection", () => {
  const h = setup(["canvasPoint", "trackGraphGesture", "syncGraphSelection", "startBoxSelect"]);
  const g = graph(h);
  g.pan = { x: 0, y: 0 };
  for (const [id, pos] of [["session", { x: 10, y: 10 }], ["cmd-a", { x: 110, y: 10 }], ["far", { x: 400, y: 10 }]]) {
    g.pos.set(id, pos);
    g.cards.set(id, element());
  }
  h.run('startBoxSelect({ pointerId: 1, clientX: 100, clientY: 50, preventDefault() {} })');
  h.emit("pointermove", { pointerId: 1, clientX: 310, clientY: 140 });
  assert.deepEqual([...h.state.graphSelected], ["session", "cmd-a"]);
  h.emit("pointerup", { pointerId: 1 });
  assert.equal(g.dragging, false);
  h.run('startBoxSelect({ pointerId: 2, clientX: 490, clientY: 50, preventDefault() {} })');
  h.emit("pointermove", { pointerId: 2, clientX: 600, clientY: 140 });
  assert.deepEqual([...h.state.graphSelected], ["far"]);
  h.emit("blur");
  assert.deepEqual([...h.state.graphSelected], ["session", "cmd-a"]);
  assert.equal(g.canvas.children.at(-1).removed, true);
});

test("graph: Delete removes selected sessions and commands with one confirmation and leaves failed nodes selected", async () => {
  const h = setup(["syncGraphSelection", "deleteGraphSelection"]);
  const g = graph(h);
  h.state.sessions = [{ id: "s1", title: "session", state: "running", projectPath: "C:/repo" }, { id: "other", projectPath: "C:/else" }];
  h.state.commands = [{ id: "cmd-a", title: "command" }];
  h.state.graphSelected = new Set(["s1", "cmd-a", "other"]);
  for (const id of ["s1", "cmd-a", "other"]) g.cards.set(id, element());
  h.context.api = async (...args) => { h.calls.push(args); if (args[1] === "/api/commands/cmd-a") throw Error("locked"); return {}; };
  await h.run("deleteGraphSelection()");
  assert.equal(h.calls.filter((c) => c[0] === "confirm").length, 1);
  assert.match(h.calls.find((c) => c[0] === "confirm")[1], /실행 중인 1개/);
  assert.deepEqual(h.calls.filter((c) => c[0] === "DELETE").map((c) => c[1]), ["/api/sessions/s1?force=1", "/api/commands/cmd-a"]);
  assert.deepEqual([...h.state.graphSelected], ["cmd-a", "other"]);
  assert.match(h.calls.find((c) => c[0] === "alert")[1], /locked/);
  assert.equal(h.state.deletingGraphNodes, false);
});

test("graph: Delete ignores editors, open dialogs, and repeated keys", () => {
  const h = setup();
  let deleted = 0;
  h.context.deleteGraphSelection = () => deleted++;
  h.state.graphSelected.add("s1");
  h.run(listener("p-graph", "keydown"));
  const handler = h.get("p-graph").handlers.keydown;
  const event = (editable = false) => ({ key: "Delete", target: { closest: () => editable }, preventDefault() {} });
  handler(event(true));
  handler({ ...event(), repeat: true });
  h.context.document.querySelector = () => ({});
  handler(event());
  assert.equal(deleted, 0);
  h.context.document.querySelector = () => null;
  handler(event());
  assert.equal(deleted, 1);
});

test("graph: auto-connect uses the source defaults and rejects canceled, missing, or cross-project sources", async () => {
  const h = setup(["connectCreatedGraphNode"]);
  h.state.sessions = [{ id: "from", projectPath: "C:/repo" }];
  h.context.context = { projectPath: "C:/repo", connectFrom: "from" };
  await h.run('connectCreatedGraphNode(context, "new", "C:/repo")');
  const link = h.calls.find((c) => c[0] === "POST");
  assert.equal(link[1], "/api/links");
  assert.equal(link[2].from, "from");
  assert.equal(link[2].to, "new");
  assert.equal(link[2].when, "success");
  h.calls.length = 0;
  h.context.context.cancelled = true;
  await h.run('connectCreatedGraphNode(context, "new", "C:/repo")');
  h.context.context.cancelled = false;
  await h.run('connectCreatedGraphNode(context, "new", "C:/other")');
  h.state.project = "C:/other";
  await h.run('connectCreatedGraphNode(context, "new", "C:/repo")');
  h.state.project = "C:/repo";
  h.state.sessions = [];
  await h.run('connectCreatedGraphNode(context, "new", "C:/repo")');
  assert.equal(h.calls.length, 0);
});

test("graph: a link failure reports the created node without rejecting or retrying creation", async () => {
  const h = setup(["connectCreatedGraphNode"]);
  h.state.sessions = [{ id: "from", projectPath: "C:/repo" }];
  h.context.api = async () => { throw Error("offline"); };
  await h.run('connectCreatedGraphNode({ projectPath: "C:/repo", connectFrom: "from" }, "new", "C:/repo")');
  assert.match(h.calls.find((c) => c[0] === "alert")[1], /노드는 만들었지만.*offline/s);
});

test("graph: view changes invalidate creation contexts, close dialogs, and clear selection", () => {
  const h = setup(["clearGraphTransientState"]);
  const session = { connectFrom: "from" };
  const command = { connectFrom: "cmd-from" };
  h.state.newSessionContext = session;
  h.state.editingCommand = command;
  h.get("new-dialog").open = true;
  h.get("command-dialog").open = true;
  h.state.graphSelected.add("from");
  h.run("clearGraphTransientState()");
  assert.equal(session.cancelled, true);
  assert.equal(command.cancelled, true);
  assert.equal(h.state.newSessionContext, null);
  assert.equal(h.state.editingCommand, null);
  assert.equal(h.get("new-dialog").open, false);
  assert.equal(h.get("command-dialog").open, false);
  assert.equal(h.state.graphSelected.size, 0);
});

function sessionForm(h) {
  h.context.newKind = () => ({ agent: "codex", chat: false });
  h.context.FormData = class extends Map { constructor(form) { super(form.fields); } };
  h.run(listener("new-form", "submit"));
  return { submitter: { value: "ok" }, target: { fields: [["projectPath", "C:/repo"]], reset() {} }, preventDefault() {} };
}

test("graph: new sessions preserve drop position and create their outgoing source link immediately", async () => {
  const h = setup(["connectCreatedGraphNode"]);
  h.state.sessions = [{ id: "from", projectPath: "C:/repo" }];
  const context = { projectPath: "C:/repo", pos: { x: 120, y: 160 }, connectFrom: "from" };
  h.state.newSessionContext = context;
  const event = sessionForm(h);
  await h.get("new-form").handlers.submit(event);
  const created = h.calls.filter((c) => ["POST", "PUT"].includes(c[0]));
  assert.deepEqual(created.map((c) => c[1]), ["/api/sessions", "/api/sessions/created", "/api/links"]);
  assert.equal(created[1][2].graphPos, context.pos);
  assert.equal(created[2][2].to, "created");
  assert.equal(h.state.newSessionContext, null);
});


test("graph: canceled creation does not connect a later session, while API failures stay in their own dialog", async () => {
  const h = setup(["connectCreatedGraphNode"]);
  h.state.sessions = [{ id: "from", projectPath: "C:/repo" }];
  const oldContext = { projectPath: "C:/repo", pos: { x: 10, y: 20 }, connectFrom: "from" };
  h.state.newSessionContext = oldContext;
  const event = sessionForm(h);
  h.context.api = async () => { throw Error("create failed"); };
  await h.get("new-form").handlers.submit(event);
  assert.equal(h.get("new-error").textContent, "create failed");
  assert.equal(h.state.newSessionContext, oldContext);
  h.run(listener("new-dialog", "close"));
  h.get("new-dialog").close();
  assert.equal(oldContext.cancelled, true);
  assert.equal(h.state.newSessionContext, null);
  h.state.newSessionContext = { projectPath: "C:/repo", pos: null };
  h.context.api = async (...args) => { h.calls.push(args); return { id: "next" }; };
  await h.get("new-form").handlers.submit(event);
  assert.deepEqual(h.calls.filter((c) => c[0] === "POST").map((c) => c[1]), ["/api/sessions"]);
});

test("graph: creating a command after a handle drop immediately connects it and clears the dialog context", async () => {
  const h = setup(["connectCreatedGraphNode"]);
  h.state.commands = [{ id: "cmd-from", projectPath: "C:/repo" }];
  const context = { id: null, projectPath: "C:/repo", pos: { x: 150, y: 210 }, connectFrom: "cmd-from" };
  h.state.editingCommand = context;
  h.get("command-title").value = "New command";
  h.get("command-text").value = "echo hello";
  h.get("command-timeout").value = "600";
  h.run(listener("command-form", "submit"));
  await h.get("command-form").handlers.submit({ submitter: { value: "ok" }, preventDefault() {} });
  const created = h.calls.filter((c) => c[0] === "POST");
  assert.deepEqual(created.map((c) => c[1]), ["/api/commands", "/api/links"]);
  assert.equal(created[0][2].pos, context.pos);
  assert.equal(created[1][2].from, "cmd-from");
  assert.equal(created[1][2].to, "created");
  assert.equal(h.state.editingCommand, null);
});
