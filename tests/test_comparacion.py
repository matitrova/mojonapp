"""Las variaciones del Dashboard ("+12,5% vs. mes anterior").

QUÉ SE PRUEBA. El dato del pasado no está guardado en ninguna parte: se
RECONSTRUYE caminando hacia atrás los cambios de etapa que quedaron como
actividades en cada contacto. Si esa reconstrucción se equivoca, el
dashboard muestra con total convicción que el negocio mejoró o empeoró
un 30% cuando no pasó nada — y nadie tiene forma de darse cuenta mirando
la pantalla.

Los tres errores que este módulo no puede cometer:

  1. Contar como "existente el mes pasado" a un contacto que se cargó
     ayer. Infla el pasado y hace que todo parezca que empeoró.
  2. Equivocar la etapa de un contacto que fue y volvió
     (nuevo → visita → nuevo): el ingenuo mira el último cambio, y hay
     que mirar el primero posterior al corte.
  3. Mostrar un porcentaje cuando no hay con qué compararlo. Pasar de 0
     a 3 no es "+300%": es una base que recién arranca.

Módulo puro: se importa suelto, sin Firestore ni navegador de verdad.
"""

import json
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]
MODULO = "/js/comparacion.js"


@pytest.fixture
def evaluar(page, base_url):
    page.goto(base_url)

    def _correr(expresion, *args):
        return page.evaluate(
            f"""(args) => import('{MODULO}').then((m) => {{ const f = {expresion}; return f(m, ...args); }})""",
            list(args),
        )

    return _correr


def _contacto(creacion, estado, cambios=(), actividades=()):
    """Un contacto con la forma que guarda el CRM."""
    lista = [
        {"tipo": "cambio_etapa", "etapa_desde": desde, "etapa_hasta": hasta, "fecha": fecha}
        for desde, hasta, fecha in cambios
    ]
    lista += [{"tipo": "nota", "texto": "algo", "fecha": f} for f in actividades]
    return {"fecha_creacion": creacion, "estado": estado, "actividades": lista}


# --- El corte del mes anterior -------------------------------------------
#
# SE COMPARA EN HORA LOCAL, no en UTC, y no es un detalle: el cierre del
# mes de una inmobiliaria de San Luis es a SU medianoche. En UTC el
# 31/08 23:59 local se lee como 01/09 02:59Z, que cae en el mes
# siguiente. La primera versión de estos tests comparaba el string ISO
# y fallaba por eso, culpando a una función que estaba bien.


def _partes_del_corte(evaluar, ahora_iso):
    """El corte desarmado en hora local, para no depender de la zona de
    la máquina que corre los tests."""
    return evaluar(
        """(m, ahora) => {
             const c = m.cierreDelMesAnterior(new Date(ahora));
             return { anio: c.getFullYear(), mes: c.getMonth() + 1, dia: c.getDate(),
                      hora: c.getHours(), minuto: c.getMinutes() };
           }""",
        ahora_iso,
    )


def test_el_corte_es_el_ultimo_instante_del_mes_pasado(evaluar):
    c = _partes_del_corte(evaluar, "2026-09-18T10:00:00.000Z")
    assert (c["anio"], c["mes"], c["dia"]) == (2026, 8, 31), c
    assert (c["hora"], c["minuto"]) == (23, 59), c


def test_en_enero_el_corte_cae_en_diciembre_del_ano_anterior(evaluar):
    """El caso que rompe cualquier resta de meses hecha a mano."""
    c = _partes_del_corte(evaluar, "2026-01-05T10:00:00.000Z")
    assert (c["anio"], c["mes"], c["dia"]) == (2025, 12, 31), c


def test_en_marzo_de_un_ano_bisiesto_el_corte_es_el_29_de_febrero(evaluar):
    """No hay ninguna tabla de días por mes en el código: lo resuelve
    Date. Este test es el que lo garantiza."""
    c = _partes_del_corte(evaluar, "2028-03-10T10:00:00.000Z")
    assert (c["anio"], c["mes"], c["dia"]) == (2028, 2, 29), c


def test_en_marzo_de_un_ano_normal_el_corte_es_el_28(evaluar):
    c = _partes_del_corte(evaluar, "2027-03-10T10:00:00.000Z")
    assert (c["anio"], c["mes"], c["dia"]) == (2027, 2, 28), c


# --- Reconstruir la etapa del pasado ------------------------------------


def test_un_contacto_que_no_se_movio_estaba_donde_esta(evaluar):
    c = _contacto("2026-07-01T10:00:00.000Z", "contactado")
    etapa = evaluar(
        "(m, c, corte) => m.etapaEnLaFecha(c, new Date(corte))", c, "2026-08-31T23:59:59.999Z"
    )
    assert etapa == "contactado"


def test_un_contacto_que_avanzo_despues_del_corte_estaba_en_la_etapa_de_antes(evaluar):
    """Cerró una venta en septiembre: al cierre de agosto NO estaba
    cerrado. Contarlo como cerrado infla el pasado y hace que la
    conversión de este mes parezca peor de lo que es."""
    c = _contacto(
        "2026-07-01T10:00:00.000Z",
        "cerrado",
        cambios=[("visita", "cerrado", "2026-09-10T10:00:00.000Z")],
    )
    etapa = evaluar(
        "(m, c, corte) => m.etapaEnLaFecha(c, new Date(corte))", c, "2026-08-31T23:59:59.999Z"
    )
    assert etapa == "visita"


def test_un_contacto_que_fue_y_volvio(evaluar):
    """EL CASO QUE ROMPE EL CÁLCULO INGENUO.

    nuevo → visita (septiembre) → nuevo (septiembre). Mirar el ÚLTIMO
    cambio diría "venía de visita"; lo correcto es el PRIMERO posterior
    al corte, que dice que en agosto estaba en nuevo.
    """
    c = _contacto(
        "2026-07-01T10:00:00.000Z",
        "nuevo",
        cambios=[
            ("nuevo", "visita", "2026-09-05T10:00:00.000Z"),
            ("visita", "nuevo", "2026-09-12T10:00:00.000Z"),
        ],
    )
    etapa = evaluar(
        "(m, c, corte) => m.etapaEnLaFecha(c, new Date(corte))", c, "2026-08-31T23:59:59.999Z"
    )
    assert etapa == "nuevo"


def test_varios_cambios_despues_del_corte_en_desorden(evaluar):
    """Las actividades no tienen garantizado el orden en el array."""
    c = _contacto(
        "2026-07-01T10:00:00.000Z",
        "cerrado",
        cambios=[
            ("oferta", "cerrado", "2026-09-20T10:00:00.000Z"),
            ("nuevo", "contactado", "2026-09-02T10:00:00.000Z"),
            ("contactado", "oferta", "2026-09-11T10:00:00.000Z"),
        ],
    )
    etapa = evaluar(
        "(m, c, corte) => m.etapaEnLaFecha(c, new Date(corte))", c, "2026-08-31T23:59:59.999Z"
    )
    assert etapa == "nuevo"


def test_un_contacto_creado_despues_del_corte_no_existia(evaluar):
    """null y no "nuevo": no es que estaba en la primera etapa, es que
    no estaba. Contarlo como existente infla el pasado."""
    c = _contacto("2026-09-15T10:00:00.000Z", "nuevo")
    etapa = evaluar(
        "(m, c, corte) => m.etapaEnLaFecha(c, new Date(corte))", c, "2026-08-31T23:59:59.999Z"
    )
    assert etapa is None


def test_un_contacto_sin_fecha_de_creacion_no_se_cuenta(evaluar):
    """Hay contactos viejos de antes de que existiera el campo. Sin
    fecha no se puede ubicar en el tiempo, y adivinar sería peor."""
    etapa = evaluar(
        "(m, c, corte) => m.etapaEnLaFecha(c, new Date(corte))",
        {"estado": "nuevo", "actividades": []},
        "2026-08-31T23:59:59.999Z",
    )
    assert etapa is None


def test_un_cambio_de_etapa_sin_etapa_desde_se_ignora(evaluar):
    """Los cambios registrados antes de que se guardaran las claves solo
    tienen el texto ("Nuevo → Contactado"). Parsear castellano para
    recuperarlos sería frágil: mejor ignorarlos que inventar."""
    c = {
        "fecha_creacion": "2026-07-01T10:00:00.000Z",
        "estado": "cerrado",
        "actividades": [{"tipo": "cambio_etapa", "texto": "Visita → Cerrado", "fecha": "2026-09-10T10:00:00.000Z"}],
    }
    etapa = evaluar(
        "(m, c, corte) => m.etapaEnLaFecha(c, new Date(corte))", c, "2026-08-31T23:59:59.999Z"
    )
    assert etapa == "cerrado"


# --- Las actividades hasta el corte -------------------------------------


def test_las_actividades_posteriores_al_corte_no_cuentan(evaluar):
    """Si contaran, un contacto atendido la semana pasada parecería
    haber estado atendido el mes pasado también."""
    c = _contacto(
        "2026-07-01T10:00:00.000Z", "nuevo",
        actividades=["2026-09-10T10:00:00.000Z"],
    )
    cuantas = evaluar(
        "(m, c, corte) => m.actividadesHasta(c, new Date(corte)).length", c, "2026-08-31T23:59:59.999Z"
    )
    assert cuantas == 0


def test_las_actividades_anteriores_al_corte_si_cuentan(evaluar):
    c = _contacto(
        "2026-07-01T10:00:00.000Z", "nuevo",
        actividades=["2026-08-10T10:00:00.000Z", "2026-09-10T10:00:00.000Z"],
    )
    cuantas = evaluar(
        "(m, c, corte) => m.actividadesHasta(c, new Date(corte)).length", c, "2026-08-31T23:59:59.999Z"
    )
    assert cuantas == 1


# --- El porcentaje -------------------------------------------------------


@pytest.mark.parametrize(
    "ahora,antes,esperado",
    [(9, 8, 13), (8, 8, 0), (4, 8, -50), (12, 8, 50), (16, 8, 100)],
)
def test_calcula_el_porcentaje(evaluar, ahora, antes, esperado):
    assert evaluar("(m, a, b) => m.variacion(a, b)", ahora, antes) == esperado


def test_pasar_de_cero_no_es_un_porcentaje(evaluar):
    """"De 0 a 3" es una noticia, pero no es +300% ni +∞. Sin base no
    hay porcentaje, y la tarjeta no muestra nada."""
    assert evaluar("(m, a, b) => m.variacion(a, b)", 3, 0) is None


@pytest.mark.parametrize("antes", [None, "ocho", float("nan")])
def test_sin_valor_anterior_no_hay_comparacion(evaluar, antes):
    """La base recién arranca y todavía no pasó un mes: el dashboard
    tiene que quedarse callado, no mostrar 0%."""
    valor = None if antes is None else ("NaN" if antes != "ocho" else antes)
    assert evaluar("(m, a, b) => m.variacion(a, b === 'NaN' ? NaN : b)", 3, valor) is None


# --- Qué es una buena noticia -------------------------------------------


def test_mas_contactos_es_bueno(evaluar):
    assert evaluar("(m, clave, v) => m.esBuenaNoticia(clave, v)", "total", 20) is True


def test_menos_contactos_es_malo(evaluar):
    assert evaluar("(m, clave, v) => m.esBuenaNoticia(clave, v)", "total", -20) is False


def test_menos_estancados_es_BUENO_aunque_el_numero_sea_negativo(evaluar):
    """EL PUNTO DE esMejorQueBaje. Sin esto, "Estancados -40%" se
    pintaría de rojo por tener el signo menos, cuando es exactamente lo
    que el corredor quiere ver."""
    assert evaluar("(m, clave, v) => m.esBuenaNoticia(clave, v)", "estancados", -40) is True
    assert evaluar("(m, clave, v) => m.esBuenaNoticia(clave, v)", "estancados", 40) is False


def test_mas_sin_atender_es_malo(evaluar):
    assert evaluar("(m, clave, v) => m.esBuenaNoticia(clave, v)", "sinAtender", 25) is False


def test_sin_cambio_no_es_ni_bueno_ni_malo(evaluar):
    assert evaluar("(m, clave, v) => m.esBuenaNoticia(clave, v)", "total", 0) is None


def test_sin_datos_no_es_ni_bueno_ni_malo(evaluar):
    assert evaluar("(m, clave, v) => m.esBuenaNoticia(clave, v)", "total", None) is None


# --- El texto ------------------------------------------------------------


def test_el_texto_lleva_el_signo_cuando_sube(evaluar):
    assert evaluar("(m, v) => m.textoDeVariacion(v)", 13) == "+13%"


def test_el_texto_del_negativo_ya_trae_su_signo(evaluar):
    assert evaluar("(m, v) => m.textoDeVariacion(v)", -50) == "-50%"


def test_sin_variacion_no_hay_texto(evaluar):
    """null y no "0%" ni "—": la tarjeta decide no mostrar nada."""
    assert evaluar("(m, v) => m.textoDeVariacion(v)", None) is None


# --- Las métricas al cierre del mes pasado -------------------------------


CORTE = "2026-08-31T23:59:59.999Z"

# Los umbrales se pasan EXPLÍCITOS y no se importan de la app: este es un
# módulo puro y sus tests tienen que definir el criterio que prueban. La
# primera versión los tenía duplicados adentro del módulo y no coincidían
# con los de la app (48h/30d contra 24h/7d): el pasado se calculaba con
# un umbral y el presente con otro. Ningún test lo vio, porque los tests
# usaban los mismos números inventados.
UMBRALES = {"horasSinAtender": 24, "diasEstancado": 7}
UMBRALES_JS = json.dumps(UMBRALES)


def test_cuenta_solo_los_que_ya_existian(evaluar):
    contactos = [
        _contacto("2026-07-01T10:00:00.000Z", "nuevo"),
        _contacto("2026-07-15T10:00:00.000Z", "contactado"),
        _contacto("2026-09-10T10:00:00.000Z", "nuevo"),  # nació después
    ]
    m = evaluar(f"(m, cs, corte) => m.metricasALaFecha(cs, new Date(corte), {UMBRALES_JS})", contactos, CORTE)
    assert m["total"] == 2


def test_la_conversion_del_pasado_usa_las_etapas_del_pasado(evaluar):
    """Dos contactos; uno cerró en septiembre. Al cierre de agosto la
    conversión era 0%, no 50%. Si usara el estado de hoy, el mes pasado
    parecería mejor de lo que fue y este mes parecería un retroceso."""
    contactos = [
        _contacto("2026-07-01T10:00:00.000Z", "cerrado",
                  cambios=[("oferta", "cerrado", "2026-09-05T10:00:00.000Z")]),
        _contacto("2026-07-02T10:00:00.000Z", "contactado"),
    ]
    m = evaluar(f"(m, cs, corte) => m.metricasALaFecha(cs, new Date(corte), {UMBRALES_JS})", contactos, CORTE)
    assert m["tasaConversion"] == 0


def test_un_contacto_atendido_despues_del_corte_estaba_sin_atender(evaluar):
    """Se lo atendió en septiembre: al cierre de agosto llevaba dos
    meses sin que nadie lo tocara. Mirar las actividades de hoy lo
    contaría como atendido y escondería el problema del mes pasado."""
    contactos = [
        _contacto("2026-06-01T10:00:00.000Z", "nuevo", actividades=["2026-09-03T10:00:00.000Z"]),
    ]
    m = evaluar(f"(m, cs, corte) => m.metricasALaFecha(cs, new Date(corte), {UMBRALES_JS})", contactos, CORTE)
    assert m["sinAtender"] == 1


def test_un_contacto_recien_creado_al_corte_no_esta_sin_atender(evaluar):
    """Entró hace dos horas: todavía no es un descuido de nadie."""
    contactos = [_contacto("2026-08-31T22:00:00.000Z", "nuevo")]
    m = evaluar(f"(m, cs, corte) => m.metricasALaFecha(cs, new Date(corte), {UMBRALES_JS})", contactos, CORTE)
    assert m["sinAtender"] == 0


def test_estancado_se_mide_con_la_ultima_actividad_ANTERIOR_al_corte(evaluar):
    """Se movió en septiembre, pero al cierre de agosto llevaba meses
    quieto. Usar fecha_actualizacion diría que estaba fresco, porque ese
    campo ya está contaminado por lo que pasó después."""
    contactos = [
        _contacto("2026-05-01T10:00:00.000Z", "contactado",
                  actividades=["2026-06-01T10:00:00.000Z", "2026-09-04T10:00:00.000Z"]),
    ]
    m = evaluar(f"(m, cs, corte) => m.metricasALaFecha(cs, new Date(corte), {UMBRALES_JS})", contactos, CORTE)
    assert m["estancados"] == 1


def test_un_cerrado_no_esta_estancado(evaluar):
    contactos = [
        _contacto("2026-01-01T10:00:00.000Z", "cerrado",
                  cambios=[("oferta", "cerrado", "2026-02-01T10:00:00.000Z")]),
    ]
    m = evaluar(f"(m, cs, corte) => m.metricasALaFecha(cs, new Date(corte), {UMBRALES_JS})", contactos, CORTE)
    assert m["estancados"] == 0


def test_sin_nadie_en_el_pasado_no_hay_metricas(evaluar):
    """La base arrancó este mes: no hay con qué comparar y hay que
    decirlo con null, no con ceros que parecen un dato."""
    contactos = [_contacto("2026-09-10T10:00:00.000Z", "nuevo")]
    assert evaluar(f"(m, cs, corte) => m.metricasALaFecha(cs, new Date(corte), {UMBRALES_JS})", contactos, CORTE) is None


def test_las_metricas_del_pasado_no_traen_las_de_plata(evaluar):
    """No están a propósito: dependen del precio de cada lote y no hay
    historial de precios. Si algún día aparecen acá sin que exista ese
    historial, es un número inventado."""
    contactos = [_contacto("2026-07-01T10:00:00.000Z", "nuevo")]
    m = evaluar(f"(m, cs, corte) => m.metricasALaFecha(cs, new Date(corte), {UMBRALES_JS})", contactos, CORTE)
    assert "valorPipelineActivo" not in m
    assert "comisionEnPipeline" not in m


# --- La ventana de 7 días ------------------------------------------------


def test_cuenta_los_de_la_ventana_y_no_los_de_antes(evaluar):
    contactos = [
        _contacto("2026-09-16T10:00:00.000Z", "nuevo"),  # dentro
        _contacto("2026-09-12T10:00:00.000Z", "nuevo"),  # dentro
        _contacto("2026-09-01T10:00:00.000Z", "nuevo"),  # fuera
    ]
    n = evaluar(
        "(m, cs, hasta, dias) => m.nuevosEnLaVentana(cs, new Date(hasta), dias)",
        contactos, "2026-09-18T10:00:00.000Z", 7,
    )
    assert n == 2


def test_la_ventana_anterior_no_se_solapa_con_la_actual(evaluar):
    """Las dos ventanas tienen que ser disjuntas: si un contacto contara
    en las dos, la comparación se compararía consigo misma."""
    contactos = [_contacto("2026-09-16T10:00:00.000Z", "nuevo")]
    ahora = "2026-09-18T10:00:00.000Z"
    actual = evaluar(
        "(m, cs, hasta, dias) => m.nuevosEnLaVentana(cs, new Date(hasta), dias)", contactos, ahora, 7
    )
    anterior = evaluar(
        """(m, cs, hasta, dias) => {
             const finAnterior = new Date(new Date(hasta).getTime() - dias * 86400000);
             return m.nuevosEnLaVentana(cs, finAnterior, dias);
           }""",
        contactos, ahora, 7,
    )
    assert (actual, anterior) == (1, 0)


# --- Que el pasado y el presente usen el MISMO criterio ------------------


def test_comparacion_no_tiene_umbrales_propios():
    """EL TEST QUE FALTABA Y DEJÓ PASAR EL BUG.

    comparacion.js tenía sus propias constantes (48 horas, 30 días) y la
    app usaba otras (24 y 7): el pasado se calculaba con un criterio y el
    presente con otro, y la tarjeta mostraba un porcentaje que comparaba
    dos cosas distintas. Ningún test lo vio porque los tests usaban los
    mismos números inventados que el módulo; lo agarró una captura donde
    el rótulo decía "(+24h)" al lado de un cálculo hecho con 48.

    Ahora los umbrales entran por parámetro y el único lugar donde viven
    es crm-metricas.js. Este test es el que impide que vuelvan.
    """
    fuente = (RAIZ / "js" / "comparacion.js").read_text()
    for prohibido in ("HORAS_SIN_ATENDER", "DIAS_ESTANCADO"):
        # Se permite nombrarlo en un comentario (la explicación de por
        # qué no está) pero no definirlo.
        assert f"const {prohibido}" not in fuente, (
            f"comparacion.js volvió a definir {prohibido}. Tiene que recibirlo de "
            f"crm-metricas.js, que es donde vive, o el pasado y el presente se "
            f"calculan con criterios distintos."
        )


def test_metricas_a_la_fecha_exige_los_umbrales(evaluar):
    """Sin umbrales no calcula con valores por defecto: falla y lo dice.
    Un default silencioso es cómo se reintroduce el bug de arriba."""
    error = evaluar(
        """(m, cs, corte) => {
             try {
               m.metricasALaFecha(cs, new Date(corte), {});
               return null;
             } catch (e) { return e.message; }
           }""",
        [_contacto("2026-07-01T10:00:00.000Z", "nuevo")],
        CORTE,
    )
    assert error and "umbrales" in error
