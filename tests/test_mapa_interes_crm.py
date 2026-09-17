"""
Test de Playwright para "Interés del CRM" en el mapa (idea propia #5,
última de "el mapa como una cualidad del CRM" — resalta, no filtra: los
lotes sin interés se ven exactamente igual que siempre). Ver
interesPorLote en crm-metricas.js y activarInteresCrm en js/mapa.js.
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


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _datos_lote(manzana, offset):
    return {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": "disponible",
        "precio_usd": 10000,
        "sector": None,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.120000 + offset, "lat": -32.450000},
                {"lon": -65.119780 + offset, "lat": -32.450000},
                {"lon": -65.119780 + offset, "lat": -32.450200},
                {"lon": -65.120000 + offset, "lat": -32.450200},
                {"lon": -65.120000 + offset, "lat": -32.450000},
            ],
        },
    }


def test_pin_de_interes_muestra_cantidad_y_lleva_a_la_ficha(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_con_interes = crear_lote_de_prueba(_datos_lote(f"CRMINT-{marcador}", 0))
    lote_sin_interes = crear_lote_de_prueba(_datos_lote(f"SININT-{marcador}", 0.01))
    contactos = [
        crear_contacto_de_prueba(
            {
                "nombre": f"INT-{marcador}-{i}",
                "telefono": None,
                "email": None,
                "estado": "nuevo",
                "lotes_interes": [{"id": lote_con_interes, "titulo": f"Manzana CRMINT-{marcador} — Lote 1"}],
                "etiquetas": [],
                "actividades": [],
                "asignado_a": _uid_de_prueba(),
            }
        )
        for i in range(2)
    ]
    try:
        _loguearse(page, base_url)
        page.locator("#btn-menu").click()
        page.locator("#btn-ver-interes-crm").click()
        soltar_el_mouse(page)

        pin = page.locator(".marcador-interes-crm")
        expect(pin).to_have_count(1)
        expect(pin).to_have_text("2")

        pin.dispatch_event("click")
        expect(page.locator("#ficha-lote")).to_be_visible()
        expect(page.locator("#ficha-titulo")).to_have_text(f"Manzana CRMINT-{marcador} — Lote 1")
        page.locator("#cerrar-ficha").click()

        # Apagarlo con el botón flotante lo saca del mapa y del drawer.
        expect(page.locator("#btn-flotante-interes-crm")).to_be_visible()
        page.locator("#btn-flotante-interes-crm").click()
        expect(page.locator(".marcador-interes-crm")).to_have_count(0)
    finally:
        for cid in contactos:
            borrar_contacto_de_prueba(cid)
        borrar_lote_de_prueba(lote_con_interes)
        borrar_lote_de_prueba(lote_sin_interes)
