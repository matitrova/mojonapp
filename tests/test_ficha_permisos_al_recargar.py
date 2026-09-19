"""La ficha abierta por URL no queda de solo lectura.

EL BUG QUE CUBRE. El perfil del corredor llega por una lectura
asíncrona a Firestore, así que puede resolverse DESPUÉS de que la ficha
ya se dibujó. Cuando eso pasaba, nadie la volvía a dibujar: quedaba sin
botón de editar, sin borrar, sin interesados y sin portales, aunque el
corredor tuviera todos los permisos. Había que cerrarla y abrirla de
nuevo para que apareciera todo.

POR QUÉ APARECIÓ AHORA. Mientras abrir una ficha era siempre un click,
el perfil ya había llegado para entonces y casi no se veía. Desde que el
lote abierto vive en la URL (2026-09-18), recargar la página o entrar
por un link compartido abre la ficha en la PRIMERA pasada, antes del
perfil — así que pasó a verse siempre.

Es el mismo bug que ya había tenido la vista de lista, en otro lugar:
ver gotcha_test_intermitente_era_bug_real en la memoria del proyecto.

CÓMO SE PRUEBA. Entrando directo a /?lote=<id> con sesión, que es
exactamente el camino donde se rompía. No sirve abrir la ficha con un
click: para entonces el perfil ya llegó y el test pasaría siempre.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

pytestmark = pytest.mark.con_sesion

GEOMETRIA = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.0800, "lat": -32.4100},
        {"lon": -65.0798, "lat": -32.4100},
        {"lon": -65.0798, "lat": -32.4102},
        {"lon": -65.0800, "lat": -32.4102},
        {"lon": -65.0800, "lat": -32.4100},
    ],
}


@pytest.fixture
def lote():
    doc_id = crear_lote_de_prueba(
        {
            "manzana": f"PERM-{uuid.uuid4().hex[:8]}",
            "lote": "1",
            "superficie_m2": 500,
            "estado": "disponible",
            "geometry": GEOMETRIA,
        }
    )
    try:
        yield doc_id
    finally:
        borrar_lote_de_prueba(doc_id)


def _entrar_directo(page, base_url, doc_id):
    page.goto(f"{base_url}/?lote={doc_id}")
    expect(page.locator("#sesion-activa")).to_be_visible()
    expect(page.locator("#ficha-lote")).to_be_visible()


def test_la_ficha_se_abre_sola_al_entrar_por_la_url(page, base_url, lote):
    """Es el motivo de que el lote viva en la URL: el link tiene que
    llevar al lote, no al mapa."""
    _entrar_directo(page, base_url, lote)
    expect(page.locator("#ficha-titulo")).to_contain_text("PERM-")


def test_los_botones_de_editar_aparecen_aunque_el_perfil_llegue_despues(page, base_url, lote):
    """La cuenta de los tests es root: tiene que poder editar y borrar.

    HONESTIDAD SOBRE QUÉ PRUEBA ESTE TEST: estos tres botones ya estaban
    cubiertos por otro camino (onAuthStateChanged en app.js los volvía a
    aplicar a mano), así que NO fueron los que delataron el bug —
    quitando el arreglo, este test seguía pasando. Se deja igual porque
    afirma algo que tiene que ser cierto para el usuario, pero el que
    prueba el bug es el de los portales, abajo.
    """
    _entrar_directo(page, base_url, lote)
    expect(page.locator("#btn-editar-lote-completo")).to_be_visible()
    expect(page.locator("#btn-borrar-lote")).to_be_visible()
    expect(page.locator("#btn-editar-forma-lote")).to_be_visible()


def test_los_portales_aparecen_aunque_el_perfil_llegue_despues(page, base_url, lote):
    """EL TEST DEL BUG, y el único que lo agarra.

    Los portales se sumaron a la ficha DESPUÉS de que app.js tuviera su
    copia a mano de los toggles de permisos, y nadie se acordó de
    agregarlos ahí. Por eso eran lo único que quedaba oculto al
    recargar. Validado quitando el arreglo: este test falla y los otros
    no.
    """
    _entrar_directo(page, base_url, lote)
    expect(page.locator("#ficha-portales")).to_be_visible()


def test_los_interesados_aparecen_aunque_el_perfil_llegue_despues(page, base_url, lote):
    _entrar_directo(page, base_url, lote)
    expect(page.locator("#ficha-interesados")).to_be_visible()


def test_entrar_por_la_url_no_infla_el_contador_de_visitas(page, base_url, lote):
    """Volver a aplicar los permisos NO puede redibujar la ficha entera:
    mostrarFicha registra una visita para "más consultados", así que
    hacerlo de nuevo cuando llega el perfil contaría dos por cada
    apertura y ensuciaría esa métrica del Dashboard."""
    _entrar_directo(page, base_url, lote)
    # Se espera a que el perfil haya llegado (los botones ya aparecieron
    # arriba, pero acá importa que el refresco ya corrió).
    expect(page.locator("#btn-editar-lote-completo")).to_be_visible()
    page.wait_for_timeout(1500)

    vistas = page.evaluate(
        """(id) => import('/js/estado.js').then((e) => {
             const f = e.getLotesActuales().find((x) => x.id === id);
             return f ? (f.properties.vistas ?? 0) : null;
           })""",
        lote,
    )
    assert vistas is None or vistas <= 1, (
        f"el lote quedó con {vistas} visitas después de UNA apertura: "
        f"el refresco de permisos está redibujando la ficha entera"
    )
