"""
Test de Playwright para "Calificación de contactos" en el CRM (idea
propia, módulo #2 del listado para competir con Tokko — investigado en
comparativas de CRM inmobiliario antes de armarla, donde "calificación
automática de contactos" aparece señalada como algo que ni Tokko
ofrece hoy): un puntaje de 5 señales simples (teléfono, actividad,
actividad reciente, 2+ lotes de interés, sin alertas de atención) da
🔥 Caliente / 🌤️ Tibio / ❄️ Frío. No se muestra para cerrado/perdido —
la calificación es para decidir a quién llamar, no para juzgar el
pasado.
"""

import datetime
import uuid

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD, _uid_de_prueba, borrar_contacto_de_prueba, crear_contacto_de_prueba


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


def _datos_base(nombre, **extra):
    base = {
        "nombre": nombre,
        "telefono": None,
        "email": None,
        "estado": "nuevo",
        "motivo_perdido": None,
        "proximo_seguimiento": None,
        "lotes_interes": [],
        "actividades": [],
        "asignado_a": _uid_de_prueba(),
        "fecha_creacion": "2026-09-01T00:00:00.000Z",
        "fecha_actualizacion": "2026-09-01T00:00:00.000Z",
    }
    base.update(extra)
    return base


def test_contacto_sin_ninguna_senal_es_frio(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_contacto_de_prueba(_datos_base(f"CAL-FRIO-{marcador}"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta.locator(".crm-calificacion-frio")).to_contain_text("Frío")
    finally:
        borrar_contacto_de_prueba(doc_id)


def test_contacto_con_todas_las_senales_es_caliente(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    ahora = datetime.datetime.now(datetime.timezone.utc).isoformat()
    doc_id = crear_contacto_de_prueba(
        _datos_base(
            f"CAL-CALIENTE-{marcador}",
            telefono="1123131231",
            actividades=[{"tipo": "llamada", "texto": "Muy interesado.", "fecha": ahora, "autor_email": TEST_USER_EMAIL}],
            lotes_interes=[{"id": "x", "titulo": "Lote X"}, {"id": "y", "titulo": "Lote Y"}],
            fecha_creacion=ahora,
            fecha_actualizacion=ahora,
        )
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta.locator(".crm-calificacion-caliente")).to_contain_text("Caliente")
    finally:
        borrar_contacto_de_prueba(doc_id)


def test_contacto_cerrado_no_muestra_calificacion(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_contacto_de_prueba(_datos_base(f"CAL-CERRADO-{marcador}", estado="cerrado"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta).to_be_visible()
        expect(tarjeta.locator(".crm-calificacion")).to_have_count(0)
    finally:
        borrar_contacto_de_prueba(doc_id)
