"""
Test de Playwright para el menú de módulos (ver #drawer-menu en
index.html, js/app.js) — reemplazó a la barra de secciones persistente
por pedido explícito del usuario: "quiero sacar la sidebar y dejar el
menú desplegable con iconos que se vean cuando está contraído", con el
contenido categorizado como en Gestor/Tokko.

Con sesión y en escritorio, el menú contraído es un rail de 4 íconos de
módulo (Inicio, Lotes, Contactos, Sistema); tocar uno lleva a la pantalla
por defecto de ese módulo. Sin sesión no hay rail y el ☰ solo muestra lo
público (el catálogo se puede mirar sin cuenta).

La barra vieja (#nav-secciones) sigue en el DOM pero oculta a propósito:
su clase "activo" es la que define qué sección se ve (ver
sincronizarSeccionMapa en app.js) — por eso acá se sigue chequeando esa
clase, aunque el usuario ya no la vea.
"""

import pytest
from playwright.sync_api import expect

from conftest import soltar_el_mouse

ANCHO_ESCRITORIO = {"width": 1200, "height": 900}


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de cada
    test). Se conserva el nombre para no tocar los llamados."""
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()
    _soltar_el_mouse(page)


def _soltar_el_mouse(page):
    """El menú se expande al pasar el mouse por encima (pedido del usuario),
    y Playwright deja el puntero en (0,0) — es decir, ENCIMA del rail — así
    que sin esto el menú aparece siempre expandido y no se puede verificar
    el estado contraído."""
    page.mouse.move(600, 400)


# SIN marcador a propósito: este test verifica qué se ve sin
# sesión, así que necesita el contexto limpio.
def test_sin_sesion_no_hay_rail_y_el_menu_solo_muestra_lo_publico(page, base_url):
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(base_url)
    # Contraído y sin sesión, el menú no se muestra para nada.
    expect(page.locator("#drawer-menu")).to_be_hidden()

    page.locator("#btn-menu").click()
    expect(page.locator("#drawer-menu")).to_be_visible()
    # Lo público del catálogo sí (mapa/lista/favoritos)...
    expect(page.locator("#btn-ver-lista")).to_be_visible()
    expect(page.locator("#btn-abrir-favoritos")).to_be_visible()
    # ...y nada de gestión: ni cargar lotes, ni zonas, ni usuarios.
    # La carga vive ahora en el botón flotante "+" (ver js/fab-carga.js),
    # así que lo que tiene que estar escondido sin sesión es ese.
    expect(page.locator("#fab-carga")).to_be_hidden()
    expect(page.locator("#btn-abrir-sectores")).to_be_hidden()
    expect(page.locator("#menu-seguridad-usuarios")).to_be_hidden()


@pytest.mark.con_sesion
def test_el_rail_muestra_los_4_modulos_y_cada_uno_lleva_a_su_pantalla(page, base_url):
    """La barra lateral está SIEMPRE desplegada en escritorio.

    Antes era un rail de íconos que se expandía al pasar el mouse, y
    este test verificaba que los ítems estuvieran escondidos hasta
    entonces. El rediseño del 2026-09-18 la dejó fija con sus ítems a la
    vista, así que lo que corresponde verificar ahora es lo contrario:
    que se llegue a cada pantalla sin tener que abrir nada.
    """
    _loguearse(page, base_url)

    # Los cuatro grupos y sus ítems, a la vista sin abrir nada.
    expect(page.locator("#btn-modulo-inicio")).to_be_visible()
    expect(page.locator("#btn-modulo-lotes")).to_be_visible()
    expect(page.locator("#btn-modulo-contactos")).to_be_visible()
    expect(page.locator("#btn-modulo-sistema")).to_be_visible()
    expect(page.locator("#btn-abrir-dashboard")).to_be_visible()

    page.locator("#btn-modulo-inicio").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-dashboard")).to_be_visible()

    page.locator("#btn-modulo-contactos").click()
    expect(page.locator("#panel-crm")).to_be_visible()
    expect(page.locator("#panel-dashboard")).to_be_hidden()

    page.locator("#btn-modulo-sistema").click()
    expect(page.locator("#panel-admin")).to_be_visible()
    expect(page.locator("#panel-crm")).to_be_hidden()

    # "Lotes" vuelve al mapa, que ahora es una sección más (#seccion-mapa).
    page.locator("#btn-modulo-lotes").click()
    _soltar_el_mouse(page)
    expect(page.locator("#panel-admin")).to_be_hidden()
    # Sobre #mapa y no sobre #seccion-mapa: el wrapper mide 0 de alto
    # (el mapa de adentro es position:absolute), y para Playwright algo de
    # tamaño 0 está "oculto" aunque no tenga display:none.
    expect(page.locator("#mapa")).to_be_visible()
    expect(page.locator("#nav-tab-mapa")).to_have_class("nav-tab activo")


@pytest.mark.con_sesion
def test_abrir_el_menu_muestra_las_pantallas_agrupadas_por_categoria(page, base_url):
    _loguearse(page, base_url)
    page.locator("#btn-menu").click()

    # Expandido se ven los ítems de cada módulo, con sus categorías.
    expect(page.locator("#btn-ver-lista")).to_be_visible()
    expect(page.locator("#fab-carga")).to_be_visible()
    expect(page.locator("#btn-abrir-sectores")).to_be_visible()
    # El texto en el DOM va en capitalización normal; las mayúsculas las
    # pone el CSS (text-transform), y Playwright compara el DOM.
    expect(page.locator("#drawer-menu")).to_contain_text("Clasificación")
    # "Carga" ya NO es una categoría del menú: las tres formas de sumar un
    # lote se mudaron al botón flotante "+" (ver js/fab-carga.js).
    expect(page.locator("#drawer-menu")).not_to_contain_text("Carga")

    # Elegir un ítem navega a esa sección.
    page.locator("#btn-ver-lista").click()
    expect(page.locator("#vista-lista")).to_be_visible()
    _soltar_el_mouse(page)


@pytest.mark.con_sesion
def test_en_celular_no_hay_rail_y_el_menu_se_abre_con_el_boton(page, base_url):
    _loguearse(page, base_url)
    page.set_viewport_size({"width": 375, "height": 812})
    _soltar_el_mouse(page)

    # Sin rail: contraído no ocupa lugar en una pantalla chica.
    expect(page.locator("#btn-modulo-lotes")).to_be_hidden()

    page.locator("#btn-menu").click()
    expect(page.locator("#btn-modulo-lotes")).to_be_visible()
    expect(page.locator("#fab-carga")).to_be_visible()
    expect(page.locator("#btn-modulo-lotes")).to_be_visible()
    expect(page.locator("#fab-carga")).to_be_visible()
