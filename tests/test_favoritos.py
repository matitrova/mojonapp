"""
Tests de Playwright para Favoritos (js/favoritos.js): guardado en el propio
navegador (localStorage), sin sesión — cualquier visitante anónimo tiene
que poder marcar/sacar un lote y volver a verlo en el panel "Favoritos".
A propósito NINGUNO de estos tests loguea: es justo lo que se está
probando, que funcione sin cuenta.
"""

from playwright.sync_api import expect
from conftest import soltar_el_mouse


def _abrir_ficha_desde_lista(page, doc_id):
    """Mismo criterio que abrir_ficha_desde_lista en test_lotes.py: entra
    por "Ver como lista" en vez de tocar el polígono en el mapa, para no
    depender de dónde haya quedado encuadrado el mapa."""
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_marcar_favorito_sin_sesion_y_verlo_en_el_panel(page, base_url, lote_sembrado):
    page.goto(base_url)
    _abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])

    boton = page.locator("#btn-favorito")
    expect(boton).to_have_text("🤍")
    boton.click()
    expect(boton).to_have_text("❤️")

    # Persiste en localStorage, no en Firestore — no hace falta sesión
    # para que sobreviva a un F5.
    favoritos = page.evaluate("JSON.parse(localStorage.getItem('mojonapp_favoritos') || '[]')")
    assert lote_sembrado["doc_id"] in favoritos

    page.locator("#cerrar-ficha").click()
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-favoritos").click()
    soltar_el_mouse(page)
    expect(page.locator("#lista-favoritos")).to_contain_text(
        f"Manzana {lote_sembrado['manzana']} — Lote {lote_sembrado['lote']}"
    )


def test_quitar_favorito_desde_el_panel(page, base_url, lote_sembrado):
    page.goto(base_url)
    _abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])
    page.locator("#btn-favorito").click()
    page.locator("#cerrar-ficha").click()

    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-favoritos").click()
    soltar_el_mouse(page)
    fila = page.locator("li", has_text=f"Manzana {lote_sembrado['manzana']} — Lote {lote_sembrado['lote']}")
    expect(fila).to_have_count(1)

    fila.locator(".favorito-quitar").click()
    expect(page.locator("#favoritos-vacio")).to_be_visible()
    favoritos = page.evaluate("JSON.parse(localStorage.getItem('mojonapp_favoritos') || '[]')")
    assert lote_sembrado["doc_id"] not in favoritos
