"""
Test de Playwright para "Fusionar con otro contacto" (js/crm.js) —
deduplicación manual: cubre el hueco que el dedupe automático (por
teléfono EXACTO al crear desde "Agregar interesado") no cubre, como dos
altas manuales de la misma persona con el teléfono escrito distinto.
"""

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


def _datos(nombre, **extra):
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


def test_fusionar_combina_lotes_de_interes_y_borra_el_duplicado(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    principal_id = crear_contacto_de_prueba(
        _datos(f"FUS-PRINCIPAL-{marcador}", telefono="1122334455", lotes_interes=[{"id": "loteA", "titulo": "Lote A"}])
    )
    duplicado_id = crear_contacto_de_prueba(
        _datos(f"FUS-DUPLICADO-{marcador}", email="dup@test.com", lotes_interes=[{"id": "loteB", "titulo": "Lote B"}])
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator(f'[data-testid="crm-tarjeta-{principal_id}"]').click()
        page.locator("#btn-fusionar-contacto").click()
        page.locator("#crm-fusionar-select").select_option(duplicado_id)

        page.on("dialog", lambda dialog: dialog.accept())
        page.locator("#btn-fusionar-confirmar").click()

        # Vuelve a mostrar el formulario del contacto que sobrevive, ya
        # actualizado — con los datos combinados de los dos.
        expect(page.locator("#contacto-nombre")).to_have_value(f"FUS-PRINCIPAL-{marcador}")
        expect(page.locator("#contacto-email")).to_have_value("dup@test.com")
        expect(page.locator("#crm-lista-lotes-interes")).to_contain_text("Lote A")
        expect(page.locator("#crm-lista-lotes-interes")).to_contain_text("Lote B")

        # El duplicado ya no está en el pipeline.
        page.locator("#crm-volver").click()
        expect(page.locator(f'[data-testid="crm-tarjeta-{duplicado_id}"]')).to_have_count(0)
        expect(page.locator(f'[data-testid="crm-tarjeta-{principal_id}"]')).to_have_count(1)
    finally:
        borrar_contacto_de_prueba(principal_id)
        borrar_contacto_de_prueba(duplicado_id)


def test_cancelar_fusion_no_cambia_nada(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    principal_id = crear_contacto_de_prueba(_datos(f"FUS-CANCELA-{marcador}"))
    otro_id = crear_contacto_de_prueba(_datos(f"FUS-OTRO-{marcador}"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator(f'[data-testid="crm-tarjeta-{principal_id}"]').click()
        page.locator("#btn-fusionar-contacto").click()
        expect(page.locator("#crm-fusionar-panel")).to_be_visible()
        page.locator("#btn-fusionar-cancelar").click()
        expect(page.locator("#crm-fusionar-panel")).to_be_hidden()

        page.locator("#crm-volver").click()
        expect(page.locator(f'[data-testid="crm-tarjeta-{otro_id}"]')).to_have_count(1)
    finally:
        borrar_contacto_de_prueba(principal_id)
        borrar_contacto_de_prueba(otro_id)
