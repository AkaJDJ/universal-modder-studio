import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, access, mkdir, unlink, readdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(process.env.UM_STUDIO_ASSET_DIR || APP_DIR);
const DATA_DIR = path.resolve(process.env.UM_STUDIO_DATA_DIR || APP_DIR);
const REPO_DIR = path.resolve(process.env.UNIVERSAL_MODDER_REPO || (process.env.UM_STUDIO_PACKAGED === '1'
  ? path.join(DATA_DIR, 'universal-modder')
  : path.join(APP_DIR, '..', '..', 'universal-modder')));
const WORKSPACE = path.join(DATA_DIR, 'workspace');
const PID_FILE = path.join(WORKSPACE, 'server.pid');
const STATE_FILE = path.join(DATA_DIR, 'studio-state.json');
const PORT = Number(process.env.UM_STUDIO_PORT ?? 8765);
const APP_KEY = randomBytes(24).toString('hex');
const USER_HOME = os.homedir();
const UV_INSTALL_DIR = path.join(DATA_DIR, 'tools');
const UM_EXE = process.env.UM_EXE || path.join(USER_HOME, '.local', 'bin', 'um.exe');
const UV_EXE = process.env.UV_EXE || path.join(USER_HOME, '.local', 'bin', 'uv.exe');
async function locateCodex() {
  if (process.env.CODEX_EXE) return process.env.CODEX_EXE;
  const searchDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.env.LOCALAPPDATA) {
    const installRoot = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const builds = (await readdir(installRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(installRoot, entry.name))
        .reverse();
      searchDirs.push(...builds);
    } catch { /* Codex may be installed elsewhere */ }
  }
  for (const folder of searchDirs) {
    const candidate = path.join(folder, 'codex.exe');
    if (await exists(candidate)) return candidate;
  }
  return 'codex';
}
let CODEX_EXE = await locateCodex();

await mkdir(WORKSPACE, { recursive: true });
await writeFile(PID_FILE, String(process.pid), 'utf8');

function send(res, status, value, type = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(value) ? value : (typeof value === 'string' ? value : JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
  });
  res.end(body);
}

async function readBody(req, maximum = 80_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maximum) throw new Error('Request is too large.');
  }
  return body ? JSON.parse(body) : {};
}

function run(executable, args, cwd, timeoutMs = 90_000, stdinText = null, env = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, ...env } });
    if (stdinText !== null) child.stdin?.end(stdinText);
    else child.stdin?.end();
    const finish = (code, out, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    };
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
        finish(124, stdout, stderr + '\nStopped after ' + Math.round(timeoutMs / 1000) + ' seconds.');
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-500_000); });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-120_000); });
    child.on('error', (error) => finish(127, stdout, stderr + '\n' + error.message));
    child.on('close', (code) => finish(code ?? 1, stdout, stderr));
  });
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function quotePowerShell(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function locateUm() {
  if (process.env.UM_EXE) return process.env.UM_EXE;
  const candidates = [
    path.join(USER_HOME, '.local', 'bin', 'um.exe'),
    path.join(USER_HOME, '.local', 'bin', 'um'),
    path.join(process.env.LOCALAPPDATA || USER_HOME, 'Programs', 'Python', 'Scripts', 'um.exe'),
    path.join(path.dirname(UV_EXE), 'um.exe'),
  ];
  for (const folder of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(folder, 'um.exe'), path.join(folder, 'um.cmd'));
  }
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return candidates[0];
}

function locateUmPython() {
  const toolDir = process.env.UV_TOOL_DIR || path.join(process.env.APPDATA || USER_HOME, 'uv', 'tools');
  return path.join(toolDir, 'universal-modder', 'Scripts', 'python.exe');
}

async function runUm(executable, args, cwd, timeoutMs = 90_000) {
  const result = await run(executable, args, cwd, timeoutMs);
  const output = (result.stdout + '\n' + result.stderr).trim();
  if (result.code === 0 || !/uv trampoline failed to canonicalize script path/i.test(output)) return result;

  const python = locateUmPython();
  if (!(await exists(python))) return result;

  const fallback = await run(python, ['-c', 'from um.cli import main; main()', ...args], cwd, timeoutMs);
  if (fallback.code === 0) return fallback;
  return {
    ...fallback,
    stderr: [fallback.stderr.trim(), 'The Universal Modder launcher also failed: ' + output].filter(Boolean).join('\n'),
  };
}

async function locateUv() {
  if (process.env.UV_EXE && await exists(process.env.UV_EXE)) return process.env.UV_EXE;
  const candidates = [
    UV_EXE,
    path.join(process.env.LOCALAPPDATA || USER_HOME, 'Programs', 'uv', 'uv.exe'),
    path.join(UV_INSTALL_DIR, 'uv.exe'),
  ];
  for (const folder of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(folder, 'uv.exe'));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return '';
}

async function codexLoginStatus() {
  CODEX_EXE = await locateCodex();
  if (CODEX_EXE === 'codex') return { available: false, loggedIn: false, detail: 'Codex CLI was not found.' };
  const result = await run(CODEX_EXE, ['login', 'status'], WORKSPACE, 25_000);
  return {
    available: true,
    loggedIn: result.code === 0 && /logged in|authenticated/i.test(result.stdout + '\n' + result.stderr),
    detail: (result.stdout || result.stderr).trim().slice(0, 800),
  };
}

async function universalModderStatus() {
  const codex = await codexLoginStatus();
  let pluginAvailable = false;
  if (codex.available) {
    const result = await run(CODEX_EXE, ['plugin', 'list', '--marketplace', 'universal-modder', '--json'], WORKSPACE, 35_000);
    try {
      const report = JSON.parse(result.stdout);
      pluginAvailable = (report.installed || []).some((plugin) => plugin.name === 'universal-modder' && plugin.installed && plugin.enabled);
    } catch { /* The marketplace can be offline while local tools are still usable. */ }
  }
  return {
    repoAvailable: await exists(REPO_DIR),
    umAvailable: await exists(await locateUm()),
    pluginAvailable,
    codexAvailable: codex.available,
    loggedIn: codex.loggedIn,
    codexDetail: codex.detail,
    repoName: path.basename(REPO_DIR),
    workspace: WORKSPACE,
    repoPath: REPO_DIR,
  };
}

async function downloadUniversalModder() {
  if (await exists(path.join(REPO_DIR, 'pyproject.toml')) && await exists(path.join(REPO_DIR, '.agents', 'plugins', 'marketplace.json'))) return;
  const zipPath = path.join(DATA_DIR, 'universal-modder-download.zip');
  const extractRoot = path.join(DATA_DIR, 'universal-modder-unpack');
  await mkdir(DATA_DIR, { recursive: true });
  const response = await fetch('https://github.com/rehan-remade/universal-modder/archive/refs/heads/main.zip', { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error('Could not download Universal Modder from GitHub (HTTP ' + response.status + ').');
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  await rm(extractRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  const unpack = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath ' + quotePowerShell(zipPath) + ' -DestinationPath ' + quotePowerShell(extractRoot) + ' -Force'], DATA_DIR, 180_000);
  if (unpack.code !== 0) throw new Error('Could not unpack the Universal Modder files. ' + (unpack.stderr || unpack.stdout).trim().slice(-1200));
  const entries = await readdir(extractRoot, { withFileTypes: true });
  const sourceRoot = entries.find((entry) => entry.isDirectory());
  if (!sourceRoot || !(await exists(path.join(extractRoot, sourceRoot.name, 'pyproject.toml')))) throw new Error('The downloaded Universal Modder archive did not contain its project files.');
  if (await exists(REPO_DIR)) {
    const existingContents = await readdir(REPO_DIR);
    if (existingContents.length) throw new Error('A folder already exists at ' + REPO_DIR + ' but it is not a complete Universal Modder checkout. Nothing in that folder was changed. Move it or choose another setup folder, then retry.');
    await rm(REPO_DIR, { recursive: false });
  }
  await mkdir(path.dirname(REPO_DIR), { recursive: true });
  await rename(path.join(extractRoot, sourceRoot.name), REPO_DIR);
  await rm(extractRoot, { recursive: true, force: true });
  await unlink(zipPath);
}

async function ensureUv() {
  let executable = await locateUv();
  if (executable) return executable;
  await mkdir(UV_INSTALL_DIR, { recursive: true });
  const scriptPath = path.join(DATA_DIR, 'uv-install.ps1');
  const response = await fetch('https://astral.sh/uv/install.ps1', { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error('Could not download the official uv installer (HTTP ' + response.status + ').');
  await writeFile(scriptPath, await response.text(), 'utf8');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], DATA_DIR, 180_000, null, {
    UV_INSTALL_DIR,
    UV_NO_MODIFY_PATH: '1',
  });
  try { await unlink(scriptPath); } catch { /* keep setup moving */ }
  if (result.code !== 0) throw new Error('The official uv installer did not finish. ' + (result.stderr || result.stdout).trim().slice(-1200));
  executable = await locateUv();
  if (!executable) executable = path.join(UV_INSTALL_DIR, 'uv.exe');
  if (!(await exists(executable))) throw new Error('uv installed, but its executable was not found.');
  return executable;
}

async function installUniversalModder() {
  const auth = await codexLoginStatus();
  if (!auth.available) throw new Error('Install Codex first, then sign in with your ChatGPT account.');
  if (!auth.loggedIn) throw new Error('Sign in to Codex before installing Universal Modder.');
  await downloadUniversalModder();
  const status = await universalModderStatus();
  if (!status.umAvailable) {
    const uv = await ensureUv();
    const result = await run(uv, ['tool', 'install', '--from', REPO_DIR, 'universal-modder'], REPO_DIR, 900_000);
    if (result.code !== 0) throw new Error('Universal Modder could not be installed. ' + (result.stderr || result.stdout).trim().slice(-2400));
  }
  const refreshed = await universalModderStatus();
  if (!refreshed.pluginAvailable) {
    const market = await run(CODEX_EXE, ['plugin', 'marketplace', 'add', REPO_DIR, '--json'], REPO_DIR, 180_000);
    if (market.code !== 0 && !/already exists|already configured/i.test(market.stderr + '\n' + market.stdout)) {
      throw new Error('The Universal Modder plugin source could not be added. ' + (market.stderr || market.stdout).trim().slice(-1800));
    }
    const plugin = await run(CODEX_EXE, ['plugin', 'add', 'universal-modder@universal-modder', '--json'], REPO_DIR, 240_000);
    if (plugin.code !== 0) throw new Error('The Universal Modder Codex plugin could not be installed. ' + (plugin.stderr || plugin.stdout).trim().slice(-1800));
  }
  return await universalModderStatus();
}

async function openCodexLogin() {
  CODEX_EXE = await locateCodex();
  if (CODEX_EXE === 'codex') throw new Error('Codex CLI was not found. Install Codex, then choose Refresh setup.');
  const command = '& ' + quotePowerShell(CODEX_EXE) + ' login; Write-Host "Return to Universal Modder Studio when sign-in finishes."';
  const child = spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', command], { windowsHide: false, stdio: 'inherit', shell: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

function parseGameNames(raw) {
  let games;
  try { games = JSON.parse(raw); } catch { games = null; }
  const names = Array.isArray(games)
    ? games.map((game) => typeof game === 'string' ? game : game?.name)
    : raw.split(/\r?\n/)
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter((line) => line && !/^(installed games?|games? found|name\s+path|[-=]+|scan complete|no games)/i.test(line))
      .map((line) => {
        const row = line.match(/^(steam|epic|xbox)\s+(.*?)\s{2}(.+?)\s{2}->\s*(.+)$/i);
        if (row) return row[3].trim();
        return line.split(/\s{2,}|\t/)[0].replace(/^[-*•]\s*/, '').trim();
      });
  const seen = new Set();
  return names.map((name) => String(name || '').trim()).filter((name) => {
    const key = name.toLocaleLowerCase();
    if (name.length < 2 || name.length > 160 || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 100);
}

const SYSTEM_PROMPT = 'You are the Codex-based guide inside Universal Modder Studio. The user has Universal Modder installed as a Codex plugin. Use its installed skills when relevant, especially mod-any-game, mashup-mods, game-recon, and share-field-notes. The local checkout is at ' + REPO_DIR + '; the local CLI is ' + UM_EXE + '. The app\'s only writable project area is ' + WORKSPACE + '.\n\n' +
  'Workflow and safety: read the relevant local Universal Modder guidance before planning a real mod. For game pairs, first establish what content or behavior should cross over and whether the guest should run, then choose the lightest route (port content, passthrough, or rebuild) and identify game versions/platforms. Only work with games the user owns. Keep work offline/single-player or on servers they control; never modify protected online clients, bypass anti-cheat/DRM/ownership, or ship game files/decompiled assets. Do not install loaders into game folders, alter the registry, touch saves, launch/drive games, or publish without explicit user approval. Do not claim success without in-game verification.\n\n' +
  'In question mode, ask one useful follow-up at a time, tailored to everything already said. Avoid generic questionnaires and don\'t repeat answered questions. For the fusion flow, the user already chose a base game: ask about the specific guest-game content/mechanics they want inside it, then only ask for missing details that change the route. For single-game mode, clarify the mod\'s behavior and target game details. Keep it conversational and concise. When you have enough details, summarize a concrete plan and ask before creating/modifying files.\n\n' +
  'In build mode, act only after this explicit in-app Build action. Make a first playable slice under the app workspace, use Universal Modder commands where useful, write a MODLOG.md, and report what you created and what still needs real-game verification. Do not write outside the app workspace.';

async function askCodex(payload) {
  const isBuild = Boolean(payload.build);
  const flow = payload.flow === 'single' ? 'Single game modding' : 'Two-game fusion';
  const chat = Array.isArray(payload.messages) ? payload.messages.slice(-24) : [];
  const context = {
    flow,
    games: payload.games || [],
    baseGame: payload.baseGame || '',
    guestGame: payload.guestGame || '',
    modIdea: payload.modIdea || '',
    options: payload.options || {},
  };
  const transcript = chat.map((m) => (m.role === 'assistant' ? 'Guide: ' : 'Player: ') + String(m.content || '').slice(0, 3500)).join('\n\n');
  const currentUm = await locateUm();
  const prompt = SYSTEM_PROMPT.replace(UM_EXE, currentUm) + '\n\nMODE: ' + (isBuild ? 'BUILD — the user explicitly clicked Build. Proceed only if enough details are settled; otherwise ask the next needed question.' : 'FOLLOW-UP — no files may be created or changed.') +
    '\n\nPROJECT CONTEXT (JSON):\n' + JSON.stringify(context, null, 2) + '\n\nCONVERSATION SO FAR:\n' + (transcript || '(No messages yet.)') +
    '\n\nRespond as the next assistant turn. In follow-up mode, ask one targeted question or give a short plan and ask for confirmation. In build mode, start the scoped first slice if safe and sufficiently specified; otherwise explain what is still needed.';

  if (!(await exists(REPO_DIR))) return { answer: 'Universal Modder setup is missing. Open the setup prompt to install it before continuing.', session: false };
  const auth = await codexLoginStatus();
  if (!auth.loggedIn) return { answer: 'Sign in to Codex to use the AI guide. Select the connection status at the top of the app to sign in.', session: false };
  const outputPath = path.join(WORKSPACE, '.assistant-' + Date.now() + '-' + randomBytes(3).toString('hex') + '.txt');
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', isBuild ? 'workspace-write' : 'read-only', '--cd', WORKSPACE, '--output-last-message', outputPath, '-'];
  const result = await run(CODEX_EXE, args, WORKSPACE, isBuild ? 240_000 : 120_000, prompt);
  let answer = '';
  try { answer = await readFile(outputPath, 'utf8'); } catch { /* use CLI output below */ }
  try { await unlink(outputPath); } catch { /* no output file to remove */ }
  if (!answer.trim()) answer = result.stdout.trim() || result.stderr.trim();
  if (!answer.trim()) answer = 'Codex finished with code ' + result.code + ', but did not return a message.';
  return { answer: answer.trim(), session: true, code: result.code, error: result.code === 0 ? '' : result.stderr.trim() };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    send(res, 200, { key: APP_KEY, ...(await universalModderStatus()) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    try { send(res, 200, await readFile(STATE_FILE, 'utf8')); }
    catch { send(res, 200, null); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/games') {
    const um = await locateUm();
    const available = await exists(um);
    if (!available) return send(res, 200, { games: [], raw: '', error: 'Universal Modder is not installed yet. Open setup from the connection status.' });
    const result = await runUm(um, ['scan', '--list', '--json'], REPO_DIR, 45_000);
    const raw = (result.stdout + (result.stderr ? '\n' + result.stderr : '')).trim();
    send(res, 200, { games: parseGameNames(result.stdout), raw, error: result.code === 0 ? '' : 'Game detection did not finish cleanly. You can type a game name manually.' });
    return;
  }
  if (req.method !== 'GET' && url.pathname.startsWith('/api/')) {
    if (req.headers['x-um-studio-key'] !== APP_KEY) return send(res, 403, { error: 'This app session is no longer valid. Restart the app.' });
    let payload;
    try { payload = await readBody(req, url.pathname === '/api/state' ? 500_000 : 80_000); } catch (error) { return send(res, 400, { error: error.message || 'Invalid request.' }); }
    if (req.method !== 'POST') return send(res, 405, { error: 'Unsupported request.' });

    if (url.pathname === '/api/state') {
      try { await writeFile(STATE_FILE, JSON.stringify(payload), 'utf8'); send(res, 200, { saved: true }); }
      catch (error) { send(res, 500, { error: error.message || 'Could not save app state.' }); }
      return;
    }
    if (url.pathname === '/api/auth/login') {
      try { await openCodexLogin(); send(res, 200, { opened: true }); }
      catch (error) { send(res, 200, { error: error.message }); }
      return;
    }
    if (url.pathname === '/api/auth/status') {
      send(res, 200, await codexLoginStatus());
      return;
    }
    if (url.pathname === '/api/setup/install') {
      try { send(res, 200, { installed: await installUniversalModder() }); }
      catch (error) { send(res, 200, { error: error.message || 'Universal Modder setup did not finish.' }); }
      return;
    }
    if (url.pathname === '/api/assistant') {
      const result = await askCodex(payload);
      send(res, 200, result);
      return;
    }
    if (url.pathname === '/api/command') {
      const um = await locateUm();
      if (!(await exists(um))) return send(res, 200, { code: 127, stdout: '', stderr: 'Universal Modder CLI is not installed. Open setup from the connection status.' });
      const action = String(payload.action || '');
      let args;
      let cwd = REPO_DIR;
      if (action === 'scan-list') args = ['scan', '--list'];
      else if (action === 'scan' && String(payload.game || '').trim()) args = ['scan', String(payload.game).trim()];
      else if (action === 'kb-search' && String(payload.query || '').trim()) args = ['kb', 'search', String(payload.query).trim()];
      else if (action === 'publish-check') { args = ['publish', 'check', '.']; cwd = WORKSPACE; }
      else return send(res, 400, { error: 'Choose a supported Universal Modder command.' });
      const result = await runUm(um, args, cwd, 120_000);
      send(res, 200, { ...result, command: 'um ' + args.join(' ') });
      return;
    }
    return send(res, 404, { error: 'Unknown app endpoint.' });
  }

  const file = url.pathname === '/' ? 'index.html' : path.basename(decodeURIComponent(url.pathname));
  if (!['index.html', 'app.js', 'styles.css'].includes(file)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  try {
    const data = await readFile(path.join(ASSET_DIR, file));
    const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
    send(res, 200, data, types[file]);
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  console.log('Universal Modder Studio is ready at http://127.0.0.1:' + (typeof address === 'object' ? address.port : PORT));
});

server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function shutDown() {
  try { await unlink(PID_FILE); } catch { /* file may already be gone */ }
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

if (process.env.UM_STUDIO_PACKAGED !== '1') {
  process.on('SIGINT', () => { void shutDown().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { void shutDown().finally(() => process.exit(0)); });
}

export { server, APP_DIR, WORKSPACE, REPO_DIR, shutDown };
