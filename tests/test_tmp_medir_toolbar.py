"""TEMPORAL — medición del defecto #5. Borrar al terminar."""

import json

import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.con_sesion

MEDIR = """
() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right),
      scrollW: el.scrollWidth, clientW: el.clientWidth,
      overflowX: cs.overflowX, flexShrink: cs.flexShrink, flexWrap: cs.flexWrap,
    };
  };
  return {
    doc: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth },
    toolbar: r('#crm-toolbar'),
    acciones: r('#crm-toolbar-acciones'),
    filtros: r('#crm-toolbar-filtros'),
    modo: r('#crm-modo-vista'),
    exportar: r('#btn-exportar-contactos'),
    pegar: r('#btn-pegar-mail'),
    nuevo: r('#btn-agregar-contacto'),
  };
}
"""


def test_tmp_medir(page, base_url):
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(base_url + "/contactos")
    expect(page.locator("#panel-crm")).to_be_visible()
    expect(page.locator("#btn-agregar-contacto")).to_be_visible()
    page.wait_for_timeout(600)

    antes = page.evaluate(MEDIR)
    print("\n=== ANTES ===\n" + json.dumps(antes, indent=2))

    # Arreglo candidato: que el grupo de acciones pueda achicarse y
    # envolver sus botones en vez de desbordar.
    page.add_style_tag(content="#crm-toolbar-acciones { flex-wrap: wrap; flex-shrink: 1; }")
    page.wait_for_timeout(200)
    despues = page.evaluate(MEDIR)
    print("\n=== DESPUES (flex-wrap:wrap; flex-shrink:1) ===\n" + json.dumps(despues, indent=2))

    # Variante B: solo quitar flex-shrink:0, sin wrap interno.
    page.add_style_tag(content="#crm-toolbar-acciones { flex-wrap: nowrap; }")
    page.wait_for_timeout(200)
    b = page.evaluate(MEDIR)
    print("\n=== VARIANTE B (solo flex-shrink:1, sin wrap) ===\n" + json.dumps(b, indent=2))

    # Escritorio, con el arreglo puesto, para ver que no cambia nada ahí.
    page.add_style_tag(content="#crm-toolbar-acciones { flex-wrap: wrap; flex-shrink: 1; }")
    page.set_viewport_size({"width": 1280, "height": 900})
    page.wait_for_timeout(400)
    esc = page.evaluate(MEDIR)
    print("\n=== ESCRITORIO 1280 con arreglo ===\n" + json.dumps(esc, indent=2))
