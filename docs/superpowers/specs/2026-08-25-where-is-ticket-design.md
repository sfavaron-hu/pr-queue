# `/where` — ¿en qué entorno está este ticket?

Diseño, 2026-08-25.

Contesta "¿SQSH-1234 está en dev / stg / prd?" desde la página de pr-queue, sin infra
nueva, sin datos en reposo y con la credencial que la página ya pide. Cada veredicto sale
con la evidencia cruda y el comando que lo reproduce: la página no pide que le crean.

## Qué contesta y qué no

| | |
|---|---|
| Entrada | una clave de ticket (`SQSH-1234`); opcional, la clave del padre tipeada a mano |
| Salida | por repo y entorno: `SÍ` / `NO` / `DESCONOCIDO`, con nivel de confianza y evidencia |
| Alcance | los 6 repos definidos en `config/repos.json` con `branch_model` (5 `scan:true` + `material-hu`); `humand-main-api` sale `DESCONOCIDO` a propósito |
| Cache | ninguno. Cada consulta recomputa contra la API |
| Credencial | el PAT `repo` que pr-queue ya guarda en localStorage. Ninguna otra |

## Resolución, tres pasos

**1 · ticket → PRs.** `GET /search/issues?q=<KEY>+org:HumandDev+is:pr`, y por hit
`GET /repos/{o}/{r}/pulls/{n}` para `merged`, `merge_commit_sha`, `base.ref`, `head.ref`.

Solo los PRs con `base.ref === 'develop'` alimentan el cómputo. Los `backport/*-fix-*` se
listan como evidencia adicional — son consecuencia del tren, no origen del cambio.

Sin hits por clave propia el resultado es `NO_RESUELTO` y la UI ofrece un campo para la
clave del padre. Un hit que viene solo del padre **nunca** sube de `NO_RESUELTO`: el padre
lo comparten todos los sub-tickets, y está verificado que devuelve PRs de hermanos.

**2 · refs de cada entorno.** Leídos en vivo, medidos el 25/08/2026 con un PAT `repo` sin
admin:

| repo | dev | stg | prd |
|---|---|---|---|
| `humand-web`, `humand-backoffice` | `develop` | var `REACT_STAGING_BRANCH` | var `REACT_PRODUCTION_BRANCH` |
| `material-hu` | `develop` | idem | idem |
| `hu-translations` | `main` | `staging` | `prod` |
| `humand-mobile` | último tag `v*-dev-*` | `v*-stg-*` | `v*-prod-*` |
| `humand-main-api` | `develop` | `DESCONOCIDO` | `DESCONOCIDO` |

`humand-main-api` figura `branch_model: release-date` en `repos.json`, pero sus variables
son `AWS_DEV_ACCOUNT` / `AWS_PFM_ACCOUNT` / `LOKALISE_PROJECT_ID` — ninguna `REACT_*`.
Despliega por otro camino; queda declarado sin veredicto hasta leer su `cd.yml`.

`humand-mobile` son **6 destinos, no 3**: los tags son `v<semver>-<env>-<n>` con una
variante regional `-eu` (`v4.3.4-prod-1` y `v4.3.3-prod-eu-1` son despliegues distintos).
Una fila "prd ✓" sin región miente. Su `target_commitish` es `develop` e inservible para
ancestría: resolver el tag a sha con `GET /git/ref/tags/<tag>` y comparar contra el tag.

**3 · commit → entorno.** `GET /repos/{o}/{r}/compare/{merge_sha}...{env_ref}`; `status` en
`ahead` o `identical` significa que el commit está contenido en ese ref.

Costo ~8-15 llamadas por consulta (1 search + 1-3 pulls + 2 vars + 3 compare por repo con
PR). Límite de la API: 5000/h autenticado.

## Confianza

El nivel no es decorativo: es la única defensa contra fuentes que mienten de formas
conocidas.

| Nivel | Condición | Qué se muestra |
|---|---|---|
| `PROBADO` | clave propia + PR mergeado a `develop` + `compare` `ahead`/`identical` | PR, sha, ref, fecha, comando |
| `PARCIAL` | resuelto en unos repos y no en otros; repo sin modelo; o las dos fuentes de prd discrepan | además, qué quedó sin resolver y por qué |
| `NO_RESUELTO` | sin hits por clave propia; solo candidatos del padre | los candidatos, marcados como "del padre, no prueba nada" |
| `DESCONOCIDO` | el repo no tiene modelo de entorno conocido (`humand-main-api`) | la fila visible, sin veredicto, con el motivo |

**El cruce de prd.** `REACT_PRODUCTION_BRANCH` dice qué rama está *designada* prod; el
último run de CD con `event=release` + `conclusion=success` dice qué *desplegó*. El
11/08/2026 discreparon: se publicó un tag sobre la rama recién cortada. Se leen las dos y,
si no coinciden, el veredicto baja a `PARCIAL` y se muestran ambas. Nunca elegir una.

```bash
gh api repos/HumandDev/humand-web/actions/variables/REACT_PRODUCTION_BRANCH --jq .value
gh api "repos/HumandDev/humand-web/actions/runs?event=release&status=success&per_page=1" \
  --jq '.workflow_runs[0]|[.created_at,.head_branch]|@tsv'
```

## Módulos

Sin build step: scripts planos en `index.html:963-970`, en ese orden.

| archivo | qué hace | puro |
|---|---|---|
| `github.js` | agrega `searchPRsByKey`, `repoVariable`, `compareRefs`, `latestTag`, `lastReleaseRun` | no (I/O) |
| `where.js` (nuevo) | recibe lo fetcheado y devuelve veredictos + confianza + evidencia | **sí** |
| `where-render.js` (nuevo) | filas por repo/entorno, bloque de evidencia, comando copiable | no (DOM) |

`where.js` sigue el contrato de `classify.js`: función pura, sin saber de dónde vinieron
los datos, exportada vía el bloque `module.exports` del final del archivo
(`classify.js:455`) para que corra bajo `node --test`.

## Errores

| caso | comportamiento |
|---|---|
| sin PAT | el mismo cartel de conexión que ya usa la página |
| 403 rate limit | se muestra el reset y **no** se dibuja veredicto parcial silencioso |
| 404 en una variable de repo | ese repo pasa a `DESCONOCIDO`, no rompe la consulta |
| `compare` falla en un repo | ese repo pasa a `PARCIAL`, los demás siguen |
| clave sin formato de ticket | validación antes de gastar llamadas |

Regla transversal: ningún fallo de red se convierte en `NO`. Un entorno que no se pudo
leer es `DESCONOCIDO`, nunca "no está".

## Testing

`node --test` desde la raíz, sin deps, como el resto (`tests/classify-*.test.js`).
Fixtures con la forma cruda de la API — payload de `search/issues`, de `pulls/{n}`, de
`compare` — y los casos que importan: hit del padre no promociona, PR no mergeado no
cuenta, prd discrepante degrada a `PARCIAL`, repo sin modelo sale `DESCONOCIDO`, fallo de
red no produce `NO`.

## Fuera de alcance

- Índice precomputado o cache de cualquier tipo.
- Jira desde el browser: preflight desde el origin de Pages devuelve `204` sin
  `Access-Control-Allow-Origin`. La clave del padre se tipea.
- Adopción en mobile: `prod` significa publicado, no instalado. Se muestran como hechos
  distintos, no se estima el segundo.
- `humand-main-api` stg/prd, hasta iterar sobre su `cd.yml`.
