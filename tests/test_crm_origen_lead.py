"""
Test de Playwright para "Origen del lead" (js/crm-datos.js, js/crm-formulario.js,
js/crm.js) — idea propia inspirada en el gap de "centralización de leads"
de Tokko Broker (ver benchmarking): sin canales pagos, alcanza con saber
si un contacto salió de "Agregar interesado" en la ficha de un lote
puntual ("ficha") o de un alta manual en el CRM ("manual"). Se fija solo
al crear, se ve como un ícono chico en la tarjeta y es filtrable en la
barra de herramientas.
"""

import uuid

from playwright.sync_api import expect

from conftest import (
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
    borrar_contacto_de_prueba,
    buscar_contacto_doc_id_por_nombre,
)


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


def test_alta_manual_queda_marcada_como_origen_manual(page, base_url):
    nombre = f"ORIGEN-MANUAL-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator("#crm-vista-kanban")).to_be_visible()

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta.locator(".crm-tarjeta-origen")).to_have_text("✍️")

        page.locator("#crm-filtro-origen").select_option("ficha")
        expect(tarjeta).to_be_hidden()
        page.locator("#crm-filtro-origen").select_option("manual")
        expect(tarjeta).to_be_visible()
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)


def test_agregar_interesado_queda_marcado_como_origen_ficha(page, base_url, lote_sembrado):
    nombre = f"ORIGEN-FICHA-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _loguearse(page, base_url)
        page.locator("#btn-menu").click()
        page.locator("#btn-ver-lista").click()
        page.locator("#filtro-cantidad").select_option("0")
        page.locator(f'tr[data-lote-id="{lote_sembrado["doc_id"]}"]').click()

        page.locator("#interesado-nombre").fill(nombre)
        page.locator("[data-testid='interesado-guardar']").click()
        expect(page.locator("#lista-interesados")).to_contain_text(nombre)

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        page.locator("#cerrar-ficha").click()
        _abrir_crm(page)
        page.locator("#btn-crm-vista-todas").click()
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta.locator(".crm-tarjeta-origen")).to_have_text("🌐")

        page.locator("#crm-filtro-origen").select_option("manual")
        expect(tarjeta).to_be_hidden()
        page.locator("#crm-filtro-origen").select_option("ficha")
        expect(tarjeta).to_be_visible()
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)
