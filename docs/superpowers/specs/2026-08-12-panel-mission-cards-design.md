# El panel muestra lo que mission-control ve

**Goal:** el panel local pinta las cinco fuentes de mission-control, sus leases y sus
cuatro estados, en el mismo vocabulario de cards que ya usa para worktrees y PRs —
sin dejar de ser read-only.

**Por qué ahora:** mission-control (`~/Code/workbench/mission-control`) ganó entre el
10 y el 11/08 cinco fuentes, leases, colas de tickets, takequeue y el contrato de
cuatro estados por fuente. El panel quedó en C1 — worktrees, sesiones y PRs — y no
lee nada de eso: cero referencias a `assist`, `lease`, `inbox` o `friction` en
`local.js`, `collect.js` o `index.html`. Lo único que tiene de degradación es
`· N warnings` en el header (`local.js:665,680,690`), que no distingue una fuente
ausente de una fuente vacía.

Esto es la §6 del spec del 2026-08-03 (`docs/superpowers/specs/2026-08-03-work-assistant-design.md:196`)
cumplida a medias a propósito: se hace la mitad de lectura, no la de escritura.

## Non-goals

- **Contestar preguntas desde el panel.** `POST /api/answer` sigue diferido
  (decisión del dueño, 12/08). El panel muestra la pregunta y sus opciones; contestar
  es `/mission-control` en la terminal.
- **Ejecutar acciones.** El browser nunca lanza un proceso. Sin cambios respecto del
  spec original.
- **Reimplementar las fuentes.** pr-queue no aprende qué es Jira ni fricción.
- **Tocar `collect.js`.** Sigue siendo el dueño de worktrees, sesiones y PRs.
- **Prometerle mission-control a un visitante de GH Pages.** Es personal y no lo tiene.

## 1. Arquitectura

```
   /api/local   ──▶ collect.js ────────────────▶ worktrees, sesiones, PRs   (hoy)
   /api/mission ──▶ bin/mission.js ──▶ exec mc ─▶ status (5 fuentes) + lease
                                                 ↓
                                mission.js (puro) ─▶ cards
                                                 ↓
                       local.js cose ambos en un solo vocabulario de cards
```

**Dos fetches independientes.** El source `work` de mc tiene timeouts internos de
180s (`mission-control/src/sources/work.js:34-35`). Si se cuelga, las cards de proceso
ya están pintadas y sólo la parte de mission queda marcada como vieja. Un solo payload
las acopla y una fuente lenta deja el panel entero en blanco.

**Dos execs, una respuesta.** `mc status` y `mc lease`. Los leases **no viven en el
snapshot** (sus claves son `at, generatedAt, sources, ask, deferred, declined, take`):
salen por `mc lease` sin subcomando, que es un dir read instantáneo
(`mission-control/src/cli.js:213`).

**Tres archivos nuevos**, siguiendo el split que ya usa el repo (`collect.js` puro con
IO inyectado + `bin/collect.js` con la IO real):

| archivo | qué es | quién lo carga |
|---|---|---|
| `mission.js` | puro, sin IO, sin deps: parsea la salida de mc, la clasifica en los 4 estados y construye las cards. Footer de export dual como `classify.js` | `index.html` como `<script src>` **y** `require()` en Node |
| `bin/mission.js` | la IO real: `exec` de `mc`, resolución de `PRQ_MC_BIN`, TTL y single-flight | `serve.js` |
| `tests/mission.test.js` | `node --test`, `exec` inyectado | — |

`local.js` sólo gana el fetch y el punto de montaje; la construcción de cards vive en
`mission.js` para no engordar un archivo que ya tiene 857 líneas.

## 2. Contrato de `/api/mission`

```js
{ status: 'ok'|'degraded'|'absent'|'broken',   // el read entero, no una fuente
  mcBin, generatedAt, ageMs,                   // edad del SNAPSHOT, no del fetch
  sources: [ /* crudas, como las emite mc: name, status, headline, detail,
                install{what,where,how}, items[], + sus campos propios */ ],
  ask: [...],                                  // {id, source, priority, item{...}}
  deferred: n, take: {...},
  leases: { active: [{path, branch, forWhat, minutesLeft}], expired: [...],
            error: null | string },
  error: null | { code, stderr, timedOut } }
```

| decisión | valor | por qué |
|---|---|---|
| `PRQ_MC_BIN` | default `$CLAUDE_CONFIG_DIR/mission-control/bin/mc`, con fallback a `~/.claude/…` | `shareability.test.js` falla si aparece un home hardcodeado |
| TTL del sidecar | 60s (`?fresh=1` pasa `--fresh` a mc) | mc ya cachea 5 min en disco; el TTL del sidecar sólo evita un spawn por poll |
| single-flight | sí | dos polls concurrentes no disparan dos `mc status` |
| timeout del exec | 20s | el `ask`/`--dry-run` de mc puede tardar; el panel no puede |

Los cuatro estados de cada fuente **pasan crudos**. pr-queue no reinterpreta `absent`
vs `broken`, sólo los pinta distinto: el que tiene que hacer cosas distintas con cada
uno es el lector.

Con una excepción obligatoria: `mission.js` tiene que aplicar el mismo `normalize()`
que mc (`src/status.js:22`), que mapea el legacy `no-check` a `broken`. mc cachea el
snapshot 5 minutos en disco, así que una caché escrita por una versión anterior le
puede llegar al panel con `no-check` y, sin normalizar, caería en el `else` de los
estados conocidos — un quinto estado fantasma que nadie pintó.

## 3. Los kinds de card

Todas con el markup que ya existe (`.proc-card`, `.badge`, `.pr-actions`), porque un
vocabulario visual es el punto de coserlas al panel en vez de abrir tabs.

| kind | de dónde sale | cuándo aparece | qué evita |
|---|---|---|---|
| `process` | `collect.js` | siempre | — |
| ↳ cosido | `ask[]` cuyo `item.processKey` matchea la clave del proceso + `leases.active` que cubre su path o branch | dentro de la card | que la pregunta y el lease vivan lejos del trabajo que describen |
| `mission` | el read entero | siempre que `mc` esté presente (ver §5: ausente y sin configurar ⇒ ninguna card, tampoco esta), mínima: `mc · hace 3m · 5/5 fuentes` | que "no hay cards nuevas" se lea como "todo ok" cuando no leyó |
| `source` | cada fuente **no**-`ok` | `absent` → gris con `install.what/where/how`; `broken` → rojo con exit + 1ª línea de stderr; `degraded` → ámbar | ausente ≡ vacío |
| `question` | `ask[]` sin `processKey`, o cuyo proceso no está en el panel | una por pregunta | que una pregunta se caiga porque su proceso no matcheó |
| `ticket` | source `tickets` | **una card por cola** (`Shark frontend sin dueño · 58 · ver`), expandible a la lista con link y estado | 60 cards enterrando 27 procesos |
| `inbox` | source `heartbeat` (`inbox`, `attention`) | una card agregada (`inbox ×6`), expandible | una card por nota |
| `friction` | source `friction` (`open`) | una card con las observaciones abiertas del mes | — |
| `take` | `take` | una card si la takequeue tiene algo, con los `snoozed` y su fecha | — |

Una fuente `degraded` produce card **y** sus items se siguen pintando: mirar a medias
no es no mirar, y esconder los items que sí trajo sería perder información que existe.
La card es la advertencia de que los números vienen cortos.

**El match pregunta→proceso** es por `processKey` contra la clave con la que el panel
ya agrupa (ticket-o-branch). **El lease matchea por path Y por branch**, igual que en
mc (`src/lease.js:88`), porque las preguntas del drenaje no traen campo de path.

**La invariante que hace honesto al esquema:** toda fuente que no miró produce una
card, y si no se pudo leer `mc` entero, la card `mission` se pone roja. Es lo único
que hace que la ausencia de cards signifique algo.

## 4. Orden y filtros

1. `mission` y `source` en problema — un ciego es lo primero que hay que saber.
2. Los procesos, exactamente con el orden de hoy (`TU TURNO` primero).
3. El bloque informativo: `ticket`, `inbox`, `friction`, `take`.

Un chip nuevo `mc` oculta todas las cards nuevas de una. Los chips actuales
(`con PR` / `sin PR` / `abierto` / `draft`) siguen aplicando **sólo** a procesos, y
sus contadores siguen contando procesos, no cards.

## 5. Degradación

**El gotcha que rompe todo si no se dice:** `mc` usa el exit code como contrato —
`10` hay preguntas, `4` degradado, `3` alguna fuente ciega, `0` limpio
(`mission-control/src/cli.js:86-93`). Si el sidecar toma "exit ≠ 0" como fallo,
**un pase con preguntas se renderiza como roto**. El criterio de éxito es *¿parseó el
JSON?*; el exit code se guarda como dato y nada más.

| situación | qué hace el panel |
|---|---|
| `PRQ_MC_BIN` sin setear y el default no existe | cero cards nuevas, panel idéntico a hoy (es el compañero que clonó pr-queue) |
| `PRQ_MC_BIN` seteado y no existe | card `broken`: config explícita es expectativa de que exista |
| exec timeout (20s) | `broken` con `timedOut`; el browser **conserva** el último render y lo marca viejo |
| JSON no parseable | `broken`. Nunca `ok` con 0 items |
| `status` anduvo, `mc lease` falló | card `mission` ámbar: "no pude leer leases". Un lease invisible es exactamente lo que hace que el drenaje pise a un agente |

## 6. El hint de GH Pages

Hoy, si `/api/local` 404ea, el panel no monta y el visitante no se entera de que
existe. Cambia: se pinta una línea descartable (dismiss en `localStorage`, no vuelve).

```
┌──────────────────────────────────────────────────────┐
│ Además de esta cola: corriendo el sidecar local      │
│ (git clone + node serve.js) ves tus worktrees,       │
│ sesiones de Claude y PRs propios agrupados por       │
│ ticket. Nada sale de tu máquina.        [ver] [ok, ✕]│
└──────────────────────────────────────────────────────┘
```

Dos precisiones: se pinta **después** de que el fetch falla, nunca mientras está en
vuelo (si no, parpadea en localhost); y menciona sólo el sidecar, no mission-control.

Esto revierte a propósito el "someone who never runs the sidecar sees no change at
all" del spec del 2026-08-03: ese invariante era sobre no *romperle* nada, no sobre
esconderle que existe.

## 7. Preexistente: el compare no puede apuntar a la nada

`diffLinksFor` (`local.js:210`) suprime el link sólo con `onOrigin === false`
confirmado; `null` y el campo ausente lo renderizan igual, deliberadamente
(`local.js:205-209`). Pero el panel cachea el payload en `localStorage`
(`prq_proc_cache`, `local.js:12`), así que un payload viejo — de antes de que el
drenaje pushee la rama — produce un `compare/<base>...<branch>` que GitHub no puede
resolver. Es lo que se vio con `bp-prod-10230` (hoy en origin: `diverged`, 34 commits,
135 archivos).

Cambia así:

- Con `onOrigin` **desconocido** el link ya no se pinta como link: se pinta el chip de
  push que ya existe (`pushChip`, `local.js:290`) y el badge "no está en origin" que
  ya existe, con el motivo.
- Un payload servido desde caché marca sus links como no confiables hasta que el
  primer `/api/local` fresco responde. La regla vieja ("unknown se comporta como antes
  de que existiera `onOrigin`") se mantiene **sólo** para el payload fresco.
- El panel **no** pushea. Eso ya lo hace el drenaje (acción `push` del gate, ramas
  `notOnOrigin` no consumidas) y el read-only del panel no se toca por esto.

## Testing

`node --test`, sin deps, con `exec` inyectado. Consistente con el repo (353 tests
verdes en `dd567cf`).

| Unidad | Cubre |
|---|---|
| cards | un caso por kind; una fuente `ok` no produce card; `absent` produce card con los tres campos de `install` |
| estados | **exit 10 con JSON válido ⇒ `ok`** — el test que blinda el gotcha del exit code |
| estados | JSON roto ⇒ `broken`; timeout ⇒ `broken` con `timedOut`; nunca `ok` con 0 items |
| endpoint | TTL y single-flight: N requests concurrentes ⇒ 1 exec; pasado el TTL ⇒ 2 execs |
| join | pregunta con `processKey` desconocido ⇒ card propia; lease que matchea por branch cuando el path no coincide |
| tickets | 58 filas sintéticas ⇒ 1 card por cola, no 58 |
| ausencia | `PRQ_MC_BIN` sin setear + default inexistente ⇒ cero cards y ningún hint |
| shareability | el default de `PRQ_MC_BIN` se deriva de `CLAUDE_CONFIG_DIR`/homedir (`tests/shareability.test.js` ya falla con un home hardcodeado) |
| GH Pages | con `/api/local` en 404 el hint se pinta una vez y el dismiss persiste |
| compare | payload desde caché con `onOrigin` desconocido ⇒ chip de push, **no** link; el mismo payload fresco ⇒ link |

## Entrega

- Worktree `pr-queue--mission-cards`, rama `feat/panel-mission-cards`, desde `main`
  (que ya trae `assist/bin/run.js`: #5 se mergeó en squash `dd567cf` el 12/08).
- Dev en `PRQ_PORT=7778`. El sidecar vivo en `:7777` no se toca.
- PR normal contra `main`, no apilado.
- `mc lease take` sobre el worktree mientras se trabaja: es lo que el sistema pide y
  lo más fácil de saltear.

## Deferred

- `POST /api/answer` y contestar desde el panel (§6 del spec del 2026-08-03: enum-only,
  same-origin + token de archivo local).
- Ejecutar acciones mecánicas desde el panel.
- Que `mc` exponga los leases dentro del snapshot y ahorre el segundo exec.
