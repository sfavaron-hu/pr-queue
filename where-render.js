// Dibuja el reporte de /where. Toda la decision ya la tomo where.js: aca no
// hay logica de veredicto, solo presentacion.

var WHERE_ICON = { 'SÍ': '✓', 'NO': '✗', 'DESCONOCIDO': '?' };

function whereRowHTML(row) {
  // Un ref resuelto no alcanza para callar la razon: si no hay status (el
  // compare fallo) el motivo tiene que verse igual que en cualquier otra fila
  // no-PROBADO, no quedar detras de un ref que ya no explica nada solo.
  var detail = row.ref
    ? esc(row.ref) + (row.status ? ' · ' + esc(row.status)
                       : row.reason ? ' · ' + esc(row.reason) : '')
    : esc(row.reason || 'sin ref');
  var cmd = row.command
    ? '<code class="where-cmd" title="click para copiar">' + esc(row.command) + '</code>'
    : '';
  return '<div class="where-row" data-conf="' + esc(row.confidence) + '">'
       +   '<span class="where-env">' + esc(row.id) + '</span>'
       +   '<span class="where-val">' + WHERE_ICON[row.value] + '</span>'
       +   '<span class="where-detail">' + detail + '</span>'
       +   cmd
       + '</div>';
}

function whereRepoHTML(r) {
  if (r.model === 'unknown') {
    // La busqueda es org-wide: cualquier repo de HumandDev puede caer aca,
    // y ahi los tres entornos son DESCONOCIDO, no solo stg/prd (ese era el
    // caso especifico de humand-main-api, no la regla general). La etiqueta
    // no puede nombrar entornos que no midio.
    return '<div class="where-repo"><b>' + esc(r.repo) + '</b>'
         + '<div class="where-row" data-conf="DESCONOCIDO">'
         + '<span class="where-env">entornos</span><span class="where-val">?</span>'
         + '<span class="where-detail">' + esc(r.reason) + '</span></div></div>';
  }
  var cross = '';
  if (r.prodCross && r.prodCross.agree === false) {
    cross = '<div class="where-warn">prd discrepa: la variable dice <b>' + esc(r.prodCross.varBranch)
          + '</b> y el ultimo release (' + esc(r.prodCross.tag) + ', ' + esc(r.prodCross.runAt)
          + ') salio de <b>' + esc(r.prodCross.target) + '</b></div>';
  } else if (r.prodCross && r.prodCross.agree === null) {
    // Ninguna disputa: simplemente el cruce nunca se pudo hacer. Se muestra
    // igual, mas apagado, porque una medicion que no paso tiene que verse
    // distinta de una medicion que no se hizo.
    cross = '<div class="where-note">prd sin cruzar: ' + esc(r.prodCross.note) + '</div>';
  }
  return '<div class="where-repo"><b>' + esc(r.repo) + '</b> '
       + '<a href="' + esc(r.pr.url) + '" target="_blank" rel="noopener">#' + r.pr.number + '</a> '
       + '<code>' + esc((r.pr.mergeCommitSha || '').slice(0, 7)) + '</code>'
       + r.rows.map(whereRowHTML).join('') + cross + '</div>';
}

function whereFailedNote(report) {
  if (!report.failedPulls) return '';
  var n = report.failedPulls;
  return '<div class="where-note">' + n + (n === 1 ? ' PR no se pudo leer' : ' PRs no se pudieron leer') + '</div>';
}

function renderWhere(report) {
  var box = document.getElementById('where-result');
  var head = '<div class="where-head">' + esc(report.key)
           + ' · <span class="where-conf">' + esc(report.confidence) + '</span></div>';

  // repos vacio cubre dos causas distintas: sin ningun PR de clave propia
  // (NO_RESUELTO), o PRs de clave propia que existieron pero no se pudieron
  // leer (PARCIAL, failedPulls > 0) — el aviso tiene que decir cual paso, no
  // afirmar "sin PR mergeado" cuando lo unico que se sabe es que la lectura
  // fallo.
  if (report.repos.length === 0) {
    var cands = report.candidates.map(function (c) {
      return '<li><a href="' + esc(c.url) + '" target="_blank" rel="noopener">'
           + esc(c.repo) + ' #' + c.number + '</a> — ' + esc(c.title)
           + (c.matchedKey !== report.key ? ' <i>(hit por la clave del padre: no prueba nada)</i>' : '') + '</li>';
    }).join('');
    document.getElementById('where-parent').classList.remove('hidden');
    var warn = report.failedPulls
      ? '<div class="where-warn">No se pudo confirmar si hay PR mergeado a develop con esta clave: '
        + report.failedPulls + (report.failedPulls === 1 ? ' PR no se pudo leer.' : ' PRs no se pudieron leer.')
        + '</div>'
      : '<div class="where-warn">Sin PR mergeado a develop con esta clave. '
        + 'Si el trabajo vive en un PR titulado con la clave del padre, tipeala arriba.</div>';
    box.innerHTML = head + warn + (cands ? '<ul class="where-cands">' + cands + '</ul>' : '');
    return;
  }

  document.getElementById('where-parent').classList.add('hidden');

  var backports = report.backports.length
    ? '<div class="where-bp">backports: ' + report.backports.map(function (b) {
        return '<a href="' + esc(b.url) + '" target="_blank" rel="noopener">#' + b.number + '</a>';
      }).join(' ') + '</div>'
    : '';
  box.innerHTML = head + whereFailedNote(report) + report.repos.map(whereRepoHTML).join('') + backports;
}

async function runWhere(key, parentKey) {
  var box = document.getElementById('where-result');
  // Un error de una consulta anterior (403, clave malformada) no puede
  // quedar colgado debajo de un reporte que si resolvio: se limpia al
  // arrancar cada consulta, no solo cuando el panel de PRs carga.
  document.getElementById('error-msg').classList.add('hidden');
  box.innerHTML = '<div class="where-head">buscando ' + esc(key) + '…</div>';
  try {
    renderWhere(buildWhereReport(await whereFetchAll(key, parentKey)));
  } catch (e) {
    box.innerHTML = '';
    showError('/where: ' + (e.message || e));
  }
}
