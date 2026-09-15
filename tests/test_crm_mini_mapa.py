"""
Test de Playwright para el mini-mapa de "Lotes de interés" en el
formulario del CRM (js/crm-formulario.js, renderMiniMapa) — primera de
las ideas propias de "el mapa como una cualidad del CRM": un Leaflet
chico embebido en la ficha del contacto, sin controles, solo para ubicar
de un vistazo dónde está su interés sin salir del formulario. Tocar el
polígono lleva a la ficha real del lote (irALoteDesdeCrm).
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
)


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
    expect(page.locator("#panel-crm")).to_be_visible()


def test_sin_lotes_de_interes_no_muestra_el_mini_mapa(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    contacto_id = crear_contacto_de_prueba(
        {
            "nombre": f"MINIMAPA-VACIO-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "nuevo",
            "lotes_interes": [],
            "etiquetas": [],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator(f'[data-testid="crm-tarjeta-{contacto_id}"]').click()
        expect(page.locator("#crm-mini-mapa")).to_be_hidden()
    finally:
        borrar_contacto_de_prueba(contacto_id)


def test_con_lote_de_interes_el_mini_mapa_muestra_el_poligono_y_lleva_a_la_ficha(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(
        {
            "manzana": f"MINIMAPA-{marcador}",
            "lote": "1",
            "nomenclatura": None,
            "superficie_m2": 500,
            "estado": "disponible",
            "precio_usd": 10000,
            "sector": None,
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    {"lon": -65.060000, "lat": -32.390000},
                    {"lon": -65.059780, "lat": -32.390000},
                    {"lon": -65.059780, "lat": -32.390200},
                    {"lon": -65.060000, "lat": -32.390200},
                    {"lon": -65.060000, "lat": -32.390000},
                ],
            },
        }
    )
    contacto_id = crear_contacto_de_prueba(
        {
            "nombre": f"MINIMAPA-CON-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "nuevo",
            "lotes_interes": [{"id": lote_id, "titulo": f"Manzana MINIMAPA-{marcador} — Lote 1"}],
            "etiquetas": [],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator(f'[data-testid="crm-tarjeta-{contacto_id}"]').click()
        # El mini-mapa quedó en la pestaña "Lotes" (ver Parte B del
        # timeline unificado + formulario en pestañas) — "Datos" es la
        # que se muestra por default al abrir un contacto.
        page.locator("#crm-tab-lotes").click()

        elMiniMapa = page.locator("#crm-mini-mapa")
        expect(elMiniMapa).to_be_visible()
        poligono = elMiniMapa.locator("path")
        expect(poligono).to_have_count(1)

        poligono.dispatch_event("click")
        expect(page.locator("#ficha-lote")).to_be_visible()
        expect(page.locator("#ficha-titulo")).to_have_text(f"Manzana MINIMAPA-{marcador} — Lote 1")
        expect(page.locator("#nav-tab-mapa")).to_have_class("nav-tab activo")
    finally:
        borrar_contacto_de_prueba(contacto_id)
        borrar_lote_de_prueba(lote_id)
