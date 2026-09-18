"""
Test de Playwright para "Visitas agendadas para hoy" en el Dashboard
(idea propia #4 de "el mapa como una cualidad del CRM", literalmente
"pineadas" — ver visitasDeHoy en crm-metricas.js y renderVisitasDeHoy/
verVisitasEnElMapa en dashboard.js): contactos en etapa "Visita" con el
seguimiento agendado para HOY (no hay un campo de "fecha de visita"
propio, se reusa proximo_seguimiento). "Ver la ruta en el mapa" pinea
todas las paradas juntas; tocar un pin lleva a la ficha real con
"← Volver a [contacto]" (idea #2).
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from playwright.sync_api import expect

from conftest import (
    _uid_de_prueba,
    borrar_contacto_de_prueba,
    borrar_lote_de_prueba,
    crear_contacto_de_prueba,
    crear_lote_de_prueba,
)

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion


def _hoy():
    return datetime.now(timezone.utc).date().isoformat()


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()


def _datos_lote(manzana, offset, sector):
    return {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": "disponible",
        "precio_usd": 10000,
        "sector": sector,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.110000 + offset, "lat": -32.440000},
                {"lon": -65.109780 + offset, "lat": -32.440000},
                {"lon": -65.109780 + offset, "lat": -32.440200},
                {"lon": -65.110000 + offset, "lat": -32.440200},
                {"lon": -65.110000 + offset, "lat": -32.440000},
            ],
        },
    }


def test_visita_de_hoy_aparece_pin_lleva_a_la_ficha_con_volver(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(_datos_lote(f"VISITAHOY-{marcador}", 0, f"ZonaVisita-{marcador}"))
    contacto_id = crear_contacto_de_prueba(
        {
            "nombre": f"VISITA-HOY-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "visita",
            "proximo_seguimiento": _hoy(),
            "lotes_interes": [{"id": lote_id, "titulo": f"Manzana VISITAHOY-{marcador} — Lote 1"}],
            "etiquetas": [],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    try:
        _loguearse(page, base_url)
        expect(page.locator("#panel-dashboard")).to_be_visible()

        fila = page.locator("#dashboard-visitas li", has_text=f"VISITA-HOY-{marcador}")
        expect(fila).to_be_visible()
        expect(fila).to_contain_text(f"ZonaVisita-{marcador}")

        page.locator("#dashboard-visitas li", has_text="Ver la ruta en el mapa").click()
        expect(page.locator("#panel-dashboard")).to_be_hidden()
        expect(page.locator("#nav-tab-mapa")).to_have_class("nav-tab activo")
        expect(page.locator(".leaflet-marker-icon")).to_have_count(1)

        page.locator(".leaflet-marker-icon").click()
        expect(page.locator("#ficha-lote")).to_be_visible()
        expect(page.locator("#ficha-titulo")).to_have_text(f"Manzana VISITAHOY-{marcador} — Lote 1")
        expect(page.locator("#ficha-volver-contacto")).to_have_text(f"← Volver a VISITA-HOY-{marcador}")
    finally:
        borrar_contacto_de_prueba(contacto_id)
        borrar_lote_de_prueba(lote_id)


def test_visita_agendada_para_otro_dia_no_aparece(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(_datos_lote(f"VISITAOTRO-{marcador}", 0.01, f"ZonaOtro-{marcador}"))
    mañana = (datetime.now(timezone.utc).date() + timedelta(days=1)).isoformat()
    contacto_id = crear_contacto_de_prueba(
        {
            "nombre": f"VISITA-MANANA-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "visita",
            "proximo_seguimiento": mañana,
            "lotes_interes": [{"id": lote_id, "titulo": f"Manzana VISITAOTRO-{marcador} — Lote 1"}],
            "etiquetas": [],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    try:
        _loguearse(page, base_url)
        expect(page.locator("#panel-dashboard")).to_be_visible()
        expect(page.locator("#dashboard-visitas li", has_text=f"VISITA-MANANA-{marcador}")).to_have_count(0)
    finally:
        borrar_contacto_de_prueba(contacto_id)
        borrar_lote_de_prueba(lote_id)
