"""
Test de Playwright para el grupo colapsable "Ver métricas y estadísticas"
del Dashboard — feedback directo del usuario ("siento que en el
dashboard hay muchas cosas en pantalla y marea"): las secciones de
análisis (Más consultados, Con más interesados anotados, Resumen por
zona) se agrupan detrás de un <details> nativo, cerrado por defecto, para
que lo primero que se ve al abrir el Dashboard sea más corto. No siembra
datos — solo verifica el comportamiento de abrir/cerrar, que no depende
de que haya lotes o contactos cargados.
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


def test_metricas_arrancan_colapsadas_y_se_expanden_al_clickear(page, base_url):
    _loguearse(page, base_url)
    expect(page.locator("#panel-dashboard")).to_be_visible()

    detalle = page.locator("#dashboard-metricas-detalle")
    resumen_zona = page.locator('[data-testid="dashboard-precios-zona"]')

    # Colapsado por defecto: el contenido existe en el DOM (dashboard.js
    # lo rellena igual) pero no está visible hasta abrir el <details>.
    expect(detalle).not_to_have_js_property("open", True)
    expect(resumen_zona).to_be_hidden()

    page.locator("#dashboard-metricas-detalle summary").click()
    expect(detalle).to_have_js_property("open", True)
    expect(resumen_zona).to_be_visible()
    expect(page.locator("#dashboard-consultados")).to_be_visible()
