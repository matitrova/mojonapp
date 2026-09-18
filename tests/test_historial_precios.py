"""El historial de precios de un lote (js/historial-precios.js).

PARA QUÉ EXISTE. Tres tarjetas del Dashboard —valor en pipeline y las
dos de comisión— no se pueden comparar contra el mes anterior porque
dependen del precio de cada lote, y un lote solo guardaba su precio
actual. El valor de hace un mes se calcularía con los precios de hoy: un
número que nunca existió, en las tarjetas que se miran para decidir.
Decisión del usuario el 2026-09-18: empezar a guardar el historial y
mostrar esas comparaciones cuando haya un mes, en vez de aproximar.

Los dos errores que este módulo no puede cometer:

  1. Registrar una entrada cuando NO cambió el precio. Guardar el
     formulario sin tocar el precio es lo más frecuente que pasa; si eso
     dejara rastro, el historial sería una lista de cuántas veces
     alguien abrió el formulario, no de cuánto valió el lote.
  2. Devolver el precio de HOY para una fecha en la que no se lo
     conocía. Es exactamente el número inventado que este historial
     existe para evitar.
"""

import pytest

MODULO = "/js/historial-precios.js"
CUANDO = "2026-09-18T10:00:00.000Z"


@pytest.fixture
def evaluar(page, base_url):
    page.goto(base_url)

    def _correr(expresion, *args):
        return page.evaluate(
            f"""(args) => import('{MODULO}').then((m) => {{ const f = {expresion}; return f(m, ...args); }})""",
            list(args),
        )

    return _correr


# --- Cuándo se registra y cuándo no --------------------------------------


def test_un_cambio_de_precio_se_registra(evaluar):
    h = evaluar(
        "(m, antes, ahora, hist, cuando) => m.historialTrasCambio(antes, ahora, hist, cuando)",
        20000, 25000, [], CUANDO,
    )
    assert h == [{"precio_usd": 25000, "fecha": CUANDO}]


def test_guardar_sin_tocar_el_precio_no_registra_nada(evaluar):
    """EL CASO MÁS FRECUENTE. Si esto registrara, el historial contaría
    ediciones del formulario y no cambios de precio."""
    h = evaluar(
        "(m, antes, ahora, hist, cuando) => m.historialTrasCambio(antes, ahora, hist, cuando)",
        20000, 20000, [{"precio_usd": 20000, "fecha": "2026-08-01T10:00:00.000Z"}], CUANDO,
    )
    assert h is None


def test_el_mismo_precio_escrito_como_texto_tampoco_registra(evaluar):
    """El formulario devuelve strings. "20000" y 20000 son el mismo
    precio, y registrar un cambio ahí sería registrar un cambio de tipo
    de dato."""
    h = evaluar(
        "(m, antes, ahora, hist, cuando) => m.historialTrasCambio(antes, ahora, hist, cuando)",
        20000, "20000", [], CUANDO,
    )
    assert h is None


def test_el_primer_precio_de_un_lote_se_registra(evaluar):
    """Es el punto de partida de cualquier comparación futura."""
    h = evaluar(
        "(m, antes, ahora, hist, cuando) => m.historialTrasCambio(antes, ahora, hist, cuando)",
        None, 18000, None, CUANDO,
    )
    assert h == [{"precio_usd": 18000, "fecha": CUANDO}]


def test_borrar_el_precio_tambien_se_registra(evaluar):
    """"Dejó de tener precio" es un hecho del negocio: se sacó de la
    venta. Perderlo dejaría el historial diciendo que todavía vale lo de
    antes."""
    h = evaluar(
        "(m, antes, ahora, hist, cuando) => m.historialTrasCambio(antes, ahora, hist, cuando)",
        20000, None, [{"precio_usd": 20000, "fecha": "2026-08-01T10:00:00.000Z"}], CUANDO,
    )
    assert h[-1] == {"precio_usd": None, "fecha": CUANDO}


def test_se_conserva_lo_que_ya_estaba(evaluar):
    h = evaluar(
        "(m, antes, ahora, hist, cuando) => m.historialTrasCambio(antes, ahora, hist, cuando)",
        20000, 25000,
        [{"precio_usd": 15000, "fecha": "2026-06-01T10:00:00.000Z"},
         {"precio_usd": 20000, "fecha": "2026-08-01T10:00:00.000Z"}],
        CUANDO,
    )
    assert len(h) == 3
    assert h[0]["precio_usd"] == 15000


def test_no_muta_el_historial_que_recibe(evaluar):
    """Si lo mutara, el lote en memoria quedaría con la entrada nueva
    aunque el guardado en Firestore falle: la pantalla mostraría un
    historial que la base no tiene."""
    resultado = evaluar(
        """(m, cuando) => {
             const original = [{ precio_usd: 15000, fecha: '2026-06-01T10:00:00.000Z' }];
             m.historialTrasCambio(15000, 20000, original, cuando);
             return original.length;
           }""",
        CUANDO,
    )
    assert resultado == 1


# --- El precio en una fecha pasada ---------------------------------------


HISTORIAL = [
    {"precio_usd": 15000, "fecha": "2026-06-01T10:00:00.000Z"},
    {"precio_usd": 20000, "fecha": "2026-08-15T10:00:00.000Z"},
    {"precio_usd": 25000, "fecha": "2026-09-10T10:00:00.000Z"},
]


def test_devuelve_el_precio_vigente_en_esa_fecha(evaluar):
    """Al cierre de agosto valía 20.000, no los 25.000 de hoy."""
    p = evaluar(
        "(m, lote, corte) => m.precioEnLaFecha(lote, new Date(corte))",
        {"historial_precios": HISTORIAL}, "2026-08-31T23:59:59.999Z",
    )
    assert p == 20000


def test_antes_de_la_primera_entrada_no_se_conocia_el_precio(evaluar):
    """null y no 15000: en mayo todavía no se le había puesto precio."""
    p = evaluar(
        "(m, lote, corte) => m.precioEnLaFecha(lote, new Date(corte))",
        {"historial_precios": HISTORIAL}, "2026-05-01T10:00:00.000Z",
    )
    assert p is None


def test_un_lote_sin_historial_no_tiene_pasado(evaluar):
    """LA DECISIÓN IMPORTANTE. Los lotes cargados antes de que esto
    existiera tienen precio hoy pero no pasado. Usar el precio actual
    como si hubiera sido el de hace un mes es el número inventado que
    todo esto existe para evitar."""
    p = evaluar(
        "(m, lote, corte) => m.precioEnLaFecha(lote, new Date(corte))",
        {"precio_usd": 30000}, "2026-08-31T23:59:59.999Z",
    )
    assert p is None


def test_las_entradas_desordenadas_se_resuelven_igual(evaluar):
    """Un array de Firestore no garantiza orden."""
    p = evaluar(
        "(m, lote, corte) => m.precioEnLaFecha(lote, new Date(corte))",
        {"historial_precios": [HISTORIAL[2], HISTORIAL[0], HISTORIAL[1]]},
        "2026-08-31T23:59:59.999Z",
    )
    assert p == 20000


def test_un_precio_borrado_en_el_pasado_devuelve_null(evaluar):
    """Se sacó de la venta en julio: en agosto no tenía precio."""
    p = evaluar(
        "(m, lote, corte) => m.precioEnLaFecha(lote, new Date(corte))",
        {"historial_precios": [
            {"precio_usd": 15000, "fecha": "2026-06-01T10:00:00.000Z"},
            {"precio_usd": None, "fecha": "2026-07-01T10:00:00.000Z"},
        ]},
        "2026-08-31T23:59:59.999Z",
    )
    assert p is None
