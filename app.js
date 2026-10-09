const STORAGE_KEY = 'um-studio-state-v1';
let appKey = '';
let appConfig = null;
let gameLibrary = [];
let busy = false;
let toastTimer = null;
let setupConsentPending = false;
let setupBusy = false;
let setupPollTimer = null;
let setupPollCount = 0;
let stateSaveQueue = Promise.resolve();

const defaults = {
  view: 'fusion',
  fusion: { gameOne: '', gameTwo: '', baseGame: '', guestGame: '', begun: false, chosenBase: false, messages: [] },
  single: { game: '', idea: '', playMode: 'offline', assetPref: 'existing', platform: '', deliverable: 'working', knownTools: '', begun: false, messages: [] },
};
let state = loadState();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      ...defaults,
      ...saved,
      fusion: { ...defaults.fusion, ...(saved.fusion || {}) },
      single: { ...defaults.single, ...(saved.single || {}) },
    };
  } catch { return structuredClone(defaults); }
}

function persist() {
  const snapshot = JSON.stringify(state);
  try { localStorage.setItem(STORAGE_KEY, snapshot); } catch { /* App data storage remains available in desktop mode. */ }
  if (appKey) {
    stateSaveQueue = stateSaveQueue.catch(() => {}).then(() => api('/api/state', { method: 'POST', body: snapshot }));
  }
}

function $(id) { return document.getElementById(id); }

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setView(view) {
  state.view = view;
  persist();
  document.querySelectorAll('.page-view').forEach((node) => node.classList.toggle('active', node.id === 'view-' + view));
  document.querySelectorAll('.nav-item[data-view]').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
  const names = { fusion: 'GAME FUSION', single: 'SINGLE GAME', commands: 'COMMAND DECK', projects: 'MY WORKSPACE' };
  $('breadcrumb-title').textContent = names[view] || 'WORKBENCH';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderChat(flow) {
  const container = $(flow + '-messages');
  if (!container) return;
  container.replaceChildren();
  const messages = state[flow].messages || [];
  for (const message of messages) {
    const row = document.createElement('div');
    row.className = 'message-row ' + (message.role === 'user' ? 'user-row' : 'assistant-row');
    if (message.role !== 'user') {
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = '✳';
      row.append(avatar);
    }
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + (message.role === 'user' ? 'user-bubble' : 'assistant-message');
    const label = document.createElement('span');
    label.className = 'bubble-label';
    label.textContent = message.role === 'user' ? 'YOU' : 'UNIVERSAL MODDER';
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.content || '';
    bubble.append(label, text);
    row.append(bubble);
    container.append(row);
  }
  if (busy && state.view === flow) {
    const row = document.createElement('div');
    row.className = 'message-row assistant-row';
    row.innerHTML = '<div class="message-avatar">✳</div><div class="message-bubble assistant-message typing"><span class="bubble-label">UNIVERSAL MODDER</span><span class="typing-dots"><i></i><i></i><i></i></span><span class="typing-text">Thinking through the best route…</span></div>';
    container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}

function syncForms() {
  $('game-one').value = state.fusion.gameOne;
  $('game-two').value = state.fusion.gameTwo;
  $('single-game').value = state.single.game;
  $('mod-idea').value = state.single.idea;
  $('play-mode').value = state.single.playMode;
  $('asset-pref').value = state.single.assetPref;
  $('platform').value = state.single.platform;
  $('deliverable').value = state.single.deliverable;
  $('known-tools').value = state.single.knownTools;
  $('fusion-chat-stage').classList.toggle('hidden', !state.fusion.begun);
  $('single-chat-stage').classList.toggle('hidden', !state.single.begun);
  $('base-choice').classList.toggle('hidden', state.fusion.chosenBase);
  $('base-question').textContent = state.fusion.baseGame ? 'Which game do you want as the base?' : 'Which game do you want as the base?';
  $('base-options').replaceChildren();
  if (state.fusion.begun && !state.fusion.chosenBase) {
    [state.fusion.gameOne, state.fusion.gameTwo].forEach((game) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'base-option';
      button.innerHTML = '<span class="base-option-icon">◉</span><span><b>' + escapeHTML(game) + '</b><small>Make this the base game</small></span><span class="base-option-arrow">→</span>';
      button.addEventListener('click', () => chooseBase(game));
      $('base-options').append(button);
    });
  }
  if (state.fusion.chosenBase) $('fusion-chat-stage').classList.remove('hidden');
  if (state.single.begun) $('single-chat-stage').classList.remove('hidden');
  $('advanced-options').classList.toggle('hidden', !state.single.advanced);
  $('toggle-advanced').innerHTML = (state.single.advanced ? 'Fewer options <span>⌃</span>' : 'More options <span>⌄</span>');
  renderChat('fusion');
  renderChat('single');
}

function updateConnection() {
  const badge = $('connection');
  if (!appConfig) return;
  const toolsReady = appConfig.repoAvailable && appConfig.umAvailable && appConfig.pluginAvailable;
  const ready = toolsReady && appConfig.codexAvailable && appConfig.loggedIn;
  badge.classList.toggle('warning', !ready);
  const label = ready ? 'Local tools connected' : (!appConfig.codexAvailable ? 'Connect Codex' : (!appConfig.loggedIn ? 'Sign in to Codex' : 'Setup needed'));
  badge.innerHTML = '<span class="connection-dot"></span><span>' + label + '</span>';
  $('workspace-path').textContent = appConfig.workspace || 'App workspace';
  $('workspace-path').title = appConfig.workspace || '';
}

function setupNeeded() {
  return Boolean(appConfig && (!appConfig.repoAvailable || !appConfig.umAvailable || !appConfig.pluginAvailable));
}

function paintSetupStatus() {
  if (!appConfig) return;
  const entries = [
    ['Universal Modder files', appConfig.repoAvailable],
    ['Universal Modder command line', appConfig.umAvailable],
    ['Universal Modder Codex plugin', appConfig.pluginAvailable],
    ['Codex / ChatGPT sign-in', appConfig.loggedIn],
  ];
  $('setup-missing').replaceChildren(...entries.map(([label, ready]) => {
    const row = document.createElement('div');
    row.className = 'setup-missing-row' + (ready ? ' ready' : '');
    const indicator = document.createElement('i');
    const text = document.createElement('span');
    text.textContent = label + (ready ? ' · ready' : ' · needed');
    row.append(indicator, text);
    return row;
  }));
  const missing = setupNeeded();
  $('setup-title').textContent = missing ? 'Connect Universal Modder' : (appConfig.loggedIn ? 'Everything is ready' : 'Connect your Codex account');
  $('setup-copy').textContent = missing
    ? 'Some Universal Modder files are missing. Choose Yes and sign in to Codex to install them automatically, or choose No to continue without setup.'
    : (appConfig.loggedIn ? 'Universal Modder is ready to use.' : 'Sign in to Codex with your ChatGPT account to use the AI guide. Your password stays with Codex.');
  $('setup-yes').innerHTML = (missing ? 'Yes, set it up' : 'Sign in to Codex') + ' <span>→</span>';
  $('setup-yes').disabled = setupBusy;
}

function showSetupProgress(title, copy) {
  $('setup-progress-title').textContent = title;
  $('setup-progress-copy').textContent = copy;
  $('setup-progress').classList.remove('hidden');
}

function hideSetupProgress() {
  $('setup-progress').classList.add('hidden');
}

function showSetupError(message) {
  setupBusy = false;
  hideSetupProgress();
  $('setup-account').classList.add('hidden');
  $('setup-choices').classList.add('hidden');
  $('setup-retry-actions').classList.remove('hidden');
  $('setup-error').textContent = message;
  $('setup-error').classList.remove('hidden');
  $('setup-retry').disabled = false;
}

function openSetup() {
  if (!appConfig) return;
  paintSetupStatus();
  $('setup-error').classList.add('hidden');
  $('setup-account').classList.add('hidden');
  $('setup-choices').classList.remove('hidden');
  $('setup-retry-actions').classList.add('hidden');
  hideSetupProgress();
  if (!$('setup-dialog').open) $('setup-dialog').showModal();
}

async function refreshAppConfig() {
  const updated = await api('/api/config');
  appConfig = updated;
  appKey = updated.key || appKey;
  updateConnection();
  paintSetupStatus();
  return updated;
}

async function continueSetup() {
  setupConsentPending = true;
  $('setup-choices').classList.add('hidden');
  $('setup-retry-actions').classList.add('hidden');
  $('setup-error').classList.add('hidden');
  if (!appConfig.codexAvailable) {
    setupBusy = false;
    hideSetupProgress();
    $('setup-title').textContent = 'Codex is required first';
    $('setup-copy').textContent = 'Install the Codex app or CLI and sign in with ChatGPT, then return here. Universal Modder will install after Codex is connected.';
    $('setup-account').classList.remove('hidden');
    $('setup-login').classList.add('hidden');
    $('setup-get-codex').classList.remove('hidden');
    $('setup-refresh').classList.remove('hidden');
    return;
  }
  if (!appConfig.loggedIn) {
    $('setup-account').classList.remove('hidden');
    $('setup-login').classList.remove('hidden');
    $('setup-get-codex').classList.add('hidden');
    $('setup-refresh').classList.remove('hidden');
    $('setup-login').disabled = false;
    showSetupProgress('Sign in to Codex first', 'Finish the ChatGPT sign-in in the Codex window. Setup will continue when you return.');
    await launchCodexLogin();
    return;
  }
  await runSetupInstall();
}

async function launchCodexLogin() {
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: '{}' });
    if (result.error) throw new Error(result.error);
    beginAuthPolling();
  } catch (error) {
    showSetupError(error.message || 'Could not open Codex sign-in.');
  }
}

function beginAuthPolling() {
  clearInterval(setupPollTimer);
  setupPollCount = 0;
  setupPollTimer = setInterval(() => { void checkSignIn(); }, 2500);
}

async function checkSignIn() {
  try {
    const status = await api('/api/auth/status', { method: 'POST', body: '{}' });
    appConfig = { ...appConfig, codexAvailable: status.available, loggedIn: status.loggedIn };
    updateConnection();
    paintSetupStatus();
    if (!status.available) {
      clearInterval(setupPollTimer);
      $('setup-title').textContent = 'Codex is required first';
      $('setup-copy').textContent = 'Install Codex and sign in with ChatGPT, then return here and choose “I’m signed in — continue”.';
      hideSetupProgress();
      $('setup-account').classList.remove('hidden');
      $('setup-login').classList.add('hidden');
      $('setup-get-codex').classList.remove('hidden');
      $('setup-refresh').classList.remove('hidden');
      return;
    }
    if (status.loggedIn) {
      clearInterval(setupPollTimer);
      if (setupConsentPending) await runSetupInstall();
      else {
        hideSetupProgress();
        $('setup-account').classList.add('hidden');
        $('setup-choices').classList.remove('hidden');
        showToast('Codex is connected.');
      }
      return;
    }
    $('setup-title').textContent = 'Sign in to Codex first';
    $('setup-copy').textContent = 'Use the Codex sign-in window, or open it below. When your ChatGPT sign-in finishes, setup will continue.';
    $('setup-account').classList.remove('hidden');
    $('setup-login').classList.remove('hidden');
    $('setup-get-codex').classList.add('hidden');
    $('setup-refresh').classList.remove('hidden');
    setupPollCount += 1;
    if (setupPollCount > 240) {
      clearInterval(setupPollTimer);
      showSetupError('Sign-in is taking longer than expected. Finish it in the Codex window, then choose “I’m signed in — continue”.');
    }
  } catch { /* The user can still refresh the sign-in status manually. */ }
}

async function runSetupInstall() {
  if (setupBusy) return;
  setupBusy = true;
  $('setup-account').classList.add('hidden');
  $('setup-choices').classList.add('hidden');
  $('setup-retry-actions').classList.add('hidden');
  $('setup-error').classList.add('hidden');
  showSetupProgress('Installing Universal Modder', 'The app is setting up the command line and Codex plugin. This can take a few minutes.');
  try {
    const result = await api('/api/setup/install', { method: 'POST', body: '{}' });
    if (result.error) throw new Error(result.error);
    appConfig = await api('/api/config');
    appKey = appConfig.key || appKey;
    updateConnection();
    paintSetupStatus();
    hideSetupProgress();
    setupBusy = false;
    setupConsentPending = false;
    if (setupNeeded()) throw new Error('Setup finished, but not all components are available. Choose Try again to refresh the setup.');
    showToast('Universal Modder setup is ready.');
    setTimeout(() => { if ($('setup-dialog').open) $('setup-dialog').close(); }, 900);
  } catch (error) {
    showSetupError(error.message || 'Universal Modder setup did not finish.');
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    headers['X-UM-Studio-Key'] = appKey;
  }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The app request failed.');
  return data;
}

async function detectGames() {
  showToast('Looking for installed games…');
  try {
    const result = await api('/api/games');
    gameLibrary = result.games || [];
    $('game-options').replaceChildren(...gameLibrary.map((game) => {
      const option = document.createElement('option');
      option.value = game;
      return option;
    }));
    if (gameLibrary.length) {
      showToast('Found ' + gameLibrary.length + ' game' + (gameLibrary.length === 1 ? '' : 's') + '.');
    } else {
      showToast(result.error || 'No titles detected. You can type any game name.');
      if (result.raw) showCommandOutput('Installed game scan', result.raw);
    }
  } catch (error) {
    showToast('Game scan did not complete. You can enter a title manually.');
    showCommandOutput('Installed game scan', error.message);
  }
}

function syncFusionInputs() {
  state.fusion.gameOne = $('game-one').value.trim();
  state.fusion.gameTwo = $('game-two').value.trim();
  persist();
}

function syncSingleInputs() {
  state.single.game = $('single-game').value.trim();
  state.single.idea = $('mod-idea').value.trim();
  state.single.playMode = $('play-mode').value;
  state.single.assetPref = $('asset-pref').value;
  state.single.platform = $('platform').value.trim();
  state.single.deliverable = $('deliverable').value;
  state.single.knownTools = $('known-tools').value.trim();
  persist();
}

function startFusion() {
  syncFusionInputs();
  const error = $('fusion-error');
  error.textContent = '';
  if (!state.fusion.gameOne || !state.fusion.gameTwo) {
    error.textContent = 'Choose two games first. You can type a title if it is not detected.';
    return;
  }
  if (state.fusion.gameOne.toLowerCase() === state.fusion.gameTwo.toLowerCase()) {
    error.textContent = 'Choose two different games for a fusion.';
    return;
  }
  state.fusion.begun = true;
  state.fusion.chosenBase = false;
  state.fusion.baseGame = '';
  state.fusion.guestGame = '';
  state.fusion.messages = [];
  persist();
  syncForms();
  $('fusion-chat-stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function chooseBase(game) {
  state.fusion.baseGame = game;
  state.fusion.guestGame = game === state.fusion.gameOne ? state.fusion.gameTwo : state.fusion.gameOne;
  state.fusion.chosenBase = true;
  state.fusion.messages = [
    { role: 'assistant', content: 'Which game do you want as the base?' },
    { role: 'user', content: 'Use ' + game + ' as the base. ' + state.fusion.guestGame + ' is the guest game.' },
  ];
  persist();
  syncForms();
  await askGuide('fusion', false);
}

function collectContext(flow) {
  if (flow === 'fusion') {
    syncFusionInputs();
    return {
      flow,
      games: [state.fusion.gameOne, state.fusion.gameTwo],
      baseGame: state.fusion.baseGame,
      guestGame: state.fusion.guestGame,
      messages: state.fusion.messages,
      options: { playMode: 'offline or private / owner-controlled server only' },
    };
  }
  syncSingleInputs();
  return {
    flow,
    games: [state.single.game],
    modIdea: state.single.idea,
    messages: state.single.messages,
    options: {
      playMode: state.single.playMode,
      assets: state.single.assetPref,
      platform: state.single.platform,
      deliverable: state.single.deliverable,
      knownTools: state.single.knownTools,
    },
  };
}

async function askGuide(flow, build) {
  const errorNode = $(flow + '-chat-error');
  errorNode.textContent = '';
  if (busy) return;
  busy = true;
  renderChat(flow);
  const payload = { ...collectContext(flow), build };
  try {
    const result = await api('/api/assistant', { method: 'POST', body: JSON.stringify(payload) });
    if (result.answer) state[flow].messages.push({ role: 'assistant', content: result.answer });
    else state[flow].messages.push({ role: 'assistant', content: 'I did not receive a reply from Codex. Check that the local Codex command is available, then try again.' });
    if (result.error) errorNode.textContent = result.error;
    persist();
  } catch (error) {
    errorNode.textContent = error.message || 'Could not reach the local Codex assistant.';
  } finally {
    busy = false;
    renderChat(flow);
  }
}

function sendReply(flow, text) {
  const reply = text.trim();
  if (!reply || busy) return;
  state[flow].messages.push({ role: 'user', content: reply });
  persist();
  renderChat(flow);
  askGuide(flow, false);
}

function showCommandOutput(title, output) {
  const quick = $('quick-console');
  if (quick) {
    quick.classList.remove('hidden');
    $('quick-output').textContent = '$ ' + title + '\n\n' + (output || 'No output.');
  }
  $('deck-output').classList.add('has-result');
  $('deck-result').textContent = '$ ' + title + '\n\n' + (output || 'No output.');
}

async function runCommand(action, value = {}) {
  showCommandOutput('Running command…', 'Waiting for Universal Modder');
  try {
    const result = await api('/api/command', { method: 'POST', body: JSON.stringify({ action, ...value }) });
    const output = (result.stdout || '') + (result.stderr ? '\n' + result.stderr : '');
    const title = result.command || 'Universal Modder command';
    showCommandOutput(title, output.trim() || ('Finished with exit code ' + result.code + '.'));
    if (result.code === 0) showToast('Command finished.');
    else showToast('Command returned an issue. See the output.');
  } catch (error) {
    showCommandOutput('Universal Modder command', error.message);
    showToast('Could not run that command.');
  }
}

function commandClick(key) {
  syncFusionInputs();
  syncSingleInputs();
  if (key === 'scan-list') return runCommand('scan-list');
  if (key === 'scan-current' || key === 'scan-current-single') {
    const game = state.view === 'single' || key === 'scan-current-single' ? state.single.game : (state.fusion.baseGame || state.fusion.gameOne);
    if (!game) return showToast('Choose a game first.');
    return runCommand('scan', { game });
  }
  if (key === 'kb-current' || key === 'kb-current-single') {
    const query = state.view === 'single' || key === 'kb-current-single' ? state.single.game : (state.fusion.baseGame || state.fusion.gameOne);
    if (!query) return showToast('Choose a game first.');
    return runCommand('kb-search', { query });
  }
  if (key === 'scan-deck') {
    const game = $('deck-game').value.trim();
    if (!game) return showToast('Enter a game title.');
    return runCommand('scan', { game });
  }
  if (key === 'kb-deck') {
    const query = $('deck-query').value.trim();
    if (!query) return showToast('Enter a game or engine.');
    return runCommand('kb-search', { query });
  }
  if (key === 'publish-check') return runCommand('publish-check');
}

function resetFlow(flow) {
  if (flow === 'fusion') state.fusion = { ...defaults.fusion };
  else state.single = { ...defaults.single };
  persist();
  syncForms();
  if (flow === 'single') $('idea-nudge').classList.add('hidden');
  showToast('Started a fresh ' + (flow === 'fusion' ? 'fusion' : 'mod') + ' brief.');
}

function updateIdeaNudge() {
  const idea = $('mod-idea').value.toLowerCase();
  const notes = [];
  if (/multiplayer|pvp|online|ranked|competitive|server/.test(idea)) notes.push('Your idea mentions online play. The guide will clarify an allowed offline or owner-controlled route.');
  if (/sprite|art|texture|model|music|sound|voice|animation/.test(idea)) notes.push('This may need new assets. You can switch Assets to “Generate new art/audio”.');
  if (/save|inventory|profile|world file/.test(idea)) notes.push('This may touch saves or profiles. The guide will plan a backup before any changes.');
  const target = $('idea-nudge');
  if (!notes.length) {
    target.classList.add('hidden');
    target.textContent = '';
  } else {
    target.textContent = notes.join(' ');
    target.classList.remove('hidden');
  }
}

async function init() {
  try {
    appConfig = await api('/api/config');
    appKey = appConfig.key || '';
    const savedResponse = await fetch('/api/state');
    const savedState = await savedResponse.json();
    if (savedState && typeof savedState === 'object') {
      state = {
        ...defaults,
        ...savedState,
        fusion: { ...defaults.fusion, ...(savedState.fusion || {}) },
        single: { ...defaults.single, ...(savedState.single || {}) },
      };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* The desktop data file is the durable copy. */ }
    }
  } catch {
    appConfig = null;
  }
  syncForms();
  setView(state.view || 'fusion');
  document.querySelectorAll('.nav-item[data-view], .rail-link[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

  ['game-one', 'game-two'].forEach((id) => $(id).addEventListener('input', syncFusionInputs));
  ['single-game', 'mod-idea', 'play-mode', 'asset-pref', 'platform', 'deliverable', 'known-tools'].forEach((id) => {
    $(id).addEventListener('input', syncSingleInputs);
    $(id).addEventListener('change', syncSingleInputs);
  });
  $('begin-fusion').addEventListener('click', startFusion);
  $('start-single').addEventListener('click', () => {
    syncSingleInputs();
    $('single-error').textContent = '';
    if (!state.single.game) return $('single-error').textContent = 'Choose the game you want to mod.';
    if (!state.single.idea) return $('single-error').textContent = 'Describe what you want the mod to do.';
    state.single.begun = true;
    state.single.messages = [{ role: 'user', content: 'I want to mod ' + state.single.game + ': ' + state.single.idea }];
    persist();
    syncForms();
    $('single-chat-stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    askGuide('single', false);
  });

  $('fusion-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('fusion-reply').value;
    $('fusion-reply').value = '';
    sendReply('fusion', text);
  });
  $('single-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('single-reply').value;
    $('single-reply').value = '';
    sendReply('single', text);
  });
  $('reset-fusion').addEventListener('click', () => resetFlow('fusion'));
  $('reset-single').addEventListener('click', () => resetFlow('single'));
  $('build-fusion').addEventListener('click', () => askGuide('fusion', true));
  $('build-single').addEventListener('click', () => askGuide('single', true));
  $('toggle-advanced').addEventListener('click', () => {
    state.single.advanced = !state.single.advanced;
    persist();
    syncForms();
  });
  $('mod-idea').addEventListener('input', updateIdeaNudge);
  document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => commandClick(button.dataset.command)));
  $('detect-top').addEventListener('click', detectGames);
  $('detect-single').addEventListener('click', detectGames);
  $('close-console').addEventListener('click', () => $('quick-console').classList.add('hidden'));
  $('clear-deck-output').addEventListener('click', () => {
    $('deck-result').textContent = 'Choose a command above to see its output here.';
    $('deck-output').classList.remove('has-result');
  });
  $('help-button').addEventListener('click', () => $('about-dialog').showModal());
  $('close-about').addEventListener('click', () => $('about-dialog').close());
  $('connection').addEventListener('click', openSetup);
  $('setup-yes').addEventListener('click', () => { void continueSetup(); });
  $('setup-no').addEventListener('click', () => {
    setupConsentPending = false;
    $('setup-dialog').close();
  });
  $('close-setup').addEventListener('click', () => $('setup-dialog').close());
  $('setup-login').addEventListener('click', () => { void launchCodexLogin(); });
  $('setup-refresh').addEventListener('click', () => { void checkSignIn(); });
  $('setup-retry').addEventListener('click', () => { setupConsentPending = true; void continueSetup(); });
  $('setup-close-error').addEventListener('click', () => $('setup-dialog').close());
  $('copy-workspace').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(appConfig.workspace); showToast('Workspace path copied.'); }
    catch { showToast('Select and copy the path shown above.'); }
  });

  if (appConfig) {
    updateConnection();
    paintSetupStatus();
    if (setupNeeded()) openSetup();
    if (appConfig.umAvailable) void detectGames();
  } else {
    $('connection').classList.add('warning');
    $('connection').innerHTML = '<span class="connection-dot"></span><span>App connection lost</span>';
  }
}

init();
