"""
Test de Playwright para "Seguimientos pendientes (CRM)" en el Dashboard
(idea #11, js/dashboard.js): un contacto con "Próximo seguimiento" vencido
o próximo tiene que aparecer ahí (mismo criterio que la sección
"Seguimientos" del propio CRM, contactosParaSeguimiento en crm.js), y
tocarlo tiene que abrir el CRM directo en el formulario de ESE contacto.
"""

import uuid
from datetime import date, timedelta

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD, borrar_contacto_de_prueba, buscar_contacto_doc_id_por_nombre


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()


def _abrir_dashboard(page):
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-dashboard").click()
    expect(page.locator("#panel-dashboard")).to_be_visible()


def test_seguimiento_vencido_aparece_en_el_dashboard_y_abre_el_crm(page, base_url):
    nombre = f"DASH-TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        # El login ya deja el dashboard abierto (arranque automático) —
        # se crea el contacto desde el CRM primero, y recién después se
        # vuelve a abrir el dashboard para que pida los contactos de
        # nuevo (ver abrirPanelDashboard en dashboard.js).
        _loguearse(page, base_url)
        page.locator("#cerrar-panel-dashboard").click()

        page.locator("#btn-menu").click()
        page.locator("#btn-abrir-crm").click()
        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        ayer = (date.today() - timedelta(days=1)).isoformat()
        page.locator("#contacto-seguimiento").fill(ayer)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator("#crm-vista-kanban")).to_be_visible()

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        page.locator("#cerrar-panel-crm").click()
        _abrir_dashboard(page)

        seccion = page.locator("#dashboard-seguimientos-seccion")
        expect(seccion).to_be_visible()
        fila = page.locator("#dashboard-seguimientos li", has_text=nombre)
        expect(fila).to_be_visible(timeout=10000)
        expect(fila).to_contain_text("vencido")

        fila.click()
        expect(page.locator("#panel-crm")).to_be_visible()
        expect(page.locator("#contacto-nombre")).to_have_value(nombre)
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)
