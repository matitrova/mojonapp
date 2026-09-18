"""
Tests de las reglas de las tareas (js/tareas.js).

QUÉ PROTEGEN. Una pantalla de tareas se juzga por una sola cosa: si lo
urgente aparece arriba y lo cumplido no molesta. Los errores que la
arruinan son de reglas, no de dibujo:

  - una tarea hecha que sigue contando como vencida (el corredor ve
    atrasos que no existen y deja de creerle a la pantalla);
  - comparar fechas como instantes y no como días, que hace que "vence
    hoy" dependa de la hora y de la zona horaria;
  - un orden inestable, que hace saltar la lista entre recargas;
  - textos como "vence en 1 días".

Todo esto se decide sin Firestore y sin navegador, así que se testea
directo.
"""

import pytest
from playwright.sync_api import expect  # noqa: F401  (consistencia con el resto de la suite)

HOY = "2026-09-18"


def _evaluar(page, base_url, expresion, *args):
    page.goto(base_url)
    return page.evaluate(
        "(args) => import('/js/tareas.js').then((m) => (" + expresion + "))",
        list(args),
    )


def _tarea(titulo, vence, hecha=False, asignado=None, email=None):
    return {
        "titulo": titulo,
        "vence": vence,
        "hecha": hecha,
        "asignado_a": asignado,
        "asignado_email": email,
        "tipo": "llamar",
    }


def test_una_tarea_hecha_no_cuenta_como_vencida(page, base_url):
    """El error que haría desconfiar de toda la pantalla.

    Una tarea cumplida la semana pasada tiene fecha vieja, pero no es un
    atraso: mostrarla en rojo junto a lo realmente pendiente hace que el
    corredor deje de mirar el color.
    """
    grupos = _evaluar(
        page,
        base_url,
        "m.clasificarPorVencimiento(args[0], args[1])",
        [_tarea("Llamar a Pérez", "2026-09-10", hecha=True)],
        HOY,
    )
    assert grupos["vencidas"] == []
    assert len(grupos["hechas"]) == 1


def test_separa_vencidas_de_hoy_y_proximas(page, base_url):
    grupos = _evaluar(
        page,
        base_url,
        "m.clasificarPorVencimiento(args[0], args[1])",
        [
            _tarea("Vieja", "2026-09-15"),
            _tarea("De hoy", HOY),
            _tarea("Futura", "2026-09-25"),
        ],
        HOY,
    )
    assert [t["titulo"] for t in grupos["vencidas"]] == ["Vieja"]
    assert [t["titulo"] for t in grupos["hoy"]] == ["De hoy"]
    assert [t["titulo"] for t in grupos["proximas"]] == ["Futura"]


def test_una_tarea_sin_fecha_no_es_vencida(page, base_url):
    """Sin fecha no se puede afirmar que esté atrasada: va a próximas."""
    grupos = _evaluar(
        page, base_url, "m.clasificarPorVencimiento(args[0], args[1])", [_tarea("Sin fecha", None)], HOY
    )
    assert grupos["vencidas"] == []
    assert len(grupos["proximas"]) == 1


def test_el_orden_es_estable_a_igual_fecha(page, base_url):
    """Dos tareas del mismo día tienen que salir siempre en el mismo orden.

    Si no, la lista se reordena sola entre recargas y se pierde de vista
    lo que se estaba mirando.
    """
    primera = _evaluar(
        page,
        base_url,
        "m.ordenarTareas(args[0]).map((t) => t.titulo)",
        [_tarea("Zeta", HOY), _tarea("Alfa", HOY), _tarea("Mario", HOY)],
    )
    segunda = _evaluar(
        page,
        base_url,
        "m.ordenarTareas(args[0]).map((t) => t.titulo)",
        [_tarea("Mario", HOY), _tarea("Zeta", HOY), _tarea("Alfa", HOY)],
    )
    assert primera == segunda == ["Alfa", "Mario", "Zeta"]


@pytest.mark.parametrize(
    "vence,esperado",
    [
        ("2026-09-18", "Vence hoy"),
        ("2026-09-17", "Venció ayer"),
        ("2026-09-15", "Vencida hace 3 días"),
        ("2026-09-19", "Vence mañana"),
        ("2026-09-23", "Vence en 5 días"),
        (None, "Sin fecha"),
    ],
)
def test_el_texto_de_vencimiento_se_lee_bien(page, base_url, vence, esperado):
    """Incluidos los singulares: "vence en 1 días" delata descuido."""
    assert _evaluar(page, base_url, "m.textoDeVencimiento(args[0], args[1])", _tarea("X", vence), HOY) == esperado


def test_una_tarea_hecha_dice_hecha_aunque_este_vencida(page, base_url):
    assert (
        _evaluar(
            page, base_url, "m.textoDeVencimiento(args[0], args[1])", _tarea("X", "2026-09-01", hecha=True), HOY
        )
        == "Hecha"
    )


def test_el_resumen_por_responsable_solo_cuenta_lo_pendiente(page, base_url):
    """Mezclar lo hecho con lo pendiente daría un número que no dice si
    alguien está al día o desbordado."""
    filas = _evaluar(
        page,
        base_url,
        "m.resumenPorResponsable(args[0], args[1])",
        [
            _tarea("A", "2026-09-10", asignado="santi", email="santi@x.com"),
            _tarea("B", "2026-09-11", asignado="santi", email="santi@x.com"),
            _tarea("C", HOY, asignado="santi", email="santi@x.com"),
            _tarea("D", "2026-09-01", hecha=True, asignado="santi", email="santi@x.com"),
            _tarea("E", HOY, asignado="mati", email="mati@x.com"),
        ],
        HOY,
    )
    por_uid = {f["uid"]: f for f in filas}
    assert por_uid["santi"]["vencidas"] == 2
    assert por_uid["santi"]["hoy"] == 1
    assert por_uid["santi"]["hechas"] == 1
    assert por_uid["mati"]["vencidas"] == 0
    # El que más atraso tiene va primero: es a quien hay que mirar.
    assert filas[0]["uid"] == "santi"


def test_las_tareas_sin_responsable_no_se_pierden(page, base_url):
    """Una tarea sin asignar tiene que verse igual, no desaparecer del
    resumen — si no, nadie se entera de que quedó huérfana."""
    filas = _evaluar(
        page, base_url, "m.resumenPorResponsable(args[0], args[1])", [_tarea("Huérfana", "2026-09-10")], HOY
    )
    assert len(filas) == 1
    assert filas[0]["uid"] == "__sin_asignar__"
    assert filas[0]["vencidas"] == 1


def test_no_se_guarda_una_tarea_sin_titulo_ni_fecha(page, base_url):
    errores = _evaluar(page, base_url, "m.validarTarea({})")
    assert len(errores) == 2
    assert any("título" in e for e in errores)
    assert any("fecha" in e for e in errores)


def test_un_tipo_inventado_no_pasa(page, base_url):
    """Los tipos son una lista cerrada: uno inventado dejaría una tarea
    sin ícono ni etiqueta en la pantalla."""
    errores = _evaluar(page, base_url, "m.validarTarea(args[0])", {"titulo": "X", "vence": HOY, "tipo": "bailar"})
    assert len(errores) == 1 and "bailar" in errores[0]


def test_una_tarea_valida_no_tiene_errores(page, base_url):
    assert _evaluar(page, base_url, "m.validarTarea(args[0])", {"titulo": "Llamar", "vence": HOY, "tipo": "llamar"}) == []


def test_el_dia_no_depende_de_la_hora_del_navegador(page, base_url):
    """Una tarea vence un DÍA, no un instante.

    Comparando con Date, la misma tarea se vería vencida o no según la
    hora y el huso del navegador. Acá se compara el texto AAAA-MM-DD, así
    que el 18 es el 18 en todos lados.
    """
    formato = _evaluar(page, base_url, "m.diaComoTexto()")
    assert len(formato) == 10 and formato[4] == "-" and formato[7] == "-"
    # Medianoche y un minuto antes de medianoche del MISMO día dan lo mismo.
    dos = _evaluar(
        page,
        base_url,
        "[m.diaComoTexto(new Date(2026, 8, 18, 0, 0)), m.diaComoTexto(new Date(2026, 8, 18, 23, 59))]",
    )
    assert dos[0] == dos[1] == "2026-09-18"
