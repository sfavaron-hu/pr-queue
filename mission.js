// Shared pure logic for the mission-control cards. Loaded both as a browser
// <script src> (globals) and via require() in Node — see the dual-export
// footer, same discipline as classify.js. No dependencies, no IO.

// mc's exit code is a CONTRACT, not a failure signal: 10 = there are
// questions, 4 = degraded, 3 = some source is blind, 0 = clean
// (mission-control/src/cli.js:86-93). Reading "exit != 0" as broken renders a
// pass that merely has questions as a crash, which is the worst possible
// failure mode for a tool whose whole job is telling you what needs a
// decision. Success is "did the JSON parse", full stop.
var MISSION_STATES = Object.freeze(['ok', 'degraded', 'absent', 'broken', 'off']);

// A snapshot cached by an older mc can carry the legacy `no-check`, which mc
// itself folds into `broken` (mission-control/src/status.js:22). Without this
// the value falls through every known branch and no card paints it at all.
function normalizeSourceStatus(status) {
  return status === 'no-check' ? 'broken' : status;
}

function classifyMissionRead(read) {
  var r = read || {};
  if (r.missing) {
    // Not configured and not there = a pr-queue user who never installed
    // mission-control. Explicitly configured and not there = a broken setup.
    return { status: r.configured ? 'broken' : 'off', snapshot: null,
             error: r.configured ? { code: null, stderr: 'no existe el binario de mc', timedOut: false } : null };
  }
  var snapshot = null;
  try { snapshot = JSON.parse(r.stdout || ''); } catch (e) { snapshot = null; }
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.sources)) {
    return { status: 'broken', snapshot: null,
             error: { code: typeof r.code === 'number' ? r.code : null,
                      stderr: (r.stderr || '').split('\n')[0] || '', timedOut: !!r.timedOut } };
  }
  return { status: r.code === 4 ? 'degraded' : 'ok', snapshot: snapshot, error: null };
}

function ageLabel(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return 'edad desconocida';
  var m = Math.round(ms / 60000);
  return m < 1 ? 'hace <1m' : (m < 90 ? 'hace ' + m + 'm' : 'hace ' + Math.round(m / 60) + 'h');
}

var SOURCE_TONE = { absent: 'gray', broken: 'red', degraded: 'amber' };

function missionCard(payload, sources) {
  var looked = sources.filter(function (s) { return ['absent', 'broken'].indexOf(normalizeSourceStatus(s.status)) === -1; });
  var lines = [];
  var tone = 'plain';
  if (payload.status === 'broken') {
    tone = 'red';
    var e = payload.error || {};
    lines.push(e.timedOut ? 'mc no respondió en el tiempo del panel'
                          : ('no pude leer mc' + (e.stderr ? ': ' + e.stderr : '')));
    lines.push('lo que ves abajo es de la última lectura buena, si hubo alguna');
  } else if (payload.status === 'degraded') {
    // mc exited 4: it DID look, and the snapshot parsed fine — the pass just
    // came up short. Claiming "no pude leer mc" here asserts blindness about
    // a fresh, valid read, which is the same collapse the four states exist
    // to prevent, only inverted.
    tone = 'amber';
    lines.push('mc miró, pero la pasada vino corta');
    lines.push('los conteos están incompletos; el snapshot es de recién, no viejo');
  } else {
    lines.push(looked.length + '/' + sources.length + ' fuentes miraron');
  }
  // A lease that cannot be read is the exact condition under which the drain
  // walks over a working agent, so it can never be a silent omission.
  if (payload.leases && payload.leases.error) {
    if (tone === 'plain') tone = 'amber';
    lines.push('no pude leer los leases (' + payload.leases.error + '): una card puede ofrecer algo que un agente está usando');
  }
  return { kind: 'mission', id: 'mission', tone: tone, title: 'mission-control',
           badge: ageLabel(payload.ageMs), lines: lines, links: [], slot: 'top' };
}

function questionCard(entry) {
  var q = entry.item || {};
  return { kind: 'question', id: 'q:' + entry.id, tone: 'amber',
           title: q.header || 'Pregunta', badge: entry.source || null,
           lines: [q.question || ''].concat((q.options || []).map(function (o) {
             return '· ' + o.label + ' — ' + (o.description || '');
           })).concat(['contestar: /mission-control']),
           links: [], slot: 'bottom' };
}

function missionCards(payload) {
  if (!payload || payload.status === 'off') return [];
  var sources = payload.sources || [];
  var cards = [missionCard(payload, sources)];

  sources.forEach(function (s) {
    var st = normalizeSourceStatus(s.status);
    if (st === 'ok') return;
    var lines = [s.headline || ''].concat((s.detail || []).slice(0, 3));
    if (s.install) {
      lines.push('qué es: ' + s.install.what);
      if (s.install.where) lines.push('dónde: ' + s.install.where);
      lines.push('cómo: ' + s.install.how);
    }
    cards.push({ kind: 'source', id: 'source:' + s.name, tone: SOURCE_TONE[st] || 'red',
                 title: s.name, badge: st, lines: lines, links: [], slot: 'top' });
  });

  // Questions with no process of their own. The ones that DO match a process
  // are stitched into its card by Task 3 and must not be duplicated here —
  // local.js passes the already-matched ids in `payload.matchedAskIds`.
  var matched = payload.matchedAskIds || [];
  (payload.ask || []).forEach(function (entry) {
    if (matched.indexOf(entry.id) !== -1) return;
    cards.push(questionCard(entry));
  });

  sources.forEach(function (s) {
    if (s.name === 'tickets' && Array.isArray(s.rows)) {
      var queues = s.queues && s.queues.length ? s.queues : [{ name: null, label: 'tickets' }];
      queues.forEach(function (q) {
        var rows = s.rows.filter(function (r) { return q.name === null || r.queue === q.name; });
        if (!rows.length) return;
        cards.push({ kind: 'ticket', id: 'tickets:' + (q.name || 'all'), tone: 'plain',
                     title: q.label, badge: String(rows.length), slot: 'bottom',
                     lines: rows.map(function (r) { return r.key + ' · ' + (r.status || '') + ' · ' + (r.summary || ''); }),
                     links: rows.filter(function (r) { return r.url; }).map(function (r) { return { label: r.key, url: r.url }; }) });
      });
    }
    if (s.name === 'heartbeat') {
      var notes = (s.inbox || []).concat(s.attention || []);
      if (notes.length) {
        var per = {};
        notes.forEach(function (n) { var k = n.source || n.check || 'otros'; per[k] = (per[k] || 0) + 1; });
        cards.push({ kind: 'inbox', id: 'inbox', tone: 'plain', title: 'inbox', badge: String(notes.length),
                     lines: Object.keys(per).map(function (k) { return k + ' ×' + per[k]; })
                              .concat(['leer y marcar: mc inbox / mc ack']),
                     links: [], slot: 'bottom' });
      }
    }
    if (s.name === 'friction' && (s.open || []).length) {
      cards.push({ kind: 'friction', id: 'friction', tone: 'plain', title: 'fricción abierta',
                   badge: String(s.open.length), slot: 'bottom', links: [],
                   lines: s.open.map(function (o) { return (o.note || o.evidence || '').slice(0, 140); }) });
    }
  });

  var take = payload.take || {};
  var taken = (take.rows || take.taken || []);
  if (taken.length) {
    cards.push({ kind: 'take', id: 'take', tone: 'plain', title: 'tickets tomados',
                 badge: String(taken.length), slot: 'bottom', links: [],
                 lines: taken.map(function (t) { return (t.key || '?') + ' · ' + (t.state || '') + (t.until ? ' hasta ' + t.until : ''); }) });
  }
  return cards;
}

// Matches by path AND by branch, the same way mc does (src/lease.js:88):
// the drain's own questions carry no path field, so a branch-only match is
// the only thing that connects a lease to half of them.
function leaseForRow(active, row) {
  var wts = (row.proc && row.proc.worktrees) || [];
  for (var i = 0; i < active.length; i++) {
    var l = active[i];
    for (var j = 0; j < wts.length; j++) {
      if (l.path && wts[j].path && l.path === wts[j].path) return l;
      if (l.branch && wts[j].branch && l.branch === wts[j].branch) return l;
    }
  }
  return null;
}

function stitchMission(payload, rows) {
  var out = { perKey: {}, matchedAskIds: [] };
  if (!payload) return out;
  var active = (payload.leases && payload.leases.active) || [];
  var keys = {};
  (rows || []).forEach(function (r) { if (r.proc && r.proc.key) keys[r.proc.key] = r; });

  (payload.ask || []).forEach(function (entry) {
    var pk = entry.item && entry.item.processKey;
    if (!pk || !keys[pk]) return;
    out.perKey[pk] = out.perKey[pk] || { questions: [], lease: null };
    out.perKey[pk].questions.push(entry);
    out.matchedAskIds.push(entry.id);
  });

  Object.keys(keys).forEach(function (k) {
    var lease = leaseForRow(active, keys[k]);
    if (!lease) return;
    out.perKey[k] = out.perKey[k] || { questions: [], lease: null };
    out.perKey[k].lease = lease;
  });
  return out;
}

var TONE_CLASS = { red: 'badge-red', amber: 'badge-amber', gray: 'badge-gray', plain: 'badge-gray badge-dim' };

function escM(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Only http(s). Everything in a card comes from mc's output, which includes
// Jira summaries and branch names — none of it is trusted markup.
function safeUrlM(url) {
  var checker = (typeof safeHttpUrl === 'function') ? safeHttpUrl : null;
  if (checker) return checker(url) ? url : null;
  return /^https?:\/\//i.test(String(url || '')) ? url : null;
}

function missionCardHTML(card) {
  var badge = card.badge
    ? '<span class="badge ' + (TONE_CLASS[card.tone] || 'badge-gray') + '">' + escM(card.badge) + '</span>'
    : '';
  var lines = (card.lines || []).map(function (l) {
    return '<div class="proc-detail">' + escM(l) + '</div>';
  }).join('');
  var links = (card.links || []).map(function (l) {
    var u = safeUrlM(l.url);
    return u ? '<a class="btn btn-ghost btn-sm" href="' + escM(u) + '" target="_blank" rel="noopener noreferrer">' + escM(l.label) + '</a>'
             : '<span class="btn btn-ghost btn-sm">' + escM(l.label) + '</span>';
  }).join('');
  return '<div class="proc-card pr-card mission-card" data-mc-kind="' + escM(card.kind) + '">'
       + '<div class="pr-number">' + escM(card.title) + badge + '</div>'
       + lines
       + (links ? '<div class="pr-actions">' + links + '</div>' : '')
       + '</div>';
}

// A cached payload can predate the drain pushing the branch, and then the
// card offers a `compare/<base>...<branch>` that GitHub cannot resolve. The
// old rule (unknown behaves as it did before onOrigin existed) is right for a
// fresh payload and wrong for a cached one — measured with bp-prod-10230,
// which by the time it was clicked was on origin with 34 commits.
function compareLinkAllowed(worktree, fromCache) {
  var w = worktree || {};
  if (w.onOrigin === false) return false;
  if (fromCache) return w.onOrigin === true;
  return true;
}

// Painted only after /api/local has actually failed — never while the fetch
// is in flight, or it flashes on localhost where the sidecar does answer.
function shouldShowSidecarHint(state) {
  var s = state || {};
  return !!s.fetchFailed && !s.dismissed;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MISSION_STATES: MISSION_STATES,
                     normalizeSourceStatus: normalizeSourceStatus,
                     classifyMissionRead: classifyMissionRead,
                     missionCards: missionCards,
                     stitchMission: stitchMission,
                     missionCardHTML: missionCardHTML,
                     escM: escM,
                     safeUrlM: safeUrlM,
                     compareLinkAllowed: compareLinkAllowed,
                     shouldShowSidecarHint: shouldShowSidecarHint };
}
