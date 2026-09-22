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
    # EL FORMATO REAL: la subida guarda { url, id } (ver
    # subirFotoACloudinary en js/ficha.js). Antes acá había un string
    # suelto, un formato que la app no produce nunca — y por eso el test
    # pasaba en verde mientras la grilla mostraba src="[object Object]"
    # en todas las tarjetas con foto.
    "fotos": [{"url": "https://res.cloudinary.com/demo/image/upload/sample.jpg", "id": "demo/sample"}],
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
        foto = tarjeta.locator(".tarjeta-lote-foto")
        expect(foto).to_be_visible()
        # QUE ESTÉ VISIBLE NO ALCANZA: un <img> con un src roto también
        # ocupa lugar y Playwright lo da por visible. Lo que hay que
        # comprobar es que el src sea una URL de verdad — cuando la
        # grilla interpolaba el objeto entero, el src decía
        # "[object Object]" y el test pasaba igual.
        src = foto.get_attribute("src")
        assert src and src.startswith("http"), f"la tarjeta tiene un src roto: {src!r}"
        # NO se comprueba que la imagen termine de cargar, a propósito.
        # Eso ataría el test a que Cloudinary responda rápido: con
        # loading="lazy" la carga es asíncrona y depende de una red
        # ajena, y un test que falla porque un CDN tardó es exactamente
        # el ruido que hace que después nadie confíe en la suite. El src
        # es lo que se rompió y es lo que se prueba.
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
