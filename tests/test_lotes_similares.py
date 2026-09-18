"""
Test de Playwright para "También te puede interesar" (renderLotesSimilares
en js/ficha.js): al abrir un lote, tienen que aparecer otros lotes de la
misma zona, y tocar uno de esos tiene que llevar a SU ficha.
"""

import uuid

from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

ZONA_PRUEBA = "ZonaTestSimilares"


def _datos_lote(manzana, lote, offset):
    return {
        "manzana": manzana,
        "lote": lote,
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": "disponible",
        "sector": ZONA_PRUEBA,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.030000 + offset, "lat": -32.360000},
                {"lon": -65.029780 + offset, "lat": -32.360000},
                {"lon": -65.029780 + offset, "lat": -32.360200},
                {"lon": -65.030000 + offset, "lat": -32.360200},
                {"lon": -65.030000 + offset, "lat": -32.360000},
            ],
        },
    }


def _abrir_ficha_desde_lista(page, doc_id):
    abrir_menu(page)
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_lote_similar_de_la_misma_zona_lleva_a_su_ficha(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id_a = crear_lote_de_prueba(_datos_lote(f"SIM-A-{marcador}", "1", 0))
    doc_id_b = crear_lote_de_prueba(_datos_lote(f"SIM-B-{marcador}", "2", 0.001))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, doc_id_a)

        similar_b = page.locator(f'[data-testid="ficha-similar-{doc_id_b}"]')
        expect(similar_b).to_be_visible()
        expect(similar_b).to_contain_text(f"SIM-B-{marcador}")

        similar_b.click()
        expect(page.locator("#ficha-titulo")).to_have_text(f"Manzana SIM-B-{marcador} — Lote 2")
    finally:
        borrar_lote_de_prueba(doc_id_a)
        borrar_lote_de_prueba(doc_id_b)
