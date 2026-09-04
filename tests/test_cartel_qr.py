"""
Test de Playwright para "Cartel con QR para imprimir" en la ficha
(idea #7, js/ficha.js): el botón tiene que abrir un panel con el título
del lote y una imagen de QR que apunte al mismo link que "Compartir
este lote" (?lote=<id>).
"""

from urllib.parse import unquote

from playwright.sync_api import expect


def _abrir_ficha_desde_lista(page, doc_id):
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_cartel_qr_muestra_titulo_y_qr_del_link_correcto(page, base_url, lote_sembrado):
    page.goto(base_url)
    _abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])

    page.locator("#btn-cartel-qr").click()

    panel = page.locator("#panel-cartel-qr")
    expect(panel).to_be_visible()
    expect(page.locator("#cartel-qr-titulo")).to_have_text(
        f"Manzana {lote_sembrado['manzana']} — Lote {lote_sembrado['lote']}"
    )

    imagen = page.locator("#cartel-qr-imagen")
    src = imagen.get_attribute("src")
    assert src.startswith("https://api.qrserver.com/v1/create-qr-code/")
    assert f"lote%3D{lote_sembrado['doc_id']}" in src or f"lote={lote_sembrado['doc_id']}" in unquote(src)

    page.locator("#cerrar-cartel-qr").click()
    expect(panel).to_be_hidden()
