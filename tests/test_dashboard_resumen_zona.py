"""
Test de Playwright para "Resumen por zona" en el Dashboard (idea propia,
investigada en las funcionalidades y planes de Tokko Broker antes de
armarla — ver feedback_buscar_inspiracion_real: Tokko cobra
"Emprendimientos" aparte, recién desde su plan de $252.320/mes, para dar
"visión general del estado de las propiedades" — acá cualquier zona ya
cumple ese rol, sin costo extra).
"""

import uuid

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


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()


def _datos_lote(manzana, offset, *, estado, precio_usd, sector):
    return {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": estado,
        "precio_usd": precio_usd,
        "sector": sector,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.150000 + offset, "lat": -32.480000},
                {"lon": -65.149780 + offset, "lat": -32.480000},
                {"lon": -65.149780 + offset, "lat": -32.480200},
                {"lon": -65.150000 + offset, "lat": -32.480200},
                {"lon": -65.150000 + offset, "lat": -32.480000},
            ],
        },
    }


def test_resumen_por_zona_desglosa_inventario_y_precio_promedio(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    zona = f"ZonaResumenTest-{marcador}"
    disponible = crear_lote_de_prueba(_datos_lote("RESZ-1", 0, estado="disponible", precio_usd=10000, sector=zona))
    reservado = crear_lote_de_prueba(_datos_lote("RESZ-2", 0.001, estado="reservado", precio_usd=20000, sector=zona))
    vendido = crear_lote_de_prueba(_datos_lote("RESZ-3", 0.002, estado="vendido", precio_usd=None, sector=zona))
    try:
        _loguearse(page, base_url)
        # El login ya abre el dashboard automático (ver formularioLogin
        # en app.js) — no hace falta navegar, alcanza con esperar a que
        # la fila de esta zona (recién sembrada) aparezca. "Resumen por
        # zona" vive dentro del <details> colapsado por default (pedido
        # explícito del usuario para no sobrecargar el Dashboard), hay
        # que abrirlo primero.
        expect(page.locator("#panel-dashboard")).to_be_visible()
        page.locator("#dashboard-metricas-detalle summary").click()

        fila = page.locator("#dashboard-precios-zona-cuerpo tr", has_text=zona)
        expect(fila).to_be_visible()
        celdas = fila.locator("td")
        expect(celdas.nth(1)).to_have_text("3")  # total
        expect(celdas.nth(2)).to_have_text("1")  # disponible
        expect(celdas.nth(3)).to_have_text("1")  # reservado
        expect(celdas.nth(4)).to_contain_text("1")  # vendido (33%)
        expect(celdas.nth(4)).to_contain_text("33%")
        expect(celdas.nth(5)).to_have_text("—")  # interesados: sin contactos, ver test aparte
        # Precio promedio: solo los 2 con precio cargado (10000+20000)/2
        expect(celdas.nth(6)).to_contain_text("USD 15.000")
    finally:
        borrar_lote_de_prueba(disponible)
        borrar_lote_de_prueba(reservado)
        borrar_lote_de_prueba(vendido)


def test_interesados_por_zona_cuenta_contactos_activos_distintos(page, base_url):
    # Idea propia #3 de "el mapa como una cualidad del CRM" — demanda
    # por zona (demandaPorZona en crm-metricas.js): un contacto
    # interesado en 2 lotes de la MISMA zona cuenta una sola vez, y un
    # contacto "perdido" no cuenta (ya no está en juego).
    marcador = uuid.uuid4().hex[:8]
    zona = f"ZonaDemandaTest-{marcador}"
    lote_a = crear_lote_de_prueba(_datos_lote("DEM-A", 0, estado="disponible", precio_usd=10000, sector=zona))
    lote_b = crear_lote_de_prueba(_datos_lote("DEM-B", 0.001, estado="disponible", precio_usd=12000, sector=zona))
    contacto_doble_interes = crear_contacto_de_prueba(
        {
            "nombre": f"DEMANDA-DOBLE-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "contactado",
            "lotes_interes": [
                {"id": lote_a, "titulo": "Manzana DEM-A — Lote 1"},
                {"id": lote_b, "titulo": "Manzana DEM-B — Lote 1"},
            ],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    contacto_simple = crear_contacto_de_prueba(
        {
            "nombre": f"DEMANDA-SIMPLE-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "nuevo",
            "lotes_interes": [{"id": lote_b, "titulo": "Manzana DEM-B — Lote 1"}],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    contacto_perdido = crear_contacto_de_prueba(
        {
            "nombre": f"DEMANDA-PERDIDO-{marcador}",
            "telefono": None,
            "email": None,
            "estado": "perdido",
            "motivo_perdido": "Ya no le interesa",
            "lotes_interes": [{"id": lote_a, "titulo": "Manzana DEM-A — Lote 1"}],
            "actividades": [],
            "asignado_a": _uid_de_prueba(),
        }
    )
    try:
        _loguearse(page, base_url)
        expect(page.locator("#panel-dashboard")).to_be_visible()
        page.locator("#dashboard-metricas-detalle summary").click()

        fila = page.locator("#dashboard-precios-zona-cuerpo tr", has_text=zona)
        expect(fila).to_be_visible()
        # 2 contactos activos distintos cuentan para esta zona (el
        # "doble interés" en 2 lotes de la misma zona no duplica al
        # primero), y el perdido no suma nada.
        expect(fila.locator("td").nth(5)).to_have_text("2")
    finally:
        borrar_contacto_de_prueba(contacto_doble_interes)
        borrar_contacto_de_prueba(contacto_simple)
        borrar_contacto_de_prueba(contacto_perdido)
        borrar_lote_de_prueba(lote_a)
        borrar_lote_de_prueba(lote_b)
