# Repo Filter Pills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user exclude specific repos from the main PR review queue via toggleable pills in the config panel, defaulting to "all shown" (today's behavior).

**Architecture:** A static, hardcoded `REPOS_ACTIVE` list (snapshot of 90-day PR activity, same pattern as the existing `TRIBES` list) drives a multi-select pill picker in the config panel. Selection state (`state.config.excludedRepos`) persists in the existing `prq_config` localStorage blob and is applied as a pure client-side filter in `renderList()` — no new API calls.

**Tech Stack:** Vanilla JS, no build step, no test framework, no package.json. This repo has zero automated tests — verification is manual, via opening `index.html` in a browser and checking DevTools (Console/Application tabs) and the rendered UI.

## Global Constraints

- Default behavior must be unchanged for existing users: no repo ever hidden unless the user explicitly deselects it. `excludedRepos` defaults to `[]`.
- `REPOS_ACTIVE` order (from 90-day snapshot taken 2026-07-17, most active first): `humand-web`, `humand-backoffice`, `hu-translations`, `material-hu`, `humand-main-api`, `humand-frontend-testing`.
- The repo filter only affects the main review queue (`renderList()` / `#pr-list`). It must NOT affect the "Mis PRs" column (`renderOwnPRs()` / `#own-pr-list`).
- Repos not in `REPOS_ACTIVE` are never excludable and must always render (no pill exists for them).
- No new dependencies. Follow existing patterns (`TRIBES`/tribe-picker) exactly for the new repo picker.

---

### Task 1: Repo snapshot data + config state plumbing

**Files:**
- Modify: `state.js:10-41` (add `REPOS_ACTIVE`, extend default config, extend `el`)
- Modify: `state.js:88-104` (`readConfigFields`, `writeConfigFields`)

**Interfaces:**
- Produces: `REPOS_ACTIVE` (array of repo short-name strings), `state.config.excludedRepos` (array of repo short-name strings, default `[]`), `el.cfgRepos` (hidden `<input>` element reference, comma-separated excluded repo names).
- Consumes: nothing new (uses existing `$()`, `STORAGE.config`, `saveConfig()`, `updateURL()` from `state.js`).

- [ ] **Step 1: Add `REPOS_ACTIVE` array and extend default config**

In `state.js`, add the new array right after `TRIBES` (currently ends at line 17):

```js
const REPOS_ACTIVE = [
  'humand-web',              // 215 PRs, last 90d
  'humand-backoffice',       // 208 PRs, last 90d
  'hu-translations',         // 55 PRs, last 90d
  'material-hu',             // 25 PRs, last 90d
  'humand-main-api',         // 17 PRs, last 90d
  'humand-frontend-testing', // 3 PRs, last 90d
];
```

Then in the `state` object's `config`, add `excludedRepos: []` alongside the other defaults (currently `state.js:22-28`):

```js
  config: {
    org:   'HumandDev',
    label: '',
    bots:  'hu-agent|hu-reviewer',
    fx:    true,
    excludedRepos: [],
    ...JSON.parse(localStorage.getItem(STORAGE.config) || '{}'),
  },
```

- [ ] **Step 2: Add `cfgRepos` to the `el` lookup object**

In the `el` object (currently `state.js:45-76`), add a line right after `cfgLabel`:

```js
  cfgLabel: $('cfg-label'),
  cfgRepos: $('cfg-repos'),
```

- [ ] **Step 3: Verify it fails (element not in DOM yet)**

Run: `open index.html` (or drag the file into Chrome), then in DevTools Console:
```js
el.cfgRepos
```
Expected: `null` — this is correct for now, since Task 2 hasn't added the `#cfg-repos` element to `index.html` yet. This step just confirms `state.js` loaded without throwing.

- [ ] **Step 4: Extend `readConfigFields` and `writeConfigFields`**

In `readConfigFields` (currently `state.js:88-97`), add the `excludedRepos` line:

```js
function readConfigFields() {
  state.config = {
    org:   el.cfgOrg.value.trim()   || 'HumandDev',
    label: el.cfgLabel.value.trim(),
    bots:  el.cfgBots.value.trim()  || 'hu-agent|hu-reviewer',
    fx:    el.cfgFx.checked,
    excludedRepos: el.cfgRepos.value.split(',').map(s => s.trim()).filter(Boolean),
  };
  saveConfig();
  updateURL();
}
```

In `writeConfigFields` (currently `state.js:99-104`), add:

```js
function writeConfigFields() {
  el.cfgOrg.value   = state.config.org;
  el.cfgLabel.value = state.config.label;
  el.cfgBots.value  = state.config.bots;
  el.cfgFx.checked  = state.config.fx !== false;
  el.cfgRepos.value = (state.config.excludedRepos || []).join(',');
}
```

- [ ] **Step 5: Verify `state.config.excludedRepos` defaults correctly**

This step will only fully pass once Task 2 adds `#cfg-repos` to the DOM (both `readConfigFields`/`writeConfigFields` touch `el.cfgRepos`, which is `null` until then). For now, confirm no existing behavior broke:

Run: `open index.html`, DevTools Console:
```js
state.config.excludedRepos
```
Expected: `[]`

- [ ] **Step 6: Commit**

```bash
git add state.js
git commit -m "feat: add REPOS_ACTIVE snapshot and excludedRepos config state"
```

---

### Task 2: Repo picker markup and styles

**Files:**
- Modify: `index.html:684-688` (config panel — add Repos field next to Tribu field)
- Modify: `index.html:612-643` (CSS — add `.repo-picker`/`.repo-chip` styles near `.tribe-picker`/`.tribe-chip`)

**Interfaces:**
- Consumes: `REPOS_ACTIVE` (from Task 1, `state.js`).
- Produces: DOM elements `#cfg-repos` (hidden input), `#repo-picker` (empty container div, populated by Task 3's JS), CSS classes `.repo-picker`, `.repo-chip`, `.repo-chip.selected`.

- [ ] **Step 1: Add the Repos field markup**

In `index.html`, right after the existing Tribu field (currently lines 684-688):

```html
    <div class="config-field" style="grid-column:span 2;">
      <label>Tribu</label>
      <input type="hidden" id="cfg-label" />
      <div class="tribe-picker" id="tribe-picker"></div>
    </div>
    <div class="config-field" style="grid-column:span 2;">
      <label>Repos</label>
      <input type="hidden" id="cfg-repos" />
      <div class="repo-picker" id="repo-picker"></div>
    </div>
```

- [ ] **Step 2: Add CSS for the repo picker**

Right after the `.tribe-chip-dot` block (currently `index.html:637-643`), add:

```css
.repo-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.repo-chip {
  display: inline-flex;
  align-items: center;
  padding: 5px 11px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-family: var(--font);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.repo-chip:hover { border-color: var(--border-hover); }
.repo-chip.selected { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
```

- [ ] **Step 3: Verify in browser**

Run: `open index.html`. Open Config. Expected: a "Repos" label appears below "Tribu", with an empty area under it (no pills yet — `#repo-picker` is populated in Task 3). No console errors. The hidden `#cfg-repos` input exists (confirm via DevTools Elements tab or `document.getElementById('cfg-repos')` in Console → not `null`).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add repo picker markup and styles"
```

---

### Task 3: Wire the repo picker (build, sync, toggle)

**Files:**
- Modify: `app.js:1-52` (add `buildRepoPicker`/`syncRepoPicker`, wire into config open/save flow, call `buildRepoPicker()` at init)

**Interfaces:**
- Consumes: `REPOS_ACTIVE` (`state.js`), `el.cfgRepos` (`state.js`), `syncTribePicker`/`writeConfigFields` call sites (`app.js`, existing).
- Produces: `buildRepoPicker()` (call once at init, builds pills), `syncRepoPicker()` (call whenever config panel opens or `el.cfgRepos.value` changes elsewhere, to reflect current selection in the pill styles).

- [ ] **Step 1: Add `syncRepoPicker` and `buildRepoPicker`**

In `app.js`, right after `buildTribePicker` (currently ends at line 52), add:

```js
// ── Repo picker ──────────────────────────────────────────────

function syncRepoPicker() {
  const excluded = new Set(el.cfgRepos.value.split(',').map(s => s.trim()).filter(Boolean));
  document.querySelectorAll('.repo-chip[data-repo]').forEach(chip => {
    chip.classList.toggle('selected', !excluded.has(chip.dataset.repo));
  });
}

function buildRepoPicker() {
  const picker = document.getElementById('repo-picker');
  if (!picker) return;
  REPOS_ACTIVE.forEach(repo => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'repo-chip';
    btn.dataset.repo = repo;
    btn.textContent = repo;
    btn.addEventListener('click', () => {
      const excluded = new Set(el.cfgRepos.value.split(',').map(s => s.trim()).filter(Boolean));
      if (excluded.has(repo)) excluded.delete(repo);
      else excluded.add(repo);
      el.cfgRepos.value = [...excluded].join(',');
      syncRepoPicker();
    });
    picker.appendChild(btn);
  });
  syncRepoPicker();
}
```

- [ ] **Step 2: Call `buildRepoPicker()` at init and `syncRepoPicker()` on config open**

In `app.js`, find the config toggle handler (currently lines 81-87):

```js
let configOpen = false;
el.configToggle.addEventListener('click', () => {
  configOpen = !configOpen;
  el.configSection.classList.toggle('hidden', !configOpen);
  el.configToggle.textContent = configOpen ? 'Done' : 'Config';
  if (configOpen) { writeConfigFields(); syncTribePicker(); }
});
```

Change the last line to also sync the repo picker:

```js
  if (configOpen) { writeConfigFields(); syncTribePicker(); syncRepoPicker(); }
```

Then find the init section near the bottom (currently line 193, `buildTribePicker();`) and add the repo picker build call right after it:

```js
buildTribePicker();
buildRepoPicker();
```

Also find the two other places that call `writeConfigFields(); syncTribePicker();` together (the "no label configured yet" auto-open block, currently `app.js:199-205`):

```js
if (!state.config.label) {
  configOpen = true;
  el.configSection.classList.remove('hidden');
  el.configToggle.textContent = 'Done';
  writeConfigFields();
  syncTribePicker();
}
```

Add `syncRepoPicker();` right after `syncTribePicker();` there too:

```js
if (!state.config.label) {
  configOpen = true;
  el.configSection.classList.remove('hidden');
  el.configToggle.textContent = 'Done';
  writeConfigFields();
  syncTribePicker();
  syncRepoPicker();
}
```

- [ ] **Step 3: Verify in browser**

Run: `open index.html`. Open Config. Expected: 6 pills appear under "Repos" (`humand-web`, `humand-backoffice`, `hu-translations`, `material-hu`, `humand-main-api`, `humand-frontend-testing`), all in the "selected" (accent-colored) style. Click one — it should switch to the muted/unselected style. Click it again — it returns to accent-colored. Check DevTools Console:
```js
el.cfgRepos.value
```
Expected: empty string when all pills are selected; the clicked repo's name when one is toggled off.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: wire repo picker build/sync/toggle interactions"
```

---

### Task 4: Apply the repo filter to the main queue + persistence + final QA

**Files:**
- Modify: `render.js:122-129` (`renderList` — apply `excludedRepos` filter)

**Interfaces:**
- Consumes: `state.config.excludedRepos` (`state.js`, Task 1), `pr.repo` (existing field on every PR object, set in `github.js`'s `enrichPR`/`enrichOwnPR`).
- Produces: filtered main-queue rendering; no new exports (this is the last task).

- [ ] **Step 1: Apply the exclusion filter in `renderList`**

In `render.js`, the current top of `renderList` (lines 122-129):

```js
function renderList() {
  state.cardTimers.forEach(clearTimeout);
  state.cardTimers = [];
  const visible = state.prs.filter(pr => {
    if (!state.showIgnored && state.ignored.has(pr.id)) return false;
    if (state.readyOnly && !pr.ready) return false;
    return true;
  });

  const botPRs  = state.prs.filter(p => p.botPR);
```

Change to filter out excluded repos before anything else, so both `visible` and `botPRs` respect it:

```js
function renderList() {
  state.cardTimers.forEach(clearTimeout);
  state.cardTimers = [];
  const excludedRepos = state.config.excludedRepos || [];
  const prs = state.prs.filter(pr => !excludedRepos.includes(pr.repo));
  const visible = prs.filter(pr => {
    if (!state.showIgnored && state.ignored.has(pr.id)) return false;
    if (state.readyOnly && !pr.ready) return false;
    return true;
  });

  const botPRs  = prs.filter(p => p.botPR);
```

Then further down in the same function, the `others` computation (currently lines 133-139) also reads from `visible` (already correct, no change needed) — but double check there's no other direct `state.prs` reference inside `renderList` past this point. There is one more, in the "Mark all as rendered" line (currently line 179) — leave that one as-is, it just reads from `ready`/`others`/`botPRs`, all already derived from the filtered `prs`.

- [ ] **Step 2: Verify the filter works, end to end**

Run: `open index.html`, sign in with a token if not already, let the queue load. Open Config, note which repos currently have visible PRs in the queue (scroll the list). Toggle OFF the repo with the most PRs currently showing. Click "Save & refresh". Expected: PRs from that repo disappear from the main queue immediately (no full page reload needed — `renderList()` runs as part of the save handler's `loadPRs()` call). Toggle it back ON, save again — the PRs reappear.

- [ ] **Step 3: Verify persistence across reload**

With a repo still toggled OFF, reload the page (`Cmd+R`). Expected: the config panel (when opened) shows that repo's pill still in the unselected/muted state, and its PRs are still absent from the main queue. Check DevTools → Application → Local Storage → `prq_config` — expected to contain `"excludedRepos":["<repo-name>"]`.

- [ ] **Step 4: Verify "Mis PRs" is unaffected**

With the same repo still excluded, check the "Mis PRs" column (if you have any open PRs in that repo). Expected: they still show there, unaffected by the exclusion.

- [ ] **Step 5: Verify non-listed repos always show**

If any currently-open PR in the queue belongs to a repo not in `REPOS_ACTIVE`, confirm it has no corresponding pill in the config panel and remains visible regardless of any other toggle state.

- [ ] **Step 6: Commit and push to main**

```bash
git add render.js
git commit -m "feat: filter main queue by excludedRepos config"
git push origin main
```

## Self-Review Notes

- **Spec coverage:** §1 (snapshot data) → Task 1 Step 1. §2 (config UI, multi-select pills) → Tasks 2-3. §3 (state/persistence, default `[]`, localStorage) → Task 1 Steps 1/4, Task 4 Step 3. §4 (filtering behavior, main queue only, no extra API calls, "Mis PRs" untouched) → Task 4 Steps 1, 4. All spec sections covered.
- **Placeholder scan:** no TBD/TODO markers; all code blocks are complete and copy-pasteable; no "similar to Task N" references.
- **Type consistency:** `excludedRepos` is consistently an array of short repo-name strings across `state.js` (definition), `app.js` (toggle logic on `el.cfgRepos.value`, a comma-joined string of that same array), and `render.js` (`.includes(pr.repo)` check against `pr.repo`, which is the short name per `github.js`'s existing `enrichPR`). No naming drift (`excludedRepos` used verbatim everywhere; no `excludeRepos`/`repoExclusions` inconsistency).
