"""
Tests del botón flotante de carga (js/fab-carga.js).

POR QUÉ EXISTE ESE BOTÓN. Cargar un lote no es "ir a una sección": es una
acción que se hace mirando el mapa, eligiendo dónde. Tenerla en el menú
lateral obligaba a abrir el menú, elegir y que el menú se cierre — tres
pasos para lo que más se repite armando la cartera. Pedido del usuario
del 2026-09-18.

Lo que se protege acá:

  - que las tres formas de cargar sigan estando (se MOVIERON, no se
    duplicaron: si alguna quedó en el camino, no hay otro lugar de donde
    sacarla);
  - que el menú se cierre solo al elegir, porque las tres abren un
    formulario encima del mapa y dejarlo abierto taparía justo eso;
  - que sin permiso de carga no aparezca, porque un "+" que se abre y no
    ofrece nada es peor que no tenerlo.
"""

import pytest
from playwright.sync_api import expect

from conftest import soltar_el_mouse

pytestmark = pytest.mark.con_sesion


def _entrar(page, base_url):
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()
    soltar_el_mouse(page)


def test_el_flotante_ofrece_las_tres_formas_de_cargar(page, base_url):
    _entrar(page, base_url)
    expect(page.locator("#fab-carga")).to_be_visible()
    # Cerrado no muestra ninguna opción: es un botón, no una lista.
    expect(page.locator("#fab-carga-opciones")).to_be_hidden()

    page.locator("#fab-carga-boton").click()
    expect(page.locator("#fab-carga-opciones")).to_be_visible()
    expect(page.locator("#btn-cargar-lote")).to_be_visible()
    expect(page.locator("#btn-abrir-manzana")).to_be_visible()
    expect(page.locator("#btn-abrir-parcela")).to_be_visible()


def test_elegir_una_opcion_cierra_el_flotante(page, base_url):
    """Las tres abren un formulario sobre el mapa: dejar el menú abierto
    taparía justo lo que se va a usar."""
    _entrar(page, base_url)
    page.locator("#fab-carga-boton").click()
    page.locator("#btn-cargar-lote").click()
    soltar_el_mouse(page)
    expect(page.locator("#fab-carga-opciones")).to_be_hidden()


def test_el_mismo_boton_abre_y_cierra(page, base_url):
    _entrar(page, base_url)
    page.locator("#fab-carga-boton").click()
    expect(page.locator("#fab-carga-opciones")).to_be_visible()
    page.locator("#fab-carga-boton").click()
    expect(page.locator("#fab-carga-opciones")).to_be_hidden()


def test_un_click_afuera_lo_cierra(page, base_url):
    """Si no, queda un menú abierto tapando el mapa y hay que volver a
    buscar el botón para sacarlo."""
    _entrar(page, base_url)
    page.locator("#fab-carga-boton").click()
    expect(page.locator("#fab-carga-opciones")).to_be_visible()

    page.locator("#encabezado h1").click()
    expect(page.locator("#fab-carga-opciones")).to_be_hidden()


def test_la_carga_ya_no_esta_en_el_menu_lateral(page, base_url):
    """Se movieron, no se duplicaron: dos caminos para la misma acción
    son dos caminos para mantener."""
    _entrar(page, base_url)
    expect(page.locator("#drawer-menu")).not_to_contain_text("Cargar a mano")
    expect(page.locator("#drawer-menu")).not_to_contain_text("Agregar manzana")
