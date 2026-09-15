"""
Test de Playwright para "Valor en pipeline" (js/crm.js) — idea propia,
mismo lenguaje que Pipedrive/HubSpot: el pipeline se mide en plata, no
solo en cantidad de tarjetas. Suma el precio del lote de interés de cada
contacto activo (ni cerrado ni perdido) para la tarjeta de stat general,
y por columna para cada etapa del kanban.
"""

import re
import uuid

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD, _uid_de_prueba, borrar_contacto_de_prueba, borrar_lote_de_prueba, crear_contacto_de_prueba, crear_lote_de_prueba

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
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_crm(page):
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
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
        # Un reload con la sesión ya persistida (Firebase Auth) vuelve a
        # abrir el Dashboard solo, igual que el login manual (ver
        # onAuthStateChanged en app.js) — hay que cerrarlo antes de
        # poder llegar al CRM por el drawer.
        page.locator("#cerrar-panel-dashboard").click()
        _abrir_crm(page)

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
