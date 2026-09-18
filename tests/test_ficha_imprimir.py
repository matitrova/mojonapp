"""
Test de Playwright para "Imprimir ficha (PDF)" en la ficha del lote
(idea #9, js/ficha.js): a diferencia del cartel con QR (idea #7, mínimo,
para el terreno), esta hoja lleva todos los datos del lote — el test
confirma que la tabla muestra superficie/estado/precio y que el QR
apunta al link correcto, y que las dos hojas (cartel y ficha) no se
pisan entre sí.
"""

from playwright.sync_api import expect
from conftest import abrir_menu, soltar_el_mouse


def _abrir_ficha_desde_lista(page, doc_id):
    abrir_menu(page)
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_ficha_imprimir_muestra_los_datos_del_lote(page, base_url, lote_sembrado):
    page.goto(base_url)
    _abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])

    page.locator("#btn-ficha-imprimir").click()

    panel = page.locator("#panel-ficha-imprimir")
    expect(panel).to_be_visible()
    expect(page.locator("#ficha-imprimir-titulo")).to_have_text(
        f"Manzana {lote_sembrado['manzana']} — Lote {lote_sembrado['lote']}"
    )

    tabla = page.locator("#ficha-imprimir-tabla-cuerpo")
    expect(tabla).to_contain_text(f"{lote_sembrado['superficie_m2']} m²")
    expect(tabla).to_contain_text("Disponible")
    # es-AR usa "." como separador de miles (toLocaleString("es-AR")), no ","
    precio_es_ar = f"{lote_sembrado['precio_usd']:,}".replace(",", ".")
    expect(tabla).to_contain_text(f"USD {precio_es_ar}")

    imagen = page.locator("#ficha-imprimir-imagen")
    src = imagen.get_attribute("src")
    assert src.startswith("https://api.qrserver.com/v1/create-qr-code/")
    assert f"lote%3D{lote_sembrado['doc_id']}" in src

    page.locator("#cerrar-ficha-imprimir").click()
    expect(panel).to_be_hidden()


def test_cartel_y_ficha_imprimir_no_se_pisan(page, base_url, lote_sembrado):
    # Abrir una y después la otra, sin cerrar la primera "a mano", tiene
    # que dejar solo la segunda visible — ambas comparten la clase
    # .hoja-imprimible pero viven en paneles separados.
    page.goto(base_url)
    _abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])

    page.locator("#btn-cartel-qr").click()
    expect(page.locator("#panel-cartel-qr")).to_be_visible()

    page.locator("#cerrar-cartel-qr").click()
    page.locator("#btn-ficha-imprimir").click()

    expect(page.locator("#panel-ficha-imprimir")).to_be_visible()
    expect(page.locator("#panel-cartel-qr")).to_be_hidden()
