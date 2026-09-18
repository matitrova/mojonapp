"""
Test de Playwright para "Rendimiento por corredor" en el CRM (idea
propia, investigada en las funcionalidades de Tokko Broker antes de
armarla — ver feedback_buscar_inspiracion_real: "Métricas de
negocio... conocer la performance de tu equipo y de tu negocio").
Solo tiene sentido en "Todos" — en "Mis contactos" no hay nadie con
quien comparar.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import abrir_menu, borrar_contacto_de_prueba, crear_contacto_de_prueba, soltar_el_mouse

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion

OTRO_CORREDOR_UID = "uid-de-otro-corredor-inexistente"


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
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()


def _datos(nombre, estado, asignado_a):
    return {
        "nombre": nombre,
        "telefono": None,
        "email": None,
        "estado": estado,
        "motivo_perdido": None,
        "proximo_seguimiento": None,
        "lotes_interes": [],
        "actividades": [],
        "asignado_a": asignado_a,
        "fecha_creacion": "2026-01-01T00:00:00.000Z",
        "fecha_actualizacion": "2026-01-01T00:00:00.000Z",
    }


def test_rendimiento_solo_aparece_en_todos_y_agrupa_por_corredor(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    a = crear_contacto_de_prueba(_datos(f"REND-A-{marcador}", "cerrado", OTRO_CORREDOR_UID))
    b = crear_contacto_de_prueba(_datos(f"REND-B-{marcador}", "nuevo", OTRO_CORREDOR_UID))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        seccion = page.locator("#crm-rendimiento-seccion")
        expect(seccion).to_be_hidden()  # arranca en "Mis contactos"

        page.locator("#btn-crm-vista-todas").click()
        expect(seccion).to_be_visible()

        fila = page.locator(f"#crm-tabla-rendimiento tr", has_text=OTRO_CORREDOR_UID)
        expect(fila).to_contain_text("2")  # 2 contactos
        expect(fila).to_contain_text("50%")  # 1 de 2 cerrado

        page.locator("#btn-crm-vista-mias").click()
        expect(seccion).to_be_hidden()
    finally:
        borrar_contacto_de_prueba(a)
        borrar_contacto_de_prueba(b)
