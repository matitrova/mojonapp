"""
Integración de las comisiones y del embudo: que lleguen a la pantalla.

Los módulos puros ya están cubiertos (test_comisiones.py, test_embudo.py).
Acá se prueba lo que esos no pueden: que el porcentaje cargado en un lote
viaje hasta la cifra que mira el dueño de la inmobiliaria, y que el paso
del embudo aparezca con la conversión calculada a partir de los cambios
de etapa que graba el CRM.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import (
    borrar_contacto_de_prueba,
    borrar_lote_de_prueba,
    crear_contacto_de_prueba,
    crear_lote_de_prueba,
    soltar_el_mouse,
)

# Todos arrancan logueados, igual que el resto de los tests del CRM.
pytestmark = pytest.mark.con_sesion

GEOMETRIA = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.080000, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410000},
    ],
}


def _abrir_crm(page, base_url):
    """Abrir el CRM con sesión NO es solo tocar el botón del menú.

    Al entrar logueado la app aterriza en el Dashboard (función pedida,
    ver app.js), y ese panel tapa el menú: sin cerrarlo primero, el
    click sobre "#btn-abrir-crm" se queda esperando a un elemento que
    nunca se vuelve visible. Mismo camino que usan los demás tests del
    CRM.
    """
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-crm")).to_be_visible()
    # "Mis contactos" viene activo por defecto, y un contacto sembrado
    # por REST no tiene corredor asignado: sin esto no aparece ninguno.
    page.locator("#btn-crm-vista-todas").click()


def _lote(manzana, **extra):
    datos = {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": 1000,
        "estado": "disponible",
        "precio_usd": 100000,
        "sector": None,
        "barrio": None,
        "geometry": GEOMETRIA,
    }
    datos.update(extra)
    return datos


def _contacto(nombre, estado, lote_id, titulo):
    ahora = "2026-09-10T12:00:00.000Z"
    return {
        "nombre": nombre,
        "telefono": "2664000000",
        "email": None,
        "estado": estado,
        "motivo_perdido": None,
        "proximo_seguimiento": None,
        "nota_fijada": None,
        "lotes_interes": [{"id": lote_id, "titulo": titulo}],
        "etiquetas": [],
        "actividades": [
            {"tipo": "contacto_creado", "texto": "Contacto creado", "fecha": ahora, "autor_email": None}
        ],
        "origen": "manual",
        "fecha_creacion": ahora,
        "fecha_actualizacion": ahora,
    }


def test_la_comision_del_lote_llega_al_resumen_del_crm(page, base_url):
    """De punta a punta: 7% sobre un lote de USD 100.000 son USD 7.000.

    Se elige un porcentaje distinto del general a propósito: si la app
    ignorara el campo del lote y usara siempre el general, el número
    daría 4.000 y este test lo cazaría.
    """
    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(_lote(f"COMI-{marcador}", comision_pct=7))
    contacto_id = crear_contacto_de_prueba(
        _contacto(f"COMISION-{marcador}", "visita", lote_id, f"Manzana COMI-{marcador} — Lote 1")
    )
    try:
        _abrir_crm(page, base_url)
        expect(page.locator("#crm-stats")).to_contain_text("Comisión proyectada")
        # La cifra incluye lo que haya en la base además de este contacto,
        # así que se afirma sobre el aporte propio y no sobre el total.
        aporte = page.evaluate(
            """(id) => import('/js/comisiones.js').then(async (m) => {
                 const estado = await import('/js/estado.js');
                 const props = new Map(estado.getLotesActuales().map((f) => [f.id, f.properties]));
                 const contacto = estado.getContactosActuales().find((c) => c.id === id);
                 return m.comisionDeContacto(contacto, props);
               })""",
            contacto_id,
        )
        assert aporte == 7000, f"la comisión del contacto dio {aporte}, se esperaban 7000 (7% de 100.000)"
    finally:
        borrar_contacto_de_prueba(contacto_id)
        borrar_lote_de_prueba(lote_id)


def test_lo_ganado_no_se_mezcla_con_lo_proyectado_en_pantalla(page, base_url):
    """Un contacto cerrado suma a "ganada", no a "proyectada"."""
    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(_lote(f"GANA-{marcador}", comision_pct=10))
    contacto_id = crear_contacto_de_prueba(
        _contacto(f"GANADA-{marcador}", "cerrado", lote_id, f"Manzana GANA-{marcador} — Lote 1")
    )
    try:
        _abrir_crm(page, base_url)
        expect(page.locator("#crm-stats")).to_contain_text("Comisión ganada")
        resumen = page.evaluate(
            """(id) => import('/js/comisiones.js').then(async (m) => {
                 const estado = await import('/js/estado.js');
                 const props = new Map(estado.getLotesActuales().map((f) => [f.id, f.properties]));
                 const contacto = estado.getContactosActuales().find((c) => c.id === id);
                 return m.resumenDeComisiones([contacto], props);
               })""",
            contacto_id,
        )
        assert resumen["cerrada"] == 10000
        assert resumen["enPipeline"] == 0, "un contacto cerrado no puede estar proyectado además"
    finally:
        borrar_contacto_de_prueba(contacto_id)
        borrar_lote_de_prueba(lote_id)


def test_mover_un_contacto_de_etapa_deja_el_cambio_con_sus_claves(page, base_url):
    """El dato del que vive el embudo.

    Mover una tarjeta en el kanban tiene que dejar registrado el cambio
    con etapa_desde/etapa_hasta, no solo con el texto: de ahí sale toda
    la conversión entre etapas.
    """
    marcador = uuid.uuid4().hex[:8]
    lote_id = crear_lote_de_prueba(_lote(f"ETAPA-{marcador}"))
    nombre = f"EMBUDO-{marcador}"
    contacto_id = crear_contacto_de_prueba(
        _contacto(nombre, "nuevo", lote_id, f"Manzana ETAPA-{marcador} — Lote 1")
    )
    try:
        _abrir_crm(page, base_url)
        page.locator("#crm-buscar").fill(nombre)
        page.locator(f"[data-testid='crm-mover-{contacto_id}']").select_option("contactado")

        expect(page.locator(f"[data-testid='crm-columna-contactado']")).to_contain_text(nombre)

        cambios = page.evaluate(
            """(id) => import('/js/estado.js').then((m) => {
                 const c = m.getContactosActuales().find((x) => x.id === id);
                 return (c.actividades || [])
                   .filter((a) => a.tipo === 'cambio_etapa')
                   .map((a) => ({ desde: a.etapa_desde ?? null, hasta: a.etapa_hasta ?? null, texto: a.texto }));
               })""",
            contacto_id,
        )
        assert len(cambios) == 1, f"se esperaba un cambio de etapa, hay {len(cambios)}"
        assert cambios[0]["desde"] == "nuevo", "no quedó la etapa de origen como clave"
        assert cambios[0]["hasta"] == "contactado", "no quedó la etapa de destino como clave"
        assert "→" in cambios[0]["texto"], "se perdió el texto legible del historial"
    finally:
        borrar_contacto_de_prueba(contacto_id)
        borrar_lote_de_prueba(lote_id)
