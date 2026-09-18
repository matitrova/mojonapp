"""
Test de Playwright para la vista "Tabla" del pipeline del CRM
(js/crm.js, renderTablaContactos) — inspirada en la tabla de
"Oportunidades" de Tokko Broker (agrupada por etapa), alternativa al
kanban existente, no un reemplazo. Ver el plan de la sesión y
[[mojonapp_estado_proyecto]].
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import (
    abrir_menu,
    _uid_de_prueba,
    borrar_contacto_de_prueba,
    crear_contacto_de_prueba,
)

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


def _abrir_crm(page):
    abrir_menu(page)
    page.locator("#btn-abrir-crm").click()
    expect(page.locator("#panel-crm")).to_be_visible()
    _soltar_el_mouse(page)


def _soltar_el_mouse(page):
    """El menú lateral se expande al pasar el mouse por encima, y Playwright
    deja el puntero en (0,0) — o sea ENCIMA del rail. Expandido mide 288px y
    tapa el toggle Kanban/Tabla de la toolbar del CRM (que arranca en x≈163),
    así que el click se lo come un ítem del menú ("subtree intercepts pointer
    events"). Mover el puntero al centro lo contrae y deja la toolbar libre.
    Un usuario real no lo sufre salvo que tenga el menú abierto encima."""
    page.mouse.move(700, 400)


def test_arranca_en_kanban_con_tabla_oculta(page, base_url):
    _loguearse(page, base_url)
    _abrir_crm(page)
    expect(page.locator("#btn-crm-modo-kanban")).to_have_class("activo")
    expect(page.locator("#crm-kanban")).to_be_visible()
    expect(page.locator("#crm-tabla")).to_be_hidden()


def test_boton_tabla_agrupa_por_etapa_y_oculta_el_kanban(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_contacto_de_prueba(
        {
            "nombre": f"TABLA-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "contactado",
            "motivo_perdido": None,
            "proximo_seguimiento": None,
            "lotes_interes": [],
            "etiquetas": [],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
            "fecha_creacion": "2026-09-01T00:00:00.000Z",
            "fecha_actualizacion": "2026-09-01T00:00:00.000Z",
        }
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator("#btn-crm-modo-tabla").click()

        expect(page.locator("#btn-crm-modo-tabla")).to_have_class("activo")
        expect(page.locator("#crm-kanban")).to_be_hidden()
        expect(page.locator("#crm-tabla")).to_be_visible()

        grupo = page.locator('[data-testid="crm-tabla-etapa-contactado"]')
        expect(grupo).to_contain_text(f"TABLA-{marcador}")
    finally:
        borrar_contacto_de_prueba(doc_id)


def test_click_en_fila_abre_el_formulario_del_contacto(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_contacto_de_prueba(
        {
            "nombre": f"TABLA-FILA-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "nuevo",
            "motivo_perdido": None,
            "proximo_seguimiento": None,
            "lotes_interes": [],
            "etiquetas": [],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
            "fecha_creacion": "2026-09-01T00:00:00.000Z",
            "fecha_actualizacion": "2026-09-01T00:00:00.000Z",
        }
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator("#btn-crm-modo-tabla").click()

        page.locator(f'[data-testid="crm-fila-{doc_id}"]').click()
        expect(page.locator("#contacto-nombre")).to_have_value(f"TABLA-FILA-{marcador}")
    finally:
        borrar_contacto_de_prueba(doc_id)
