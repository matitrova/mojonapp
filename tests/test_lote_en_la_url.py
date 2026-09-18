"""
El lote abierto vive en la URL.

POR QUÉ ESTO ES ESTRUCTURAL Y NO UN DETALLE. Pedido del usuario del
2026-09-18: "sin un ID en la URL es info flotante que puede ser
duplicable... no puede fallarle algo así a una inmobiliaria".

Tiene razón en el fondo: un lote abierto sin identificador en la
dirección no es una cosa a la que se pueda volver. No se puede recargar
sin perderlo, no se puede mandar por WhatsApp, no se pueden tener dos
abiertos en dos pestañas, y el "atrás" del navegador no significa nada.
Para una inmobiliaria el link a una propiedad es el objeto que circula
entre el corredor y el cliente.

Lo que se prueba acá es justamente eso: que el identificador aparezca
solo, que sobreviva a una recarga, y que desaparezca cuando el lote
deja de estar abierto (si no, recargar reabriría algo que el usuario
cerró).
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

pytestmark = pytest.mark.con_sesion

GEOMETRIA = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.080000, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410000},
    ],
}


@pytest.fixture
def lote_de_prueba():
    manzana = f"URL-{uuid.uuid4().hex[:8]}"
    doc_id = crear_lote_de_prueba(
        {
            "manzana": manzana,
            "lote": "1",
            "nomenclatura": None,
            "superficie_m2": 1000,
            "estado": "disponible",
            "precio_usd": 20000,
            "sector": None,
            "barrio": None,
            "geometry": GEOMETRIA,
        }
    )
    try:
        yield {"id": doc_id, "manzana": manzana}
    finally:
        borrar_lote_de_prueba(doc_id)


def _abrir_desde_la_lista(page, base_url, lote):
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()
    abrir_menu(page)
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-buscar").fill(lote["manzana"])
    expect(page.locator(f'tr[data-lote-id="{lote["id"]}"]')).to_be_visible()
    page.locator(f'tr[data-lote-id="{lote["id"]}"]').click()
    expect(page.locator("#ficha-lote")).to_be_visible()


def test_elegir_un_lote_de_la_lista_lo_deja_en_la_url(page, base_url, lote_de_prueba):
    """El caso que motivó el pedido."""
    _abrir_desde_la_lista(page, base_url, lote_de_prueba)
    assert f"lote={lote_de_prueba['id']}" in page.url, f"la URL quedó en {page.url}"


def test_recargar_vuelve_al_mismo_lote(page, base_url, lote_de_prueba):
    """Lo que distingue "una URL linda" de una dirección de verdad.

    Si al recargar se pierde el lote, el identificador de la barra era
    decorativo.
    """
    _abrir_desde_la_lista(page, base_url, lote_de_prueba)
    page.reload()
    expect(page.locator("#ficha-lote")).to_be_visible()
    expect(page.locator("#ficha-titulo")).to_contain_text(lote_de_prueba["manzana"])


def test_cerrar_la_ficha_saca_el_lote_de_la_url(page, base_url, lote_de_prueba):
    """Si quedara, recargar reabriría una ficha que el usuario cerró."""
    _abrir_desde_la_lista(page, base_url, lote_de_prueba)
    page.locator("#cerrar-ficha").click()
    expect(page.locator("#ficha-lote")).to_be_hidden()
    assert "lote=" not in page.url, f"la URL quedó en {page.url}"


def test_irse_a_otra_seccion_tambien_lo_saca(page, base_url, lote_de_prueba):
    """La ficha es una hoja sobre el mapa: en /contactos no existe, así
    que su identificador tampoco tiene por qué seguir en la dirección."""
    _abrir_desde_la_lista(page, base_url, lote_de_prueba)
    abrir_menu(page)
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()
    assert "lote=" not in page.url, f"la URL quedó en {page.url}"
