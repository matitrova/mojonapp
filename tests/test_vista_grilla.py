"""
Test de Playwright para el toggle Tabla/Grilla en "Ver como lista" (idea
propia, investigada en LandWatch/Zonaprop antes de armarla — ver
feedback_buscar_inspiracion_real): la grilla muestra tarjetas con foto
(si tiene), estado, título, zona/barrio, superficie y precio; tocar una
tarjeta abre la ficha igual que una fila de la tabla.
"""

from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

LOTE_CON_FOTO = {
    "manzana": "GRID-TEST",
    "lote": "1",
    "nomenclatura": None,
    "superficie_m2": 800,
    "estado": "reservado",
    "precio_usd": 12000,
    "sector": "ZonaGrilla",
    "fotos": ["https://res.cloudinary.com/demo/image/upload/sample.jpg"],
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            {"lon": -65.140000, "lat": -32.470000},
            {"lon": -65.139780, "lat": -32.470000},
            {"lon": -65.139780, "lat": -32.470200},
            {"lon": -65.140000, "lat": -32.470200},
            {"lon": -65.140000, "lat": -32.470000},
        ],
    },
}


def test_grilla_muestra_tarjeta_con_foto_y_datos_y_abre_la_ficha(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE_CON_FOTO)
    try:
        page.goto(base_url)
        abrir_menu(page)
        page.locator("#btn-ver-lista").click()
        soltar_el_mouse(page)
        page.locator("#filtro-cantidad").select_option("0")

        # Arranca en Tabla.
        expect(page.locator("#tabla-lotes-scroll")).to_be_visible()
        expect(page.locator("#grilla-lotes")).to_be_hidden()

        page.locator("#btn-modo-grilla").click()
        expect(page.locator("#tabla-lotes-scroll")).to_be_hidden()
        expect(page.locator("#grilla-lotes")).to_be_visible()

        tarjeta = page.locator(f'.tarjeta-lote[data-lote-id="{doc_id}"]')
        expect(tarjeta).to_be_visible()
        expect(tarjeta.locator(".tarjeta-lote-foto")).to_be_visible()
        expect(tarjeta).to_contain_text("Manzana GRID-TEST — Lote 1")
        expect(tarjeta).to_contain_text("Reservado")
        expect(tarjeta).to_contain_text("ZonaGrilla")
        expect(tarjeta).to_contain_text("800 m²")
        expect(tarjeta).to_contain_text("USD 12.000")

        tarjeta.click()
        expect(page.locator("#ficha-lote")).to_be_visible()
        expect(page.locator("#ficha-titulo")).to_contain_text("Manzana GRID-TEST — Lote 1")
    finally:
        borrar_lote_de_prueba(doc_id)


def test_tarjeta_sin_foto_no_muestra_imagen(page, base_url):
    datos = {**LOTE_CON_FOTO, "manzana": "GRID-SIN-FOTO", "fotos": None}
    doc_id = crear_lote_de_prueba(datos)
    try:
        page.goto(base_url)
        abrir_menu(page)
        page.locator("#btn-ver-lista").click()
        soltar_el_mouse(page)
        page.locator("#filtro-cantidad").select_option("0")
        page.locator("#btn-modo-grilla").click()

        tarjeta = page.locator(f'.tarjeta-lote[data-lote-id="{doc_id}"]')
        expect(tarjeta).to_be_visible()
        expect(tarjeta.locator(".tarjeta-lote-foto")).to_have_count(0)
    finally:
        borrar_lote_de_prueba(doc_id)
