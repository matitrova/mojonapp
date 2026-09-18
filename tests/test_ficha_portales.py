"""
Test de Playwright para "Publicación en portales" (js/ficha.js) — a
pedido del usuario ("la sección para publicar en varios portales
también sumala"). No publica de verdad en ningún portal (necesitaría
credenciales/acuerdo comercial con cada uno) — es un checklist que
persiste en Firestore, más un texto listo para copiar y pegar a mano.
"""

import pytest
from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion

LOTE = {
    "manzana": "PORTAL",
    "lote": "1",
    "nomenclatura": None,
    "superficie_m2": 500,
    "estado": "disponible",
    "precio_usd": 25000,
    "sector": "Zona Portal",
    "servicios": {"luz": True, "agua": False, "gas": False, "cloaca": False},
    "descripcion": "Lote de prueba para portales",
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            {"lon": -65.083000, "lat": -32.413000},
            {"lon": -65.082780, "lat": -32.413000},
            {"lon": -65.082780, "lat": -32.413200},
            {"lon": -65.083000, "lat": -32.413200},
            {"lon": -65.083000, "lat": -32.413000},
        ],
    },
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


def test_marcar_un_portal_persiste_al_recargar(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE)
    try:
        _loguearse(page, base_url)
        _abrir_ficha_desde_lista(page, doc_id)

        expect(page.locator("#ficha-portales")).to_be_visible()
        page.locator("#portal-zonaprop").check()
        # Se guarda solo, sin botón de "guardar" aparte (mismo criterio
        # que los editores inline de servicios/zona/barrio) — se espera
        # el mensaje "Guardado." antes de recargar, porque el updateDoc
        # es asíncrono y un reload inmediato podría ganarle de mano.
        expect(page.locator("#portales-mensaje")).to_contain_text("Guardado")
        # Un reload con la sesión ya persistida (Firebase Auth) vuelve a
        # abrir el Dashboard solo, igual que el login manual (ver
        # onAuthStateChanged en app.js) — hay que cerrarlo antes de
        # poder llegar a la ficha por el drawer.
        page.reload()
        expect(page.locator("#sesion-activa")).to_be_visible()
        page.locator("#cerrar-panel-dashboard").click()
        _abrir_ficha_desde_lista(page, doc_id)

        expect(page.locator("#portal-zonaprop")).to_be_checked()
        expect(page.locator("#portal-mercadolibre")).not_to_be_checked()
    finally:
        borrar_lote_de_prueba(doc_id)


def test_copiar_descripcion_arma_texto_con_los_datos_del_lote(page, base_url):
    doc_id = crear_lote_de_prueba(LOTE)
    try:
        _loguearse(page, base_url)
        _abrir_ficha_desde_lista(page, doc_id)
        page.context.grant_permissions(["clipboard-read", "clipboard-write"])

        page.locator("#btn-copiar-descripcion-portal").click()
        texto = page.evaluate("navigator.clipboard.readText()")

        assert "Manzana PORTAL — Lote 1" in texto
        assert "Zona Portal" in texto
        assert "500 m²" in texto
        assert "USD 25.000" in texto
        assert "luz" in texto
        assert "Lote de prueba para portales" in texto
        assert f"?lote={doc_id}" in texto
        expect(page.locator("#portales-mensaje")).to_contain_text("copiada")
    finally:
        borrar_lote_de_prueba(doc_id)
