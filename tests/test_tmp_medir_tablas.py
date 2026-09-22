"""TEMPORAL - medicion del defecto #7. Borrar al terminar."""

import json

import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.con_sesion

TELEFONO = {"width": 390, "height": 844}

JS_MEDIR = """
(sel) => {
  const tabla = document.querySelector(sel);
  if (!tabla) return {falta: true};
  const cont = tabla.closest('.tabla-scroll');
  const r = tabla.getBoundingClientRect();
  const rc = cont.getBoundingClientRect();
  const botones = [...tabla.querySelectorAll('button')].map(b => {
    const rb = b.getBoundingClientRect();
    return {txt: b.textContent.trim().slice(0,30), x0: Math.round(rb.left), x1: Math.round(rb.right)};
  });
  return {
    tabla_w: Math.round(r.width),
    cont_w: Math.round(rc.width),
    scrollW: cont.scrollWidth,
    clientW: cont.clientWidth,
    minWidth: getComputedStyle(tabla).minWidth,
    filas: tabla.querySelectorAll('tbody tr').length,
    botones,
  };
}
"""

FIX = """
.tabla-panel { min-width: 0; }
#tabla-lotes, #tabla-comparar-lotes, #crm-tabla-rendimiento,
[data-testid='dashboard-precios-zona'] { min-width: 600px; }
"""


def _medir(page, sel):
    return page.evaluate(JS_MEDIR, sel)


def test_medir(page, base_url):
    page.set_viewport_size(TELEFONO)
    salida = {}

    for ruta, sel in [
        ("/motivos-de-perdida", "[data-testid='tabla-motivos']"),
        ("/usuarios", "[data-testid='tabla-usuarios']"),
        ("/perfiles", "[data-testid='tabla-perfiles']"),
    ]:
        page.goto(base_url + ruta)
        expect(page.locator("#sesion-activa")).to_be_visible(timeout=20000)
        page.wait_for_timeout(2500)
        salida[ruta + " ANTES"] = _medir(page, sel)
        page.add_style_tag(content=FIX)
        page.wait_for_timeout(300)
        salida[ruta + " DESPUES"] = _medir(page, sel)

    # tabla de lotes (la ancha de verdad), con el fix puesto
    page.goto(base_url + "/lista")
    page.wait_for_timeout(3000)
    salida["/lista ANTES"] = _medir(page, "#tabla-lotes")
    page.add_style_tag(content=FIX)
    page.wait_for_timeout(300)
    salida["/lista DESPUES"] = _medir(page, "#tabla-lotes")

    print("\nRESULTADO=" + json.dumps(salida, ensure_ascii=False, indent=1))
