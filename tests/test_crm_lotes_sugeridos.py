"""
Test de Playwright para "Lotes sugeridos" (js/crm-formulario.js +
lotesSugeridos en js/crm-metricas.js) — matching lote<->interesado por
reglas simples (misma zona/precio/superficie similares a los lotes de
interés ya cargados), sin usar ningún servicio externo ni costo. Parte
del pedido "arma lo que mejor puedas... hacelo como si estuviera pero
no lo actives" (ver mojonapp_estado_proyecto): esta es la mitad
"gratis, de verdad" de ese pedido — la vidriera de IA paga
(js/ia-proximamente.js) es la otra mitad, sin cobertura de test porque
no tiene lógica, es un panel informativo fijo.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import (
    abrir_menu,
    _uid_de_prueba,
    borrar_contacto_de_prueba,
    borrar_lote_de_prueba,
    crear_contacto_de_prueba,
    crear_lote_de_prueba,
    soltar_el_mouse,
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
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()


def _geometry(offset):
    base = -65.040000 + offset
    return {
        "type": "Polygon",
        "coordinates": [
            {"lon": base, "lat": -32.370000},
            {"lon": base + 0.00022, "lat": -32.370000},
            {"lon": base + 0.00022, "lat": -32.370200},
            {"lon": base, "lat": -32.370200},
            {"lon": base, "lat": -32.370000},
        ],
    }


def _lote(offset, **extra):
    base = {
        "manzana": "SUGT",
        "nomenclatura": None,
        "estado": "disponible",
        "geometry": _geometry(offset),
    }
    base.update(extra)
    return base


def test_sugiere_por_zona_precio_y_superficie_similares_y_agregarlo_lo_mueve_a_interes(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_interes_id = crear_lote_de_prueba(
        _lote(0.001, lote=f"IN-{marcador}", sector=f"Zona-{marcador}", precio_usd=10000, superficie_m2=500)
    )
    lote_match_id = crear_lote_de_prueba(
        _lote(0.002, lote=f"MATCH-{marcador}", sector=f"Zona-{marcador}", precio_usd=10500, superficie_m2=520)
    )
    lote_no_match_id = crear_lote_de_prueba(
        _lote(0.003, lote=f"NOMATCH-{marcador}", sector=f"OtraZona-{marcador}", precio_usd=90000, superficie_m2=5000)
    )
    contacto_id = crear_contacto_de_prueba(
        {
            "nombre": f"SUG-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "nuevo",
            "lotes_interes": [{"id": lote_interes_id, "titulo": f"Manzana SUGT — Lote IN-{marcador}"}],
            "etiquetas": [],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator(f'[data-testid="crm-tarjeta-{contacto_id}"]').click()
        # Lotes sugeridos quedó en la pestaña "Lotes" (ver Parte B del
        # timeline unificado + formulario en pestañas) — hace falta
        # visibilidad real para el .click() de "+ Agregar" más abajo.
        page.locator("#crm-tab-lotes").click()

        elLista = page.locator("#crm-lista-sugeridos")
        expect(elLista).to_contain_text(f"Lote MATCH-{marcador}")
        expect(elLista).not_to_contain_text(f"Lote NOMATCH-{marcador}")

        fila_sugerida = elLista.locator("li", has_text=f"Lote MATCH-{marcador}")
        fila_sugerida.get_by_text("+ Agregar").click()

        expect(page.locator("#crm-lista-lotes-interes")).to_contain_text(f"Lote MATCH-{marcador}")
        expect(page.locator("#crm-lista-sugeridos")).not_to_contain_text(f"Lote MATCH-{marcador}")
    finally:
        borrar_contacto_de_prueba(contacto_id)
        borrar_lote_de_prueba(lote_interes_id)
        borrar_lote_de_prueba(lote_match_id)
        borrar_lote_de_prueba(lote_no_match_id)


def test_sin_lotes_de_interes_no_muestra_la_seccion(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    contacto_id = crear_contacto_de_prueba(
        {
            "nombre": f"SUG-VACIO-{marcador}",
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
        expect(page.locator("#crm-sugeridos")).to_be_hidden()
    finally:
        borrar_contacto_de_prueba(contacto_id)
