// Go Blueprint — VS Code extension host side.
// Builds/runs the gograph analyzer and hosts the blueprint canvas webview.
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** @type {Map<string, Blueprint>} "<root>|full" or "<root>|file" -> panel */
const panels = new Map();
const panelKey = (root, mode) => root + '|' + mode;
let output;
let analyzerPromise = null;

function activate(context) {
  output = vscode.window.createOutputChannel('Go Blueprint');

  context.subscriptions.push(
    output,
    // full module graph (activity bar, command palette)
    vscode.commands.registerCommand('goBlueprint.open', async (arg) => {
      const root = typeof arg === 'string' ? arg : await pickModule(arg);
      if (root) openFull(context, root);
    }),
    // only the code of one file (editor title icon)
    vscode.commands.registerCommand('goBlueprint.openFile', async (uri) => {
      const file = uri && uri.fsPath ? uri.fsPath : activeGoFile();
      if (!file) return vscode.window.showWarningMessage('Go Blueprint: откройте .go файл.');
      const root = findModuleRoot(file);
      if (!root) return vscode.window.showWarningMessage('Go Blueprint: go.mod not found for this file.');
      openFile(context, root, file);
    }),
    // the symbol under the cursor, inside its file's view
    vscode.commands.registerCommand('goBlueprint.showSymbol', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'go') return;
      const root = findModuleRoot(ed.document.uri.fsPath);
      if (!root) return vscode.window.showWarningMessage('Go Blueprint: go.mod not found for this file.');
      openFile(context, root, ed.document.uri.fsPath, ed.selection.active.line + 1);
    }),
    vscode.commands.registerCommand('goBlueprint.addProtoPath', async () => {
      const root = await pickModule();
      if (root) await addPath(root, 'proto'); // the config change triggers a refresh
    }),
    vscode.commands.registerCommand('goBlueprint.addExtraPackage', async () => {
      const root = await pickModule();
      if (root) await addPath(root, 'gen');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('goBlueprint.protoPaths') && !e.affectsConfiguration('goBlueprint.extraPackages') &&
        !e.affectsConfiguration('goBlueprint.includeTests') && !e.affectsConfiguration('goBlueprint.includeGenerated')) return;
      for (const bp of panels.values()) bp.scheduleRefresh();
    }),
    vscode.commands.registerCommand('goBlueprint.rebuildAnalyzer', async () => {
      analyzerPromise = null;
      await ensureAnalyzer(context, true);
      vscode.window.showInformationMessage('Go Blueprint: analyzer rebuilt.');
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'go') return;
      if (!vscode.workspace.getConfiguration('goBlueprint').get('refreshOnSave')) return;
      for (const bp of panels.values()) {
        if (doc.uri.fsPath.startsWith(bp.root + path.sep)) bp.scheduleRefresh();
      }
    }),
  );
  registerSidebar(context);
}

function activeGoFile() {
  const ed = vscode.window.activeTextEditor;
  return ed && ed.document.languageId === 'go' && ed.document.uri.scheme === 'file' ? ed.document.uri.fsPath : null;
}

// ---------------------------------------------------------------- activity bar

// A module with no .go files of its own (e.g. a folder of .proto files with a go.mod).
function hasGoFiles(root) {
  const skip = new Set(['node_modules', 'vendor', '.git', 'testdata']);
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < 4000) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      if (e.isFile() && e.name.endsWith('.go')) return true;
      if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) {
        // a nested go.mod is another module
        if (!fs.existsSync(path.join(dir, e.name, 'go.mod'))) stack.push(path.join(dir, e.name));
      }
    }
  }
  return false;
}

async function listModules() {
  const mods = await vscode.workspace.findFiles('**/go.mod', '{**/node_modules/**,**/vendor/**}', 50);
  return mods.map((m) => {
    const root = path.dirname(m.fsPath);
    let name = path.basename(root);
    try {
      const mm = /^module\s+(\S+)/m.exec(fs.readFileSync(m.fsPath, 'utf8'));
      if (mm) name = mm[1];
    } catch { /* keep folder name */ }
    return { root, name, go: hasGoFiles(root) };
  }).sort((a, b) => (b.go - a.go) || a.root.localeCompare(b.root));
}

// The module to open from the activity bar: the active file's, else the only one.
async function defaultModule() {
  const f = activeGoFile();
  if (f && findModuleRoot(f)) return findModuleRoot(f);
  for (const bp of panels.values()) if (bp.mode === 'full') return bp.root;
  const mods = await listModules();
  const withGo = mods.filter((m) => m.go);
  if (withGo.length === 1) return withGo[0].root;
  return mods.length === 1 ? mods[0].root : null;
}

class ModulesTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  async getChildren() {
    const items = [];
    for (const m of await listModules()) {
      const it = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
      it.description = vscode.workspace.asRelativePath(m.root) + (m.go ? '' : ' · только .proto');
      it.tooltip = m.go
        ? `Полный граф модуля ${m.name}\n${m.root}`
        : `В модуле ${m.name} нет Go-кода — граф строится из .proto (сервисы, RPC, сообщения) без обработчиков.\n${m.root}`;
      it.iconPath = new vscode.ThemeIcon(panels.has(panelKey(m.root, 'full')) ? 'eye' : 'type-hierarchy');
      it.command = { command: 'goBlueprint.open', title: 'Открыть граф', arguments: [m.root] };
      items.push(it);
    }
    const f = activeGoFile();
    if (f) {
      const it = new vscode.TreeItem('Граф текущего файла', vscode.TreeItemCollapsibleState.None);
      it.description = path.basename(f);
      it.iconPath = new vscode.ThemeIcon('file-code');
      it.command = { command: 'goBlueprint.openFile', title: 'Граф файла', arguments: [vscode.Uri.file(f)] };
      items.push(it);
    }
    return items;
  }
}

let modulesTree;
function registerSidebar(context) {
  modulesTree = new ModulesTree();
  const view = vscode.window.createTreeView('goBlueprint.modules', { treeDataProvider: modulesTree });
  context.subscriptions.push(
    view,
    // clicking the activity bar icon opens the full graph, or brings its tab forward
    view.onDidChangeVisibility(async (e) => {
      if (!e.visible) return;
      const root = await defaultModule();
      if (root) openFull(context, root);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => modulesTree.refresh()),
  );
}

function deactivate() {}

// ---------------------------------------------------------------- go / analyzer

function goBinary() {
  const configured = vscode.workspace.getConfiguration('goBlueprint').get('goPath');
  if (configured) return configured;
  const exe = process.platform === 'win32' ? 'go.exe' : 'go';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const extra = process.platform === 'win32'
    ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Go', 'bin'),
      'C:\\Go\\bin',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Go', 'bin'),
      path.join(home, 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin',
    ]
    : ['/usr/local/go/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/lib/go/bin', path.join(home, 'go', 'bin')];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean).concat(extra);
  for (const d of dirs) {
    const p = path.join(d, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return exe;
}

function goEnv() {
  const go = goBinary();
  const env = { ...process.env };
  if (path.isAbsolute(go)) env.PATH = path.dirname(go) + path.delimiter + (env.PATH || '');
  return env;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { maxBuffer: 512 * 1024 * 1024, env: goEnv(), ...opts }, (err, stdout, stderr) => {
      if (stderr) output.append(stderr);
      if (err) {
        err.message += stderr ? '\n' + stderr : '';
        reject(err);
      } else resolve(stdout);
    });
  });
}

function ensureAnalyzer(context, force) {
  if (analyzerPromise && !force) return analyzerPromise;
  analyzerPromise = (async () => {
    const src = path.join(context.extensionPath, 'analyzer');
    const hash = crypto.createHash('sha1');
    const files = fs.readdirSync(src).filter((f) => f.endsWith('.go')).sort()
      .concat(['go.mod', 'go.sum', 'vendor/modules.txt']);
    for (const f of files) {
      try { hash.update(f); hash.update(fs.readFileSync(path.join(src, f))); } catch { /* optional */ }
    }
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, 'gograph-' + hash.digest('hex').slice(0, 10) + (process.platform === 'win32' ? '.exe' : ''));
    if (!force && fs.existsSync(bin)) return bin;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Go Blueprint: building analyzer…' },
      // deps are vendored, so the build works offline; GOTOOLCHAIN=auto lets an
      // older local Go fetch the toolchain go.mod asks for when online
      () => run(goBinary(), ['build', '-mod=vendor', '-o', bin, '.'], {
        cwd: src, env: { ...goEnv(), GOFLAGS: '', CGO_ENABLED: '0', GOTOOLCHAIN: process.env.GOTOOLCHAIN || 'auto' },
      }),
    );
    return bin;
  })();
  analyzerPromise.catch(() => { analyzerPromise = null; });
  return analyzerPromise;
}

async function analyze(context, root) {
  const bin = await ensureAnalyzer(context);
  const cfg = vscode.workspace.getConfiguration('goBlueprint');
  const args = ['-dir', root];
  if (cfg.get('includeTests')) args.push('-tests');
  if (cfg.get('includeGenerated')) args.push('-generated');
  for (const p of cfg.get('protoPaths') || []) args.push('-proto', p);
  for (const p of cfg.get('extraPackages') || []) args.push('-pkgs', p);
  const t0 = Date.now();
  const out = await run(bin, args, { cwd: root });
  output.appendLine(`[${new Date().toLocaleTimeString()}] analyzed ${root} in ${Date.now() - t0} ms`);
  return JSON.parse(out);
}

// ---------------------------------------------------------------- proto / generated code paths

const PATH_KEYS = { proto: 'protoPaths', gen: 'extraPackages' };

// Stored relative to the module root when inside it, so settings stay portable.
function storePath(root, abs) {
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? (rel || '.').split(path.sep).join('/') : abs;
}

async function updatePaths(key, fn) {
  const cfg = vscode.workspace.getConfiguration('goBlueprint');
  const next = fn([...(cfg.get(key) || [])]);
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg.update(key, next, target);
}

async function addPath(root, which) {
  const key = PATH_KEYS[which];
  let value;
  if (which === 'proto') {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      defaultUri: vscode.Uri.file(root), openLabel: 'Искать .proto здесь',
    });
    if (!picked) return false;
    value = storePath(root, picked[0].fsPath);
  } else {
    const how = await vscode.window.showQuickPick([
      { label: '$(folder) Выбрать папку…', id: 'dir', detail: 'Папка со сгенерированным кодом (*.pb.go, *_grpc.pb.go) в другом Go-модуле' },
      { label: '$(package) Ввести import path…', id: 'path', detail: 'Например github.com/org/api/gen/go/... (модуль должен быть в go.mod)' },
    ], { placeHolder: 'Где лежит сгенерированный gRPC-код?' });
    if (!how) return false;
    if (how.id === 'dir') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        defaultUri: vscode.Uri.file(path.dirname(root)), openLabel: 'Использовать эту папку',
      });
      if (!picked) return false;
      value = storePath(root, picked[0].fsPath);
    } else {
      value = await vscode.window.showInputBox({ prompt: 'Import path или шаблон пакетов', placeHolder: 'github.com/org/api/gen/go/...' });
      if (!value) return false;
      value = value.trim();
    }
  }
  await updatePaths(key, (list) => (list.includes(value) ? list : [...list, value]));
  return true;
}

// ---------------------------------------------------------------- modules

function findModuleRoot(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'go.mod'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function toRel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function pickModule(uri) {
  if (uri && uri.fsPath) {
    const r = findModuleRoot(uri.fsPath);
    if (r) return r;
  }
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') {
    const r = findModuleRoot(ed.document.uri.fsPath);
    if (r) return r;
  }
  const mods = await vscode.workspace.findFiles('**/go.mod', '{**/node_modules/**,**/vendor/**}', 50);
  if (mods.length === 0) {
    vscode.window.showWarningMessage('Go Blueprint: no go.mod found in the workspace.');
    return null;
  }
  if (mods.length === 1) return path.dirname(mods[0].fsPath);
  const pick = await vscode.window.showQuickPick(
    (await listModules()).map((m) => ({
      label: m.name, description: vscode.workspace.asRelativePath(m.root) + (m.go ? '' : ' · только .proto'), root: m.root,
    })),
    { placeHolder: 'Какой Go-модуль открыть?' },
  );
  return pick && pick.root;
}

// ---------------------------------------------------------------- panel

async function openFull(context, root) {
  const key = panelKey(root, 'full');
  let bp = panels.get(key);
  if (bp) {
    bp.panel.reveal();
    return bp;
  }
  bp = new Blueprint(context, root, 'full');
  panels.set(key, bp);
  if (modulesTree) modulesTree.refresh();
  await bp.ready;
  return bp;
}

// One file view per module: opening another file re-targets it.
async function openFile(context, root, absFile, line) {
  const key = panelKey(root, 'file');
  const file = toRel(root, absFile);
  let bp = panels.get(key);
  if (!bp) {
    bp = new Blueprint(context, root, 'file', file, line);
    panels.set(key, bp);
    await bp.ready;
    return bp;
  }
  bp.setFile(file);
  bp.panel.reveal();
  bp.post({ type: 'scope', file, line });
  return bp;
}

class Blueprint {
  constructor(context, root, mode, file, line) {
    this.context = context;
    this.root = root;
    this.mode = mode;
    this.file = file;
    this.line = line;
    this.refreshTimer = null;
    this.panel = vscode.window.createWebviewPanel(
      mode === 'full' ? 'goBlueprint' : 'goBlueprintFile',
      this.title(),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
      },
    );
    this.panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.svg'));
    this.panel.webview.html = this.html();
    this.queue = [];
    this.isReady = false;
    this.ready = new Promise((res) => { this.resolveReady = res; });
    this.panel.onDidDispose(() => {
      panels.delete(panelKey(root, mode));
      if (modulesTree) modulesTree.refresh();
    });
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  title() {
    return this.mode === 'full' ? 'Blueprint: ' + path.basename(this.root) : 'Blueprint: ' + path.basename(this.file);
  }

  setFile(file) {
    this.file = file;
    this.panel.title = this.title();
  }

  post(msg) {
    if (this.isReady) this.panel.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.isReady = true;
        await this.refresh(true);
        for (const q of this.queue.splice(0)) this.panel.webview.postMessage(q);
        this.resolveReady();
        break;
      case 'refresh':
        await this.refresh(false);
        break;
      case 'open':
        await this.openSource(m.file, m.line);
        break;
      case 'addPath':
        await addPath(this.root, m.which); // the config change triggers a refresh
        break;
      case 'removePath':
        await updatePaths(PATH_KEYS[m.which], (list) => list.filter((v) => v !== m.value));
        break;
      case 'openFull':
        await openFull(this.context, this.root);
        break;
      case 'settings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'goBlueprint');
        break;
      case 'source':
        this.panel.webview.postMessage({ type: 'source', key: m.key, ...this.readSource(m.file, m.line, m.endLine) });
        break;
    }
  }

  // Lines [line, endLine] of a module file; prefers an open (possibly unsaved) editor buffer.
  readSource(file, line, endLine) {
    const MAX = 400;
    const abs = path.resolve(this.root, file || '');
    // module files, plus .proto / generated .go files that may live elsewhere
    if (!abs.startsWith(this.root + path.sep) && !['.proto', '.go'].includes(path.extname(abs))) return { error: 'outside module' };
    try {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
      const lines = (open ? open.getText() : fs.readFileSync(abs, 'utf8')).split(/\r?\n/);
      const from = Math.max(1, line || 1);
      const to = Math.min(lines.length, Math.max(from, endLine || from));
      return { start: from, total: to - from + 1, text: lines.slice(from - 1, Math.min(to, from - 1 + MAX)).join('\n') };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(false), 800);
  }

  async refresh(initial) {
    this.panel.webview.postMessage({ type: 'busy', text: 'Analyzing…' });
    try {
      const graph = await analyze(this.context, this.root);
      const ed = vscode.window.activeTextEditor;
      const activeFile = ed && ed.document.uri.fsPath.startsWith(this.root + path.sep)
        ? toRel(this.root, ed.document.uri.fsPath) : null;
      const cfg = vscode.workspace.getConfiguration('goBlueprint');
      const config = { protoPaths: cfg.get('protoPaths') || [], extraPackages: cfg.get('extraPackages') || [] };
      const scope = { mode: this.mode, file: this.file, line: initial ? this.line : undefined };
      this.panel.webview.postMessage({ type: 'graph', graph, initial, activeFile, config, scope });
    } catch (e) {
      output.appendLine(String(e.message || e));
      this.panel.webview.postMessage({ type: 'error', text: String(e.message || e) });
    }
  }

  async openSource(file, line) {
    const uri = vscode.Uri.file(path.join(this.root, file));
    const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
    const col = this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    const ed = await vscode.window.showTextDocument(uri, { viewColumn: col, selection: new vscode.Range(pos, pos) });
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  html() {
    const w = this.panel.webview;
    const media = (f) => w.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', f)));
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}' ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('blueprint.css')}">
<title>Go Blueprint</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media('elk.bundled.js')}"></script>
<script nonce="${nonce}" src="${media('tips.js')}"></script>
<script nonce="${nonce}" src="${media('simulation.js')}"></script>
<script nonce="${nonce}" src="${media('blueprint.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { activate, deactivate };
