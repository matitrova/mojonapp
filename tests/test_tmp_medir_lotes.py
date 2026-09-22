"""TEMPORAL - medir el tamaño en pixeles de los poligonos al abrir el mapa."""

import json

import pytest


def _medir(page):
    page.wait_for_selector("#mapa[data-encuadre]")
    page.wait_for_selector("#mapa path.lote-poligono", timeout=15000)
    page.wait_for_timeout(1500)
    return page.evaluate(
        """() => {
      const cont = document.getElementById('mapa');
      const r = cont.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('#mapa img.leaflet-tile')].map(t => t.src);
      const z = tiles.map(s => (s.match(/tile\\/(\\d+)\\//) || [])[1]).filter(Boolean);
      const polis = [...document.querySelectorAll('#mapa path.lote-poligono')].map(p => {
        const b = p.getBBox();
        return {w: Math.round(b.width), h: Math.round(b.height)};
      });
      polis.sort((a,b) => (b.w*b.h) - (a.w*a.h));
      return {
        encuadre: cont.dataset.encuadre,
        contenedor: [Math.round(r.width), Math.round(r.height)],
        zoomsTiles: [...new Set(z)],
        cantidad: polis.length,
        mayor: polis[0],
        menor: polis[polis.length - 1],
        todos: polis
      };
    }"""
    )


@pytest.mark.con_sesion
def test_tmp_escritorio(page, base_url):
    page.set_viewport_size({"width": 1280, "height": 900})
    page.goto(base_url)
    print("\nESCRITORIO:", json.dumps(_medir(page), indent=1))


@pytest.mark.con_sesion
def test_tmp_telefono(page, base_url):
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(base_url)
    print("\nTELEFONO:", json.dumps(_medir(page), indent=1))
