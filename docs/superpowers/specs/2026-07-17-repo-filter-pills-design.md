# Repo filter pills

## Problem

`pr-queue` fetches PRs org-wide by label (tribu) with no way to exclude specific repos. The user wants to hide PRs from repos they don't care about, without losing today's "show everything" default.

## Design

### 1. Repo snapshot (data)

A hardcoded `REPOS_ACTIVE` array in `state.js`, same pattern as the existing `TRIBES` array. Built from a one-time snapshot (2026-07-17) of PR activity over the last 90 days across all 6 tribe labels in `HumandDev` (via `gh api search/issues`), ordered by total activity descending:

```js
const REPOS_ACTIVE = [
  'humand-web',              // 215
  'humand-backoffice',       // 208
  'hu-translations',         // 55
  'material-hu',             // 25
  'humand-main-api',         // 17
  'humand-frontend-testing', // 3
];
```

This list is static — it is not recomputed at runtime. Repos outside this list never get a pill and are never excludable; they always show, same as today.

### 2. Config UI

A new "Repos" field in the config panel (`index.html`), positioned near the existing "Tribu" field. Rendered as a `.repo-picker` of `.repo-chip` pills — visually reusing the `.tribe-chip` styles — one per entry in `REPOS_ACTIVE`.

Unlike the tribe picker (single-select), this is **multi-select and inverted**: all pills start "on" (selected/highlighted style) to match today's default of showing every repo. Clicking a pill toggles it to "off" (muted style), excluding that repo's PRs from the main queue. Clicking again re-includes it.

Built in `app.js` via `buildRepoPicker()` / `syncRepoPicker()`, mirroring `buildTribePicker()` / `syncTribePicker()`. Backed by a hidden input (`#cfg-repos`, comma-separated excluded repo names) the same way `#cfg-label` backs the tribe picker.

### 3. State & persistence

- `state.config.excludedRepos: []` — array of repo short names (no owner prefix). Default empty.
- Existing users with no `excludedRepos` key in their persisted config get `[]` via the same default-merge pattern already used for `org`/`bots`/`fx` in `state.js`. Empty array = nothing excluded = pixel-identical to current behavior, no migration step needed.
- Persisted in the existing `prq_config` localStorage blob (`saveConfig()`/`readConfigFields()`/`writeConfigFields()`), not in the URL (the other config fields that aren't in the URL, like `fx`, follow this same precedent).

### 4. Filtering behavior

Applied client-side in `renderList()` (`render.js`), alongside the existing `showIgnored`/`readyOnly` checks:

```js
if (state.config.excludedRepos?.includes(pr.repo)) return false;
```

No extra API calls — `loadPRs()` keeps fetching org+label across all repos exactly as it does today; the exclusion only affects what gets rendered.

Explicitly out of scope: the "Mis PRs" (own PRs) column is unaffected by `excludedRepos` — it keeps showing all of the user's own PRs regardless of repo. This only filters the main review queue.

## Testing

Manual QA (no automated test suite in this repo):
1. Fresh load with no `excludedRepos` in localStorage → all repos show, identical to pre-change behavior.
2. Open config, toggle off `humand-web` → its PRs disappear from the main queue; reload page → stays excluded (persisted).
3. Toggle it back on → PRs reappear.
4. Confirm "Mis PRs" column still shows PRs from `humand-web` even while it's excluded from the main queue.
5. Confirm a PR from a repo not in `REPOS_ACTIVE` (e.g. a one-off contributor repo) still always shows.
