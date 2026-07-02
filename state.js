const API = 'https://api.github.com';

const STORAGE = {
  token:    'prq_token',
  ignored:  'prq_ignored',
  config:   'prq_config',
  prsCache: 'prq_prs_cache',
};

const TRIBES = [
  { label: 'comm',              color: '#6D18A8' },
  { label: 'data',              color: '#c2e0c6' },
  { label: 'ops',               color: '#1D76DB' },
  { label: 'people foundation', color: '#19F4F2' },
  { label: 'talent',            color: '#5319e7' },
  { label: 'time management',   color: '#04547a' },
];

let state = {
  token:   localStorage.getItem(STORAGE.token) || '',
  ignored: new Set(JSON.parse(localStorage.getItem(STORAGE.ignored) || '[]')),
  config: {
    org:   'HumandDev',
    label: '',
    bots:  'hu-agent|hu-reviewer',
    fx:    true,
    ...JSON.parse(localStorage.getItem(STORAGE.config) || '{}'),
  },
  me:          localStorage.getItem('prq_me') || '',
  meAvatar:    localStorage.getItem('prq_me_avatar') || '',
  prs:         [],
  renderedIds:   new Set(),
  cardTimers:    [],
  ownPRs:      [],
  mergedPRs:   [],
  ownActivity: JSON.parse(localStorage.getItem('prq_own_activity') || '{}'),
  loading:     false,
  readyOnly:   false,
  showIgnored: true,
  lastUpdated: null,
};

const $ = id => document.getElementById(id);

const el = {
  authSection:  $('auth-section'),
  tokenInput:   $('token-input'),
  saveTokenBtn: $('save-token-btn'),
  configSection: $('config-section'),
  configToggle:  $('config-toggle-btn'),
  configSave:    $('config-save-btn'),
  cfgOrg:   $('cfg-org'),
  cfgLabel: $('cfg-label'),
  cfgBots:  $('cfg-bots'),
  cfgFx:    $('cfg-fx-toggle'),
  toolbar:       $('toolbar'),
  progressBar:   $('progress-bar'),
  progressFill:  $('progress-fill'),
  errorMsg:      $('error-msg'),
  loading:       $('loading'),
  loadingText:   $('loading-text'),
  prList:        $('pr-list'),
  empty:         $('empty'),
  lastUpdated:   $('last-updated'),
  readyOnly:     $('ready-only-toggle'),
  showIgnored:   $('show-ignored-toggle'),
  refreshBtn:    $('refresh-btn'),
  statusDot:     $('status-dot'),
  loggedUser:    $('logged-user'),
  signoutBtn:    $('signout-btn'),
  ownColumn:     $('own-column'),
  ownLoading:    $('own-loading'),
  ownPrList:     $('own-pr-list'),
  ownEmpty:      $('own-empty'),
  ownCount:      $('own-count'),
};

// ── Persistence ──────────────────────────────────────────────

function saveIgnored() {
  localStorage.setItem(STORAGE.ignored, JSON.stringify([...state.ignored]));
}

function saveConfig() {
  localStorage.setItem(STORAGE.config, JSON.stringify(state.config));
}

function readConfigFields() {
  state.config = {
    org:   el.cfgOrg.value.trim()   || 'HumandDev',
    label: el.cfgLabel.value.trim(),
    bots:  el.cfgBots.value.trim()  || 'hu-agent|hu-reviewer',
    fx:    el.cfgFx.checked,
  };
  saveConfig();
  updateURL();
}

function writeConfigFields() {
  el.cfgOrg.value   = state.config.org;
  el.cfgLabel.value = state.config.label;
  el.cfgBots.value  = state.config.bots;
  el.cfgFx.checked  = state.config.fx !== false;
}

// ── URL state ────────────────────────────────────────────────

function updateURL() {
  const p = new URLSearchParams();
  if (state.readyOnly)            p.set('ready',   '1');
  if (state.showIgnored)          p.set('skipped', '1');
  if (state.config.org   !== 'HumandDev')             p.set('org',   state.config.org);
  if (state.config.label)                              p.set('label', state.config.label);
  if (state.config.bots  !== 'hu-agent|hu-reviewer')  p.set('bots',  state.config.bots);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function readURL() {
  const p = new URLSearchParams(location.search);
  if (p.has('ready'))   state.readyOnly   = p.get('ready')   === '1';
  if (p.has('skipped')) state.showIgnored = p.get('skipped') === '1';
  if (p.has('org'))   state.config.org   = p.get('org');
  if (p.has('label')) state.config.label = p.get('label');
  if (p.has('bots'))  state.config.bots  = p.get('bots');
}
