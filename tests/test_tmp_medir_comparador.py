"""TEMPORAL — medición del comparador en teléfono. Borrar al terminar.

No carga index.html a propósito: solo el CSS real, para no tocar Firestore.
"""

import json

TELEFONO = {"width": 390, "height": 844}

MARCADO = """
<!doctype html><html lang="es"><head><meta charset="utf-8">
<link rel="stylesheet" href="estilos.css">
</head><body>
<div id="panel-comparar-lotes" class="panel-pantalla-completa">
  <div class="panel-header"><h2>Comparar lotes</h2></div>
  <div class="tabla-scroll">
    <table id="tabla-comparar-lotes" class="tabla-panel">
      <thead><tr><th></th>%COLS%</tr></thead>
      <tbody>
        <tr><th>Zona</th>%Z%</tr>
        <tr><th>Barrio</th>%B%</tr>
        <tr><th>Superficie</th>%S%</tr>
        <tr><th>Estado</th>%E%</tr>
        <tr><th>Precio</th>%P%</tr>
        <tr><th>Servicios</th>%SV%</tr>
      </tbody>
    </table>
  </div>
</div>
</body></html>
"""


def _html(n):
    th = (
        '<th><button type="button" class="comparar-lote-titulo">'
        "Manzana 100-0{i} — Lote {i}</button><br>"
        '<button type="button" class="comparar-quitar">Quitar ×</button></th>'
    )
    h = MARCADO.replace("%COLS%", "".join(th.format(i=i + 1) for i in range(n)))
    for marca, val in [
        ("%Z%", "<td>Sector Norte</td>"),
        ("%B%", "<td>Barrio Jardín</td>"),
        ("%S%", "<td>734 m²</td>"),
        ("%E%", "<td>Disponible</td>"),
        ("%P%", "<td>USD 42.000</td>"),
        ("%SV%", "<td>Agua: sí · Luz: sí · Gas: no · Cloacas: no</td>"),
    ]:
        h = h.replace(marca, val * n)
    return h


MEDIR = """
() => {
  const cont = document.querySelector('.tabla-scroll');
  const tabla = document.querySelector('#tabla-comparar-lotes');
  const cs = getComputedStyle(tabla);
  const filaSup = [...tabla.querySelectorAll('tbody tr')].find(
    tr => tr.querySelector('th').textContent === 'Superficie');
  const etiqueta = filaSup.querySelector('th');
  const csEt = getComputedStyle(etiqueta);
  const celdas = [...filaSup.children].map(c => Math.round(c.getBoundingClientRect().width));
  cont.scrollLeft = 9999;
  const rEt = etiqueta.getBoundingClientRect();
  const rCont = cont.getBoundingClientRect();
  return {
    contenedor: Math.round(rCont.width),
    tabla_ancho: Math.round(tabla.getBoundingClientRect().width),
    tabla_min_width: cs.minWidth,
    tabla_width_css: cs.width,
    columnas: celdas,
    scroll_max: Math.round(cont.scrollWidth - cont.clientWidth),
    etiqueta_position: csEt.position,
    etiqueta_left_tras_scroll: Math.round(rEt.left - rCont.left),
    etiqueta_visible_tras_scroll: rEt.right > rCont.left,
  };
}
"""


def test_tmp_medir(page, base_url):
    # Base URL dentro de /css/ para que el <link> relativo resuelva sin
    # cargar index.html (cero lecturas de Firestore).
    page.set_viewport_size(TELEFONO)
    page.goto(f"{base_url}/css/estilos.css")
    for n in (2, 3, 4):
        page.set_content(_html(n))
        page.wait_for_timeout(120)
        print(f"\n--- {n} lotes ---")
        print(json.dumps(page.evaluate(MEDIR), indent=2, ensure_ascii=False))
    assert True
