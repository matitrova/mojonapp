"""
Integración de la pantalla de Tareas.

Las reglas puras ya están cubiertas en test_tareas.py. Acá se prueba el
camino completo: crear una tarea desde la pantalla, que aparezca en el
grupo que le toca, marcarla hecha y que se mueva.

POR QUÉ IMPORTA MARCAR HECHA. Es la única acción que se usa todos los
días, y la que revela si la clasificación anda: una tarea vencida que al
completarse sigue apareciendo en "Vencidas" convierte la pantalla en
ruido que nadie mira.
"""

import uuid

import pytest
import requests
from playwright.sync_api import expect

from conftest import FIRESTORE_RAIZ, _id_token_de_prueba, soltar_el_mouse

pytestmark = pytest.mark.con_sesion


def _borrar_tarea(doc_id):
    """Limpieza por REST. El borrado funciona aunque las LECTURAS por REST
    estén con la cuota agotada (comprobado el 2026-09-18: POST y DELETE
    daban 200 y GET daba 429)."""
    requests.delete(
        f"{FIRESTORE_RAIZ}/tareas/{doc_id}",
        headers={"Authorization": f"Bearer {_id_token_de_prueba()}"},
        timeout=15,
    )


def _abrir_tareas(page, base_url):
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    # Con sesión la app aterriza en el Dashboard, que tapa el menú.
    page.locator("#cerrar-panel-dashboard").click()
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-tareas").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-tareas")).to_be_visible()


def _id_de_la_tarea(page, titulo):
    """El id del documento, leyendo del estado de la pantalla."""
    return page.evaluate(
        """(titulo) => {
             const fila = [...document.querySelectorAll('.tarea-fila')]
               .find((f) => f.querySelector('.tarea-titulo').textContent.includes(titulo));
             return fila ? fila.dataset.testid.replace('tarea-', '') : null;
           }""",
        titulo,
    )


def test_crear_una_tarea_y_verla_en_el_grupo_que_le_toca(page, base_url):
    titulo = f"Llamar a TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _abrir_tareas(page, base_url)
        page.locator("#btn-nueva-tarea").click()
        page.locator("#tarea-titulo").fill(titulo)
        page.locator("#tarea-tipo").select_option("llamar")
        # La fecha viene con hoy puesta: se deja, así cae en "Para hoy".
        page.locator("#tarea-guardar").click()

        expect(page.locator("[data-testid='tareas-grupo-hoy']")).to_contain_text(titulo)
        expect(page.locator("#tareas-vacio")).to_be_hidden()
        doc_id = _id_de_la_tarea(page, titulo)
        assert doc_id, "la tarea no quedó en la pantalla"
    finally:
        if doc_id:
            _borrar_tarea(doc_id)


def test_completar_una_tarea_la_saca_de_lo_pendiente(page, base_url):
    """El recorrido de todos los días: crear, hacer, tildar."""
    titulo = f"Visitar TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _abrir_tareas(page, base_url)
        page.locator("#btn-nueva-tarea").click()
        page.locator("#tarea-titulo").fill(titulo)
        page.locator("#tarea-guardar").click()
        expect(page.locator("[data-testid='tareas-grupo-hoy']")).to_contain_text(titulo)

        doc_id = _id_de_la_tarea(page, titulo)
        page.locator(f"[data-testid='tarea-completar-{doc_id}']").check()

        expect(page.locator("[data-testid='tareas-grupo-hechas']")).to_contain_text(titulo)
        expect(page.locator("[data-testid='tareas-grupo-hoy']")).to_have_count(0)
    finally:
        if doc_id:
            _borrar_tarea(doc_id)


def test_no_se_guarda_una_tarea_sin_titulo(page, base_url):
    """El formulario avisa en vez de guardar una tarea que no dice nada."""
    _abrir_tareas(page, base_url)
    page.locator("#btn-nueva-tarea").click()
    page.locator("#tarea-titulo").fill("")
    page.locator("#tarea-guardar").click()
    expect(page.locator("#tarea-error")).to_be_visible()
    expect(page.locator("#tarea-error")).to_contain_text("título")


def test_la_tarea_queda_guardada_al_recargar(page, base_url):
    """Que aparezca en pantalla no prueba que se haya guardado.

    Sin recargar, la tarea podría estar solo en memoria: este test es el
    que distingue "se dibujó" de "se guardó en Firestore".
    """
    titulo = f"Escriturar TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _abrir_tareas(page, base_url)
        page.locator("#btn-nueva-tarea").click()
        page.locator("#tarea-titulo").fill(titulo)
        page.locator("#tarea-guardar").click()
        expect(page.locator("[data-testid='tareas-grupo-hoy']")).to_contain_text(titulo)
        doc_id = _id_de_la_tarea(page, titulo)

        _abrir_tareas(page, base_url)
        expect(page.locator("[data-testid='tareas-grupo-hoy']")).to_contain_text(titulo)
    finally:
        if doc_id:
            _borrar_tarea(doc_id)
