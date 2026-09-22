"""TEMPORAL: mide el alto del menú lateral. Borrar al terminar."""

import json

import pytest
from playwright.sync_api import expect


MEDICION = """
() => {
  const nav = document.querySelector('#drawer-menu');
  const est = getComputedStyle(nav);
  const r = nav.getBoundingClientRect();
  const items = [...nav.querySelectorAll('.drawer-item, .menu-categoria, .menu-modulo-nombre, #lateral-usuario')]
    .filter(e => e.offsetParent !== null)
    .map(e => ({t: (e.textContent || '').trim().slice(0, 30), bottom: Math.round(e.getBoundingClientRect().bottom)}));
  const antes = nav.scrollTop;
  nav.scrollTop = 99999;
  const despues = nav.scrollTop;
  nav.scrollTop = antes;
  return {
    top: Math.round(r.top), alto_caja: Math.round(r.height),
    clientHeight: nav.clientHeight, scrollHeight: nav.scrollHeight,
    ancho_barra: nav.offsetWidth - nav.clientWidth,
    overflowY: est.overflowY, position: est.position,
    scrollTopMax: despues,
    viewport: [window.innerWidth, window.innerHeight],
    anchoLateral: getComputedStyle(document.documentElement).getPropertyValue('--ancho-lateral'),
    altoEncab: getComputedStyle(document.documentElement).getPropertyValue('--alto-encabezado'),
    clasesBody: document.body.className,
    items,
  };
}
"""


@pytest.mark.con_sesion
def test_tmp_medir(page, base_url):
    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.wait_for_selector("#btn-abrir-ia:not(.oculto)", timeout=20000)
    page.mouse.move(700, 400)
    page.wait_for_timeout(500)

    for w, h in ((1440, 900), (1366, 768)):
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(400)
        print(f"\n===== {w}x{h} =====")
        print(json.dumps(page.evaluate(MEDICION), indent=1, ensure_ascii=False))
