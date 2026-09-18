"""
Test de Playwright para la sección "Ventas" del Dashboard (js/dashboard.js)
— pedido explícito del usuario: "apenas inicie sesión que tenga un
dashboard con información importante para él y que le sirva para mejorar
sus ventas". Cubre dos cosas separadas:

1. Que "#dashboard-ventas-stats" muestre exactamente los mismos números
   que "#crm-stats" del panel CRM (mismo template, ver htmlResumenVentas
   en crm-metricas.js) — no se siembra ningún dato nuevo, solo se compara
   consistencia entre las dos vistas del mismo cálculo.
2. Que reabrir la app con la sesión ya guardada (sin pasar por el
   formulario de login) abra el Dashboard solo — la brecha real que
   tenía la app antes de este cambio (ver onAuthStateChanged en app.js).
"""

import pytest
from playwright.sync_api import expect

from conftest import soltar_el_mouse

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def test_ventas_del_dashboard_muestra_los_mismos_numeros_que_el_crm(page, base_url):
    _loguearse(page, base_url)

    # Abrir el CRM primero fija el alcance ("Mis contactos") con el que
    # se piden los contactos — abrir el Dashboard DESPUÉS, sin pasar por
    # ningún otro cambio de alcance en el medio, garantiza que las dos
    # pantallas lean exactamente el mismo conjunto de contactos ya en
    # memoria (getContactosActuales), sin depender de qué usuarios reales
    # existan hoy en el proyecto.
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()
    # #panel-crm ya está visible en cuanto se togglea la clase, pero
    # "#crm-stats" recién se rellena cuando termina cargarContactos()
    # (await, ver abrirPanelCrm en crm.js) — esperar a que tenga
    # contenido antes de leerlo.
    expect(page.locator("#crm-stats .crm-stat").first).to_be_visible()
    valores_crm = page.locator("#crm-stats .crm-stat strong").all_inner_texts()
    page.locator("#cerrar-panel-crm").click()

    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-dashboard").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-dashboard")).to_be_visible()
    expect(page.locator("#dashboard-ventas-seccion")).to_be_visible()
    expect(page.locator("#dashboard-ventas-stats .crm-stat").first).to_be_visible()
    valores_dashboard = page.locator("#dashboard-ventas-stats .crm-stat strong").all_inner_texts()

    assert valores_dashboard == valores_crm


def test_reabrir_con_sesion_guardada_abre_el_dashboard_solo(page, base_url, lote_sembrado):
    _loguearse(page, base_url)
    expect(page.locator("#panel-dashboard")).to_be_hidden()

    # Recargar SIN pasar por el formulario de login (la sesión de
    # Firebase Auth ya persiste) — antes de este cambio, esto dejaba al
    # corredor derecho en el mapa, igual que un visitante anónimo.
    page.reload()
    expect(page.locator("#sesion-activa")).to_be_visible()
    expect(page.locator("#panel-dashboard")).to_be_visible()

    # Un lote puntual en la URL (deep link deliberado, ej. compartido por
    # WhatsApp) no debe taparse con el Dashboard — ver el guard en
    # onAuthStateChanged (app.js).
    # El lote lo siembra la fixture. Antes se tomaba el primero que
    # hubiera en la base (getLotesActuales()[0]), lo que hacía que el
    # test dependiera de que alguien más hubiera cargado lotes: en una
    # base limpia era undefined y el test se caía.
    page.goto(f"{base_url}/?lote={lote_sembrado['doc_id']}")
    expect(page.locator("#sesion-activa")).to_be_visible()
    expect(page.locator("#ficha-lote")).to_be_visible()
    expect(page.locator("#panel-dashboard")).to_be_hidden()
