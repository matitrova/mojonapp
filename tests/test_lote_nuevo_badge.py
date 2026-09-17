"""
Test de Playwright para el badge "Nuevo" (idea propia, mismo criterio que
LandWatch, que deja ordenar por "listing age" — ver
feedback_buscar_inspiracion_real): un lote cargado hace ≤7 días lo
muestra junto al título, en la ficha y en "Ver como lista"; uno más
viejo, o sin el campo `creado_en` (lotes cargados antes de que existiera
este campo), no.
"""

import datetime

from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse


def _datos_lote(manzana, offset, *, creado_en):
    datos = {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": "disponible",
        "precio_usd": None,
        "sector": None,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.110000 + offset, "lat": -32.440000},
                {"lon": -65.109780 + offset, "lat": -32.440000},
                {"lon": -65.109780 + offset, "lat": -32.440200},
                {"lon": -65.110000 + offset, "lat": -32.440200},
                {"lon": -65.110000 + offset, "lat": -32.440000},
            ],
        },
    }
    if creado_en is not None:
        datos["creado_en"] = creado_en
    return datos


def _abrir_ficha_desde_lista(page, doc_id):
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_badge_nuevo_en_lista_y_ficha_segun_antiguedad(page, base_url):
    ahora = datetime.datetime.now(datetime.timezone.utc).isoformat()
    hace_10_dias = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=10)).isoformat()

    reciente = crear_lote_de_prueba(_datos_lote("NUEVO-A", 0, creado_en=ahora))
    viejo = crear_lote_de_prueba(_datos_lote("NUEVO-B", 0.001, creado_en=hace_10_dias))
    sin_campo = crear_lote_de_prueba(_datos_lote("NUEVO-C", 0.002, creado_en=None))
    try:
        page.goto(base_url)
        page.locator("#btn-menu").click()
        page.locator("#btn-ver-lista").click()
        soltar_el_mouse(page)
        page.locator("#filtro-cantidad").select_option("0")

        fila_reciente = page.locator(f'tr[data-lote-id="{reciente}"]')
        fila_vieja = page.locator(f'tr[data-lote-id="{viejo}"]')
        fila_sin_campo = page.locator(f'tr[data-lote-id="{sin_campo}"]')
        expect(fila_reciente.locator(".chip-nuevo")).to_be_visible()
        expect(fila_vieja.locator(".chip-nuevo")).to_have_count(0)
        expect(fila_sin_campo.locator(".chip-nuevo")).to_have_count(0)

        fila_reciente.click()
        expect(page.locator("#ficha-titulo .chip-nuevo")).to_be_visible()
    finally:
        borrar_lote_de_prueba(reciente)
        borrar_lote_de_prueba(viejo)
        borrar_lote_de_prueba(sin_campo)
