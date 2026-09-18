"""
Tests del resumen de actividad del equipo (js/actividad-equipo.js).

QUÉ PROTEGEN. Esta pantalla la mira quien tiene empleados, para saber
quién trabajó y en qué. Un número mal contado ahí no es un bug de
pantalla: es una injusticia con alguien del equipo.

Los errores que la arruinarían, cubiertos acá:

  - meter todo en un solo total, que diría que quien pasó el día
    renombrando zonas trabajó igual que quien cerró una venta;
  - contar un evento sin fecha dentro del período (los recién escritos
    pueden llegar con el timestamp del servidor sin resolver);
  - saltear los días sin actividad en el gráfico, que haría ver pareja
    una semana con un solo día de trabajo.
"""

import pytest
from playwright.sync_api import expect  # noqa: F401  (consistencia con el resto de la suite)

HOY = "2026-09-18"


def _evaluar(page, base_url, expresion, *args):
    page.goto(base_url)
    return page.evaluate(
        "(args) => import('/js/actividad-equipo.js').then((m) => (" + expresion + "))",
        list(args),
    )


def _evento(accion, quien, dia=HOY):
    return {"accion": accion, "usuario_email": quien, "fecha": f"{dia}T14:00:00.000Z"}


@pytest.mark.parametrize(
    "accion,categoria",
    [
        ("mover_contacto", "venta"),
        ("vender_lote", "venta"),
        ("crear_lote", "cartera"),
        ("editar_lotes_en_masa", "cartera"),
        ("completar_tarea", "tareas"),
        ("editar_zona", "mantenimiento"),
    ],
)
def test_cada_accion_cae_en_su_categoria(page, base_url, accion, categoria):
    assert _evaluar(page, base_url, "m.categoriaDe(args[0])", accion) == categoria


def test_una_accion_desconocida_cae_en_mantenimiento(page, base_url):
    """Es preferible subestimar el trabajo comercial de alguien a
    inflarlo con acciones que nadie clasificó."""
    assert _evaluar(page, base_url, "m.categoriaDe('accion_del_futuro')") == "mantenimiento"


def test_el_resumen_separa_venta_de_mantenimiento(page, base_url):
    """El test central: un solo total mentiría sobre quién hizo qué."""
    filas = _evaluar(
        page,
        base_url,
        "m.resumenPorPersona(args[0])",
        [
            _evento("mover_contacto", "santi@x.com"),
            _evento("vender_lote", "santi@x.com"),
            _evento("editar_zona", "mati@x.com"),
            _evento("editar_zona", "mati@x.com"),
            _evento("editar_zona", "mati@x.com"),
        ],
    )
    por_persona = {f["persona"]: f for f in filas}
    assert por_persona["santi@x.com"]["venta"] == 2
    assert por_persona["santi@x.com"]["mantenimiento"] == 0
    assert por_persona["mati@x.com"]["mantenimiento"] == 3
    assert por_persona["mati@x.com"]["venta"] == 0
    # Ordena por total: mati hizo más eventos aunque ninguno sea de venta.
    assert filas[0]["persona"] == "mati@x.com"


def test_un_evento_sin_fecha_no_entra_en_el_periodo(page, base_url):
    """Los eventos recién escritos pueden llegar sin el timestamp del
    servidor resuelto. No se les puede afirmar el día."""
    eventos = [_evento("crear_lote", "santi@x.com"), {"accion": "crear_lote", "usuario_email": "santi@x.com"}]
    del_periodo = _evaluar(page, base_url, "m.eventosDelPeriodo(args[0], 1, args[1])", eventos, HOY)
    assert len(del_periodo) == 1


def test_el_periodo_de_un_dia_es_solo_hoy(page, base_url):
    eventos = [_evento("crear_lote", "a@x.com", HOY), _evento("crear_lote", "a@x.com", "2026-09-17")]
    assert len(_evaluar(page, base_url, "m.eventosDelPeriodo(args[0], 1, args[1])", eventos, HOY)) == 1
    assert len(_evaluar(page, base_url, "m.eventosDelPeriodo(args[0], 7, args[1])", eventos, HOY)) == 2


def test_los_dias_sin_actividad_aparecen_en_cero(page, base_url):
    """Saltearlos haría ver pareja una semana con un solo día de trabajo."""
    filas = _evaluar(
        page,
        base_url,
        "m.actividadPorDia(args[0], 7, args[1])",
        [_evento("crear_lote", "a@x.com", "2026-09-16")],
        HOY,
    )
    assert len(filas) == 7
    assert filas[-1]["dia"] == HOY
    assert sum(f["cantidad"] for f in filas) == 1
    assert sum(1 for f in filas if f["cantidad"] == 0) == 6


def test_el_resumen_en_palabras_maneja_los_singulares(page, base_url):
    una = _evaluar(page, base_url, "m.resumenEnPalabras(args[0])", {"venta": 1, "cartera": 0, "tareas": 1, "mantenimiento": 0})
    assert una == "1 movimiento de venta, 1 tarea"

    varias = _evaluar(page, base_url, "m.resumenEnPalabras(args[0])", {"venta": 3, "cartera": 2, "tareas": 0, "mantenimiento": 0})
    assert varias == "3 movimientos de venta, 2 cambios en la cartera"


def test_sin_actividad_lo_dice_en_vez_de_quedar_vacio(page, base_url):
    assert (
        _evaluar(page, base_url, "m.resumenEnPalabras(args[0])", {"venta": 0, "cartera": 0, "tareas": 0, "mantenimiento": 0})
        == "Sin actividad"
    )


def test_entiende_la_fecha_venga_como_venga(page, base_url):
    """Firestore devuelve un Timestamp con toDate(); los datos de prueba,
    texto ISO. Las dos formas tienen que dar el mismo día."""
    dias = _evaluar(
        page,
        base_url,
        """[
             m.diaDelEvento({ fecha: '2026-09-18T14:00:00.000Z' }),
             m.diaDelEvento({ fecha: { toDate: () => new Date('2026-09-18T14:00:00.000Z') } }),
             m.diaDelEvento({ fecha: 'no es una fecha' }),
             m.diaDelEvento({})
           ]""",
    )
    assert dias[0] == dias[1] == "2026-09-18"
    assert dias[2] is None and dias[3] is None
