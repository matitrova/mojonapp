"""
Test de Playwright para "Compartir este filtro" en "Ver como lista"
(js/vista-lista.js): arma un link con los filtros puestos en la URL
(?vista=lista&...) y, al abrirlo, la app tiene que abrir el panel con
esos mismos filtros ya aplicados — mismo criterio que "Compartir este
lote", pero para el estado completo de la grilla en vez de un lote
puntual.
"""

import uuid

from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

ZONA_PRUEBA = "ZonaTestCompartirFiltro"


def _datos_lote(manzana, lote, offset, *, superficie_m2, estado="disponible"):
    return {
        "manzana": manzana,
        "lote": lote,
        "nomenclatura": None,
        "superficie_m2": superficie_m2,
        "estado": estado,
        "sector": ZONA_PRUEBA,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.050000 + offset, "lat": -32.380000},
                {"lon": -65.049780 + offset, "lat": -32.380000},
                {"lon": -65.049780 + offset, "lat": -32.380200},
                {"lon": -65.050000 + offset, "lat": -32.380200},
                {"lon": -65.050000 + offset, "lat": -32.380000},
            ],
        },
    }


def test_compartir_filtro_arma_un_link_con_los_filtros_actuales(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    chico = crear_lote_de_prueba(_datos_lote(f"CF-CHICO-{marcador}", "1", 0, superficie_m2=300))
    grande = crear_lote_de_prueba(_datos_lote(f"CF-GRANDE-{marcador}", "2", 0.001, superficie_m2=5000))
    try:
        page.goto(base_url)
        abrir_menu(page)
        page.locator("#btn-ver-lista").click()
        soltar_el_mouse(page)
        page.locator("#filtro-cantidad").select_option("0")
        page.locator("#filtro-sector").select_option(ZONA_PRUEBA)
        page.locator("#filtro-superficie-min").fill("1000")

        # navigator.share no está disponible en el Chromium de prueba —
        # cae al flujo de portapapeles, que es el que se puede leer acá
        # (pide permiso explícito, si no Playwright lo bloquea).
        page.context.grant_permissions(["clipboard-read", "clipboard-write"])
        page.locator("#btn-compartir-filtro").click()
        link = page.evaluate("navigator.clipboard.readText()")

        assert "vista=lista" in link
        assert f"sector={ZONA_PRUEBA}" in link
        assert "superficieMin=1000" in link
    finally:
        borrar_lote_de_prueba(chico)
        borrar_lote_de_prueba(grande)


def test_abrir_un_link_de_filtro_compartido_aplica_esos_filtros(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    chico = crear_lote_de_prueba(_datos_lote(f"CF2-CHICO-{marcador}", "1", 0, superficie_m2=300))
    grande = crear_lote_de_prueba(_datos_lote(f"CF2-GRANDE-{marcador}", "2", 0.001, superficie_m2=5000))
    try:
        page.goto(f"{base_url}?vista=lista&sector={ZONA_PRUEBA}&superficieMin=1000")

        vista_lista = page.locator("#vista-lista")
        expect(vista_lista).to_be_visible()
        expect(page.locator("#filtro-sector")).to_have_value(ZONA_PRUEBA)
        expect(page.locator("#filtro-superficie-min")).to_have_value("1000")

        expect(page.locator(f'tr[data-lote-id="{grande}"]')).to_be_visible()
        expect(page.locator(f'tr[data-lote-id="{chico}"]')).to_have_count(0)
    finally:
        borrar_lote_de_prueba(chico)
        borrar_lote_de_prueba(grande)
