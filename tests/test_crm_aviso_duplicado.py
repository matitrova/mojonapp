"""
Test de Playwright para el aviso de posible duplicado al dar de alta un
contacto (js/crm.js) — complementa "Fusionar con otro contacto…": mejor
avisar ANTES de cargar dos veces a la misma persona que limpiarlo
después a mano. Compara nombre (exacto, sin mayúsculas/minúsculas) y
teléfono (normalizado) contra lo ya cargado.
"""

import uuid

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD, _uid_de_prueba, borrar_contacto_de_prueba, crear_contacto_de_prueba, soltar_el_mouse


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
    soltar_el_mouse(page)
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
        "etiquetas": [],
        "asignado_a": _uid_de_prueba(),
        "fecha_creacion": "2026-09-01T00:00:00.000Z",
        "fecha_actualizacion": "2026-09-01T00:00:00.000Z",
    }
    base.update(extra)
    return base


def test_avisa_por_telefono_repetido_y_abre_el_existente(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    existente_id = crear_contacto_de_prueba(_datos_base(f"DUPE-TEL-{marcador}", telefono="1122334455"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator("#btn-agregar-contacto").click()

        page.locator("#contacto-nombre").fill("Otro nombre cualquiera")
        page.locator("#contacto-telefono").fill("1122334455")

        aviso = page.locator("#crm-aviso-duplicado")
        expect(aviso).to_be_visible()
        expect(aviso).to_contain_text(f"DUPE-TEL-{marcador}")

        page.locator("#btn-abrir-duplicado").click()
        expect(page.locator("#crm-form-titulo")).to_have_text(f"DUPE-TEL-{marcador}")
        expect(page.locator("#contacto-id-editando")).to_have_value(existente_id)
    finally:
        borrar_contacto_de_prueba(existente_id)


def test_avisa_por_nombre_exacto_repetido(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    nombre = f"DUPE-NOMBRE-{marcador}"
    existente_id = crear_contacto_de_prueba(_datos_base(nombre))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator("#btn-agregar-contacto").click()

        # Mismo nombre, distintas mayúsculas — igual tiene que avisar.
        page.locator("#contacto-nombre").fill(nombre.lower())

        expect(page.locator("#crm-aviso-duplicado")).to_be_visible()
    finally:
        borrar_contacto_de_prueba(existente_id)


def test_no_avisa_con_nombre_no_relacionado(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    otro_id = crear_contacto_de_prueba(_datos_base(f"DUPE-AJENO-{marcador}", telefono="1199998888"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator("#btn-agregar-contacto").click()

        page.locator("#contacto-nombre").fill(f"Persona sin relación {marcador}")
        page.locator("#contacto-telefono").fill("1100001111")

        expect(page.locator("#crm-aviso-duplicado")).to_be_hidden()
    finally:
        borrar_contacto_de_prueba(otro_id)
