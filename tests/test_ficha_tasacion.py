"""
Test de Playwright para "Tasador automático simple" en la ficha (idea
propia, módulo #3 del listado para competir con Tokko — Tokko no ofrece
una tasación automática ni siquiera en sus planes más caros): compara
precio_usd/m² de lotes similares (misma zona si hay 3+, si no toda la
cartera) y estima un rango ±15% sobre la mediana. Se oculta si no hay
suficientes comparables o si el lote no tiene superficie cargada — una
estimación con pocos datos sería más ruido que ayuda.
"""

from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

GEOMETRY_BASE = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.080000, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410000},
    ],
}


def _lote(manzana, *, superficie_m2, precio_usd, sector):
    return {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": superficie_m2,
        "estado": "disponible",
        "precio_usd": precio_usd,
        "sector": sector,
        "geometry": GEOMETRY_BASE,
    }


def _abrir_ficha_desde_lista(page, doc_id):
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_tasacion_usa_mediana_de_la_misma_zona(page, base_url):
    zona = "TASA-ZONA"
    # 1000 m2 a 18/20/22 USD/m2 -> mediana 20 USD/m2 -> estimado 20000, rango ±15%
    comparables = [
        crear_lote_de_prueba(_lote("TAS-A", superficie_m2=1000, precio_usd=18000, sector=zona)),
        crear_lote_de_prueba(_lote("TAS-B", superficie_m2=1000, precio_usd=20000, sector=zona)),
        crear_lote_de_prueba(_lote("TAS-C", superficie_m2=1000, precio_usd=22000, sector=zona)),
    ]
    objetivo = crear_lote_de_prueba(_lote("TAS-SIN-PRECIO", superficie_m2=1000, precio_usd=None, sector=zona))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, objetivo)

        tasacion = page.locator("#ficha-tasacion")
        expect(tasacion).to_be_visible()
        expect(page.locator("#tasacion-rango")).to_contain_text("USD 17.000")
        expect(page.locator("#tasacion-rango")).to_contain_text("USD 23.000")
        expect(page.locator("#tasacion-nota")).to_contain_text("misma zona")
    finally:
        borrar_lote_de_prueba(objetivo)
        for doc_id in comparables:
            borrar_lote_de_prueba(doc_id)


def test_tasacion_usa_toda_la_cartera_si_la_zona_no_alcanza(page, base_url):
    zona_objetivo = "TASA-ZONA-CHICA"
    otra_zona = "TASA-ZONA-OTRA"
    # Solo 1 comparable en la zona del lote (no alcanza el mínimo de 3) ->
    # cae a toda la cartera. No fijamos el rango numérico exacto porque el
    # fallback a "toda la cartera" mezcla estos comparables con cualquier
    # otro lote real con precio+superficie que ya exista en producción —
    # lo que sí podemos afirmar sin depender de esos datos ajenos es que
    # se muestra y que la nota dice "de la cartera" (no "misma zona").
    comparables = [
        crear_lote_de_prueba(_lote("TAS-D", superficie_m2=1000, precio_usd=25000, sector=zona_objetivo)),
        crear_lote_de_prueba(_lote("TAS-E", superficie_m2=1000, precio_usd=18000, sector=otra_zona)),
        crear_lote_de_prueba(_lote("TAS-F", superficie_m2=1000, precio_usd=20000, sector=otra_zona)),
        crear_lote_de_prueba(_lote("TAS-G", superficie_m2=1000, precio_usd=22000, sector=otra_zona)),
    ]
    objetivo = crear_lote_de_prueba(_lote("TAS-SIN-PRECIO-2", superficie_m2=1000, precio_usd=None, sector=zona_objetivo))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, objetivo)

        tasacion = page.locator("#ficha-tasacion")
        expect(tasacion).to_be_visible()
        expect(page.locator("#tasacion-rango")).to_contain_text("USD")
        expect(page.locator("#tasacion-nota")).to_contain_text("de la cartera")
    finally:
        borrar_lote_de_prueba(objetivo)
        for doc_id in comparables:
            borrar_lote_de_prueba(doc_id)


def test_tasacion_oculta_sin_comparables_suficientes(page, base_url):
    # No creamos ningún comparable propio: la zona es única así que
    # mismaZona queda vacía, y cae al fallback de toda la cartera — que
    # hoy en producción tiene menos de 3 lotes con precio+superficie
    # cargados (verificado en vivo). Si algún día la cartera real crece
    # por encima del mínimo, este test empezaría a fallar y habría que
    # revisarlo — es una limitación conocida de probar contra el
    # inventario real en vez de uno aislado.
    zona = "TASA-SOLA"
    objetivo = crear_lote_de_prueba(_lote("TAS-SIN-PRECIO-3", superficie_m2=1000, precio_usd=None, sector=zona))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, objetivo)
        expect(page.locator("#ficha-tasacion")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(objetivo)


def test_tasacion_oculta_sin_superficie_cargada(page, base_url):
    zona = "TASA-SINSUP"
    comparables = [
        crear_lote_de_prueba(_lote("TAS-H", superficie_m2=1000, precio_usd=18000, sector=zona)),
        crear_lote_de_prueba(_lote("TAS-I", superficie_m2=1000, precio_usd=20000, sector=zona)),
        crear_lote_de_prueba(_lote("TAS-J", superficie_m2=1000, precio_usd=22000, sector=zona)),
    ]
    objetivo = crear_lote_de_prueba(_lote("TAS-SIN-SUP", superficie_m2=None, precio_usd=None, sector=zona))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, objetivo)
        expect(page.locator("#ficha-tasacion")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(objetivo)
        for doc_id in comparables:
            borrar_lote_de_prueba(doc_id)
