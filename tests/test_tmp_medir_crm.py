"""TEMPORAL - medicion del defecto #4 (header sticky del CRM). BORRAR."""

import json

import pytest
from playwright.sync_api import expect

ANCHO_ESCRITORIO = {"width": 1200, "height": 900}

MEDICION = """
() => {
  const panel = document.querySelector('#panel-crm');
  const header = panel.querySelector('.panel-header');
  const ids = ['crm-buscar', 'btn-crm-modo-kanban', 'btn-crm-modo-tabla',
               'btn-agregar-contacto', 'btn-exportar-contactos', 'crm-toolbar'];
  const out = {
    scrollTop: panel.scrollTop,
    scrollHeight: panel.scrollHeight,
    clientHeight: panel.clientHeight,
    maxScroll: panel.scrollHeight - panel.clientHeight,
    panelRect: [panel.getBoundingClientRect().top, panel.getBoundingClientRect().bottom],
    headerRect: [header.getBoundingClientRect().top, header.getBoundingClientRect().bottom],
    headerPos: getComputedStyle(header).position,
    controles: {},
  };
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out.controles[id] = 'no existe'; continue; }
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    out.controles[id] = {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      centro: [Math.round(cx), Math.round(cy)],
      hit: hit ? (hit.tagName + '#' + (hit.id || '') + '.' + hit.className) : null,
      esEl: hit === el || (hit && el.contains(hit)),
    };
  }
  return out;
}
"""


@pytest.mark.con_sesion
def test_tmp_medir(page, base_url):
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(f"{base_url}/contactos")
    expect(page.locator("#panel-crm")).to_be_visible()
    expect(page.locator("#crm-toolbar")).to_be_visible()
    page.wait_for_timeout(1500)

    for st in [0, 300, 700, 99999]:
        page.evaluate(
            "(st) => { document.querySelector('#panel-crm').scrollTop = st; }", st
        )
        page.wait_for_timeout(120)
        datos = page.evaluate(MEDICION)
        print(f"\n=== pedido scrollTop={st} ===")
        print(json.dumps(datos, indent=1, ensure_ascii=False))

    # Y lo mismo en la vista Tabla
    page.evaluate("() => { document.querySelector('#panel-crm').scrollTop = 0; }")
    page.locator("#btn-crm-modo-tabla").click()
    page.wait_for_timeout(400)
    page.evaluate("() => { document.querySelector('#panel-crm').scrollTop = 99999; }")
    page.wait_for_timeout(150)
    print("\n=== vista TABLA, fondo del scroll ===")
    print(json.dumps(page.evaluate(MEDICION), indent=1, ensure_ascii=False))
