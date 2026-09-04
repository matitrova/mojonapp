"""
Test de Playwright para "Compartir este lote" (js/ficha.js): el mensaje
tiene que incluir superficie y precio cuando están cargados (idea propia
— mismo criterio que un portal real, que arma el texto de WhatsApp con
esos datos en vez de mandar un link pelado), y omitirlos si no están.
"""

from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

LOTE_COMPLETO = {
    "manzana": "SHARE",
    "lote": "1",
    "nomenclatura": None,
    "superficie_m2": 500,
    "estado": "disponible",
    "precio_usd": 20000,
    "sector": None,
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            {"lon": -65.090000, "lat": -32.420000},
            {"lon": -65.089780, "lat": -32.420000},
            {"lon": -65.089780, "lat": -32.420200},
            {"lon": -65.090000, "lat": -32.420200},
            {"lon": -65.090000, "lat": -32.420000},
        ],
    },
}

LOTE_SIN_DATOS = {**LOTE_COMPLETO, "manzana": "SHARE-SIN", "superficie_m2": None, "precio_usd": None}


def _abrir_ficha_desde_lista(page, doc_id):
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def _forzar_flujo_portapapeles(page):
    # navigator.share no está disponible en el Chromium de prueba — cae
    # al flujo de portapapeles, que es el que se puede leer acá.
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])


def test_mensaje_incluye_superficie_y_precio_cuando_estan_cargados(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE_COMPLETO)
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, doc_id)
        _forzar_flujo_portapapeles(page)

        page.locator("#btn-compartir-lote").click()
        texto = page.evaluate("navigator.clipboard.readText()")

        assert "Manzana SHARE — Lote 1" in texto
        assert "500 m²" in texto
        assert "USD 20.000" in texto
        assert f"?lote={doc_id}" in texto
    finally:
        borrar_lote_de_prueba(doc_id)


def test_mensaje_omite_superficie_y_precio_si_no_estan_cargados(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE_SIN_DATOS)
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, doc_id)
        _forzar_flujo_portapapeles(page)

        page.locator("#btn-compartir-lote").click()
        texto = page.evaluate("navigator.clipboard.readText()")

        assert "Manzana SHARE-SIN — Lote 1" in texto
        assert "m²" not in texto
        assert "USD" not in texto
    finally:
        borrar_lote_de_prueba(doc_id)
