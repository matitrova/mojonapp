"""
Página pública de un lote (/lote/<id>).

QUÉ ES Y POR QUÉ EXISTE. Es la pantalla que se le manda al comprador:
fotos grandes, precio a la vista, el mapa como un bloque al costado y un
formulario para dejar los datos. Pedido del usuario del 2026-09-18, con
una publicación de portal inmobiliario como referencia.

Convive con la ficha, que es la hoja de trabajo del corredor sobre el
mapa. Son dos usos distintos: la ficha tiene notas internas, tasación y
edición; esta no.

Lo que se prueba acá, en orden de importancia:

  - que se llegue por la URL directa, porque ESE es el objeto que
    circula entre el corredor y el cliente;
  - que un visitante SIN sesión la vea (si pidiera login, el link no
    serviría para nada);
  - que no ofrezca subir fotos a quien no puede;
  - que un lote que no existe lo diga, en vez de mostrar una página
    vacía con el precio en blanco.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

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
def lote_publicado():
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_lote_de_prueba(
        {
            "manzana": f"PUB-{marcador}",
            "lote": "7",
            "nomenclatura": "00-06-65-01-000123-000007",
            "superficie_m2": 900,
            "estado": "disponible",
            "precio_usd": 22000,
            "sector": "Potrero de los Funes",
            "barrio": "Altos del Potrero",
            "descripcion": "Lote en pendiente suave con vista al dique.",
            "servicios": {"luz": True, "agua": True, "gas": False, "cloaca": False},
            "geometry": GEOMETRIA,
        }
    )
    try:
        yield {"id": doc_id, "manzana": f"PUB-{marcador}"}
    finally:
        borrar_lote_de_prueba(doc_id)


def test_se_llega_por_la_url_directa(page, base_url, lote_publicado):
    """El link es el objeto que circula entre el corredor y el cliente."""
    page.goto(f"{base_url}/lote/{lote_publicado['id']}")
    expect(page.locator("#panel-lote-publico")).to_be_visible()
    expect(page.locator("#lp-titulo")).to_contain_text(lote_publicado["manzana"])
    expect(page.locator("#lp-precio")).to_have_text("USD 22.000")
    expect(page.locator("#lp-ubicacion")).to_contain_text("Potrero de los Funes")


def test_un_visitante_sin_sesion_la_ve_completa(page, base_url, lote_publicado):
    """Si pidiera iniciar sesión, el link no serviría para nada."""
    page.goto(f"{base_url}/lote/{lote_publicado['id']}")
    expect(page.locator("#lp-contenido")).to_be_visible()
    expect(page.locator("#lp-descripcion")).to_contain_text("vista al dique")
    expect(page.locator("#lp-datos")).to_contain_text("900 m²")
    # El formulario de consulta es el motivo de la página: tiene que estar.
    expect(page.locator("#lp-form")).to_be_visible()
    expect(page.locator("#lp-whatsapp")).to_be_visible()


def test_no_le_ofrece_subir_fotos_a_un_visitante(page, base_url, lote_publicado):
    """Mostrarle el botón sería prometerle algo que las reglas rechazan."""
    page.goto(f"{base_url}/lote/{lote_publicado['id']}")
    expect(page.locator("#lp-contenido")).to_be_visible()
    expect(page.locator("#lp-subir")).to_be_hidden()


def test_los_servicios_que_no_tiene_tambien_se_muestran(page, base_url, lote_publicado):
    """Saber que NO hay gas es un dato para quien compra, no un vacío."""
    page.goto(f"{base_url}/lote/{lote_publicado['id']}")
    expect(page.locator("#lp-servicios")).to_contain_text("Luz")
    expect(page.locator("#lp-servicios")).to_contain_text("Gas")
    expect(page.locator("#lp-servicios .lp-servicio.sin")).to_have_count(2)


def test_un_lote_sin_fotos_lo_dice(page, base_url, lote_publicado):
    """Mejor decirlo que mostrar un recuadro gris sin explicación."""
    page.goto(f"{base_url}/lote/{lote_publicado['id']}")
    expect(page.locator("#lp-sin-fotos")).to_be_visible()
    expect(page.locator("#lp-foto-principal")).to_be_hidden()


def test_un_lote_que_no_existe_lo_dice(page, base_url, lote_publicado):
    """Un link viejo de una propiedad ya vendida tiene que explicarse,
    no mostrar una página vacía con el precio en blanco."""
    page.goto(f"{base_url}/lote/no-existe-este-id")
    expect(page.locator("#lp-no-encontrado")).to_be_visible()
    expect(page.locator("#lp-contenido")).to_be_hidden()


def test_el_titulo_de_la_pestana_es_el_del_lote(page, base_url, lote_publicado):
    """Es lo que se ve al compartir el link y al guardarlo en favoritos."""
    page.goto(f"{base_url}/lote/{lote_publicado['id']}")
    expect(page.locator("#lp-contenido")).to_be_visible()
    expect(page).to_have_title(f"Manzana {lote_publicado['manzana']} — Lote 7 — MojonApp")
