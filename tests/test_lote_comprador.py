"""
Test de Playwright para "Vendido a" — trazabilidad de venta (idea propia:
Tokko no conecta su CRM con su inventario de forma tan directa). Al
marcar un lote como "Vendido" desde "Editar lote", se puede elegir el
contacto del CRM que cerró la compra; la ficha lo muestra como un link
que abre ese contacto directo en el CRM.
"""

import pytest
from playwright.sync_api import expect

from conftest import _uid_de_prueba, borrar_contacto_de_prueba, borrar_lote_de_prueba, crear_contacto_de_prueba, crear_lote_de_prueba, soltar_el_mouse

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion

GEOMETRY_BASE = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.082000, "lat": -32.412000},
        {"lon": -65.081780, "lat": -32.412000},
        {"lon": -65.081780, "lat": -32.412200},
        {"lon": -65.082000, "lat": -32.412200},
        {"lon": -65.082000, "lat": -32.412000},
    ],
}


def _lote(manzana):
    return {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": "disponible",
        "precio_usd": 30000,
        "sector": None,
        "geometry": GEOMETRY_BASE,
    }


def _contacto(nombre):
    return {
        "nombre": nombre,
        "telefono": None,
        "email": None,
        "estado": "visita",
        "motivo_perdido": None,
        "proximo_seguimiento": None,
        "lotes_interes": [],
        "actividades": [],
        "asignado_a": _uid_de_prueba(),
        "fecha_creacion": "2026-09-01T00:00:00.000Z",
        "fecha_actualizacion": "2026-09-01T00:00:00.000Z",
    }


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_ficha_desde_lista(page, doc_id):
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_vender_lote_con_comprador_muestra_link_al_contacto(page, base_url):
    contacto_id = crear_contacto_de_prueba(_contacto("COMPRA-CON-CONTACTO"))
    lote_id = crear_lote_de_prueba(_lote("VENDA"))
    try:
        _loguearse(page, base_url)
        _abrir_ficha_desde_lista(page, lote_id)

        page.locator("#btn-editar-lote-completo").click()
        page.locator("#editar-lote-estado").select_option("vendido")
        page.locator("#editar-lote-comprador").select_option(contacto_id)
        page.locator('[data-testid="editar-lote-guardar"]').click()

        expect(page.locator("#ficha-comprador-dt")).to_be_visible()
        expect(page.locator("#ficha-comprador")).to_have_text("COMPRA-CON-CONTACTO")

        # Clickear el link abre el CRM directo en la ficha de ESE contacto.
        page.locator("#ficha-comprador").click()
        expect(page.locator("#panel-crm")).to_be_visible()
        expect(page.locator("#contacto-nombre")).to_have_value("COMPRA-CON-CONTACTO")
    finally:
        borrar_lote_de_prueba(lote_id)
        borrar_contacto_de_prueba(contacto_id)


def test_vender_lote_sin_elegir_comprador_no_muestra_la_fila(page, base_url):
    lote_id = crear_lote_de_prueba(_lote("VENDA-SINCOMPRADOR"))
    try:
        _loguearse(page, base_url)
        _abrir_ficha_desde_lista(page, lote_id)

        page.locator("#btn-editar-lote-completo").click()
        page.locator("#editar-lote-estado").select_option("vendido")
        # Se deja "Sin especificar" (valor por defecto), a propósito.
        page.locator('[data-testid="editar-lote-guardar"]').click()

        expect(page.locator("#ficha-estado")).to_contain_text("Vendido")
        expect(page.locator("#ficha-comprador-dt")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(lote_id)


def test_volver_a_disponible_borra_el_comprador_guardado(page, base_url):
    contacto_id = crear_contacto_de_prueba(_contacto("COMPRA-REVERTIDA"))
    lote_id = crear_lote_de_prueba(_lote("VENDA-REVIERTE"))
    try:
        _loguearse(page, base_url)
        _abrir_ficha_desde_lista(page, lote_id)

        page.locator("#btn-editar-lote-completo").click()
        page.locator("#editar-lote-estado").select_option("vendido")
        page.locator("#editar-lote-comprador").select_option(contacto_id)
        page.locator('[data-testid="editar-lote-guardar"]').click()
        expect(page.locator("#ficha-comprador-dt")).to_be_visible()

        page.locator("#btn-editar-lote-completo").click()
        page.locator("#editar-lote-estado").select_option("disponible")
        page.locator('[data-testid="editar-lote-guardar"]').click()

        expect(page.locator("#ficha-estado")).to_contain_text("Disponible")
        expect(page.locator("#ficha-comprador-dt")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(lote_id)
        borrar_contacto_de_prueba(contacto_id)
