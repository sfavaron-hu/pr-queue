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

Solo los PRs mergeados al **tronco** del repo alimentan el cómputo — `develop` para
`humand-web`, `humand-backoffice`, `humand-mobile` y `humand-main-api`; `main` para
`material-hu` y `hu-translations`, que no tienen rama `develop`. Los `backport/*-fix-*` se
listan como evidencia adicional — son consecuencia del tren, no origen del cambio.

Sin ningún PR "contributing" por clave propia (mergeado al tronco) el resultado es
`NO_RESUELTO` y la UI ofrece un campo para la clave del padre. Esto dispara también cuando
la clave propia sí tuvo hits pero ninguno contribuye — un PR abierto, un `backport/*`, un
`deps/*` — no solo cuando la búsqueda no trajo nada: de lo contrario el fallback nunca
dispara y el panel le pide al usuario tipear la clave que ya escribió. Un hit que viene
solo del padre **nunca** sube de `NO_RESUELTO`: el padre lo comparten todos los
sub-tickets, y está verificado que devuelve PRs de hermanos.

**2 · refs de cada entorno.** Leídos en vivo, medidos el 25/08/2026 con un PAT `repo` sin
admin:

| repo | dev | stg | prd |
|---|---|---|---|
| `humand-web`, `humand-backoffice` | `develop` | var `REACT_STAGING_BRANCH` | var `REACT_PRODUCTION_BRANCH` |
| `material-hu` | `main` | idem | idem |
| `hu-translations` | `main` | `staging` | `prod` |
| `humand-mobile` | último tag `v*-dev-*` | `v*-stg-*` | `v*-prod-*` |
| `humand-main-api` | `DESCONOCIDO` | `DESCONOCIDO` | `DESCONOCIDO` |

`material-hu` no tiene rama `develop` (`GET /git/ref/heads/develop` 404). Medido contra los
últimos 30 PRs cerrados+mergeados: `main` 26 / `develop` 0. Su tronco y su ref `dev` son
los dos `main`; lo mismo mide `hu-translations` (`main` 27 / `develop` 0).

`humand-main-api` figura `branch_model: release-date` en `repos.json`, pero sus variables
son `AWS_DEV_ACCOUNT` / `AWS_PFM_ACCOUNT` / `LOKALISE_PROJECT_ID` — ninguna `REACT_*`.
Despliega por otro camino; queda declarado sin veredicto hasta leer su `cd.yml`.

`humand-mobile` son **5 destinos, no 3**: los tags son `v<semver>-<env>-<n>` con una
variante regional `-eu`, pero no simétrica por entorno — medido en la ventana de 100 tags
más recientes: 0 `dev-eu` (el último fue `v4.2.7`, ya fuera de esa ventana), 20 `stg-eu`,
8 `prod-eu`. Generar un destino `dev-eu` que la app nunca publica lo deja `DESCONOCIDO`
para siempre, una señal de degradación que no informa nada; los destinos son `dev`, `stg`,
`stg-eu`, `prd`, `prd-eu`. `v4.3.4-prod-1` y `v4.3.3-prod-eu-1` son despliegues distintos;
una fila "prd ✓" sin región miente. Su `target_commitish` es `develop` e inservible para
ancestría: el nombre del tag se pasa tal cual como `head` a `compare` — GitHub lo resuelve
del lado del servidor, no hay un `GET /git/ref/tags/<tag>` intermedio.

Elegir "el tag actual" de cada destino no es tomar el primero de `/tags`: ese endpoint
ordena lexicográfico descendente, y con un contador de build multi-dígito eso pone
`v4.3.4-dev-9` antes que `v4.3.4-dev-11`. Se comparan todos los matches por tupla numérica
`(major, minor, patch, build)`.

**3 · commit → entorno.** `GET /repos/{o}/{r}/compare/{merge_sha}...{env_ref}`; `status` en
`ahead` o `identical` significa que el commit está contenido en ese ref.

Costo ~8-15 llamadas por consulta (1 search + 1-3 pulls + 2 vars + 3 compare por repo con
PR). Límite de la API: 5000/h autenticado.

## Confianza

El nivel no es decorativo: es la única defensa contra fuentes que mienten de formas
conocidas.

| Nivel | Condición | Qué se muestra |
|---|---|---|
| `PROBADO` | clave propia + PR mergeado al tronco del repo + `compare` `ahead`/`identical` | PR, sha, ref, fecha, comando |
| `PARCIAL` | resuelto en unos repos y no en otros; repo sin modelo; las dos fuentes de prd discrepan; o algún PR no se pudo leer | además, qué quedó sin resolver y por qué, y cuántos PRs no se pudieron leer |
| `NO_RESUELTO` | sin PRs "contributing" por clave propia, y ningún fetch de detalle de PR falló; solo candidatos del padre | los candidatos, marcados como "del padre, no prueba nada" |
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

Sin build step: scripts planos en `index.html:1079-1088`, en ese orden.

| archivo | qué hace | puro |
|---|---|---|
| `github.js` | agrega `searchPRsByKey`, `repoVariable`, `compareRefs`, `lastReleaseRun`; fetchea tags y llama a `latestTag` | no (I/O) |
| `where.js` (nuevo) | recibe lo fetcheado y devuelve veredictos + confianza + evidencia; incluye `latestTag` — cuál tag es "el actual" es un juicio, no un fetch | **sí** |
| `where-render.js` (nuevo) | filas por repo/entorno, bloque de evidencia, comando copiable | no (DOM) |

`where.js` sigue el contrato de `classify.js`: función pura, sin saber de dónde vinieron
los datos, exportada vía el bloque `module.exports` del final del archivo
(`classify.js:455`) para que corra bajo `node --test`.

## Errores

| caso | comportamiento |
|---|---|
| sin PAT | el mismo cartel de conexión que ya usa la página |
| 403 rate limit | se muestra el reset y **no** se dibuja veredicto parcial silencioso |
| 403 sin nombrar rate limit (permiso, SAML/org-access) | no se relanza: es local a ese destino, degrada ese repo a `DESCONOCIDO` como cualquier otro `{error}` en banda |
| 404 en una variable de repo | ese repo pasa a `DESCONOCIDO`, no rompe la consulta |
| `compare` falla en un repo | ese repo pasa a `PARCIAL`, los demás siguen |
| `GET /pulls/{n}` falla en un PR | ese PR no cuenta, pero se cuenta: el reporte baja a `PARCIAL` y dice cuántos no se pudieron leer, nunca `NO_RESUELTO` con una afirmación no medida |
| el run de CD existe pero su release no se pudo leer | nota propia en el cruce de prd, no la de "sin run" — son dos llamadas distintas |
| clave sin formato de ticket | validación antes de gastar llamadas, también para la clave del padre |

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
