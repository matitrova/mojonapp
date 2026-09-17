"""
Test de Playwright para "Redactar con IA" (js/ia-descripcion.js) — el
botón de la ficha que le pide a un modelo de lenguaje el texto del aviso
para portales, en vez de armarlo por plantilla como
"Copiar descripción para portales" (ese sigue existiendo, ver
test_ficha_portales.py).

El endpoint que hace la llamada paga vive en
functions/ia-descripcion.js, una Cloudflare Pages Function — y la suite
corre contra `python -m http.server` (ver tests/conftest.py), que sirve
archivos estáticos y NO ejecuta Pages Functions. Así que acá se mockea
la respuesta con page.route(): lo que se prueba es la UI (que el botón
esté, que el texto aparezca, que un error se vea y el botón vuelva a
quedar usable), no la llamada al proveedor.

Que sea mockeado además es lo que mantiene a CI (.github/workflows/
tests.yml) sin API key y sin gastar tokens en cada push. La llamada real
solo se puede verificar sobre el sitio ya desplegado.
"""

import json

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

LOTE = {
    "manzana": "IA",
    "lote": "1",
    "nomenclatura": None,
    "superficie_m2": 800,
    "estado": "disponible",
    "precio_usd": 18000,
    "sector": "Zona IA",
    "servicios": {"luz": True, "agua": True, "gas": False, "cloaca": False},
    "descripcion": "Lote de prueba para redacción con IA",
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            {"lon": -65.084000, "lat": -32.414000},
            {"lon": -65.083780, "lat": -32.414000},
            {"lon": -65.083780, "lat": -32.414200},
            {"lon": -65.084000, "lat": -32.414200},
            {"lon": -65.084000, "lat": -32.414000},
        ],
    },
}

AVISO_REDACTADO = (
    "Lote de 800 m² en Zona IA, con luz y agua en el terreno. "
    "Una buena opción para proyectar la casa con tranquilidad."
)


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_ficha_desde_lista(page, doc_id):
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def _mockear_endpoint(page, *, status, cuerpo):
    """Reemplaza /ia-descripcion por una respuesta fija. Sin esto el
    fetch se va contra el servidor estático de test, que devuelve un 501
    sin JSON."""
    page.route(
        "**/ia-descripcion",
        lambda ruta: ruta.fulfill(
            status=status,
            content_type="application/json",
            body=json.dumps(cuerpo),
        ),
    )


def test_redactar_con_ia_muestra_el_texto_devuelto(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE)
    try:
        _mockear_endpoint(page, status=200, cuerpo={"texto": AVISO_REDACTADO})
        _loguearse(page, base_url)
        _abrir_ficha_desde_lista(page, doc_id)

        expect(page.locator("#btn-redactar-ia")).to_be_visible()
        # Todavía no se apretó nada: el cuadro con el resultado no tiene
        # por qué estar ocupando lugar en la ficha.
        expect(page.locator("#ia-descripcion-resultado")).to_be_hidden()

        page.locator("#btn-redactar-ia").click()

        expect(page.locator("#ia-descripcion-resultado")).to_be_visible()
        expect(page.locator("#ia-descripcion-texto")).to_have_value(AVISO_REDACTADO)
        # Editable a propósito (el corredor retoca antes de publicar), no
        # un cuadro de solo lectura.
        expect(page.locator("#ia-descripcion-texto")).to_be_editable()
    finally:
        borrar_lote_de_prueba(doc_id)


def test_error_del_endpoint_se_avisa_y_el_boton_vuelve_a_quedar_usable(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE)
    try:
        _mockear_endpoint(
            page,
            status=502,
            cuerpo={"error": "El servicio de IA no pudo responder ahora. Probá de nuevo en un rato."},
        )
        _loguearse(page, base_url)
        _abrir_ficha_desde_lista(page, doc_id)

        page.locator("#btn-redactar-ia").click()

        expect(page.locator("#ia-mensaje")).to_be_visible()
        expect(page.locator("#ia-mensaje")).to_contain_text("no pudo responder")
        # Sin resultado no se abre el cuadro: mostrarlo vacío haría
        # pensar que la IA devolvió un aviso en blanco.
        expect(page.locator("#ia-descripcion-resultado")).to_be_hidden()
        # Un error no puede dejar el botón trabado en "Redactando…" para
        # siempre — tiene que poder reintentarse.
        expect(page.locator("#btn-redactar-ia")).to_be_enabled()
        expect(page.locator("#btn-redactar-ia")).to_contain_text("Redactar con IA")
    finally:
        borrar_lote_de_prueba(doc_id)
