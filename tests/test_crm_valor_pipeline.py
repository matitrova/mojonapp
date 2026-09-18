"""
Test de Playwright para "Valor en pipeline" (js/crm.js) — idea propia,
mismo lenguaje que Pipedrive/HubSpot: el pipeline se mide en plata, no
solo en cantidad de tarjetas. Suma el precio del lote de interés de cada
contacto activo (ni cerrado ni perdido) para la tarjeta de stat general,
y por columna para cada etapa del kanban.
"""

import re
import uuid

import pytest
from playwright.sync_api import expect

from conftest import _uid_de_prueba, abrir_menu, borrar_contacto_de_prueba, borrar_lote_de_prueba, crear_contacto_de_prueba, crear_lote_de_prueba, soltar_el_mouse

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion

GEOMETRY_BASE = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.085000, "lat": -32.415000},
        {"lon": -65.084780, "lat": -32.415000},
        {"lon": -65.084780, "lat": -32.415200},
        {"lon": -65.085000, "lat": -32.415200},
        {"lon": -65.085000, "lat": -32.415000},
    ],
}


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_crm(page):
    abrir_menu(page)
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()


def _valor_a_numero(texto):
    # "USD 40.000" -> 40000, "—" (sin valor todavía) -> 0. El punto es
    # separador de miles en es-AR, no decimal.
    digitos = re.sub(r"[^\d]", "", texto)
    return int(digitos) if digitos else 0


def test_valor_pipeline_suma_precio_de_lotes_de_interes_activos(page, base_url):
    # No se fija un total exacto de entrada: el stat es una suma GLOBAL de
    # todo lo que exista en el pipeline en ese momento, así que se mide el
    # antes y el después (delta) en vez de asumir que arranca en $0 — mismo
    # criterio ya aplicado en test_ficha_tasacion.py para el fallback "toda
    # la cartera".
    _loguearse(page, base_url)
    _abrir_crm(page)
    valor_antes = _valor_a_numero(page.locator("#crm-stats .crm-stat-valor strong").inner_text())
    columna_contactado = page.locator('[data-testid="crm-columna-valor-contactado"]')
    valor_columna_antes = _valor_a_numero(columna_contactado.inner_text()) if columna_contactado.count() else 0

    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(
        {
            "manzana": f"PIPE-{marcador}",
            "lote": "1",
            "nomenclatura": None,
            "superficie_m2": 500,
            "estado": "disponible",
            "precio_usd": 40000,
            "sector": None,
            "geometry": GEOMETRY_BASE,
        }
    )
    contacto_activo_id = crear_contacto_de_prueba(
        {
            "nombre": f"PIPE-ACTIVO-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "contactado",
            "motivo_perdido": None,
            "proximo_seguimiento": None,
            "lotes_interes": [{"id": lote_id, "titulo": f"Manzana PIPE-{marcador} — Lote 1"}],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
            "fecha_creacion": "2026-09-01T00:00:00.000Z",
            "fecha_actualizacion": "2026-09-01T00:00:00.000Z",
        }
    )
    # Mismo lote de interés, pero "perdido" — no debería sumar al valor
    # de pipeline activo (ya no está en juego).
    contacto_perdido_id = crear_contacto_de_prueba(
        {
            "nombre": f"PIPE-PERDIDO-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "perdido",
            "motivo_perdido": "No le interesó más",
            "proximo_seguimiento": None,
            "lotes_interes": [{"id": lote_id, "titulo": f"Manzana PIPE-{marcador} — Lote 1"}],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
            "fecha_creacion": "2026-09-01T00:00:00.000Z",
            "fecha_actualizacion": "2026-09-01T00:00:00.000Z",
        }
    )
    try:
        page.reload()
        expect(page.locator("#sesion-activa")).to_be_visible()
        # Recargar estando en el CRM devuelve AL CRM, no al Dashboard:
        # cada sección tiene su URL y la recarga la respeta (ver
        # entrarEnLaRutaDeLaUrl en js/router.js). Antes esto abría el
        # Dashboard encima y había que cerrarlo para volver acá.
        expect(page).to_have_url(f"{base_url}/contactos")
        expect(page.locator("#panel-crm")).to_be_visible()

        expect(page.locator("#crm-stats .crm-stat-valor strong")).to_be_visible()
        valor_despues = _valor_a_numero(page.locator("#crm-stats .crm-stat-valor strong").inner_text())
        assert valor_despues - valor_antes == 40000

        columna_contactado = page.locator('[data-testid="crm-columna-valor-contactado"]')
        expect(columna_contactado).to_be_visible()
        valor_columna_despues = _valor_a_numero(columna_contactado.inner_text())
        assert valor_columna_despues - valor_columna_antes == 40000
    finally:
        borrar_lote_de_prueba(lote_id)
        borrar_contacto_de_prueba(contacto_activo_id)
        borrar_contacto_de_prueba(contacto_perdido_id)
