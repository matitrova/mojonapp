"""
Test de Playwright para "Simular cuotas" en la ficha (idea propia,
investigada en el simulador de financiación de REPLUS antes de armarla
— ver feedback_buscar_inspiracion_real): sin interés (a diferencia de un
crédito hipotecario, un lote en estos loteos se paga directo a la
inmobiliaria en cuotas fijas), solo visible con precio cargado.
"""

from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

LOTE_CON_PRECIO = {
    "manzana": "CALC",
    "lote": "1",
    "nomenclatura": None,
    "superficie_m2": 500,
    "estado": "disponible",
    "precio_usd": 43500,
    "sector": None,
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            {"lon": -65.080000, "lat": -32.410000},
            {"lon": -65.079780, "lat": -32.410000},
            {"lon": -65.079780, "lat": -32.410200},
            {"lon": -65.080000, "lat": -32.410200},
            {"lon": -65.080000, "lat": -32.410000},
        ],
    },
}

LOTE_SIN_PRECIO = {**LOTE_CON_PRECIO, "manzana": "CALC-SIN", "precio_usd": None}


def _abrir_ficha_desde_lista(page, doc_id):
    abrir_menu(page)
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_calculadora_muestra_anticipo_y_cuota_por_defecto(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE_CON_PRECIO)
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, doc_id)

        calc = page.locator("#ficha-calculadora-cuotas")
        expect(calc).to_be_visible()
        # Default: 20% anticipo, 12 cuotas → 43500*0.2=8700, saldo 34800/12=2900
        expect(page.locator("#calc-resultado")).to_contain_text("USD 8.700")
        expect(page.locator("#calc-resultado")).to_contain_text("12")
        expect(page.locator("#calc-resultado")).to_contain_text("USD 2.900")
    finally:
        borrar_lote_de_prueba(doc_id)


def test_calculadora_recalcula_en_vivo_al_cambiar_los_campos(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE_CON_PRECIO)
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, doc_id)

        page.locator("#calc-anticipo-pct").fill("30")
        page.locator("#calc-cantidad-cuotas").fill("6")
        # 43500*0.3=13050, saldo 30450/6=5075
        expect(page.locator("#calc-resultado")).to_contain_text("USD 13.050")
        expect(page.locator("#calc-resultado")).to_contain_text("USD 5.075")
    finally:
        borrar_lote_de_prueba(doc_id)


def test_calculadora_oculta_sin_precio_cargado(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE_SIN_PRECIO)
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, doc_id)
        expect(page.locator("#ficha-calculadora-cuotas")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(doc_id)
