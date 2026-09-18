"""
Tests de Playwright (pytest) para el CRM (js/crm.js): contactos + pipeline
visual. Mismo criterio que el resto de la suite (ver test_lotes.py y
conftest.py): corre contra el proyecto real de Firebase (no hay emulador en
esta máquina), así que cada test siembra y borra sus propios datos.

Cubren: crear un contacto desde el panel y verlo en la columna "Nuevo",
moverlo de etapa con el selector de la tarjeta (y que quede reflejado tanto
en el pipeline como en Firestore), que "Agregar interesado" en la ficha de
un lote (js/ficha.js) alimente el CRM automáticamente, registrar una
actividad y un seguimiento, pedir el motivo al perder un contacto desde el
kanban, que el toggle "Mis contactos"/"Todos" esté visible para root, que
"Exportar CSV" dispare una descarga real, y que un contacto de otro
corredor se identifique como tal (y solo aparezca) en la vista "Todos".
"""

import uuid
from datetime import date

import pytest
from playwright.sync_api import expect

from conftest import (
    LOTE_PRUEBA_DATOS,
    borrar_contacto_de_prueba,
    borrar_usuario_de_prueba,
    buscar_contacto_doc_id_por_nombre,
    crear_contacto_de_prueba,
    crear_usuario_de_prueba,
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
    # Mismo motivo que en test_lotes.py: el login abre el dashboard
    # automático y tapa el resto de la UI.


def _abrir_crm(page):
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()


def test_crear_contacto_y_verlo_en_la_columna_nuevo(page, base_url):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-guardar-btn").click()

        columna_nuevo = page.locator('[data-testid="crm-columna-nuevo"]')
        expect(columna_nuevo.locator(".crm-tarjeta", has_text=nombre)).to_have_count(1)

        # Se busca en Firestore DESPUÉS de la aserción del pipeline a
        # propósito (mismo criterio que test_corredor_logueado_puede_
        # cargar_un_lote): si la aserción fallara con esto al revés, el
        # "finally" nunca llegaría a limpiar el contacto creado.
        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None, "El contacto creado no apareció en Firestore."
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)


def test_mover_contacto_actualiza_la_columna(page, base_url):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator(".crm-tarjeta", has_text=nombre)).to_have_count(1)

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta).to_be_visible()
        tarjeta.locator("select").select_option("contactado")

        expect(
            page.locator('[data-testid="crm-columna-contactado"]').locator(".crm-tarjeta", has_text=nombre)
        ).to_have_count(1)
        expect(
            page.locator('[data-testid="crm-columna-nuevo"]').locator(".crm-tarjeta", has_text=nombre)
        ).to_have_count(0)
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)


def test_agregar_interesado_alimenta_el_crm(page, base_url, lote_sembrado):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    telefono = f"11{uuid.uuid4().int % 10**8:08d}"
    doc_id_contacto = None
    try:
        _loguearse(page, base_url)

        # Mismo patrón que abrir_ficha_desde_lista en test_lotes.py: entra
        # por "Ver como lista" en vez de tocar el polígono en el mapa, para
        # no depender de dónde haya quedado encuadrado el mapa.
        page.locator("#btn-menu").click()
        page.locator("#btn-ver-lista").click()
        soltar_el_mouse(page)
        page.locator("#filtro-cantidad").select_option("0")
        page.locator(f'tr[data-lote-id="{lote_sembrado["doc_id"]}"]').click()

        page.locator("#interesado-nombre").fill(nombre)
        page.locator("#interesado-telefono").fill(telefono)
        page.locator("[data-testid='interesado-guardar']").click()
        expect(page.locator("#lista-interesados")).to_contain_text(nombre)

        # crearContactoDesdeInteresado (js/crm.js) es fire-and-forget — no
        # bloquea el guardado del interesado, así que puede terminar un
        # instante después de que la UI ya muestra el interesado guardado.
        doc_id_contacto = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id_contacto is not None, "Agregar interesado no creó el contacto en el CRM."

        page.locator("#cerrar-ficha").click()
        _abrir_crm(page)
        # "Todos", no "Mis contactos": el reparto automático de interesados
        # nuevos (siguienteAsignado en crm.js) puede terminar asignándolo a
        # OTRO corredor del equipo real (hay más de uno en este proyecto),
        # no necesariamente a quien lo cargó.
        page.locator("#btn-crm-vista-todas").click()
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id_contacto}"]')
        expect(tarjeta).to_be_visible()
        expect(tarjeta).to_contain_text(f"Manzana {LOTE_PRUEBA_DATOS['manzana']} — Lote {LOTE_PRUEBA_DATOS['lote']}")
    finally:
        if doc_id_contacto:
            borrar_contacto_de_prueba(doc_id_contacto)


def test_agregar_actividad_y_seguimiento_para_hoy(page, base_url):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator(".crm-tarjeta", has_text=nombre)).to_have_count(1)

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]').click()

        # La actividad quedó en la pestaña "Actividad" (ver Parte B del
        # timeline unificado + formulario en pestañas). Se guarda con su
        # propio botón, no con "Guardar" del resto del formulario (ver
        # elBtnAgregarActividad en js/crm-formulario.js).
        page.locator("#crm-tab-actividad").click()
        page.locator("#actividad-tipo").select_option("llamada")
        page.locator("#actividad-texto").fill("Llamada de prueba, pidió más fotos.")
        page.locator("#btn-agregar-actividad").click()
        expect(page.locator("#crm-lista-actividades")).to_contain_text("Llamada de prueba, pidió más fotos.")
        # El campo de texto se limpia después de agregar, para poder
        # cargar la próxima sin arrastrar la anterior.
        expect(page.locator("#actividad-texto")).to_have_value("")

        # "Próximo seguimiento" está en la pestaña "Datos" → tiene que
        # aparecer en la sección "Seguimientos" del pipeline al volver.
        page.locator("#crm-tab-datos").click()
        page.locator("#contacto-seguimiento").fill(date.today().isoformat())
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator("#crm-vista-kanban")).to_be_visible()
        expect(page.locator("#crm-seguimientos")).to_contain_text(nombre)
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)


def test_mover_a_perdido_pide_motivo_y_lo_guarda(page, base_url):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    motivo = "Se fue con otra inmobiliaria"
    doc_id = None
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator(".crm-tarjeta", has_text=nombre)).to_have_count(1)

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        # moverContacto() (js/crm.js) pide el motivo con window.prompt()
        # solo al mover a "Perdido" — Playwright intercepta el diálogo
        # nativo con page.on("dialog", ...), no hay otra forma de
        # responderlo desde un test.
        page.on("dialog", lambda dialog: dialog.accept(motivo))
        page.locator(f'[data-testid="crm-tarjeta-{doc_id}"] select').select_option("perdido")

        expect(
            page.locator('[data-testid="crm-columna-perdido"]').locator(".crm-tarjeta", has_text=nombre)
        ).to_have_count(1)

        page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]').click()
        expect(page.locator("#contacto-motivo-perdido")).to_have_value(motivo)
        # El campo solo se muestra con estado "Perdido" (ver
        # actualizarVisibilidadMotivoPerdido en js/crm.js).
        expect(page.locator("#crm-campo-motivo-perdido")).to_be_visible()
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)


def test_toggle_ver_todos_visible_para_root(page, base_url):
    _loguearse(page, base_url)
    _abrir_crm(page)
    # La cuenta de prueba es root (ver tests/.env): tiene que ver el
    # toggle "Mis contactos"/"Todos" — un corredor sin
    # "ver_todos_los_contactos" no lo vería (queda oculto, ver
    # elBtnAbrir en js/crm.js).
    expect(page.locator("#crm-filtro-vista")).to_be_visible()
    expect(page.locator("#btn-crm-vista-mias")).to_have_class("activo")


def test_exportar_csv_dispara_descarga(page, base_url):
    _loguearse(page, base_url)
    _abrir_crm(page)
    with page.expect_download() as descarga_info:
        page.locator("#btn-exportar-contactos").click()
    descarga = descarga_info.value
    assert descarga.suggested_filename.startswith("contactos-mojonapp-")


def test_contacto_de_otro_corredor_solo_aparece_en_todos(page, base_url):
    # "asignado_a" de un uid que no es el de la cuenta de prueba: simula
    # la cartera de OTRO corredor sin necesitar una segunda cuenta real
    # (ver crear_contacto_de_prueba en conftest.py).
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    doc_id = crear_contacto_de_prueba(
        {
            "nombre": nombre,
            "telefono": None,
            "email": None,
            "estado": "nuevo",
            "motivo_perdido": None,
            "proximo_seguimiento": None,
            "lotes_interes": [],
            "actividades": [],
            "asignado_a": "uid-de-otro-corredor-inexistente",
            "fecha_creacion": "2026-01-01T00:00:00.000Z",
            "fecha_actualizacion": "2026-01-01T00:00:00.000Z",
        }
    )
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        # "Mis contactos" (default al abrir el panel): no es mío, no
        # tiene que aparecer.
        expect(page.locator(".crm-tarjeta", has_text=nombre)).to_have_count(0)

        page.locator("#btn-crm-vista-todas").click()
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta).to_be_visible()
        # Uid inexistente en "usuarios" → cae al texto genérico
        # (textoAsignado en js/crm.js), no revienta ni lo deja en blanco.
        expect(tarjeta).to_contain_text("Otro corredor")

        tarjeta.click()
        # Con "ver_todos_los_contactos" (root), "Asignado a" es un
        # <select> editable, no un texto de solo lectura — el uid
        # inexistente entra como opción aparte (mismo criterio que
        # poblarSelectCatalogo en catalogos.js), no se pierde ni revienta.
        expect(page.locator("#crm-campo-asignado")).to_be_visible()
        select_asignado = page.locator("#contacto-asignado")
        expect(select_asignado).to_have_value("uid-de-otro-corredor-inexistente")
        expect(select_asignado).to_contain_text("usuario no encontrado")
    finally:
        borrar_contacto_de_prueba(doc_id)


def test_reasignar_contacto_a_otro_corredor(page, base_url):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    otro_uid = f"uid-test-{uuid.uuid4().hex[:8]}"
    otro_email = f"otro-{uuid.uuid4().hex[:6]}@mojonapp.local"
    doc_id = None
    # Segundo corredor de prueba, autocontenido — no depende de qué
    # usuarios reales haya cargados hoy en este proyecto (ver
    # crear_usuario_de_prueba en conftest.py).
    crear_usuario_de_prueba(otro_uid, otro_email)
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator(".crm-tarjeta", has_text=nombre)).to_have_count(1)

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]').click()
        page.locator("#contacto-asignado").select_option(otro_uid)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator("#crm-vista-kanban")).to_be_visible()

        # Reasignado fuera de uno mismo: ya no tiene que aparecer en "Mis
        # contactos" (default), pero sí en "Todos", ahora con el email
        # del nuevo dueño.
        expect(page.locator(".crm-tarjeta", has_text=nombre)).to_have_count(0)
        page.locator("#btn-crm-vista-todas").click()
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta).to_be_visible()
        expect(tarjeta).to_contain_text(otro_email)
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)
        borrar_usuario_de_prueba(otro_uid)
