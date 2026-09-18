"""
Test de Playwright para "Comparar" en Favoritos (idea propia, investigada
en el comparador de Trulia antes de armarla — ver
feedback_buscar_inspiracion_real): tildar 2+ favoritos muestra "Comparar
(N)", y la tabla comparativa tiene que traer los datos reales de cada
lote. A propósito sin sesión (favoritos no la necesita).
"""

import uuid

from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse


def _datos_lote(manzana, lote, offset, *, superficie_m2):
    return {
        "manzana": manzana,
        "lote": lote,
        "nomenclatura": None,
        "superficie_m2": superficie_m2,
        "estado": "disponible",
        "sector": None,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.070000 + offset, "lat": -32.400000},
                {"lon": -65.069780 + offset, "lat": -32.400000},
                {"lon": -65.069780 + offset, "lat": -32.400200},
                {"lon": -65.070000 + offset, "lat": -32.400200},
                {"lon": -65.070000 + offset, "lat": -32.400000},
            ],
        },
    }


def test_comparar_dos_favoritos_muestra_tabla_con_datos_reales(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_a = crear_lote_de_prueba(_datos_lote(f"CMP-A-{marcador}", "1", 0, superficie_m2=300))
    lote_b = crear_lote_de_prueba(_datos_lote(f"CMP-B-{marcador}", "2", 0.001, superficie_m2=900))
    try:
        page.goto(base_url)
        page.evaluate(
            "ids => localStorage.setItem('mojonapp_favoritos', JSON.stringify(ids))",
            [lote_a, lote_b],
        )
        page.reload()
        # renderFavoritos() solo muestra lo que ya está en
        # getLotesActuales() — sin esperar a que la carga inicial
        # termine, el panel se abre con la lista todavía vacía.
        page.wait_for_selector(f".lote-{lote_a}", state="attached")

        abrir_menu(page)
        page.locator("#btn-abrir-favoritos").click()
        soltar_el_mouse(page)
        expect(page.locator("#lista-favoritos li")).to_have_count(2)

        btn_comparar = page.locator("#btn-comparar-favoritos")
        expect(btn_comparar).to_be_hidden()

        page.locator(f'li[data-lote-id="{lote_a}"] .favorito-comparar-check').check()
        page.locator(f'li[data-lote-id="{lote_b}"] .favorito-comparar-check').check()
        expect(btn_comparar).to_have_text("Comparar (2)")

        btn_comparar.click()
        tabla = page.locator("#tabla-comparar-lotes")
        expect(tabla).to_be_visible()
        expect(tabla).to_contain_text("300 m²")
        expect(tabla).to_contain_text("900 m²")
        expect(tabla).to_contain_text(f"Manzana CMP-A-{marcador} — Lote 1")
        expect(tabla).to_contain_text(f"Manzana CMP-B-{marcador} — Lote 2")

        # "Quitar" en una columna, con solo 1 restante tiene que cerrar
        # el comparador (no tiene sentido "comparar" un solo lote).
        page.locator("#tabla-comparar-lotes .comparar-quitar").first.click()
        expect(page.locator("#panel-comparar-lotes")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(lote_a)
        borrar_lote_de_prueba(lote_b)


def test_tocar_el_titulo_en_el_comparador_abre_la_ficha(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_a = crear_lote_de_prueba(_datos_lote(f"CMP2-A-{marcador}", "1", 0, superficie_m2=300))
    lote_b = crear_lote_de_prueba(_datos_lote(f"CMP2-B-{marcador}", "2", 0.001, superficie_m2=900))
    try:
        page.goto(base_url)
        page.evaluate(
            "ids => localStorage.setItem('mojonapp_favoritos', JSON.stringify(ids))",
            [lote_a, lote_b],
        )
        page.reload()
        # renderFavoritos() solo muestra lo que ya está en
        # getLotesActuales() — sin esperar a que la carga inicial
        # termine, el panel se abre con la lista todavía vacía.
        page.wait_for_selector(f".lote-{lote_a}", state="attached")

        abrir_menu(page)
        page.locator("#btn-abrir-favoritos").click()
        soltar_el_mouse(page)
        page.locator(f'li[data-lote-id="{lote_a}"] .favorito-comparar-check').check()
        page.locator(f'li[data-lote-id="{lote_b}"] .favorito-comparar-check').check()
        page.locator("#btn-comparar-favoritos").click()

        page.locator("#tabla-comparar-lotes .comparar-lote-titulo").first.click()

        expect(page.locator("#panel-comparar-lotes")).to_be_hidden()
        expect(page.locator("#panel-favoritos")).to_be_hidden()
        expect(page.locator("#ficha-lote")).to_be_visible()
    finally:
        borrar_lote_de_prueba(lote_a)
        borrar_lote_de_prueba(lote_b)
