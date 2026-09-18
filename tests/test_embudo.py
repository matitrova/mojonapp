"""
Tests del embudo de conversión (js/embudo.js).

QUÉ PROTEGEN. El embudo se calcula con las actividades que el CRM ya
grababa, y ahí está el riesgo: son datos viejos, incompletos y a veces
inconsistentes. Un embudo que muestre "0 de 3 llegaron a visita" teniendo
3 contactos en visita no es un número flojo, es un número que hace
desconfiar de toda la pantalla.

Los casos que lo romperían, todos cubiertos acá:

  - contactos SIN historial (creados desde la ficha de un lote o
    importados, que pueden nacer en cualquier etapa);
  - actividades viejas que guardaban el cambio solo como texto;
  - "perdido", que no es un paso del embudo sino una fuga;
  - una base de cero contactos, donde el porcentaje no es 0% sino
    "todavía no se sabe";
  - fechas inconsistentes, que restarían días negativos al promedio.
"""

from playwright.sync_api import expect  # noqa: F401  (consistencia con el resto de la suite)


def _evaluar(page, base_url, expresion, *args):
    page.goto(base_url)
    return page.evaluate(
        "(args) => import('/js/embudo.js').then((m) => (" + expresion + "))",
        list(args),
    )


def _contacto(estado, cambios=(), creado="2026-09-01T10:00:00.000Z"):
    return {
        "estado": estado,
        "fecha_creacion": creado,
        "actividades": [
            {"tipo": "cambio_etapa", "etapa_desde": desde, "etapa_hasta": hasta, "fecha": fecha}
            for desde, hasta, fecha in cambios
        ],
    }


def test_la_etapa_actual_implica_las_anteriores(page, base_url):
    """El caso que haría desconfiar de la pantalla entera.

    Tres contactos en "visita" sin ningún historial registrado: el
    embudo NO puede decir que 0 llegaron a visita.
    """
    contactos = [_contacto("visita"), _contacto("visita"), _contacto("visita")]
    pasos = _evaluar(page, base_url, "m.pasosDelEmbudo(args[0])", contactos)
    por_paso = {f"{p['desde']}->{p['hasta']}": p for p in pasos}
    assert por_paso["nuevo->contactado"]["base"] == 3
    assert por_paso["contactado->visita"]["avanzaron"] == 3
    assert por_paso["contactado->visita"]["tasa"] == 100


def test_sin_base_la_tasa_es_desconocida_no_cero(page, base_url):
    """0 de 0 no es 0%: es que todavía no hay con qué calcular.

    Mostrar 0% ahí diría "no convertís nada", que es una afirmación
    falsa sobre un negocio que recién arranca.
    """
    pasos = _evaluar(page, base_url, "m.pasosDelEmbudo([])", )
    assert all(paso["tasa"] is None for paso in pasos), pasos
    assert all(paso["base"] == 0 for paso in pasos)


def test_un_contacto_perdido_cuenta_en_las_etapas_por_las_que_paso(page, base_url):
    """"Perdido" es una fuga, no un paso.

    Este contacto llegó a visita y se perdió: tiene que contar como
    alguien que llegó a visita, y no puede aparecer como si hubiera
    avanzado a oferta.
    """
    contacto = _contacto(
        "perdido",
        cambios=[
            ("nuevo", "contactado", "2026-09-02T10:00:00.000Z"),
            ("contactado", "visita", "2026-09-03T10:00:00.000Z"),
            ("visita", "perdido", "2026-09-05T10:00:00.000Z"),
        ],
    )
    alcanzadas = _evaluar(page, base_url, "[...m.etapasAlcanzadas(args[0])]", contacto)
    assert set(alcanzadas) == {"nuevo", "contactado", "visita", "perdido"}

    pasos = _evaluar(page, base_url, "m.pasosDelEmbudo([args[0]])", contacto)
    por_paso = {f"{p['desde']}->{p['hasta']}": p for p in pasos}
    assert por_paso["contactado->visita"]["tasa"] == 100
    assert por_paso["visita->oferta"]["avanzaron"] == 0, "un perdido no avanzó a oferta"


def test_un_perdido_sin_historial_no_infla_el_embudo(page, base_url):
    """Sin historial, de un perdido no se puede afirmar nada.

    "Perdido" no tiene lugar en el orden del embudo, así que no implica
    etapas anteriores — si no, un contacto que se perdió apenas entró
    contaría como que llegó hasta el final.
    """
    alcanzadas = _evaluar(page, base_url, "[...m.etapasAlcanzadas(args[0])]", _contacto("perdido"))
    assert alcanzadas == []


def test_las_actividades_viejas_de_solo_texto_se_siguen_entendiendo(page, base_url):
    """Compatibilidad: antes el cambio se guardaba solo como texto.

    Si esto no funcionara, el embudo empezaría a contar desde cero el
    día que se publicó, ignorando todo el historial anterior.
    """
    contacto = {
        "estado": "oferta",
        "fecha_creacion": "2026-09-01T10:00:00.000Z",
        "actividades": [
            {"tipo": "cambio_etapa", "texto": "Nuevo → Contactado", "fecha": "2026-09-02T10:00:00.000Z"},
            {"tipo": "cambio_etapa", "texto": "Contactado → Visita", "fecha": "2026-09-04T10:00:00.000Z"},
        ],
    }
    alcanzadas = _evaluar(page, base_url, "[...m.etapasAlcanzadas(args[0])]", contacto)
    assert {"nuevo", "contactado", "visita", "oferta"} <= set(alcanzadas)


def test_los_dias_por_etapa_solo_cuentan_tramos_terminados(page, base_url):
    """Creado el 1, contactado el 3, visita el 6.

    Son 2 días en "nuevo" y 3 en "contactado". "visita" es la etapa
    actual, todavía corriendo, así que no tiene que aparecer: promediar
    un tramo abierto bajaría el número de forma engañosa.
    """
    contacto = _contacto(
        "visita",
        cambios=[
            ("nuevo", "contactado", "2026-09-03T10:00:00.000Z"),
            ("contactado", "visita", "2026-09-06T10:00:00.000Z"),
        ],
    )
    dias = _evaluar(page, base_url, "m.diasPromedioPorEtapa([args[0]])", contacto)
    assert dias["nuevo"]["dias"] == 2
    assert dias["contactado"]["dias"] == 3
    assert "visita" not in dias, "la etapa actual todavía está corriendo, no se puede promediar"


def test_una_fecha_inconsistente_no_resta_dias(page, base_url):
    """Un cambio anterior a la fecha de creación daría días negativos.

    Se descarta ese tramo en vez de restar: un promedio negativo de días
    es peor que no mostrar el dato.
    """
    contacto = _contacto(
        "contactado",
        cambios=[("nuevo", "contactado", "2026-08-20T10:00:00.000Z")],
        creado="2026-09-01T10:00:00.000Z",
    )
    dias = _evaluar(page, base_url, "m.diasPromedioPorEtapa([args[0]])", contacto)
    assert dias == {}


def test_el_paso_mas_flojo_necesita_datos_para_opinar(page, base_url):
    """Con pocos casos, cualquier porcentaje es ruido.

    Señalar "acá se te cae todo" por un solo contacto sería peor que no
    decir nada, así que por debajo del mínimo no se opina.
    """
    pocos = [_contacto("nuevo")]
    assert _evaluar(page, base_url, "m.pasoMasFlojo(m.pasosDelEmbudo(args[0]))", pocos) is None

    # Seis contactos: cinco llegaron a contactado, uno solo a visita.
    muchos = [_contacto("contactado") for _ in range(5)] + [_contacto("visita")]
    paso = _evaluar(page, base_url, "m.pasoMasFlojo(m.pasosDelEmbudo(args[0]))", muchos)
    assert paso["desde"] == "contactado" and paso["hasta"] == "visita"
    assert paso["base"] == 6 and paso["avanzaron"] == 1
