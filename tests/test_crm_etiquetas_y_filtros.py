"""
Test de Playwright para etiquetas libres + filtros combinables en el CRM
(js/crm.js) — profundizar el CRM en sí (pedido explícito del usuario:
"quiero armar un buen crm y que el mapa sea un complemento más").

Etiquetas: texto libre por contacto (no un catálogo fijo, a diferencia
de "lotes de interés"), se ven como chips en la tarjeta del kanban.
Filtros: calificación y etiqueta, combinables entre sí y con la
búsqueda de texto — solo afectan el pipeline visible, igual que la
búsqueda ya existente.
"""

import uuid
from datetime import datetime, timezone

import pytest
from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, _uid_de_prueba, abrir_menu, borrar_contacto_de_prueba, crear_contacto_de_prueba, soltar_el_mouse

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


def _datos_base(nombre, **extra):
    base = {
        "nombre": nombre,
        "telefono": None,
        "email": None,
        "estado": "nuevo",
        "motivo_perdido": None,
        "proximo_seguimiento": None,
        "lotes_interes": [],
        "actividades": [],
        "etiquetas": [],
        "asignado_a": _uid_de_prueba(),
        "fecha_creacion": "2026-09-01T00:00:00.000Z",
        "fecha_actualizacion": "2026-09-01T00:00:00.000Z",
    }
    base.update(extra)
    return base


def test_agregar_y_quitar_etiqueta_persiste(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_contacto_de_prueba(_datos_base(f"ETQ-{marcador}"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)
        page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]').click()
        # Etiquetas quedó en la pestaña "Actividad" (ver Parte B del
        # timeline unificado + formulario en pestañas).
        page.locator("#crm-tab-actividad").click()

        page.locator("#crm-input-etiqueta").fill("urgente")
        page.locator("#btn-agregar-etiqueta").click()
        expect(page.locator("#crm-lista-etiquetas")).to_contain_text("urgente")

        page.locator('[data-testid="contacto-guardar"]').click()
        expect(page.locator("#crm-vista-kanban")).to_be_visible()
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta.locator(".crm-tarjeta-etiqueta")).to_have_text("urgente")

        # Reabrir y quitarla.
        tarjeta.click()
        page.locator("#crm-tab-actividad").click()
        page.locator("#crm-lista-etiquetas .crm-chip-quitar").click()
        expect(page.locator("#crm-lista-etiquetas")).not_to_contain_text("urgente")
        page.locator('[data-testid="contacto-guardar"]').click()
        expect(page.locator(f'[data-testid="crm-tarjeta-{doc_id}"] .crm-tarjeta-etiqueta')).to_have_count(0)
    finally:
        borrar_contacto_de_prueba(doc_id)


def test_filtro_por_etiqueta_muestra_solo_coincidencias(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    con_tag_id = crear_contacto_de_prueba(_datos_base(f"ETQ-CON-{marcador}", etiquetas=[f"tag-{marcador}"]))
    sin_tag_id = crear_contacto_de_prueba(_datos_base(f"ETQ-SIN-{marcador}"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#crm-filtro-etiqueta").select_option(f"tag-{marcador}")
        expect(page.locator(f'[data-testid="crm-tarjeta-{con_tag_id}"]')).to_be_visible()
        expect(page.locator(f'[data-testid="crm-tarjeta-{sin_tag_id}"]')).to_have_count(0)
    finally:
        borrar_contacto_de_prueba(con_tag_id)
        borrar_contacto_de_prueba(sin_tag_id)


def test_filtro_por_calificacion_muestra_solo_coincidencias(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    # La fecha se calcula al momento y NO va fija: "caliente" exige, entre
    # otras señales, actividad de hace 3 días o menos (ver calificacion en
    # js/crm-metricas.js). Con una fecha escrita a mano el test funciona
    # la semana que se escribe y empieza a fallar solo cuando esa fecha
    # envejece — que es justo lo que venía pasando con "2026-09-07".
    ahora = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    caliente_id = crear_contacto_de_prueba(
        _datos_base(
            f"CALIF-CALIENTE-{marcador}",
            telefono="1122334455",
            actividades=[{"tipo": "nota", "texto": "Interesado", "fecha": ahora, "autor_email": TEST_USER_EMAIL}],
            lotes_interes=[{"id": "x", "titulo": "Lote X"}, {"id": "y", "titulo": "Lote Y"}],
            fecha_creacion=ahora,
            fecha_actualizacion=ahora,
        )
    )
    frio_id = crear_contacto_de_prueba(_datos_base(f"CALIF-FRIO-{marcador}"))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#crm-filtro-calificacion").select_option("caliente")
        expect(page.locator(f'[data-testid="crm-tarjeta-{caliente_id}"]')).to_be_visible()
        expect(page.locator(f'[data-testid="crm-tarjeta-{frio_id}"]')).to_have_count(0)
    finally:
        borrar_contacto_de_prueba(caliente_id)
        borrar_contacto_de_prueba(frio_id)
