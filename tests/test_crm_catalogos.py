"""
Tests de Playwright para los catálogos del CRM: "Motivos de pérdida" y
"Etiquetas" (js/catalogos.js + los paneles en index.html).

Antes estos dos datos eran texto libre en cada contacto, así que entraban
duplicados: "precio"/"Precio" contaban como dos motivos distintos en el
Dashboard, y "urgente"/"Urgente" como dos etiquetas en el filtro del
pipeline. Ahora son catálogos con la misma fábrica que Zonas/Barrios, con
carga "lista + crear al vuelo" (se elige de la lista o se escribe uno
nuevo, que queda guardado).

OJO: estos tests escriben en las colecciones `motivos_perdida` y
`etiquetas_contacto`, así que necesitan que las reglas de Firestore de
esas dos colecciones ya estén publicadas (se pegan a mano en la consola
de Firebase, ver el bloque en el plan/README de la sesión). Sin eso van a
fallar con "No tienes permiso para administrar...", que es justamente el
comportamiento esperado de la app hasta que se publiquen.

Cada test limpia lo que crea desde la propia UI (no hace falta un helper
nuevo en conftest.py).
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import soltar_el_mouse

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion

ANCHO_ESCRITORIO = {"width": 1200, "height": 900}


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_panel(page, id_boton, id_panel):
    """El menú se expande al pasar el mouse, y Playwright deja el puntero
    en (0,0) — encima del rail — así que alcanza con abrirlo con el ☰."""
    page.locator("#btn-menu").click()
    page.locator(id_boton).click()
    soltar_el_mouse(page)
    expect(page.locator(id_panel)).to_be_visible()


def _borrar_desde_la_tabla(page, id_tabla_cuerpo, nombre):
    """Borra la fila del catálogo que tenga ese nombre. El borrado pide
    confirmación con window.confirm, que en este entorno hay que aceptar
    a mano (ver la nota del navegador de pruebas en la memoria)."""
    page.once("dialog", lambda dialog: dialog.accept())
    fila = page.locator(f"{id_tabla_cuerpo} tr", has_text=nombre)
    fila.locator(".btn-borrar-fila").click()
    expect(page.locator(id_tabla_cuerpo)).not_to_contain_text(nombre)


def test_crear_y_borrar_un_motivo_de_perdida(page, base_url):
    nombre = f"MOTIVO-{uuid.uuid4().hex[:8]}"
    _loguearse(page, base_url)
    _abrir_panel(page, "#btn-abrir-motivos", "#panel-motivos")

    page.locator("#btn-agregar-motivo").click()
    page.locator("#motivo-nombre").fill(nombre)
    page.locator("[data-testid='motivo-guardar']").click()
    expect(page.locator("#tabla-motivos-cuerpo")).to_contain_text(nombre)

    _borrar_desde_la_tabla(page, "#tabla-motivos-cuerpo", nombre)


def test_no_deja_crear_un_motivo_repetido_con_otra_capitalizacion(page, base_url):
    nombre = f"Motivo-{uuid.uuid4().hex[:8]}"
    _loguearse(page, base_url)
    _abrir_panel(page, "#btn-abrir-motivos", "#panel-motivos")

    page.locator("#btn-agregar-motivo").click()
    page.locator("#motivo-nombre").fill(nombre)
    page.locator("[data-testid='motivo-guardar']").click()
    expect(page.locator("#tabla-motivos-cuerpo")).to_contain_text(nombre)

    try:
        # Mismo nombre en minúsculas: es el duplicado que antes entraba
        # sin que nadie lo frenara.
        page.locator("#btn-agregar-motivo").click()
        page.locator("#motivo-nombre").fill(nombre.lower())
        page.locator("[data-testid='motivo-guardar']").click()
        expect(page.locator("#motivo-error")).to_be_visible()
        expect(page.locator("#motivo-error")).to_contain_text("Ya existe")
        # Y no se guardó: sigue habiendo una sola fila con ese nombre.
        page.locator("#motivo-volver").click()
        expect(page.locator("#tabla-motivos-cuerpo tr", has_text=nombre)).to_have_count(1)
    finally:
        _borrar_desde_la_tabla(page, "#tabla-motivos-cuerpo", nombre)


def test_etiqueta_escrita_en_un_contacto_queda_en_el_catalogo(page, base_url):
    """El "crear al vuelo": lo que se escribe en el formulario del
    contacto queda guardado en el catálogo para la próxima vez."""
    etiqueta = f"ETQ-{uuid.uuid4().hex[:8]}"
    _loguearse(page, base_url)

    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()
    page.locator("#btn-agregar-contacto").click()
    page.locator("#crm-tab-actividad").click()
    page.locator("#crm-input-etiqueta").fill(etiqueta)
    page.locator("#btn-agregar-etiqueta").click()
    expect(page.locator("#crm-lista-etiquetas")).to_contain_text(etiqueta)

    # Sin guardar el contacto: la etiqueta ya tiene que estar en el
    # catálogo (se registra al agregarla, no al guardar).
    page.locator("#crm-volver").click()
    try:
        _abrir_panel(page, "#btn-abrir-etiquetas-crm", "#panel-etiquetas-crm")
        expect(page.locator("#tabla-etiquetas-crm-cuerpo")).to_contain_text(etiqueta)
    finally:
        _borrar_desde_la_tabla(page, "#tabla-etiquetas-crm-cuerpo", etiqueta)


def test_el_catalogo_alimenta_el_autocompletado_del_formulario(page, base_url):
    etiqueta = f"ETQ-{uuid.uuid4().hex[:8]}"
    _loguearse(page, base_url)
    _abrir_panel(page, "#btn-abrir-etiquetas-crm", "#panel-etiquetas-crm")

    page.locator("#btn-agregar-etiqueta-crm").click()
    page.locator("#etiqueta-crm-nombre").fill(etiqueta)
    page.locator("[data-testid='etiqueta-crm-guardar']").click()
    expect(page.locator("#tabla-etiquetas-crm-cuerpo")).to_contain_text(etiqueta)

    try:
        # El <datalist> del formulario de contacto se repuebla al crear un
        # valor nuevo (refrescarDatalistsCrm en catalogos.js). Se chequea
        # el <option> por valor: un datalist no es "visible" para
        # Playwright, así que no sirve to_be_visible acá.
        expect(page.locator(f'#lista-etiquetas-crm option[value="{etiqueta}"]')).to_have_count(1)
    finally:
        _borrar_desde_la_tabla(page, "#tabla-etiquetas-crm-cuerpo", etiqueta)
