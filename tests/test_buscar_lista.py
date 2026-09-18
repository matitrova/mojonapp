"""
Test de Playwright para "Buscar" en "Ver como lista" (idea propia, mismo
criterio que el buscador del CRM — #crm-buscar en crm.js): busca en
manzana/lote/nomenclatura/zona/barrio/descripción juntos, sin tener
que saber en qué campo puntual está el dato. Integrado con "Compartir
este filtro" (?buscar=...).
"""

import uuid

from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

ZONA_PRUEBA = "ZonaTestBuscar"


def _datos_lote(manzana, lote, offset, *, sector=ZONA_PRUEBA, descripcion=None):
    return {
        "manzana": manzana,
        "lote": lote,
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": "disponible",
        "sector": sector,
        "descripcion": descripcion,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.120000 + offset, "lat": -32.450000},
                {"lon": -65.119780 + offset, "lat": -32.450000},
                {"lon": -65.119780 + offset, "lat": -32.450200},
                {"lon": -65.120000 + offset, "lat": -32.450200},
                {"lon": -65.120000 + offset, "lat": -32.450000},
            ],
        },
    }


def test_buscar_filtra_por_manzana_zona_y_descripcion(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    a = crear_lote_de_prueba(_datos_lote(f"BUS-{marcador}", "1", 0))
    b = crear_lote_de_prueba(_datos_lote("OTRA", "2", 0.001, sector="ZonaDistinta", descripcion=f"nota-{marcador}"))
    c = crear_lote_de_prueba(_datos_lote("OTRA2", "3", 0.002, sector="ZonaDistinta"))
    try:
        page.goto(base_url)
        abrir_menu(page)
        page.locator("#btn-ver-lista").click()
        soltar_el_mouse(page)
        page.locator("#filtro-cantidad").select_option("0")
        page.locator("#filtro-sector").select_option("")  # por si quedó algo de un test anterior

        buscar = page.locator("#filtro-buscar")

        # Por manzana
        buscar.fill(f"BUS-{marcador}")
        expect(page.locator(f'tr[data-lote-id="{a}"]')).to_be_visible()
        expect(page.locator(f'tr[data-lote-id="{b}"]')).to_have_count(0)

        # Por zona
        buscar.fill("ZonaDistinta")
        expect(page.locator(f'tr[data-lote-id="{b}"]')).to_be_visible()
        expect(page.locator(f'tr[data-lote-id="{c}"]')).to_be_visible()
        expect(page.locator(f'tr[data-lote-id="{a}"]')).to_have_count(0)

        # Por descripción
        buscar.fill(f"nota-{marcador}")
        expect(page.locator(f'tr[data-lote-id="{b}"]')).to_be_visible()
        expect(page.locator("tr.fila-lote")).to_have_count(1)

        # Limpiar vuelve a mostrar todo (al menos los 3 sembrados)
        buscar.fill("")
        expect(page.locator(f'tr[data-lote-id="{a}"]')).to_be_visible()
        expect(page.locator(f'tr[data-lote-id="{b}"]')).to_be_visible()
        expect(page.locator(f'tr[data-lote-id="{c}"]')).to_be_visible()
    finally:
        borrar_lote_de_prueba(a)
        borrar_lote_de_prueba(b)
        borrar_lote_de_prueba(c)


def test_compartir_filtro_incluye_la_busqueda(page, base_url):
    page.goto(base_url)
    abrir_menu(page)
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-buscar").fill("Piedra Blanca")

    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.locator("#btn-compartir-filtro").click()
    link = page.evaluate("navigator.clipboard.readText()")
    assert "buscar=Piedra+Blanca" in link or "buscar=Piedra%20Blanca" in link


def test_abrir_link_con_busqueda_lo_aplica(page, base_url):
    page.goto(f"{base_url}?vista=lista&buscar=Piedra+Blanca")
    expect(page.locator("#vista-lista")).to_be_visible()
    expect(page.locator("#filtro-buscar")).to_have_value("Piedra Blanca")
