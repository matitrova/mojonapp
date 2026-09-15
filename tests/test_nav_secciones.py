"""
Test de Playwright para la barra de secciones persistente
(Mapa | Lista | Dashboard | CRM, ver index.html/js/app.js) — pedido
explícito del usuario: "que haya una sección dashboard principal, otra
mapa... todo bien separado", en vez de tener que cerrar cada panel con
la X para volver. Los botones "×" de cada panel siguen funcionando
igual que antes (ver comentario en app.js) — esto solo cubre el camino
NUEVO, agregado por la barra.
"""

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def test_sin_sesion_no_aparece_la_barra(page, base_url):
    page.goto(base_url)
    expect(page.locator("#nav-secciones")).to_be_hidden()


def test_los_4_tabs_llevan_a_la_pantalla_correcta(page, base_url):
    _loguearse(page, base_url)
    expect(page.locator("#nav-secciones")).to_be_visible()
    expect(page.locator("#nav-tab-mapa")).to_have_class("nav-tab activo")

    page.locator("#nav-tab-lista").click()
    expect(page.locator("#vista-lista")).to_be_visible()
    expect(page.locator("#nav-tab-lista")).to_have_class("nav-tab activo")

    page.locator("#nav-tab-dashboard").click()
    expect(page.locator("#panel-dashboard")).to_be_visible()
    expect(page.locator("#vista-lista")).to_be_hidden()
    expect(page.locator("#nav-tab-dashboard")).to_have_class("nav-tab activo")

    page.locator("#nav-tab-crm").click()
    expect(page.locator("#panel-crm")).to_be_visible()
    expect(page.locator("#panel-dashboard")).to_be_hidden()
    expect(page.locator("#nav-tab-crm")).to_have_class("nav-tab activo")

    page.locator("#nav-tab-mapa").click()
    expect(page.locator("#panel-crm")).to_be_hidden()
    expect(page.locator("#nav-tab-mapa")).to_have_class("nav-tab activo")

    # Volver a entrar a Lista con el tab, ya abierto, no lo cierra (es
    # un toggle existente — solo se reenvía el click si estaba cerrado).
    page.locator("#nav-tab-lista").click()
    expect(page.locator("#vista-lista")).to_be_visible()
    page.locator("#nav-tab-lista").click()
    expect(page.locator("#vista-lista")).to_be_visible()

    # Cerrar con la "×" de siempre deja el mismo estado que tocar "Mapa".
    page.locator("#cerrar-vista-lista").click()
    expect(page.locator("#nav-tab-mapa")).to_have_class("nav-tab activo")
