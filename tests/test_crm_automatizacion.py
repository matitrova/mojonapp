"""
Test de Playwright para el banner de "Automatización configurable" en el
CRM (idea propia — Tokko recién ofrece "Automatizaciones configurables"
desde el plan Equipo, $252.320/mes): un solo clic marca en bloque como
"perdidos" a todos los contactos estancados (+7 días sin novedades) que
el usuario puede ver, en vez de tener que abrir cada uno a mano.

Nota sobre aislamiento: el banner cuenta TODOS los estancados visibles
para el usuario logueado, no solo los que siembra cada test — al momento
de escribir esto, el único contacto real de producción ("Juan Perez") se
actualizó hace pocos días y todavía no cuenta como estancado, así que
"sin estancados propios -> banner oculto" es válido hoy. Si en el futuro
ese contacto (u otro real) queda sin tocar 7+ días, el banner podría
aparecer igual sin que sea un bug — es la misma limitación ya documentada
para el tasador (tests/test_ficha_tasacion.py) de probar contra el
inventario real en vez de uno aislado.
"""

import datetime
import uuid

import pytest
from playwright.sync_api import expect

from conftest import _uid_de_prueba, borrar_contacto_de_prueba, crear_contacto_de_prueba, soltar_el_mouse

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_crm(page):
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()


def _datos_base(nombre, **extra):
    hace_10_dias = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=10)).isoformat()
    base = {
        "nombre": nombre,
        "telefono": None,
        "email": None,
        "estado": "contactado",
        "motivo_perdido": None,
        "proximo_seguimiento": None,
        "lotes_interes": [],
        "actividades": [],
        "asignado_a": _uid_de_prueba(),
        "fecha_creacion": hace_10_dias,
        "fecha_actualizacion": hace_10_dias,
    }
    base.update(extra)
    return base


def test_banner_muestra_estancados_y_los_marca_como_perdidos(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_contacto_de_prueba(_datos_base(f"AUTO-ESTANCADO-{marcador}"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        banner = page.locator("#crm-automatizacion")
        expect(banner).to_be_visible()
        expect(page.locator("#crm-automatizacion-texto")).to_contain_text("sin novedades")

        # marcarEstancadosComoPerdidos() (js/crm.js) pide confirmación con
        # window.confirm() — Playwright intercepta el diálogo nativo, no
        # hay otra forma de responderlo desde un test.
        page.on("dialog", lambda dialog: dialog.accept())
        page.locator("#btn-cerrar-estancados").click()

        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(page.locator('[data-testid="crm-columna-perdido"]').locator(f'[data-testid="crm-tarjeta-{doc_id}"]')).to_have_count(1)

        tarjeta.click()
        expect(page.locator("#contacto-motivo-perdido")).to_have_value("Sin actividad reciente (cierre en bloque)")
    finally:
        borrar_contacto_de_prueba(doc_id)


def test_banner_oculto_sin_contactos_estancados(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    ahora = datetime.datetime.now(datetime.timezone.utc).isoformat()
    doc_id = crear_contacto_de_prueba(_datos_base(f"AUTO-FRESCO-{marcador}", fecha_actualizacion=ahora))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        expect(page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')).to_be_visible()
        expect(page.locator("#crm-automatizacion")).to_be_hidden()
    finally:
        borrar_contacto_de_prueba(doc_id)
