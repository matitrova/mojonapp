"""
Test de Playwright para "Ordenar por" en "Ver como lista" (idea propia,
investigada en Zonaprop/LandWatch antes de armarla — ver
feedback_buscar_inspiracion_real): precio y superficie, cada uno de
menor a mayor y de mayor a menor. Un lote sin el dato que se está
ordenando tiene que quedar siempre al final, sea cual sea el sentido.
"""

import uuid

from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

ZONA_PRUEBA = "ZonaTestOrdenar"


def _datos_lote(manzana, lote, offset, *, superficie_m2=None, precio_usd=None):
    return {
        "manzana": manzana,
        "lote": lote,
        "nomenclatura": None,
        "superficie_m2": superficie_m2,
        "precio_usd": precio_usd,
        "estado": "disponible",
        "sector": ZONA_PRUEBA,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.060000 + offset, "lat": -32.390000},
                {"lon": -65.059780 + offset, "lat": -32.390000},
                {"lon": -65.059780 + offset, "lat": -32.390200},
                {"lon": -65.060000 + offset, "lat": -32.390200},
                {"lon": -65.060000 + offset, "lat": -32.390000},
            ],
        },
    }


def _abrir_lista_filtrada_por_zona(page, base_url):
    page.goto(base_url)
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    page.locator("#filtro-cantidad").select_option("0")
    page.locator("#filtro-sector").select_option(ZONA_PRUEBA)


def test_ordenar_por_superficie_y_precio(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    chico = crear_lote_de_prueba(_datos_lote(f"ORD-CHICO-{marcador}", "1", 0, superficie_m2=300, precio_usd=50000))
    grande = crear_lote_de_prueba(_datos_lote(f"ORD-GRANDE-{marcador}", "2", 0.001, superficie_m2=5000, precio_usd=10000))
    sin_dato = crear_lote_de_prueba(_datos_lote(f"ORD-SINDATO-{marcador}", "3", 0.002))
    try:
        _abrir_lista_filtrada_por_zona(page, base_url)
        filas = page.locator("tr.fila-lote")
        expect(filas).to_have_count(3)

        page.locator("#filtro-orden").select_option("superficie-asc")
        ids_en_orden = filas.evaluate_all("els => els.map(el => el.dataset.loteId)")
        assert ids_en_orden == [chico, grande, sin_dato]

        page.locator("#filtro-orden").select_option("superficie-desc")
        ids_en_orden = filas.evaluate_all("els => els.map(el => el.dataset.loteId)")
        assert ids_en_orden == [grande, chico, sin_dato]

        page.locator("#filtro-orden").select_option("precio-asc")
        ids_en_orden = filas.evaluate_all("els => els.map(el => el.dataset.loteId)")
        assert ids_en_orden == [grande, chico, sin_dato]

        page.locator("#filtro-orden").select_option("precio-desc")
        ids_en_orden = filas.evaluate_all("els => els.map(el => el.dataset.loteId)")
        assert ids_en_orden == [chico, grande, sin_dato]

        # Volver a "Más recientes primero" no debería romper nada.
        page.locator("#filtro-orden").select_option("")
        expect(filas).to_have_count(3)
    finally:
        borrar_lote_de_prueba(chico)
        borrar_lote_de_prueba(grande)
        borrar_lote_de_prueba(sin_dato)


def test_compartir_filtro_incluye_el_orden(page, base_url):
    page.goto(base_url)
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    page.locator("#filtro-orden").select_option("precio-desc")

    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.locator("#btn-compartir-filtro").click()
    link = page.evaluate("navigator.clipboard.readText()")
    assert "orden=precio-desc" in link


def test_abrir_link_con_orden_lo_aplica(page, base_url):
    page.goto(f"{base_url}?vista=lista&orden=superficie-desc")
    expect(page.locator("#vista-lista")).to_be_visible()
    expect(page.locator("#filtro-orden")).to_have_value("superficie-desc")
