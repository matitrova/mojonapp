"""La URL no le abre la ficha encima a alguien que está editando.

EL BUG. Desde que el lote abierto vive en la URL, abrir una ficha a mano
deja "?lote=<id>" en la dirección. Y abrirLoteDesdeUrlSiCorresponde()
corre DOS veces al arrancar: al dibujarse el mapa, y otra vez cuando
terminan de cargar los lotes con la sesión ya resuelta. La primera pasa
de largo (todavía no hay "?lote="), así que la segunda se encontraba con
una URL que el propio corredor acababa de generar — y le reabría la
ficha ENCIMA del editor de forma, tapándole los botones.

Se veía como un editor que no responde a los clicks. Lo delató un test
del editor de forma que fallaba una de cada dos corridas, con el click
interceptado por la ficha.

CÓMO SE PRUEBA. No se espera a que la carga asíncrona pise el momento
justo —eso es lo que lo hacía intermitente— sino que se llama a la
función a mano con el editor abierto, que es exactamente lo que hacía la
carga. Así el test es determinista y falla siempre si el guard se cae.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

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

# Lo que hacía la carga de lotes al terminar, sin esperar a que la
# casualidad lo dispare en el momento justo.
REABRIR_DESDE_LA_URL = """() => import('/js/ficha.js').then((f) => {
     f.abrirLoteDesdeUrlSiCorresponde();
   })"""


def _abrir_ficha_desde_lista(page, doc_id):
    """Igual que en test_cercanias/test_cartel_qr: por la lista, que es
    el camino donde el lote termina en la URL."""
    abrir_menu(page)
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


@pytest.fixture
def lote():
    doc_id = crear_lote_de_prueba(
        {
            "manzana": f"URLED-{uuid.uuid4().hex[:8]}",
            "lote": "1",
            "superficie_m2": 460,
            "estado": "disponible",
            "geometry": GEOMETRIA,
        }
    )
    try:
        yield doc_id
    finally:
        borrar_lote_de_prueba(doc_id)


def test_con_el_editor_de_forma_abierto_la_ficha_no_vuelve(page, base_url, lote):
    """EL TEST DEL BUG."""
    page.goto(base_url)
    _abrir_ficha_desde_lista(page, lote)
    expect(page.locator("#ficha-lote")).to_be_visible()
    # Abrir la ficha deja el lote en la URL: es la precondición del bug.
    assert "lote=" in page.url

    page.locator("#btn-editar-forma-lote").click()
    expect(page.locator("#ficha-lote")).to_be_hidden()

    # SE FUERZA LA PRECONDICIÓN, no se espera que salga bien.
    #
    # abrirLoteDesdeUrlSiCorresponde tiene DOS guards, en este orden:
    # primero el de modoCaptura (el que este test prueba) y después el de
    # deepLinkAbierto. Si el segundo ya está marcado, la reapertura la
    # frena ÉL y el test pasa aunque el primero no exista.
    #
    # Y se marca solo, por una carrera: abrir la ficha desde la lista
    # pone el lote en la URL, y la carga de lotes reencadena
    # abrirLoteDesdeUrlSiCorresponde. Si esa segunda carga llega antes de
    # este punto, el flag queda en true. Corriendo el test solo casi
    # nunca pasa; con el archivo entero, casi siempre (2026-09-24).
    #
    # Ponerlo en false a mano NO afloja el test: lo endurece. Le saca la
    # ayuda del otro guard y deja al de modoCaptura como lo único que
    # puede frenar la reapertura.
    page.evaluate("""() => import('/js/estado.js').then((e) => e.setDeepLinkAbierto(false))""")

    # Y recién ahora se comprueban las precondiciones. Sin esto el test
    # daba un falso verde: si por timing todavía no había modo de
    # captura, la reapertura no ocurría por otro motivo y el test pasaba
    # aunque el guard no existiera. Verificado quitando el guard: con
    # estas dos aserciones falla, sin ellas pasaba a veces.
    antes = page.evaluate(
        """() => import('/js/estado.js').then((e) => ({
             modoCaptura: e.getModoCaptura(),
             deepLinkAbierto: e.getDeepLinkAbierto(),
           }))"""
    )
    assert antes["modoCaptura"] == "editando-poligono", (
        f"el editor no dejó marcado el modo de captura: {antes}. Sin eso "
        f"este test no está probando el guard."
    )
    assert antes["deepLinkAbierto"] is False, (
        f"el deep-link ya estaba marcado: {antes}. Entonces la reapertura "
        f"la frena OTRO guard y este test no prueba el nuevo."
    )

    page.evaluate(REABRIR_DESDE_LA_URL)
    page.wait_for_timeout(600)

    expect(page.locator("#ficha-lote")).to_be_hidden()
    # Y los botones del editor se pueden tocar, que es lo que el usuario
    # notaba: no alcanza con que la ficha esté escondida en el DOM.
    page.locator("#btn-modo-lado-lista").click()
    expect(page.locator("#lista-lados")).to_be_visible()


def test_sin_nada_en_curso_la_url_si_abre_la_ficha(page, base_url, lote):
    """El guard no puede romper lo que la URL sí tiene que hacer: entrar
    por un link a un lote abre su ficha."""
    page.goto(f"{base_url}/?lote={lote}")
    expect(page.locator("#ficha-lote")).to_be_visible()
