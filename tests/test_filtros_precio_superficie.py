"""
Test de Playwright para los filtros de precio y superficie en "Ver como
lista" (js/vista-lista.js): un lote sin ese dato cargado tiene que quedar
afuera apenas se completa un mínimo o máximo — mismo criterio que un
portal inmobiliario real, donde no se puede asegurar que un lote sin
precio esté "dentro" de un rango de precio.
"""

import uuid

from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

ZONA_PRUEBA = "ZonaTestFiltros"


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
                {"lon": -65.040000 + offset, "lat": -32.370000},
                {"lon": -65.039780 + offset, "lat": -32.370000},
                {"lon": -65.039780 + offset, "lat": -32.370200},
                {"lon": -65.040000 + offset, "lat": -32.370200},
                {"lon": -65.040000 + offset, "lat": -32.370000},
            ],
        },
    }


def _abrir_lista_filtrada_por_zona(page, base_url):
    page.goto(base_url)
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    page.locator("#filtro-cantidad").select_option("0")
    page.locator("#filtro-sector").select_option(ZONA_PRUEBA)


def test_filtro_de_superficie_excluye_lotes_fuera_de_rango_y_sin_dato(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    chico = crear_lote_de_prueba(_datos_lote(f"FS-CHICO-{marcador}", "1", 0, superficie_m2=300))
    grande = crear_lote_de_prueba(_datos_lote(f"FS-GRANDE-{marcador}", "2", 0.001, superficie_m2=5000))
    sin_dato = crear_lote_de_prueba(_datos_lote(f"FS-SINDATO-{marcador}", "3", 0.002, superficie_m2=None))
    try:
        _abrir_lista_filtrada_por_zona(page, base_url)

        filas = page.locator("tr.fila-lote")
        expect(filas).to_have_count(3)

        page.locator("#filtro-superficie-min").fill("1000")

        expect(page.locator(f'tr[data-lote-id="{grande}"]')).to_be_visible()
        expect(page.locator(f'tr[data-lote-id="{chico}"]')).to_have_count(0)
        expect(page.locator(f'tr[data-lote-id="{sin_dato}"]')).to_have_count(0)
        expect(filas).to_have_count(1)
    finally:
        borrar_lote_de_prueba(chico)
        borrar_lote_de_prueba(grande)
        borrar_lote_de_prueba(sin_dato)


def test_filtro_de_precio_admite_rango_desde_hasta(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    barato = crear_lote_de_prueba(_datos_lote(f"FP-BARATO-{marcador}", "1", 0, precio_usd=5000))
    medio = crear_lote_de_prueba(_datos_lote(f"FP-MEDIO-{marcador}", "2", 0.001, precio_usd=15000))
    caro = crear_lote_de_prueba(_datos_lote(f"FP-CARO-{marcador}", "3", 0.002, precio_usd=40000))
    try:
        _abrir_lista_filtrada_por_zona(page, base_url)
        expect(page.locator("tr.fila-lote")).to_have_count(3)

        page.locator("#filtro-precio-min").fill("10000")
        page.locator("#filtro-precio-max").fill("20000")

        expect(page.locator(f'tr[data-lote-id="{medio}"]')).to_be_visible()
        expect(page.locator("tr.fila-lote")).to_have_count(1)
    finally:
        borrar_lote_de_prueba(barato)
        borrar_lote_de_prueba(medio)
        borrar_lote_de_prueba(caro)


def test_limpiar_los_filtros_de_precio_y_superficie_vuelve_a_mostrar_todo(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_a = crear_lote_de_prueba(_datos_lote(f"FL-A-{marcador}", "1", 0, superficie_m2=300, precio_usd=5000))
    lote_b = crear_lote_de_prueba(_datos_lote(f"FL-B-{marcador}", "2", 0.001, superficie_m2=5000, precio_usd=40000))
    try:
        _abrir_lista_filtrada_por_zona(page, base_url)
        expect(page.locator("tr.fila-lote")).to_have_count(2)

        page.locator("#filtro-superficie-min").fill("1000")
        expect(page.locator("tr.fila-lote")).to_have_count(1)

        page.locator("#filtro-superficie-min").fill("")
        expect(page.locator("tr.fila-lote")).to_have_count(2)
    finally:
        borrar_lote_de_prueba(lote_a)
        borrar_lote_de_prueba(lote_b)
