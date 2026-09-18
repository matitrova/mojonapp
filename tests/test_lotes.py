"""
Tests de Playwright (pytest) para MojonApp.

Los lotes ahora viven en Firestore, no en un archivo estático: cada test que
necesita un lote lo siembra antes (fixture `lote_sembrado`) y Firestore lo
borra solo al terminar (ver tests/conftest.py). No hay emulador de Firebase
instalado en esta máquina, así que estos tests tocan el proyecto real —
por eso cada uno limpia lo que crea, para no ensuciar la base de datos real.

Cubren: que se cargue el lote sembrado, que la ficha muestre sus datos
correctos, que el botón "Ver en el mapa" arme bien la URL de Google Maps,
que el modo "Estoy yendo" calcule bien distancia/rumbo y detecte cuando el
usuario está dentro del lote, y que un corredor logueado pueda cargar un
lote nuevo desde el formulario de la app.
"""

import uuid

from playwright.sync_api import expect

from conftest import (
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
    borrar_lote_de_prueba,
    buscar_doc_id_por_descripcion,
    soltar_el_mouse,
)

# Centroide del rectángulo de LOTE_PRUEBA_DATOS en conftest.py (promedio
# simple de sus 4 esquinas, ya que es un rectángulo).
LOTE_LAT = -32.3501
LOTE_LON = -65.01989


def abrir_ficha_desde_lista(page, doc_id):
    """Abre la ficha de un lote puntual desde "Ver como lista" en vez de
    tocar su polígono en el mapa: si Firestore ya tiene lotes reales
    dispersos por otras zonas, fitBounds() aleja tanto el mapa que el
    polígono del lote sembrado por el test puede quedar del tamaño de un
    píxel y Playwright no lo puede clickear. La fila de la grilla, en
    cambio, siempre existe y hace su propio setView al lote antes de
    abrir la ficha (ver actualizarVistaLista en js/app.js). "Ver como
    lista" vive en el menú lateral (drawer), hay que abrirlo primero.

    "Mostrar" (paginación, ver vista-lista.js) se pone en "Todos" antes
    de buscar la fila: con una cartera real grande cargada (más de la
    página por default), el lote recién sembrado por el test puede caer
    en cualquier página según el orden que devuelva Firestore — "Todos"
    saca esa dependencia del orden."""
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_carga_el_lote(page, base_url, lote_sembrado):
    page.goto(base_url)
    lote = page.locator(f".lote-{lote_sembrado['doc_id']}")
    expect(lote).to_have_count(1)


def test_ficha_muestra_datos_correctos_del_lote_tocado(page, base_url, lote_sembrado):
    page.goto(base_url)
    abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])

    ficha = page.locator("#ficha-lote")
    expect(ficha).to_be_visible()
    expect(page.locator("#ficha-titulo")).to_have_text("Manzana T — Lote 99")
    expect(page.locator("#ficha-superficie")).to_have_text("460.63 m²")
    expect(page.locator("#ficha-estado")).to_have_text("Disponible")
    expect(page.locator("#ficha-precio")).to_have_text("USD 5.000")
    expect(page.locator("#ficha-descripcion")).to_have_text(lote_sembrado["descripcion"])


def test_boton_como_llegar_arma_url_correcta(page, base_url, lote_sembrado):
    page.add_init_script(
        "window.open = (url) => { window.__urlComoLlegar = url; };"
    )
    page.goto(base_url)
    abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])
    page.locator("#btn-como-llegar").click()

    url = page.evaluate("window.__urlComoLlegar")
    assert url.startswith("https://www.google.com/maps/search/?api=1")
    # La app formatea con .toFixed(6): hay que comparar con la misma precisión.
    assert f"query={LOTE_LAT:.6f},{LOTE_LON:.6f}" in url


def test_estoy_yendo_calcula_distancia_y_detecta_lote(browser, base_url, lote_sembrado):
    # Punto a ~100 m al norte del lote (afuera del polígono).
    contexto = browser.new_context(
        geolocation={"latitude": LOTE_LAT + 0.0009, "longitude": LOTE_LON},
        permissions=["geolocation"],
    )
    page = contexto.new_page()
    page.goto(base_url)
    abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])
    page.locator("#btn-estoy-yendo").click()

    mensaje = page.locator("#nav-mensaje")
    expect(mensaje).to_contain_text("m hasta el lote")

    contexto.set_geolocation({"latitude": LOTE_LAT, "longitude": LOTE_LON})
    expect(mensaje).to_have_text("Estás dentro del lote.")

    contexto.close()


def test_corredor_logueado_puede_cargar_un_lote(page, base_url):
    marcador = f"TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        page.goto(base_url)

        # Este login por el formulario se conserva A PROPÓSITO, y es el
        # único de toda la suite: el resto de los tests arrancan con la
        # sesión ya puesta (ver estado_de_sesion en conftest.py, que hace
        # UN login por corrida para no agotar la cuota de verificación de
        # contraseñas de Firebase). Si este también se convirtiera, nada
        # quedaría probando que un corredor puede entrar de verdad.
        page.locator("#btn-abrir-login").click()
        page.locator("#login-email").fill(TEST_USER_EMAIL)
        page.locator("#login-password").fill(TEST_USER_PASSWORD)
        page.locator("[data-testid='login-submit']").click()
        expect(page.locator("#sesion-activa")).to_be_visible()
        # El login abre el dashboard automático (ver formularioLogin en
        # app.js) — tapa hasta el botón de menú, como cualquier panel de
        # pantalla completa de esta app; hay que cerrarlo primero.
        page.locator("#cerrar-panel-dashboard").click()

        # Cargar un lote ya no sale del menú lateral: vive en el botón
        # flotante "+" sobre el mapa (ver js/fab-carga.js), porque es una
        # acción que se hace mirando el mapa y no una sección a la que se
        # entra.
        page.locator("#fab-carga-boton").click()
        page.locator("#btn-cargar-lote").click()
        soltar_el_mouse(page)
        page.locator("#lote-superficie").fill("460.63")
        page.locator("#lote-estado").select_option("disponible")
        page.locator("#lote-descripcion").fill(marcador)
        page.locator("#lote-vertices").fill(
            "-32.350000,-65.020000\n"
            "-32.350000,-65.019780\n"
            "-32.350200,-65.019780\n"
            "-32.350200,-65.020000"
        )
        page.locator("[data-testid='lote-submit']").click()

        expect(page.locator("#form-lote")).to_be_hidden()

        # Se busca el doc_id en Firestore ANTES de la aserción sobre el
        # mapa a propósito: si quedara al revés y la aserción fallara, el
        # "finally" nunca llegaría a borrar el lote (doc_id seguiría en
        # None), dejando basura de test en la base real.
        doc_id = buscar_doc_id_por_descripcion(marcador)
        assert doc_id is not None, "El lote cargado por el formulario no apareció en Firestore."
        expect(page.locator(f".lote-{doc_id}")).to_have_count(1)
    finally:
        if doc_id:
            borrar_lote_de_prueba(doc_id)
