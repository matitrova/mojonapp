"""
Tests de Playwright para el router de MojonApp (js/router.js): una URL
por sección.

Qué protegen exactamente. Antes de esto la app era un solo index.html
donde cada pantalla se mostraba/escondía con clases, y cada una escondía
a mano una lista INCOMPLETA de las otras. El usuario lo reportó probando
producción, en tres síntomas que son el mismo problema:

  - "cada sección no genera cambios en la url, necesito que esté bien
    estructurado, no que sea una landing page"
  - "el botón de dashboard no lleva a ninguna parte" (estando en el CRM,
    el Dashboard se abría POR DEBAJO del panel del CRM)
  - "al abrir varias secciones se superponen o quedan mal en la página"

Más el pedido de que la sección actual quede marcada en el menú.

OJO con el server de prueba: entrar directo a /contactos necesita que el
servidor devuelva index.html en esa ruta. Cloudflare Pages lo hace solo
(un pedido que no matchea ningún archivo devuelve index.html con 200, sin
configurar nada), y scripts/servidor_dev.py imita esa regla — es el que
levanta la fixture `base_url` (ver tests/conftest.py) justamente por este
motivo.
"""

import pytest
from playwright.sync_api import expect

from conftest import soltar_el_mouse

ANCHO_ESCRITORIO = {"width": 1200, "height": 900}


def _loguearse(page, url=""):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de cada
    test). Se conserva el nombre para no tocar los llamados.

    A diferencia del helper de otros tests, NO cierra el Dashboard: acá
    justamente se mira a dónde aterriza la navegación.
    """
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(url)
    expect(page.locator("#sesion-activa")).to_be_visible()


def _ir_por_el_menu(page, id_boton):
    """Navega usando el menú, como un usuario real.

    Se abre con el ☰ a propósito: el menú también se expande al pasar el
    mouse por encima, y Playwright deja el puntero en (0,0) —o sea sobre
    el rail—, lo que ya causó clicks interceptados en otros tests (ver
    [[gotcha-playwright-hover-rail]]).
    """
    page.locator("#btn-menu").click()
    page.locator(id_boton).click()
    soltar_el_mouse(page)


def _secciones_visibles(page):
    return page.evaluate(
        """() => [...document.querySelectorAll('.panel-pantalla-completa')]
             .filter((p) => !p.classList.contains('oculto'))
             .map((p) => p.id)"""
    )


@pytest.mark.con_sesion
def test_al_iniciar_sesion_aterriza_en_el_dashboard_con_su_url(page, base_url):
    _loguearse(page, base_url)
    expect(page).to_have_url(f"{base_url}/dashboard")
    expect(page.locator("#panel-dashboard")).to_be_visible()


@pytest.mark.con_sesion
def test_cada_seccion_tiene_su_propia_url(page, base_url):
    _loguearse(page, base_url)

    _ir_por_el_menu(page, "#btn-abrir-crm")
    expect(page).to_have_url(f"{base_url}/contactos")
    expect(page.locator("#panel-crm")).to_be_visible()

    _ir_por_el_menu(page, "#btn-ver-lista")
    expect(page).to_have_url(f"{base_url}/lotes")
    expect(page.locator("#vista-lista")).to_be_visible()

    _ir_por_el_menu(page, "#btn-abrir-favoritos")
    expect(page).to_have_url(f"{base_url}/favoritos")
    expect(page.locator("#panel-favoritos")).to_be_visible()


@pytest.mark.con_sesion
def test_abrir_una_seccion_esconde_la_anterior(page, base_url):
    """El bug de "el botón de dashboard no lleva a ninguna parte".

    Estando en Contactos, el Dashboard se abría por debajo del panel del
    CRM (que nadie cerraba), así que parecía que el botón no hacía nada.
    """
    _loguearse(page, base_url)

    _ir_por_el_menu(page, "#btn-abrir-crm")
    assert _secciones_visibles(page) == ["panel-crm"]

    _ir_por_el_menu(page, "#btn-abrir-dashboard")
    assert _secciones_visibles(page) == ["panel-dashboard"]

    # Y al revés, que era el orden exacto que reportó el usuario.
    _ir_por_el_menu(page, "#btn-abrir-crm")
    assert _secciones_visibles(page) == ["panel-crm"]


@pytest.mark.con_sesion
def test_entrar_directo_a_la_url_de_una_seccion(page, base_url):
    """Recargar estando en una sección, o entrar desde un favorito del
    navegador. Necesita las dos pasadas del router: la URL apunta a una
    sección que requiere sesión, así que recién se puede abrir cuando
    Firebase resolvió los permisos."""
    _loguearse(page, f"{base_url}/contactos")
    expect(page).to_have_url(f"{base_url}/contactos")
    expect(page.locator("#panel-crm")).to_be_visible()
    assert _secciones_visibles(page) == ["panel-crm"]


@pytest.mark.con_sesion
def test_el_boton_atras_del_navegador_vuelve_a_la_seccion_anterior(page, base_url):
    _loguearse(page, base_url)
    _ir_por_el_menu(page, "#btn-abrir-crm")
    expect(page).to_have_url(f"{base_url}/contactos")

    page.go_back()
    expect(page).to_have_url(f"{base_url}/dashboard")
    expect(page.locator("#panel-dashboard")).to_be_visible()
    assert _secciones_visibles(page) == ["panel-dashboard"]

    page.go_forward()
    expect(page).to_have_url(f"{base_url}/contactos")
    expect(page.locator("#panel-crm")).to_be_visible()


@pytest.mark.con_sesion
def test_la_flecha_volver_vuelve_a_la_seccion_anterior(page, base_url):
    """La × de "cerrar" pasó a ser una ← de "volver" (pedido del
    usuario). El cambio no es solo el ícono: antes cerrar SIEMPRE dejaba
    en el mapa; ahora vuelve a la sección de la que se venía."""
    _loguearse(page, base_url)
    _ir_por_el_menu(page, "#btn-abrir-crm")

    page.locator("#cerrar-panel-crm").click()
    expect(page).to_have_url(f"{base_url}/dashboard")
    expect(page.locator("#panel-dashboard")).to_be_visible()


@pytest.mark.con_sesion
def test_la_flecha_volver_no_saca_de_la_app_si_se_entro_directo(page, base_url):
    """Si se entró por URL directa no hay "atrás" propio al que volver:
    la flecha tiene que llevar al mapa, no sacar del sistema (era el otro
    pedido del usuario sobre el botón atrás)."""
    _loguearse(page, f"{base_url}/contactos")

    page.locator("#cerrar-panel-crm").click()
    expect(page).to_have_url(f"{base_url}/")
    expect(page.locator("#mapa")).to_be_visible()
    assert _secciones_visibles(page) == []


# SIN marcador a propósito: este test verifica qué se ve sin
# sesión, así que necesita el contexto limpio.
def test_una_seccion_publica_se_abre_sin_sesion(page, base_url):
    """El catálogo se puede mirar sin estar logueado, así que /lotes y
    /favoritos tienen que andar para un visitante anónimo — es el caso de
    un corredor mandándole el link a un cliente."""
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(f"{base_url}/lotes")
    expect(page.locator("#vista-lista")).to_be_visible()
    expect(page).to_have_url(f"{base_url}/lotes")


@pytest.mark.con_sesion
def test_el_menu_marca_la_seccion_activa(page, base_url):
    _loguearse(page, base_url)
    page.locator("#btn-menu").click()
    expect(page.locator("#btn-abrir-dashboard")).to_have_class("drawer-item ruta-activa")

    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    page.locator("#btn-menu").click()
    expect(page.locator("#btn-abrir-crm")).to_have_class("drawer-item ruta-activa")
    # Y la marca anterior se fue: no puede haber dos secciones activas.
    expect(page.locator(".drawer-item.ruta-activa")).to_have_count(1)


@pytest.mark.con_sesion
def test_el_titulo_de_la_pagina_acompana_a_la_seccion(page, base_url):
    """Que cada sección "sea una página" incluye el título del navegador:
    es lo que se ve en la pestaña y lo que se guarda en un favorito."""
    _loguearse(page, base_url)
    expect(page).to_have_title("Dashboard — MojonApp")

    _ir_por_el_menu(page, "#btn-abrir-crm")
    expect(page).to_have_title("Pipeline de contactos — MojonApp")


@pytest.mark.con_sesion
def test_el_link_compartido_de_un_lote_sigue_andando(page, base_url, lote_sembrado):
    """Regresión: "Compartir este lote" genera /?lote=<id>, que comparte
    la ruta "/" con el mapa. El router no puede pisar esa query string al
    resolver la URL inicial (usa replaceState conservando location.search)."""
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(f"{base_url}/?lote={lote_sembrado['doc_id']}")
    expect(page.locator("#ficha-lote")).to_be_visible()
    assert "lote=" in page.url
