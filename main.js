'use strict';

/* ------------------------------------------------------------------ *
 *  Pi Harness — desktop client for the free-pi / Pi coding agent.
 *
 *  No API keys, no base URLs typed by the user. Everything runs through
 *  one long-lived `--mode rpc` agent process driven over JSONL, plus the
 *  free-pi account API for the daily allowance and the sponsored banner.
 * ------------------------------------------------------------------ */

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, spawnSync, exec } = require('child_process');

const APP_TITLE = 'Pi Harness';
const IS_WIN = process.platform === 'win32';

const DEFAULT_MODEL = process.env.PI_HARNESS_MODEL || 'deepseek-v4-flash';
const FREEPI_BASE_URL = (process.env.FREEPI_BASE_URL || 'https://api.freepi.ai').replace(/\/+$/, '');
const FREEPI_WEB = 'https://freepi.ai';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_FILES = 4000;
const MAX_DEPTH = 8;
const MAX_TOOL_OUTPUT = 20000;
const MAX_LOG_LINES = 400;
const RPC_TIMEOUT = 120000;
const START_TIMEOUT = 45000;

const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  '.cache', '.turbo', 'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
  '.harness', 'target', 'bin', 'obj', '.gradle', '.mypy_cache', '.pytest_cache',
  '.pi-harness'
]);

let win = null;
let isQuitting = false;
let projectRoot = null;
let nodeRuntime = { bin: '', version: '', ok: false };
let piBundlePath = null;
let piClientVersion = '0.6.25';
let sessionsCache = [];

/* ------------------------------------------------------------- utilities */

function emit(type, payload) {
  if (win && !win.isDestroyed()) {
    const body = Object.assign({ type }, payload || {});
    if (body.key === undefined) body.key = activeEngineKey;
    win.webContents.send('run:event', body);
  }
}

function notice(text, level) {
  emit('notice', { text: String(text || ''), level: level || 'info' });
}

function stripAnsi(text) {
  return String(text == null ? '' : text)
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n… [' + (s.length - max) + ' more characters]';
}

function safeBasename(p) {
  try {
    return path.basename(p);
  } catch {
    return p;
  }
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function relativize(abs) {
  if (!projectRoot) return abs;
  const rel = path.relative(projectRoot, abs);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : abs;
}

function resolveInProject(input) {
  const raw = String(input || '').trim();
  if (!projectRoot) throw new Error('Open a project folder first.');
  const abs = path.resolve(projectRoot, raw);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes the project folder: ' + raw);
  }
  return abs;
}

function readTextSafe(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- free-pi state */

function freePiCredentialsPath() {
  return path.join(os.homedir(), '.free-pi', 'agent', 'credentials.json');
}

function readFreePiToken() {
  try {
    const data = JSON.parse(fs.readFileSync(freePiCredentialsPath(), 'utf8'));
    return typeof data.token === 'string' && data.token.length > 10 ? data.token : '';
  } catch {
    return '';
  }
}

function harnessAgentDir() {
  return path.join(app.getPath('userData'), 'agent');
}

function piSessionDir() {
  return path.join(app.getPath('userData'), 'pi-sessions');
}

function shotsDir() {
  return path.join(os.tmpdir(), 'pi-harness-shots');
}

function findFreePiInstall() {
  const candidates = [];
  const push = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  if (process.env.FREE_PI_CLI_ROOT) push(process.env.FREE_PI_CLI_ROOT);
  push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'free-pi-cli'));
  push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'free-pi-cli'));
  if (process.env.PREFIX) push(path.join(process.env.PREFIX, 'lib', 'node_modules', 'free-pi-cli'));
  push('/usr/local/lib/node_modules/free-pi-cli');
  push('/usr/lib/node_modules/free-pi-cli');
  for (const root of candidates) {
    try {
      if (fs.existsSync(path.join(root, 'package.json'))) return root;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function resolvePiBundle() {
  if (piBundlePath && fs.existsSync(piBundlePath)) return piBundlePath;
  const roots = [];
  const install = findFreePiInstall();
  if (install) {
    roots.push(path.join(install, 'node_modules', '@earendil-works', 'pi-coding-agent'));
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(install, 'package.json'), 'utf8'));
      if (pkg && pkg.version) piClientVersion = String(pkg.version);
    } catch {
      /* keep the default */
    }
  }
  roots.push(path.join(__dirname, 'node_modules', '@earendil-works', 'pi-coding-agent'));
  for (const root of roots) {
    const cli = path.join(root, 'dist', 'bundle', 'cli.js');
    if (fs.existsSync(cli)) {
      piBundlePath = cli;
      return piBundlePath;
    }
  }
  return null;
}

/* The pi bundle is ESM that needs Node >= 22.1 (node:module enableCompileCache),
   so Electron's embedded Node 20 cannot run it. Find a usable system Node. */
function probeNodeRuntime() {
  const candidates = [process.env.PI_HARNESS_NODE, 'node', 'node.exe'].filter(Boolean);
  const seen = new Set();
  for (const bin of candidates) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    try {
      const res = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      if (res.status !== 0) continue;
      const version = String(res.stdout || res.stderr || '').trim().replace(/^v/, '');
      const major = parseInt(version.split('.')[0], 10);
      if (!major) continue;
      nodeRuntime = { bin, version, ok: major >= 22 };
      if (nodeRuntime.ok) return nodeRuntime;
    } catch {
      /* next candidate */
    }
  }
  return nodeRuntime;
}

/* ------------------------------------------------------- account & catalog */

const apiCache = { account: null, accountAt: 0, catalog: null, catalogAt: 0, ad: null, adAt: 0 };

async function apiFetch(pathname, opts) {
  const options = opts || {};
  const token = readFreePiToken();
  if (!token) throw new Error('Not signed in to free-pi. Run `npx free-pi-cli@latest` once, then restart Pi Harness.');
  const headers = Object.assign(
    {
      authorization: 'Bearer ' + token,
      'x-client-version': piClientVersion
    },
    options.headers || {}
  );
  if (options.body) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const res = await fetch(FREEPI_BASE_URL + pathname, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const reason = (data && (data.message || data.error || data.code)) || res.status + ' ' + res.statusText;
      throw new Error('free-pi API: ' + reason);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAccount(me) {
  if (!me) return null;
  const capUsd = Number(me.cap_usd_today || 0);
  const leftUsd = Number(me.remaining_usd_today || 0);
  const capCredits = Number(me.allowance_credits || 0);
  const leftCredits = Number(me.remaining_credits_today || 0);
  const cap = capCredits > 0 ? capCredits : capUsd * 1000;
  const left = capCredits > 0 ? leftCredits : leftUsd * 1000;
  const usedPercent = cap > 0 ? Math.max(0, Math.min(100, ((cap - left) / cap) * 100)) : 0;
  return {
    handle: me.handle || '',
    tier: me.tier || 'unknown',
    lane: me.lane || 'standard',
    capUsd,
    leftUsd,
    capCredits: Math.round(cap),
    leftCredits: Math.round(left),
    usedPercent: Math.round(usedPercent * 10) / 10,
    creditUsd: Number(me.credit_usd || 0),
    bonusCredits: Number(me.bonus_credits || 0),
    premiumCredits: Number(me.premium_credits || 0),
    refillAt: me.refill_at || '',
    buyUrl: me.buy_url || FREEPI_WEB + '/buy',
    notice: me.notice || '',
    guest: !!me.guest,
    fetchedAt: Date.now()
  };
}

async function refreshAccount(force) {
  if (!force && apiCache.account && Date.now() - apiCache.accountAt < 60000) return apiCache.account;
  try {
    const me = await apiFetch('/me');
    apiCache.account = normalizeAccount(me);
    apiCache.accountAt = Date.now();
    emit('quota', { account: apiCache.account });
    return apiCache.account;
  } catch (err) {
    emit('quota', { account: apiCache.account, error: err.message });
    return apiCache.account;
  }
}

async function refreshCatalog(force) {
  if (!force && apiCache.catalog && Date.now() - apiCache.catalogAt < 10 * 60 * 1000) return apiCache.catalog;
  try {
    const data = await apiFetch('/client-version', { headers: { 'x-cost-exp': '1' }, timeout: 8000 });
    const models = (Array.isArray(data.models) ? data.models : [])
      .filter((m) => m && m.id && m.section !== 'defense')
      .map((m) => ({
        id: String(m.id),
        name: String(m.display_name || m.name || m.id).split(' · ')[0],
        fullName: String(m.name || m.id),
        free: !!m.free,
        multiplier: m.usage_x ? Number(m.usage_x) : null,
        note: m.note || '',
        statsId: m.stats_id || ''
      }));
    apiCache.catalog = {
      defaultModel: data.default_model || data.model || DEFAULT_MODEL,
      fusion: data.fusion || null,
      models
    };
    apiCache.catalogAt = Date.now();
    return apiCache.catalog;
  } catch {
    return apiCache.catalog;
  }
}

function fallbackModels() {
  return [
    { id: 'particle', name: 'Particle-1', free: true, multiplier: null },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', free: true, multiplier: null },
    { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', free: true, multiplier: null },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', free: true, multiplier: null },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', free: false, multiplier: 5.9 }
  ];
}

async function modelCatalog() {
  const catalog = await refreshCatalog(false);
  const models = catalog && catalog.models && catalog.models.length ? catalog.models : fallbackModels();
  return { models, defaultModel: (catalog && catalog.defaultModel) || DEFAULT_MODEL, fusion: catalog && catalog.fusion };
}

/* The engine reads providers from models.json. It is generated from the
   free-pi catalog so the in-app model picker matches the service. */
function writeProviderConfig(models, defaultModel) {
  const dir = harnessAgentDir();
  ensureDir(dir);
  const list = (models && models.length ? models : fallbackModels()).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }));
  const config = {
    providers: {
      freepi: {
        name: 'Free-Pi',
        baseUrl: FREEPI_BASE_URL + '/v1',
        api: 'openai-completions',
        apiKey: '$FREEPI_TOKEN',
        headers: { 'x-client-version': piClientVersion },
        models: list
      }
    }
  };
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(config, null, 2), 'utf8');
  return { path: path.join(dir, 'models.json'), defaultModel: defaultModel || DEFAULT_MODEL, count: list.length };
}

/* ------------------------------------------------------------- sponsored */

function adContext() {
  return { projectRoot, platform: process.platform };
}

async function refreshAd(force) {
  if (!force && apiCache.ad && Date.now() - apiCache.adAt < 5 * 60 * 1000) return apiCache.ad;
  try {
    const data = await apiFetch('/ads/next?slot=banner', {
      headers: {
        'x-client-os': process.platform,
        'x-client-arch': process.arch,
        'x-client-locale': Intl.DateTimeFormat().resolvedOptions().locale || 'en',
        'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        'x-ad-trigger': 'app'
      },
      timeout: 8000
    });
    if (!data || !data.creative) {
      apiCache.ad = null;
      apiCache.adAt = Date.now();
      emit('ad', { ad: null });
      return null;
    }
    apiCache.ad = {
      id: data.ad_id || '',
      token: data.click_token || '',
      headline: String(data.creative.headline || ''),
      body: String(data.creative.body || ''),
      cta: String(data.creative.cta || 'Learn more'),
      accent: String(data.creative.accent || ''),
      brand: String(data.creative.brand_name || ''),
      icon: String(data.creative.icon_url || ''),
      image: String(data.creative.image_url || ''),
      url: String(data.click_url || ''),
      source: String(data.source || ''),
      impUrl: String(data.imp_url || '')
    };
    apiCache.adAt = Date.now();
    emit('ad', { ad: apiCache.ad });
    return apiCache.ad;
  } catch (err) {
    apiCache.adAt = Date.now();
    emit('ad', { ad: apiCache.ad, error: err.message });
    return apiCache.ad;
  }
}

async function adImpression(ad) {
  if (!ad || !ad.id || !ad.token) return { ok: false };
  try {
    await apiFetch('/ads/impression', { method: 'POST', body: { ad_id: ad.id, click_token: ad.token, imp_fired: true } });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/* ------------------------------------------------------------- projects */

function listProjectFiles(root) {
  const files = [];
  const walk = (dir, depth) => {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        files.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(root, 0);
  return files.sort();
}

function projectSummary() {
  return {
    projectRoot,
    name: projectRoot ? safeBasename(projectRoot) : '',
    files: projectRoot ? listProjectFiles(projectRoot) : []
  };
}

function openProject(dir) {
  const abs = path.resolve(String(dir || ''));
  const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!stat || !stat.isDirectory()) throw new Error('Not a folder: ' + dir);
  projectRoot = abs;
  saveAppState();
  return projectSummary();
}

/* -------------------------------------------------------------- sessions */

function sessionsFile() {
  return path.join(app.getPath('userData'), 'sessions.json');
}

function loadSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
    sessionsCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    sessionsCache = [];
  }
  return sessionsCache;
}

function saveSessions() {
  try {
    ensureDir(path.dirname(sessionsFile()));
    fs.writeFileSync(sessionsFile(), JSON.stringify(sessionsCache, null, 2), 'utf8');
  } catch {
    /* persistence must never break a run */
  }
}

function sessionsForProject() {
  return loadSessions()
    .filter((s) => s && s.projectRoot === projectRoot)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((s) => ({
      id: s.id,
      title: s.title || 'Session',
      updatedAt: s.updatedAt || 0,
      messages: Array.isArray(s.messages) ? s.messages.length : 0
    }));
}

function sessionsAll() {
  return loadSessions()
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((s) => ({
      id: s.id,
      title: s.title || 'Session',
      projectRoot: s.projectRoot || '',
      project: s.projectRoot ? safeBasename(s.projectRoot) : '',
      updatedAt: s.updatedAt || 0,
      messages: Array.isArray(s.messages) ? s.messages.length : 0
    }));
}

function newSessionRecord(title) {
  return {
    id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: title || 'New session',
    projectRoot,
    messages: [],
    updatedAt: Date.now()
  };
}

function upsertSession(record) {
  loadSessions();
  const idx = sessionsCache.findIndex((s) => s && s.id === record.id);
  const next = Object.assign({}, record, { updatedAt: Date.now() });
  if (idx >= 0) sessionsCache[idx] = next;
  else sessionsCache.push(next);
  sessionsCache = sessionsCache.slice(-200);
  saveSessions();
  return next;
}

function appStateFile() {
  return path.join(app.getPath('userData'), 'state.json');
}

function saveAppState() {
  try {
    ensureDir(path.dirname(appStateFile()));
    fs.writeFileSync(appStateFile(), JSON.stringify({ projectRoot }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function loadAppState() {
  try {
    const data = JSON.parse(fs.readFileSync(appStateFile(), 'utf8'));
    if (data && data.projectRoot && fs.existsSync(data.projectRoot)) projectRoot = data.projectRoot;
  } catch {
    /* first run */
  }
}
/* ---------------------------------------------------------- RPC engine */

/* One live RPC process per session; `engine` always points at the active one. */
let engine = makeEngine('', '');
const enginePool = new Map();
let activeEngineKey = '';
const MAX_ENGINES = 8;

let wrapperRpcOk = null;
let wrapperCmd = null;

function engineEnv() {
  const token = readFreePiToken();
  return Object.assign({}, process.env, {
    FREEPI_NO_AUTO_UPDATE: '1',
    FREEPI_NO_INTRO: '1',
    PI_CODING_AGENT_DIR: harnessAgentDir(),
    FREEPI_BASE_URL,
    PI_HARNESS: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...(token ? { FREEPI_TOKEN: token } : {})
  });
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

function tryWrapper(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let child;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        killTree(child);
      } catch {
        /* the probe child may already be gone */
      }
      resolve(ok);
    };
    try {
      child = spawn(command, args, {
        cwd: projectRoot || process.cwd(),
        shell: true,
        windowsHide: true,
        env: engineEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      finish(false);
      return;
    }
    child.stdout.on('data', (chunk) => {
      if (String(chunk).trim().startsWith('{')) finish(true);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (/unknown argument|unknown option|invalid option/i.test(stderr)) finish(false);
    });
    child.on('error', () => finish(false));
    child.on('close', () => finish(false));
    setTimeout(() => finish(false), timeoutMs || 2500);
  });
}

/* free-pi-cli only speaks RPC in some builds. Probe the installed wrapper
   first, then npx, and fall back to the bundled Pi runtime (system Node). */
async function probeWrapperRpc() {
  if (wrapperRpcOk !== null) return wrapperRpcOk;
  if (await tryWrapper('free-pi-cli', ['--mode', 'rpc'], 2500)) {
    wrapperCmd = { command: 'free-pi-cli', args: ['--mode', 'rpc'], shell: true, label: 'free-pi-cli --mode rpc', mode: 'wrapper' };
    wrapperRpcOk = true;
    return true;
  }
  if (await tryWrapper('npx', ['--yes', 'free-pi-cli@latest', '--mode', 'rpc'], 45000)) {
    wrapperCmd = { command: 'npx', args: ['--yes', 'free-pi-cli@latest', '--mode', 'rpc'], shell: true, label: 'npx free-pi-cli --mode rpc', mode: 'npx' };
    wrapperRpcOk = true;
    return true;
  }
  wrapperRpcOk = false;
  return false;
}

async function buildEngineSpawn(owner) {
  const token = readFreePiToken();
  if (!token) {
    throw new Error('Not signed in to free-pi. Run `npx free-pi-cli@latest` once in a terminal, then restart Pi Harness.');
  }
  const catalog = await modelCatalog();
  writeProviderConfig(catalog.models, catalog.defaultModel);
  const source = owner || engine;
  const wanted = (source.currentModel && source.currentModel.id) || catalog.defaultModel || DEFAULT_MODEL;

  if (wrapperRpcOk === null) await probeWrapperRpc();
  if (wrapperRpcOk && wrapperCmd) return Object.assign({}, wrapperCmd);

  const cli = resolvePiBundle();
  if (!cli) {
    wrapperRpcOk = null;
    throw new Error(
      'free-pi-cli was not found. Install it with `npx free-pi-cli@latest`, or open the terminal once so Pi Harness can fall back to npx.'
    );
  }
  if (!nodeRuntime.ok) probeNodeRuntime();
  if (!nodeRuntime.ok) {
    throw new Error(
      'Node.js 22 or newer is required to run the Pi runtime (found ' +
        (nodeRuntime.version || 'none') +
        '). Install it from nodejs.org, then restart Pi Harness.'
    );
  }
  ensureDir(piSessionDir());
  return {
    command: nodeRuntime.bin,
    args: [
      cli,
      '--mode',
      'rpc',
      '--provider',
      'freepi',
      '--model',
      wanted,
      '--session-dir',
      piSessionDir()
    ],
    shell: false,
    label: 'pi --mode rpc',
    mode: 'pi'
  };
}

function engineWrite(payload, eng) {
  const owner = eng || engine;
  if (!owner.child || !owner.child.stdin || !owner.child.stdin.writable) return false;
  try {
    owner.child.stdin.write(JSON.stringify(payload) + '\n');
    return true;
  } catch {
    return false;
  }
}

function engineCall(type, fields, timeout, eng) {
  const owner = eng || engine;
  return new Promise((resolve, reject) => {
    if (!owner.child) {
      reject(new Error('The agent is not running.'));
      return;
    }
    const id = 'h' + (++owner.seq);
    const timer = setTimeout(() => {
      owner.pending.delete(id);
      reject(new Error('The agent did not answer "' + type + '" in time.'));
    }, timeout || RPC_TIMEOUT);
    owner.pending.set(id, { resolve, reject, timer });
    const ok = engineWrite(Object.assign({ id, type }, fields || {}), owner);
    if (!ok) {
      clearTimeout(timer);
      owner.pending.delete(id);
      reject(new Error('The agent process is not accepting input.'));
    }
  });
}

function engineSend(type, fields, eng) {
  return engineWrite(Object.assign({ type }, fields || {}), eng);
}

function rejectPending(reason, eng) {
  const owner = eng || engine;
  for (const [, waiter] of owner.pending) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
  owner.pending.clear();
}

function engineStatus(eng) {
  const owner = eng || engine;
  return {
    key: owner.key,
    root: owner.root || '',
    mode: owner.mode,
    label: owner.label,
    ready: owner.ready,
    state: owner.ready ? 'ready' : owner.child ? 'starting' : 'stopped',
    streaming: !!owner.streaming,
    model: owner.currentModel,
    thinking: owner.thinking,
    levels: owner.levels,
    models: owner.models,
    commands: owner.commands,
    signedIn: !!readFreePiToken()
  };
}

/* Live processes kept per session, so switching projects never waits. */
function poolStatus() {
  const list = [];
  for (const [key, item] of enginePool) {
    if (!item || !item.child) continue;
    list.push({
      key,
      root: item.root || '',
      state: item.ready ? 'ready' : 'starting',
      streaming: !!item.streaming
    });
  }
  return list;
}

function pruneEnginePool() {
  if (enginePool.size <= MAX_ENGINES) return;
  const idle = [];
  for (const [key, item] of enginePool) {
    if (key === engine.key) continue;
    if (item.streaming) continue;
    idle.push([key, item]);
  }
  idle.sort((a, b) => (a[1].lastUsedAt || 0) - (b[1].lastUsedAt || 0));
  while (enginePool.size > MAX_ENGINES && idle.length) {
    const [key, item] = idle.shift();
    if (item.child) killTree(item.child);
    item.child = null;
    item.ready = false;
    enginePool.delete(key);
  }
}

function handleRpcRecord(rec, eng) {
  const owner = eng || engine;
  if (!rec || typeof rec !== 'object') return;
  if (rec.type === 'response') {
    if (rec.id && owner.pending.has(rec.id)) {
      const waiter = owner.pending.get(rec.id);
      owner.pending.delete(rec.id);
      clearTimeout(waiter.timer);
      if (rec.success === false) waiter.reject(new Error(rec.error || 'The agent rejected the command.'));
      else waiter.resolve(rec.data === undefined ? null : rec.data);
    } else if (rec.success === false && rec.command === 'parse') {
      emit('notice', { text: 'The agent could not parse a command: ' + (rec.error || ''), level: 'error', key: owner.key });
    }
    return;
  }
  handleSessionEvent(rec, owner);
}

function handleSessionEvent(rec, eng) {
  const owner = eng || engine;
  const key = owner.key;
  switch (rec.type) {
    case 'agent_start':
    case 'turn_start':
      owner.streaming = true;
      break;
    case 'agent_settled':
      owner.streaming = false;
      refreshAccount(true).catch(() => {});
      refreshAd(true).catch(() => {});
      engineCall('get_session_stats', {}, 15000, owner)
        .then((stats) => emit('stats', { stats, key }))
        .catch(() => {});
      break;
    case 'thinking_level_changed':
      if (rec.level) owner.thinking = rec.level;
      break;
    case 'session_info_changed':
      if (rec.name) emit('session-name', { name: rec.name, key });
      break;
    default:
      break;
  }

  if (rec.type === 'tool_execution_start') {
    const target = toolTargetPath(rec.args, owner);
    if (target) toolSnapshots.set(rec.toolCallId, { abs: target, before: readTextSafe(target) });
    emit('pi', {
      key,
      event: Object.assign({}, rec, {
        summary: toolSummary(rec.toolName, rec.args)
      })
    });
    return;
  }

  if (rec.type === 'tool_execution_end') {
    const snapshot = toolSnapshots.get(rec.toolCallId);
    if (snapshot) {
      toolSnapshots.delete(rec.toolCallId);
      const after = readTextSafe(snapshot.abs);
      if (after != null && snapshot.before !== after) {
        const computed = buildDiff(snapshot.before, after);
        emit('tool-diff', {
          key,
          id: rec.toolCallId,
          diff: {
            path: relativizeTo(snapshot.abs, owner.root),
            added: computed.added,
            removed: computed.removed,
            rows: computed.rows
          }
        });
      }
    }
    emit('pi', { key, event: rec });
    return;
  }

  if (rec.type === 'message_update') {
    const inner = rec.assistantMessageEvent || {};
    emit('pi', {
      key,
      event: {
        type: 'pi-message-update',
        kind: inner.type || '',
        delta: inner.delta || '',
        usage: rec.usage || null
      }
    });
    return;
  }

  if (rec.type === 'message_end' && rec.message) {
    emit('pi', {
      key,
      event: {
        type: 'pi-message-end',
        role: rec.message.role,
        usage: rec.message.usage || null,
        stopReason: rec.message.stopReason || '',
        errorMessage: rec.message.errorMessage || ''
      }
    });
    return;
  }

  emit('pi', { key, event: rec });
}

function attachEngine(child, info, eng) {
  const owner = eng || engine;
  owner.child = child;
  owner.mode = info.mode;
  owner.label = info.label;
  owner.buffer = '';
  owner.stderrTail = '';
  owner.stopping = false;

  child.stdout.on('data', (chunk) => {
    owner.buffer += chunk.toString('utf8');
    let idx = owner.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = owner.buffer.slice(0, idx).replace(/\r$/, '');
      owner.buffer = owner.buffer.slice(idx + 1);
      if (line.trim()) {
        let rec = null;
        try {
          rec = JSON.parse(line);
        } catch {
          emit('stderr', { text: stripAnsi(line).slice(0, 500), key: owner.key });
        }
        if (rec) handleRpcRecord(rec, owner);
      }
      idx = owner.buffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString('utf8')).trim();
    if (!text) return;
    owner.stderrTail = (owner.stderrTail + '\n' + text).slice(-6000);
    for (const line of text.split('\n')) {
      const clean = line.trim();
      if (!clean) continue;
      emit('stderr', { text: clean.slice(0, 600), key: owner.key });
    }
  });

  child.on('error', (err) => {
    owner.ready = false;
    rejectPending('The agent process failed: ' + err.message, owner);
    emit('engine', { state: 'error', error: err.message, info: engineStatus(owner), key: owner.key });
  });

  child.on('close', (code, signal) => {
    const wasReady = owner.ready;
    owner.ready = false;
    owner.streaming = false;
    owner.child = null;
    rejectPending('The agent process stopped.', owner);
    emit('engine', {
      state: owner.stopping ? 'stopped' : 'crashed',
      code,
      signal,
      error: owner.stopping ? '' : owner.stderrTail.trim().slice(-1200),
      info: engineStatus(owner),
      key: owner.key
    });
    if (!owner.stopping && owner.root && owner.restarts < 3 && wasReady) {
      owner.restarts += 1;
      setTimeout(() => {
        ensureEngineFor(owner).catch(() => {});
      }, 1200);
    }
  });
}

async function ensureEngineFor(owner) {
  if (!owner) throw new Error('No session engine.');
  if (owner.child && owner.ready) return engineStatus(owner);
  if (owner.starting) return owner.starting;
  if (!owner.root) throw new Error('Open a project folder first.');
  ensureDir(harnessAgentDir());

  const wasActive = owner === engine;
  const savedRoot = projectRoot;
  if (!wasActive) projectRoot = owner.root;

  owner.starting = (async () => {
    emit('engine', { state: 'starting', info: engineStatus(owner), key: owner.key });
    const info = await buildEngineSpawn(owner);
    const child = spawn(info.command, info.args, {
      cwd: owner.root,
      env: engineEnv(),
      shell: info.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    attachEngine(child, info, owner);

    const state = await engineCall('get_state', {}, START_TIMEOUT, owner);
    owner.ready = true;
    owner.restarts = 0;
    owner.state = state || null;
    owner.currentModel = (state && state.model) || owner.currentModel;
    if (state && state.thinkingLevel) owner.thinking = state.thinkingLevel;

    await loadEngineCapabilities(owner);
    emit('engine', { state: 'ready', info: engineStatus(owner), key: owner.key });
    return engineStatus(owner);
  })();

  try {
    return await owner.starting;
  } finally {
    owner.starting = null;
    if (!wasActive) projectRoot = savedRoot;
  }
}

async function ensureEngine() {
  return ensureEngineFor(engine);
}

async function loadEngineCapabilities(eng) {
  const owner = eng || engine;
  const [modelsRes, levelsRes, commandsRes] = await Promise.all([
    engineCall('get_available_models', {}, 20000, owner).catch(() => null),
    engineCall('get_available_thinking_levels', {}, 15000, owner).catch(() => null),
    engineCall('get_commands', {}, 15000, owner).catch(() => null)
  ]);

  const catalogModels = (await modelCatalog()).models;
  const byId = new Map();
  for (const m of catalogModels) byId.set(m.id, m);

  if (modelsRes && Array.isArray(modelsRes.models)) {
    owner.models = modelsRes.models.map((m) => {
      const meta = byId.get(m.id) || {};
      return {
        id: m.id,
        provider: m.provider || 'freepi',
        name: meta.name || m.name || m.id,
        multiplier: meta.multiplier || null,
        free: !!meta.free,
        contextWindow: m.contextWindow || 200000,
        reasoning: !!m.reasoning
      };
    });
  } else {
    owner.models = catalogModels.map((m) => ({
      id: m.id,
      provider: 'freepi',
      name: m.name,
      multiplier: m.multiplier,
      free: m.free,
      contextWindow: 200000,
      reasoning: true
    }));
  }

  if (levelsRes && Array.isArray(levelsRes.levels) && levelsRes.levels.length) {
    owner.levels = levelsRes.levels.filter((l) => THINKING_LEVELS.includes(l));
  } else {
    owner.levels = ['off', 'minimal', 'low', 'medium', 'high'];
  }
  if (!owner.levels.includes(owner.thinking)) owner.thinking = owner.levels[0] || 'medium';

  owner.commands = commandsRes && Array.isArray(commandsRes.commands) ? commandsRes.commands : [];

  const state = await engineCall('get_state', {}, 15000, owner).catch(() => null);
  if (state) {
    owner.state = state;
    if (state.model) owner.currentModel = state.model;
  }
}

async function restartEngine(eng) {
  const owner = eng || engine;
  owner.stopping = true;
  if (owner.child) killTree(owner.child);
  owner.child = null;
  owner.ready = false;
  owner.stopping = false;
  owner.restarts = 0;
  rejectPending('The agent is restarting.', owner);
  return ensureEngineFor(owner);
}

async function stopEngine(eng) {
  const owner = eng || engine;
  owner.stopping = true;
  if (owner.child) killTree(owner.child);
  owner.child = null;
  owner.ready = false;
  owner.streaming = false;
  rejectPending('The agent stopped.', owner);
  emit('engine', { state: 'stopped', info: engineStatus(owner), key: owner.key });
}

/* ------------------------------------------------------ session switching */

function makeEngine(key, root) {
  return {
    key: key || 'default',
    root: root || '',
    lastUsedAt: Date.now(),
    child: null,
    mode: 'unknown',
    label: '',
    ready: false,
    starting: null,
    buffer: '',
    seq: 0,
    pending: new Map(),
    stderrTail: '',
    stopping: false,
    restarts: 0,
    models: [],
    currentModel: null,
    thinking: 'medium',
    levels: ['off', 'minimal', 'low', 'medium', 'high'],
    commands: [],
    state: null,
    streaming: false,
    lastPromptAt: 0
  };
}

function activateEngine(key, root) {
  const nextKey = String(key || 'default');
  const known = enginePool.get(nextKey);
  const nextRoot = root ? path.resolve(String(root)) : (known && known.root) || engine.root || projectRoot;

  if (engine.key === nextKey) {
    if (nextRoot) {
      engine.root = nextRoot;
      projectRoot = nextRoot;
    }
    engine.lastUsedAt = Date.now();
    activeEngineKey = nextKey;
    return engine;
  }

  enginePool.set(engine.key, engine);
  let target = known;
  if (!target) target = makeEngine(nextKey, nextRoot || '');
  if (nextRoot) target.root = nextRoot;
  enginePool.set(nextKey, target);
  engine = target;
  activeEngineKey = nextKey;
  engine.lastUsedAt = Date.now();
  if (target.root) projectRoot = target.root;
  pruneEnginePool();
  return engine;
}

function stopEngineByKey(key) {
  const target = enginePool.get(key) || (engine.key === key ? engine : null);
  if (!target) return Promise.resolve(false);
  enginePool.delete(key);
  return stopEngine(target).then(() => true);
}

function stopAllEngines() {
  for (const [key, item] of enginePool) {
    item.stopping = true;
    if (item.child) killTree(item.child);
    item.child = null;
    item.ready = false;
    enginePool.delete(key);
  }
  engine.stopping = true;
  if (engine.child) killTree(engine.child);
  engine.child = null;
  engine.ready = false;
}

/* ------------------------------------------------------------ chat input */

function expandMentions(text) {
  const source = String(text || '');
  const blocks = [];
  const seen = new Set();
  const re = /(^|[\s(])@([A-Za-z0-9._\-\/\\]+)/g;
  let match;
  while ((match = re.exec(source)) !== null && blocks.length < 8) {
    const rel = match[2].replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    let abs;
    try {
      abs = resolveInProject(rel);
    } catch {
      continue;
    }
    const body = readTextSafe(abs);
    if (body == null) continue;
    blocks.push('File: ' + rel + '\n```\n' + truncate(body, 60000) + '\n```');
  }
  if (!blocks.length) return source;
  return source + '\n\n' + blocks.join('\n\n');
}

function attachmentBlocks(paths) {
  const blocks = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const abs = String(raw || '');
    if (!abs) continue;
    const body = readTextSafe(abs);
    if (body == null) continue;
    const name = relativize(abs);
    blocks.push('Attached file: ' + name + '\n```\n' + truncate(body, 60000) + '\n```');
  }
  return blocks;
}

function normalizeImages(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const value = String(item || '');
    const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(value);
    if (dataUrl) {
      out.push({ type: 'image', mimeType: dataUrl[1], data: dataUrl[2] });
      continue;
    }
    try {
      if (value && fs.existsSync(value)) {
        const ext = path.extname(value).slice(1).toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + ext;
        out.push({ type: 'image', mimeType: mime, data: fs.readFileSync(value).toString('base64') });
      }
    } catch {
      /* skip unreadable image */
    }
  }
  return out.slice(0, 6);
}

async function sendChat(payload) {
  const body = payload || {};
  await ensureEngine();
  const behavior = body.behavior === 'steer' ? 'steer' : body.behavior === 'followUp' ? 'followUp' : 'prompt';
  const images = normalizeImages(body.images);
  const extra = attachmentBlocks(body.attachments);
  let message = expandMentions(String(body.message || ''));
  if (extra.length) message += '\n\n' + extra.join('\n\n');
  if (!message.trim() && !images.length) return { ok: false, error: 'Nothing to send.' };

  const fields = { message };
  if (images.length) fields.images = images;

  /* Steering only means something while the agent is streaming. If it is
     idle, the message is sent as a normal prompt so it is never lost in a
     queue that the agent will not drain. */
  let effective = behavior;
  if (effective !== 'prompt') {
    const state = await engineCall('get_state', {}, 15000).catch(() => null);
    if (state && state.isStreaming === false) effective = 'prompt';
  }

  let data;
  if (effective === 'steer') data = await engineCall('steer', fields, 60000);
  else if (effective === 'followUp') data = await engineCall('follow_up', fields, 60000);
  else data = await engineCall('prompt', fields, 60000);

  engine.lastPromptAt = Date.now();
  if (effective === 'prompt' && data && data.disposition !== 'queued') engine.streaming = true;
  return { ok: true, behavior: effective, disposition: (data && data.disposition) || 'started' };
}

async function abortChat() {
  if (!engine.child) return { ok: false, error: 'The agent is not running.' };
  let cleared = null;
  try {
    cleared = await engineCall('clear_queue', {}, 10000);
  } catch {
    cleared = null;
  }
  try {
    await engineCall('abort', {}, 30000);
  } catch (err) {
    return { ok: false, error: err.message, cleared };
  }
  engine.streaming = false;
  return { ok: true, cleared };
}

async function runRemoteBash(command, excludeFromContext) {
  await ensureEngine();
  const data = await engineCall(
    'bash',
    { command: String(command), excludeFromContext: !!excludeFromContext },
    10 * 60 * 1000
  );
  return {
    ok: true,
    output: data && typeof data.output === 'string' ? data.output : '',
    exitCode: data ? data.exitCode : 0,
    cancelled: !!(data && data.cancelled),
    truncated: !!(data && data.truncated),
    excludeFromContext: !!excludeFromContext
  };
}

function runLocalBash(command) {
  return new Promise((resolve) => {
    if (!projectRoot) {
      resolve({ ok: false, error: 'Open a project folder first.' });
      return;
    }
    exec(
      String(command),
      { cwd: projectRoot, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        const output = stripAnsi(String(stdout || '') + String(stderr || '')).trim();
        resolve({
          ok: !err,
          output: truncate(output, MAX_TOOL_OUTPUT),
          exitCode: err && typeof err.code === 'number' ? err.code : 0,
          error: err && err.killed ? 'Command timed out' : ''
        });
      }
    );
  });
}

/* --------------------------------------------------------------- diffing */

const toolSnapshots = new Map();

function buildDiff(before, after) {
  const a = before == null ? [] : String(before).split(/\r?\n/);
  const b = after == null ? [] : String(after).split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  if (n + m > 8000) {
    return {
      rows: [
        { t: 'del', text: '… file too large to diff (' + n + ' lines before)' },
        { t: 'add', text: '… (' + m + ' lines after)' }
      ],
      added: m,
      removed: n
    };
  }
  const dp = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: 'ctx', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ t: 'del', text: a[i] });
      removed += 1;
      i += 1;
    } else {
      rows.push({ t: 'add', text: b[j] });
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ t: 'del', text: a[i] });
    removed += 1;
    i += 1;
  }
  while (j < m) {
    rows.push({ t: 'add', text: b[j] });
    added += 1;
    j += 1;
  }
  const compact = [];
  let gap = 0;
  for (const row of rows) {
    if (row.t === 'ctx') {
      gap += 1;
      if (gap > 6) continue;
      compact.push(row);
    } else {
      gap = 0;
      if (compact.length > 500) break;
      compact.push(row);
    }
  }
  return { rows: compact, added, removed };
}

function relativizeTo(abs, root) {
  if (!root) return relativize(abs);
  try {
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..')) return relativize(abs);
    return rel.split(path.sep).join('/');
  } catch {
    return relativize(abs);
  }
}

function toolTargetPath(args, owner) {
  if (!args || typeof args !== 'object') return null;
  const raw = args.path || args.file_path || args.filePath || (args.file && args.file.path) || '';
  if (!raw) return null;
  try {
    const root = (owner && owner.root) || projectRoot;
    if (!root) return null;
    const abs = path.isAbsolute(String(raw)) ? path.resolve(String(raw)) : path.resolve(root, String(raw));
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return abs;
  } catch {
    return null;
  }
}

function toolSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  let pick =
    args.command ||
    args.path ||
    args.file_path ||
    args.pattern ||
    args.query ||
    args.url ||
    args.description ||
    '';
  pick = String(pick || '');
  if ((args.path || args.file_path) && projectRoot) {
    const raw = String(args.path || args.file_path);
    const normalized = raw.split(path.sep).join('/');
    const root = projectRoot.split(path.sep).join('/') + '/';
    if (normalized.toLowerCase().startsWith(root.toLowerCase())) pick = normalized.slice(root.length);
  }
  return pick.replace(/\s+/g, ' ').slice(0, 160);
}
/* ------------------------------------------------------------- init/undo */

function detectStack(files) {
  const stack = new Set();
  const has = (p) => files.includes(p);
  if (has('package.json')) stack.add('Node.js');
  if (has('tsconfig.json')) stack.add('TypeScript');
  if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) stack.add('Next.js');
  if (has('vite.config.ts') || has('vite.config.js')) stack.add('Vite');
  if (has('pyproject.toml') || has('requirements.txt')) stack.add('Python');
  if (has('Cargo.toml')) stack.add('Rust');
  if (has('go.mod')) stack.add('Go');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) stack.add('JVM');
  if (has('Dockerfile')) stack.add('Docker');
  return Array.from(stack);
}

async function initAgentsMd() {
  if (!projectRoot) throw new Error('Open a project folder first.');
  const files = listProjectFiles(projectRoot);
  const stack = detectStack(files);
  let scripts = {};
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    scripts = pkg.scripts || {};
  } catch {
    scripts = {};
  }
  const lines = [
    '# AGENTS.md',
    '',
    '<!-- Generated by Pi Harness. The agent reads this file in every session. -->',
    '',
    '## Project',
    '- Root: ' + projectRoot,
    '- Stack: ' + (stack.length ? stack.join(', ') : 'not detected'),
    '',
    '## Commands',
    Object.keys(scripts).length
      ? Object.keys(scripts)
          .map((k) => '- `npm run ' + k + '` — ' + scripts[k])
          .join('\n')
      : '- No package.json scripts found. Document build/test/lint commands here.',
    '',
    '## Layout',
    '```',
    files.slice(0, 120).join('\n') || '(empty project)',
    '```',
    '',
    '## Working rules',
    '1. Read a file before editing it; prefer surgical edits over rewrites.',
    '2. Match the existing style, naming and formatting.',
    '3. Run the project checks after changes and report the exact result.',
    '4. Do not touch generated output, lock files or dependencies unless asked.',
    '5. Never add secrets or credentials to the repository.',
    '6. Keep diffs scoped to the request; no drive-by refactors.'
  ];
  const abs = path.join(projectRoot, 'AGENTS.md');
  await fsp.writeFile(abs, lines.join('\n'), 'utf8');
  return { path: abs, files: listProjectFiles(projectRoot) };
}

function gitUndo() {
  return new Promise((resolve) => {
    if (!projectRoot) {
      resolve({ ok: false, message: 'Open a project folder first.' });
      return;
    }
    if (!fs.existsSync(path.join(projectRoot, '.git'))) {
      resolve({ ok: false, message: 'This folder is not a git repository, so /undo has nothing to restore.' });
      return;
    }
    exec('git checkout -- .', { cwd: projectRoot, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, message: stripAnsi(err.message || stderr || 'git checkout failed').trim() });
        return;
      }
      resolve({
        ok: true,
        message: 'Reverted all tracked changes with git checkout -- .',
        output: stripAnsi(String(stdout || stderr || '')).trim(),
        files: listProjectFiles(projectRoot)
      });
    });
  });
}

/* ------------------------------------------------------- free-pi service */

async function referralInfo() {
  const data = await apiFetch('/me/referral');
  return {
    code: data && data.code ? String(data.code) : '',
    shareUrl: data && data.share_url ? String(data.share_url) : '',
    shareLine: data && data.share_line ? String(data.share_line) : ''
  };
}

async function referralStatus() {
  const data = await apiFetch('/me/referral/status');
  return {
    signups: Number((data && data.signups) || 0),
    qualified: Number((data && data.qualified) || 0),
    activeBonuses: Number((data && data.active_bonuses) || 0),
    activeBonusCreditsPerDay: Number((data && data.active_bonus_credits_per_day) || 0),
    raw: data || null
  };
}

async function redeemCode(code) {
  const value = String(code || '').trim();
  if (!value) throw new Error('Usage: /redeem FREEPI-XXXX-XXXX');
  const data = await apiFetch('/me/redeem', { method: 'POST', body: { code: value } });
  refreshAccount(true).catch(() => {});
  return {
    ok: true,
    creditsAdded: Number((data && data.credits_added) || 0),
    message: data && data.message ? String(data.message) : 'Code redeemed.'
  };
}

async function closeOtherSession() {
  const data = await apiFetch('/session/reset', { method: 'POST' });
  return { ok: true, released: !!(data && data.released) };
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { shell: true, windowsHide: true, cwd: projectRoot || process.cwd() });
    } catch (err) {
      resolve({ ok: false, output: err.message });
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
    }, timeoutMs || 240000);
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: stripAnsi(output + '\n' + err.message).trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: truncate(stripAnsi(output).trim(), 8000) });
    });
  });
}

async function updateCli() {
  const res = await runProcess('npm', ['install', '-g', 'free-pi-cli@latest'], 300000);
  wrapperRpcOk = null;
  wrapperCmd = null;
  piBundlePath = null;
  if (res.ok) {
    const install = findFreePiInstall();
    if (install) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(install, 'package.json'), 'utf8'));
        if (pkg.version) piClientVersion = String(pkg.version);
      } catch {
        /* keep the old version string */
      }
    }
  }
  return { ok: res.ok, output: res.output || 'free-pi-cli is already up to date.' };
}

async function logoutCli() {
  const token = readFreePiToken();
  if (token) {
    try {
      await apiFetch('/auth/logout-all', { method: 'POST' });
    } catch {
      /* the local token removal below still signs the user out here */
    }
  }
  try {
    fs.rmSync(freePiCredentialsPath(), { force: true });
  } catch {
    /* ignore */
  }
  const res = await runProcess('free-pi-cli', ['logout'], 60000);
  await stopEngine();
  return { ok: true, output: res.output || 'Signed out.' };
}

function openExternalUrl(url) {
  const value = String(url || '');
  if (!/^https:\/\//i.test(value)) throw new Error('Only https links can be opened.');
  return shell.openExternal(value);
}

async function exportSession() {
  await ensureEngine();
  const dir = path.join(projectRoot || os.homedir(), '.pi-harness', 'exports');
  ensureDir(dir);
  const file = path.join(dir, 'pi-session-' + new Date().toISOString().replace(/[:.]/g, '-') + '.html');
  const data = await engineCall('export_html', { outputPath: file }, 90000);
  const out = data && data.path ? String(data.path) : file;
  return { path: out };
}

/* ----------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#09090b',
    title: APP_TITLE,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
      backgroundThrottling: true
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('maximize', () => emit('window', { maximized: true }));
  win.on('unmaximize', () => emit('window', { maximized: false }));
  win.on('close', () => {
    if (!isQuitting) isQuitting = true;
  });
}

/* ------------------------------------------------------ runtime onboarding */

const CONSENT_VERSION = '4';
const CONSENT_TEXT = [
  'free-pi is free. In exchange, we show you ads and may train on your data.',
  "If you want to use free-pi, you accept that. If you don't, don't use it.",
  'You must be at least 13 in the US, 16 in the EEA/UK, or 18 elsewhere.',
  'Terms: https://freepi.ai/terms   Privacy: https://freepi.ai/privacy'
].join('\n');

const setupState = { login: null };

function setupEmit(step, phase, payload) {
  emit('setup', Object.assign({ step, phase }, payload || {}));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeCommand(bin, args) {
  try {
    const res = spawnSync(bin, args || [], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      shell: process.platform === 'win32'
    });
    if (res.status !== 0) return { found: false, version: '' };
    const text = String(res.stdout || res.stderr || '').trim().split('\n')[0];
    return { found: true, version: text.replace(/^v/, '').trim() };
  } catch {
    return { found: false, version: '' };
  }
}

/* A freshly installed Node/npm only shows up in a new shell; patch PATH now. */
function refreshPath() {
  const extra = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm')
  ];
  const parts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of extra) {
    if (!dir) continue;
    let exists = false;
    try {
      exists = fs.existsSync(dir);
    } catch {
      exists = false;
    }
    if (exists && !parts.includes(dir)) parts.unshift(dir);
  }
  process.env.PATH = parts.join(path.delimiter);
}

function findWinget() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe'),
    'winget'
  ];
  for (const bin of candidates) {
    if (!bin) continue;
    if (bin === 'winget') {
      const probe = probeCommand('winget', ['--version']);
      if (probe.found) return bin;
      continue;
    }
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function runtimeStatus() {
  refreshPath();
  probeNodeRuntime();
  const npm = probeCommand('npm', ['--version']);
  const install = findFreePiInstall();
  let cliVersion = '';
  if (install) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(install, 'package.json'), 'utf8'));
      cliVersion = String(pkg.version || '');
    } catch {
      cliVersion = '';
    }
  }
  let bundle = false;
  try {
    bundle = !!resolvePiBundle();
  } catch {
    bundle = false;
  }
  const signedIn = !!readFreePiToken();
  return {
    node: { found: !!nodeRuntime.version, version: nodeRuntime.version, ok: !!nodeRuntime.ok, bin: nodeRuntime.bin },
    npm,
    cli: { found: !!install, version: cliVersion, path: install || '' },
    bundle,
    winget: findWinget(),
    signedIn,
    ready: !!nodeRuntime.ok && bundle && signedIn,
    credentialsPath: freePiCredentialsPath(),
    consent: CONSENT_TEXT,
    consentVersion: CONSENT_VERSION,
    version: app.getVersion(),
    platform: process.platform
  };
}

function runStreamed(command, args, step) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: true, env: process.env });
    } catch (err) {
      reject(err);
      return;
    }
    let tail = '';
    const onData = (chunk) => {
      const text = stripAnsi(chunk.toString('utf8'));
      tail = (tail + text).slice(-6000);
      for (const line of text.split(/\r?\n/)) {
        const clean = line.trim();
        if (clean) setupEmit(step, 'log', { line: clean.slice(0, 300) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(tail);
      else reject(new Error('The installer exited with code ' + code + '. ' + tail.trim().slice(-800)));
    });
  });
}

async function setupInstallNode() {
  refreshPath();
  if (probeNodeRuntime().ok) return runtimeStatus();
  const winget = findWinget();
  if (!winget) {
    throw new Error('winget is unavailable. Install Node.js 22 LTS from https://nodejs.org/en/download and try again.');
  }
  setupEmit('node', 'start', { label: 'Installing Node.js LTS with winget…' });
  await runStreamed(
    winget,
    [
      'install',
      '--id',
      'OpenJS.NodeJS.LTS',
      '-e',
      '--source',
      'winget',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity'
    ],
    'node'
  );
  refreshPath();
  const status = runtimeStatus();
  setupEmit('node', 'done', { status });
  if (!status.node.ok) throw new Error('Node.js was installed but is still not visible. Restart Pi Harness.');
  return status;
}

async function setupInstallCli() {
  refreshPath();
  if (!probeNodeRuntime().ok) throw new Error('Install Node.js first.');
  if (!probeCommand('npm', ['--version']).found) throw new Error('npm is missing. Reinstall Node.js LTS.');
  setupEmit('cli', 'start', { label: 'Installing the Free-Pi runtime…' });
  await runStreamed('npm', ['install', '-g', 'free-pi-cli@latest'], 'cli');
  piBundlePath = null;
  refreshPath();
  const status = runtimeStatus();
  setupEmit('cli', 'done', { status });
  if (!status.bundle) throw new Error('The Free-Pi runtime was installed but its agent bundle was not found. Try again.');
  return status;
}

function authPost(pathname, body, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || 20000);
  return fetch(FREEPI_BASE_URL + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-client-version': piClientVersion
    },
    body: JSON.stringify(body || {}),
    signal: controller.signal
  })
    .then(async (res) => {
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      return { ok: res.ok, status: res.status, data };
    })
    .finally(() => clearTimeout(timer));
}

function describeApiReply(reply) {
  const data = (reply && reply.data) || {};
  const reason = data.message || data.error || data.code || data.raw || '';
  return (reply ? reply.status + ' ' : '') + String(reason).slice(0, 300);
}

function saveAuthToken(token) {
  const target = freePiCredentialsPath();
  const dir = path.dirname(target);
  ensureDir(dir);
  const issuer = new URL(FREEPI_BASE_URL).origin;
  const payload = JSON.stringify({ token, issuer });
  const tmp = path.join(dir, '.credentials.save-' + require('crypto').randomUUID());
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' });
  } catch {
    fs.writeFileSync(tmp, payload);
  }
  fs.renameSync(tmp, target);
}

async function restartEverything() {
  stopAllEngines();
  apiCache.account = null;
  apiCache.accountAt = 0;
  apiCache.catalog = null;
  apiCache.catalogAt = 0;
  if (engine.root) {
    await ensureEngine().catch(() => {});
  }
  refreshAccount(true).catch(() => {});
}

async function setupLogin() {
  refreshPath();
  if (setupState.login && setupState.login.running) throw new Error('Sign-in is already running.');
  if (!resolvePiBundle() && !findFreePiInstall()) throw new Error('Install the Free-Pi runtime first.');

  const session = { running: true, cancelled: false };
  setupState.login = session;
  try {
    const started = await authPost('/auth/github/device', {}, 20000);
    if (!started.ok) throw new Error('Could not start sign-in: ' + describeApiReply(started));
    const device = started.data || {};
    if (!device.session_id) throw new Error('The sign-in service returned an unexpected reply.');
    const code = String(device.user_code || '');
    let url = String(device.verification_uri_complete || device.verification_uri || '');
    if (!url) throw new Error('The sign-in service did not return a verification link.');

    setupEmit('login', 'code', {
      url,
      code,
      expiresIn: Number(device.expires_in) || 900,
      line: 'Waiting for GitHub…'
    });
    try {
      clipboard.writeText(code);
    } catch {
      /* clipboard is optional */
    }
    try {
      await shell.openExternal(url);
    } catch {
      /* the user can press the link again */
    }

    const consent = await authPost(
      '/auth/consent',
      { session_id: device.session_id, consent_version: CONSENT_VERSION },
      20000
    ).catch(() => null);
    if (!consent || !consent.ok) setupEmit('login', 'log', { line: 'Consent was not recorded yet; still waiting.' });

    const deadline = Date.now() + Math.min(Number(device.expires_in) || 900, 600) * 1000;
    let interval = Math.max(2, Number(device.interval) || 5) * 1000;
    let failures = 0;
    let lastOpened = false;

    while (Date.now() < deadline) {
      await sleep(Math.min(interval, Math.max(1000, deadline - Date.now())));
      if (session.cancelled) throw new Error('Sign-in cancelled.');
      let reply = null;
      try {
        reply = await authPost(
          '/auth/token',
          {
            session_id: device.session_id,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
            locale: String(app.getLocale() || '')
          },
          20000
        );
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= 6) throw new Error('The sign-in server is unreachable.');
        continue;
      }
      const data = reply.data || {};
      if (reply.ok && typeof data.token === 'string' && data.token.length > 10) {
        saveAuthToken(data.token);
        session.running = false;
        setupEmit('login', 'done', { signedIn: true, line: 'Signed in to free-pi.' });
        await restartEverything();
        return { ok: true, status: runtimeStatus() };
      }
      if (reply.status === 410) throw new Error('The sign-in code expired. Start again.');
      if (reply.status === 403) {
        if (data.error === 'consent_required') {
          await authPost(
            '/auth/consent',
            { session_id: device.session_id, consent_version: CONSENT_VERSION },
            20000
          ).catch(() => null);
          continue;
        }
        throw new Error('Sign-in was declined in the browser.');
      }
      if (data.retry_after) interval = Math.max(2, Number(data.retry_after) || 5) * 1000;
      if (data.status === 'pending') {
        if (data.opened === true && !lastOpened) {
          lastOpened = true;
          setupEmit('login', 'waiting', { line: 'GitHub opened. Finish signing in there.' });
        }
        continue;
      }
    }
    throw new Error('Sign-in timed out. Start again.');
  } finally {
    session.running = false;
    if (setupState.login === session) setupState.login = null;
  }
}

function setupCancelLogin() {
  if (setupState.login) setupState.login.cancelled = true;
  return { ok: true };
}

/* -------------------------------------------------------------- IPC wire */

function registerIpc() {
  ipcMain.handle('app:init', async () => {
    loadAppState();
    const runtime = runtimeStatus();
    const sessions = sessionsAll();
    if (projectRoot) activateEngine(engine.key || 'default', engine.root || projectRoot);
    const catalog = runtime.ready
      ? await modelCatalog().catch(() => ({ models: [], defaultModel: DEFAULT_MODEL }))
      : { models: [], defaultModel: DEFAULT_MODEL };
    const engineInfo = engineStatus();
    const account = runtime.ready ? await refreshAccount(false).catch(() => null) : null;
    const ad = runtime.ready ? await refreshAd(false).catch(() => null) : null;
    return {
      projectRoot,
      name: projectRoot ? safeBasename(projectRoot) : '',
      files: projectRoot ? listProjectFiles(projectRoot) : [],
      sessions,
      signedIn: runtime.signedIn,
      runtime,
      setupReady: runtime.ready,
      catalog,
      account,
      ad,
      platform: process.platform,
      home: os.homedir(),
      engine: engineInfo
    };
  });

  ipcMain.handle('setup:status', () => runtimeStatus());
  ipcMain.handle('setup:install-node', async () => {
    try {
      return { ok: true, status: await setupInstallNode() };
    } catch (err) {
      setupEmit('node', 'error', { line: err.message });
      return { ok: false, error: err.message, status: runtimeStatus() };
    }
  });
  ipcMain.handle('setup:install-cli', async () => {
    try {
      return { ok: true, status: await setupInstallCli() };
    } catch (err) {
      setupEmit('cli', 'error', { line: err.message });
      return { ok: false, error: err.message, status: runtimeStatus() };
    }
  });
  ipcMain.handle('setup:login', async () => {
    try {
      return await setupLogin();
    } catch (err) {
      setupEmit('login', 'error', { line: err.message });
      return { ok: false, error: err.message, status: runtimeStatus() };
    }
  });
  ipcMain.handle('setup:cancel-login', () => setupCancelLogin());

  ipcMain.handle('project:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Open project folder',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const summary = openProject(result.filePaths[0]);
    const existing = loadSessions().find((s) => s && s.projectRoot === summary.projectRoot);
    const record = existing || upsertSession(newSessionRecord(summary.name || 'New session'));
    activateEngine(record.id, summary.projectRoot);
    const spawned = await ensureEngine().catch((err) => ({ error: err.message }));
    refreshAd(true).catch(() => {});
    return {
      canceled: false,
      projectRoot: summary.projectRoot,
      name: summary.name,
      files: summary.files,
      sessionId: record.id,
      session: { id: record.id, title: record.title, updatedAt: record.updatedAt },
      sessions: sessionsAll(),
      engine: spawned && spawned.error ? Object.assign(engineStatus(), { error: spawned.error }) : engineStatus()
    };
  });

  ipcMain.handle('project:files', () => ({ files: projectRoot ? listProjectFiles(projectRoot) : [] }));
  ipcMain.handle('project:initAgents', async () => Object.assign({ ok: true }, await initAgentsMd()));
  ipcMain.handle('git:undo', () => gitUndo());
  ipcMain.handle('app:open', (_e, url) => openExternalUrl(url));
  ipcMain.handle('app:reveal', (_e, payload) => {
    const abs = payload && payload.path ? resolveInProject(payload.path) : projectRoot;
    if (abs) shell.showItemInFolder(abs);
    return { ok: true };
  });

  ipcMain.handle('shot:save', async (_e, payload) => {
    const dataUrl = String((payload && payload.dataUrl) || '');
    const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
    if (!match) throw new Error('Unsupported image data.');
    ensureDir(shotsDir());
    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    const abs = path.join(shotsDir(), 'shot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext);
    await fsp.writeFile(abs, Buffer.from(match[2], 'base64'));
    return { path: abs, dataUrl };
  });

  ipcMain.handle('engine:status', () => Object.assign(engineStatus(), { pool: poolStatus() }));
  ipcMain.handle('engine:restart', async () => {
    await restartEngine().catch((err) => notice(err.message, 'error'));
    return engineStatus();
  });
  ipcMain.handle('engine:ensure', async () => {
    await ensureEngine();
    return engineStatus();
  });

  ipcMain.handle('rpc:call', async (_e, payload) => {
    const body = payload || {};
    const type = String(body.type || '');
    const allowed = new Set([
      'get_state', 'get_messages', 'get_session_stats', 'get_available_models', 'get_available_thinking_levels',
      'get_commands', 'get_tree', 'get_entries', 'get_fork_messages', 'get_last_assistant_text',
      'new_session', 'switch_session', 'fork', 'clone', 'compact', 'set_model', 'cycle_model',
      'set_thinking_level', 'cycle_thinking_level', 'set_steering_mode', 'set_follow_up_mode',
      'set_auto_compaction', 'set_auto_retry', 'abort_retry', 'set_session_name', 'export_html',
      'clear_queue', 'abort'
    ]);
    if (!allowed.has(type)) throw new Error('Unsupported agent command: ' + type);
    await ensureEngine();
    const fields = Object.assign({}, body);
    delete fields.type;
    const data = await engineCall(type, fields, 90000);
    if (type === 'set_model' && data) {
      engine.currentModel = data;
      emit('engine', { state: 'model', info: engineStatus() });
    }
    if (type === 'cycle_model' && data && data.model) {
      engine.currentModel = data.model;
      emit('engine', { state: 'model', info: engineStatus() });
    }
    if (type === 'set_thinking_level' && fields.level) {
      engine.thinking = fields.level;
    }
    if (type === 'cycle_thinking_level' && data && data.level) {
      engine.thinking = data.level;
    }
    return data;
  });

  ipcMain.handle('chat:send', async (_e, payload) => {
    try {
      return await sendChat(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('chat:abort', () => abortChat());
  ipcMain.handle('chat:bash', async (_e, payload) => {
    const body = payload || {};
    try {
      if (body.local) return await runLocalBash(body.command);
      return await runRemoteBash(body.command, body.excludeFromContext);
    } catch (err) {
      return { ok: false, error: err.message, output: '' };
    }
  });

  ipcMain.handle('session:new', (_e, payload) => {
    const record = newSessionRecord(payload && payload.title);
    upsertSession(record);
    if (projectRoot) activateEngine(record.id, projectRoot);
    return {
      session: {
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        messages: 0,
        projectRoot: record.projectRoot
      },
      sessionId: record.id,
      sessions: sessionsAll()
    };
  });
  ipcMain.handle('session:list', () => ({ sessions: sessionsAll() }));
  ipcMain.handle('session:load', async (_e, payload) => {
    const id = String((payload && payload.id) || '');
    const found = loadSessions().find((s) => s && s.id === id);
    if (!found) throw new Error('Session not found.');
    activateEngine(id, found.projectRoot || projectRoot);
    let engineInfo = engineStatus();
    if (engine.root && runtimeStatus().ready) {
      const spawned = await ensureEngine().catch((err) => ({ error: err.message }));
      engineInfo = spawned && spawned.error ? Object.assign(engineStatus(), { error: spawned.error }) : engineStatus();
    }
    return {
      session: found,
      projectRoot: engine.root || projectRoot,
      name: engine.root ? safeBasename(engine.root) : '',
      files: engine.root ? listProjectFiles(engine.root) : [],
      engine: engineInfo,
      sessions: sessionsAll()
    };
  });
  ipcMain.handle('session:activate', async (_e, payload) => {
    const id = String((payload && payload.id) || '');
    const found = loadSessions().find((s) => s && s.id === id);
    if (!found) throw new Error('Session not found.');
    activateEngine(id, found.projectRoot || projectRoot);
    let engineInfo = engineStatus();
    if (engine.root && runtimeStatus().ready) {
      const spawned = await ensureEngine().catch((err) => ({ error: err.message }));
      engineInfo = spawned && spawned.error ? Object.assign(engineStatus(), { error: spawned.error }) : engineStatus();
    }
    return {
      session: found,
      projectRoot: engine.root || projectRoot,
      name: engine.root ? safeBasename(engine.root) : '',
      files: engine.root ? listProjectFiles(engine.root) : [],
      engine: engineInfo,
      sessions: sessionsAll()
    };
  });
  ipcMain.handle('session:save', (_e, payload) => {
    const record = payload && payload.session;
    if (!record || !record.id) throw new Error('Session id is required.');
    const merged = Object.assign({}, record, { projectRoot: record.projectRoot || projectRoot });
    return { session: upsertSession(merged), sessions: sessionsAll() };
  });
  ipcMain.handle('session:delete', async (_e, payload) => {
    const id = String((payload && payload.id) || '');
    loadSessions();
    sessionsCache = sessionsCache.filter((s) => !(s && s.id === id));
    saveSessions();
    if (enginePool.has(id) || engine.key === id) await stopEngineByKey(id);
    return { sessions: sessionsAll() };
  });
  ipcMain.handle('session:close', async (_e, payload) => {
    const id = String((payload && payload.id) || '');
    await stopEngineByKey(id);
    return { ok: true, sessions: sessionsAll() };
  });
  ipcMain.handle('session:export', () => exportSession());

  ipcMain.handle('svc:account', () => refreshAccount(true));
  ipcMain.handle('svc:ad', () => refreshAd(true));
  ipcMain.handle('svc:ad-click', async (_e, payload) => {
    const ad = (payload && payload.ad) || apiCache.ad;
    if (!ad || !ad.url) throw new Error('No sponsored link is available right now.');
    await adImpression(ad);
    await openExternalUrl(ad.url);
    return { ok: true };
  });
  ipcMain.handle('svc:ad-impression', () => adImpression(apiCache.ad));
  ipcMain.handle('svc:referral', () => referralInfo());
  ipcMain.handle('svc:referral-status', () => referralStatus());
  ipcMain.handle('svc:redeem', (_e, payload) => redeemCode(payload && payload.code));
  ipcMain.handle('svc:close-other-session', () => closeOtherSession());
  ipcMain.handle('svc:update', () => updateCli());
  ipcMain.handle('svc:logout', async () => {
    const result = await logoutCli();
    stopAllEngines();
    emit('engine', { state: 'stopped', info: engineStatus() });
    return result;
  });
  ipcMain.handle('svc:open', (_e, payload) => {
    const what = String((payload && payload.what) || '');
    const map = {
      buy: (apiCache.account && apiCache.account.buyUrl) || FREEPI_WEB + '/buy',
      support: (apiCache.ad && apiCache.ad.url) || FREEPI_WEB,
      tos: FREEPI_WEB + '/terms',
      privacy: FREEPI_WEB + '/privacy',
      dashboard: FREEPI_WEB + '/dashboard',
      referral: FREEPI_WEB + '/?ref=' + encodeURIComponent((payload && payload.code) || '')
    };
    const url = map[what];
    if (!url) throw new Error('Unknown link: ' + what);
    return openExternalUrl(url);
  });

  ipcMain.handle('clipboard:read-image', () => {
    const image = clipboard.readImage();
    if (!image || image.isEmpty()) return null;
    return image.toDataURL();
  });

  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win:close', () => win && win.close());
  ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));
}

/* --------------------------------------------------------------- startup */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.setAppUserModelId('com.piharness.app');

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    loadAppState();
    probeNodeRuntime();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopAllEngines();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
