"""
Tests de la geometría del lote y del editor de forma.

No hay Node/emulador instalado en esta máquina (decisión deliberada del
proyecto), así que las funciones de geometría de js/app.js (rectángulo
mínimo, medir/mover un lado, simplificar vértices) no se pueden probar
como funciones puras aisladas — se prueban a través de la UI real con
Playwright, igual que el resto del suite, contra un lote sembrado de
forma y superficie conocidas (ver LOTE_PRUEBA_DATOS en conftest.py, un
rectángulo real de 460.63 m²).

Antes de este archivo, estas funciones (rectanguloMinimoConTransform,
longitudLadoEnMetros, el handler de "Aplicar" un lado, "Guardar forma")
solo se habían verificado a mano en vivo durante el desarrollo, sin
ningún test que las cubriera para el futuro.
"""

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD, FIRESTORE_URL_BASE
import requests

from test_lotes import abrir_ficha_desde_lista

# Frente/Largo esperados del rectángulo de LOTE_PRUEBA_DATOS (calculado
# con la misma fórmula que usa la app: proyección local equirectangular,
# 111320 m/grado de latitud, ajustada por cos(latitud) en longitud).
# Ancho ~20.69 m, alto ~22.26 m -> Frente (el lado corto) 20.7, Largo 22.3.
FRENTE_ESPERADO = "20.7 m"
LARGO_ESPERADO = "22.3 m"


def _loguearse(page):
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    # El login abre el dashboard automático (ver formularioLogin en
    # app.js) — como cualquier panel de pantalla completa de esta app,
    # tapa hasta el botón de menú, así que hay que cerrarlo antes de
    # poder seguir navegando.
    page.locator("#cerrar-panel-dashboard").click()
    expect(page.locator("#panel-dashboard")).to_be_hidden()


def test_ficha_muestra_frente_y_largo_correctos(page, base_url, lote_sembrado):
    """El resumen de "Medidas" en la ficha (rectángulo mínimo) coincide
    con lo calculado a mano para el rectángulo conocido del fixture."""
    page.goto(base_url)
    abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])
    expect(page.locator("#ficha-medidas")).to_have_text(
        f"Frente {FRENTE_ESPERADO} × Largo {LARGO_ESPERADO}"
    )


def test_editor_de_forma_muestra_medidas_en_vivo(page, base_url, lote_sembrado):
    """Al abrir "Ajustar forma en el mapa", la barra del editor arranca
    mostrando las mismas medidas que la ficha (antes de tocar nada)."""
    page.goto(base_url)
    _loguearse(page)
    abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])

    page.locator("#btn-editar-forma-lote").click()
    expect(page.locator("#editor-poligono-barra")).to_be_visible()
    expect(page.locator("#editor-poligono-superficie")).to_have_text("460.6 m²")
    expect(page.locator("#editor-poligono-frente")).to_have_text(FRENTE_ESPERADO)
    expect(page.locator("#editor-poligono-largo")).to_have_text(LARGO_ESPERADO)

    # No tiene esquinas casi en línea recta (es un rectángulo prolijo) —
    # el bloque de "Simplificar forma" no debería ofrecerse.
    expect(page.locator("#editor-poligono-simplificar")).to_be_hidden()


def test_aplicar_lado_deja_esa_medida_exacta(page, base_url, lote_sembrado):
    """Elegir un lado de la lista y escribirle una medida nueva deja ESE
    lado exacto al decimal, sin tocar los demás vértices de más — no se
    guarda (se cancela), Firestore no se toca."""
    page.goto(base_url)
    _loguearse(page)
    abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])
    page.locator("#btn-editar-forma-lote").click()

    page.locator("#btn-modo-lado-lista").click()
    lados = page.locator("#lista-lados li")
    expect(lados).to_have_count(4)
    lados.first.click()

    expect(page.locator("#lado-seleccionado-form")).to_be_visible()
    page.locator("#input-lado-nuevo").fill("15")
    page.locator("#btn-aplicar-lado").click()

    expect(page.locator("#lado-seleccionado-medida")).to_have_text("15.0 m")
    expect(lados.first).to_contain_text("15.0 m")
    # La superficie tiene que haber cambiado en consecuencia (el
    # rectángulo original medía ~20.7 x 22.3 = 460 m², un lado más
    # corto a 15 m tiene que dar menos superficie que antes).
    superficie_texto = page.locator("#editor-poligono-superficie").inner_text()
    superficie_valor = float(superficie_texto.replace(" m²", ""))
    assert superficie_valor < 460.6

    page.locator("#btn-cancelar-poligono").click()
    expect(page.locator("#editor-poligono-barra")).to_be_hidden()


def test_guardar_forma_escribe_la_superficie_nueva_en_firestore(page, base_url, lote_sembrado):
    """"Guardar forma" no solo redibuja el polígono en el mapa: el
    updateDoc tiene que dejar la superficie_m2 nueva en Firestore, no
    solo en la UI."""
    page.goto(base_url)
    _loguearse(page)
    abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])
    page.locator("#btn-editar-forma-lote").click()

    page.locator("#btn-modo-lado-lista").click()
    lados = page.locator("#lista-lados li")
    lados.first.click()
    page.locator("#input-lado-nuevo").fill("15")
    page.locator("#btn-aplicar-lado").click()

    page.locator("#btn-guardar-poligono").click()
    expect(page.locator("#editor-poligono-barra")).to_be_hidden()

    respuesta = requests.get(f"{FIRESTORE_URL_BASE}/{lote_sembrado['doc_id']}", timeout=10)
    respuesta.raise_for_status()
    campo_superficie = respuesta.json()["fields"]["superficie_m2"]
    # Firestore guarda un número sin parte fraccionaria como
    # "integerValue" en vez de "doubleValue" — cubrir los dos casos.
    superficie_guardada = float(campo_superficie.get("doubleValue", campo_superficie.get("integerValue")))
    assert superficie_guardada < 460.6, (
        f"Se esperaba que la superficie guardada bajara de 460.6 m², pero quedó en {superficie_guardada}"
    )
