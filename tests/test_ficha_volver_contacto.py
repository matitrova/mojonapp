"""
Test de Playwright para "← Volver a [contacto]" en la ficha del lote
(js/ficha.js) — idea propia #2 de "el mapa como una cualidad del CRM":
no perder el contexto al saltar de un contacto del CRM al mapa. Solo
aparece cuando se llega a la ficha desde un contacto puntual (mini-mapa
o chip de "Lotes de interés" en crm-formulario.js, ver irALoteDesdeCrm
en crm.js) — cualquier otro camino a la misma ficha (grilla, mapa,
deep link) no la muestra.
"""

import uuid

from playwright.sync_api import expect

from conftest import (
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
    _uid_de_prueba,
    borrar_contacto_de_prueba,
    borrar_lote_de_prueba,
    crear_contacto_de_prueba,
    crear_lote_de_prueba,
    soltar_el_mouse,
)

GEOMETRY_BASE = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.075000, "lat": -32.405000},
        {"lon": -65.074780, "lat": -32.405000},
        {"lon": -65.074780, "lat": -32.405200},
        {"lon": -65.075000, "lat": -32.405200},
        {"lon": -65.075000, "lat": -32.405000},
    ],
}


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_crm(page):
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()


def test_ir_al_lote_desde_el_crm_muestra_volver_y_regresa_al_contacto(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(
        {
            "manzana": f"VOLVER-{marcador}",
            "lote": "1",
            "nomenclatura": None,
            "superficie_m2": 500,
            "estado": "disponible",
            "precio_usd": 10000,
            "sector": None,
            "geometry": GEOMETRY_BASE,
        }
    )
    contacto_id = crear_contacto_de_prueba(
        {
            "nombre": f"VOLVER-TEST-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "nuevo",
            "lotes_interes": [{"id": lote_id, "titulo": f"Manzana VOLVER-{marcador} — Lote 1"}],
            "etiquetas": [],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator(f'[data-testid="crm-tarjeta-{contacto_id}"]').click()
        # "Lotes de interés" quedó en la pestaña "Lotes" (ver Parte B del
        # timeline unificado + formulario en pestañas).
        page.locator("#crm-tab-lotes").click()

        page.locator("#crm-lista-lotes-interes .crm-chip-titulo").click()
        elVolver = page.locator("#ficha-volver-contacto")
        expect(elVolver).to_be_visible()
        expect(elVolver).to_have_text(f"← Volver a VOLVER-TEST-{marcador}")

        elVolver.click()
        expect(page.locator("#panel-crm")).to_be_visible()
        expect(page.locator("#contacto-nombre")).to_have_value(f"VOLVER-TEST-{marcador}")
    finally:
        borrar_contacto_de_prueba(contacto_id)
        borrar_lote_de_prueba(lote_id)


def test_abrir_la_ficha_por_otro_camino_no_muestra_volver(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(
        {
            "manzana": f"SINVOLVER-{marcador}",
            "lote": "1",
            "nomenclatura": None,
            "superficie_m2": 500,
            "estado": "disponible",
            "precio_usd": 10000,
            "sector": None,
            "geometry": GEOMETRY_BASE,
        }
    )
    try:
        _loguearse(page, base_url)
        page.locator("#btn-menu").click()
        page.locator("#btn-ver-lista").click()
        soltar_el_mouse(page)
        page.locator("#filtro-cantidad").select_option("0")
        page.locator(f'tr[data-lote-id="{lote_id}"]').click()
        expect(page.locator("#ficha-lote")).to_be_visible()
        expect(page.locator("#ficha-volver-contacto")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(lote_id)
