"""
Test de Playwright para "Nota fijada" (js/crm-formulario.js, js/crm.js)
— tercera de 3 ideas inspiradas en el gap de Tokko Broker: un
recordatorio corto SIEMPRE visible por contacto (📌 en la tarjeta del
kanban), distinto del historial de "Actividad" que ya existe.
"""

import uuid

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD, borrar_contacto_de_prueba, buscar_contacto_doc_id_por_nombre


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


def test_nota_fijada_se_guarda_se_ve_en_la_tarjeta_y_se_recarga_al_editar(page, base_url):
    nombre = f"NOTA-{uuid.uuid4().hex[:8]}"
    nota = "Pide que lo llamen después de las 18hs"
    doc_id = None
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-nota-fijada").fill(nota)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator("#crm-vista-kanban")).to_be_visible()

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta.locator(".crm-tarjeta-nota-fijada")).to_contain_text(nota)

        tarjeta.click()
        expect(page.locator("#contacto-nota-fijada")).to_have_value(nota)
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)


def test_sin_nota_no_aparece_nada_en_la_tarjeta(page, base_url):
    nombre = f"SINNOTA-{uuid.uuid4().hex[:8]}"
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
        expect(tarjeta.locator(".crm-tarjeta-nota-fijada")).to_have_count(0)
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)
