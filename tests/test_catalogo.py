"""Las reglas del catálogo público (js/catalogo.js).

QUÉ ES. La pantalla que ve alguien a quien le mandaron el link de la
inmobiliaria: /propiedades. Es distinta de /lotes, que es la herramienta
del corredor.

POR QUÉ SE SEPARÓ. Hasta el 2026-09-24 el botón "Ver las propiedades
disponibles" de la página de un lote llevaba a /lotes, o sea a la lista
interna. Ahí un comprador veía un lote VENDIDO con su precio, la
insignia interna "Nuevo", el título "Lotes cargados" y ni el nombre ni
el teléfono de la inmobiliaria. El problema no fue un descuido puntual:
mientras una sola pantalla sirva a los dos, cada cosa que se agregue hay
que acordarse de esconderla.

Se prueban sin navegador de verdad y sin Firestore: son decisiones
puras, y así se cubren todos los bordes rápido.
"""

import pytest

MODULO = "/js/catalogo.js"


@pytest.fixture
def evaluar(page, base_url):
    page.goto(base_url)

    def _correr(expresion, *args):
        return page.evaluate(
            f"""(args) => import('{MODULO}').then((m) => {{ const f = {expresion}; return f(m, ...args); }})""",
            list(args),
        )

    return _correr


def _lote(id, estado="disponible", precio=None, sector=None, barrio=None, superficie=None):
    return {
        "id": id,
        "properties": {
            "estado": estado,
            "precio_usd": precio,
            "sector": sector,
            "barrio": barrio,
            "superficie_m2": superficie,
        },
    }


# ---------------------------------------------------------------------------
# El orden
# ---------------------------------------------------------------------------


def test_lo_que_se_puede_comprar_va_primero(evaluar):
    """Un vendido arriba de todo es lo que pasaba antes en /lotes."""
    lotes = [
        _lote("v", estado="vendido", precio=18500),
        _lote("d", estado="disponible", precio=20000),
        _lote("r", estado="reservado", precio=19000),
    ]
    r = evaluar("(m, l) => m.ordenarParaElComprador(l).map((f) => f.id)", lotes)
    assert r == ["d", "r", "v"]


def test_dentro_de_cada_grupo_ordena_por_precio(evaluar):
    lotes = [_lote("caro", precio=50000), _lote("barato", precio=10000), _lote("medio", precio=25000)]
    r = evaluar("(m, l) => m.ordenarParaElComprador(l).map((f) => f.id)", lotes)
    assert r == ["barato", "medio", "caro"]


def test_las_que_no_tienen_precio_van_al_final_de_su_grupo(evaluar):
    """Sin número no hay con qué compararlas, pero siguen estando."""
    lotes = [_lote("sin", precio=None), _lote("con", precio=30000)]
    r = evaluar("(m, l) => m.ordenarParaElComprador(l).map((f) => f.id)", lotes)
    assert r == ["con", "sin"]


def test_el_orden_es_estable_entre_recargas(evaluar):
    """Si cambia, el comprador que vuelve no encuentra dos veces lo mismo
    en el mismo lugar."""
    lotes = [_lote("bbb", precio=10000), _lote("aaa", precio=10000), _lote("ccc", precio=10000)]
    primera = evaluar("(m, l) => m.ordenarParaElComprador(l).map((f) => f.id)", lotes)
    segunda = evaluar("(m, l) => m.ordenarParaElComprador(l.slice().reverse()).map((f) => f.id)", lotes)
    assert primera == segunda == ["aaa", "bbb", "ccc"]


def test_ordenar_no_toca_la_lista_original(evaluar):
    """El catálogo comparte la lista con el resto de la app."""
    lotes = [_lote("b", precio=2), _lote("a", precio=1)]
    r = evaluar("(m, l) => { const antes = l.map((f) => f.id); m.ordenarParaElComprador(l); return [antes, l.map((f) => f.id)]; }", lotes)
    assert r[0] == r[1] == ["b", "a"]


# ---------------------------------------------------------------------------
# Los filtros
# ---------------------------------------------------------------------------


def test_filtra_por_zona(evaluar):
    lotes = [_lote("merlo", sector="Merlo"), _lote("cortaderas", sector="Cortaderas")]
    r = evaluar("(m, l) => m.filtrarCatalogo(l, { zona: 'Merlo' }).map((f) => f.id)", lotes)
    assert r == ["merlo"]


def test_filtra_por_precio(evaluar):
    lotes = [_lote("barato", precio=10000), _lote("caro", precio=90000)]
    r = evaluar("(m, l) => m.filtrarCatalogo(l, { hasta: 50000 }).map((f) => f.id)", lotes)
    assert r == ["barato"]
    r2 = evaluar("(m, l) => m.filtrarCatalogo(l, { desde: 50000 }).map((f) => f.id)", lotes)
    assert r2 == ["caro"]


def test_una_propiedad_sin_precio_no_se_filtra_por_precio(evaluar):
    """Descartarla sería esconderle justo la que dice "consultar" a
    alguien que puso un máximo — y en terrenos eso es común."""
    lotes = [_lote("sin", precio=None), _lote("caro", precio=90000)]
    r = evaluar("(m, l) => m.filtrarCatalogo(l, { hasta: 50000 }).map((f) => f.id)", lotes)
    assert r == ["sin"]


def test_sin_filtros_pasa_todo(evaluar):
    lotes = [_lote("a"), _lote("b")]
    assert evaluar("(m, l) => m.filtrarCatalogo(l).map((f) => f.id)", lotes) == ["a", "b"]


def test_las_zonas_del_desplegable_son_las_que_tienen_algo(evaluar):
    """Ofrecer una zona vacía lleva a una pantalla sin resultados."""
    lotes = [_lote("a", sector="Merlo"), _lote("b", sector="Merlo"), _lote("c", sector=None), _lote("d", sector="Cortaderas")]
    assert evaluar("(m, l) => m.zonasDelCatalogo(l)", lotes) == ["Cortaderas", "Merlo"]


# ---------------------------------------------------------------------------
# Cómo se lee cada propiedad
# ---------------------------------------------------------------------------


def test_el_precio_a_consultar_se_dice_con_palabras(evaluar):
    """En la tabla del corredor el "—" significa "no lo cargué
    todavía". Al comprador eso no le dice nada."""
    r = evaluar("(m, p) => m.precioParaElComprador(p)", {"estado": "disponible", "precio_usd": None})
    assert r == "Precio a consultar"


def test_un_precio_cargado_sale_en_formato_argentino(evaluar):
    r = evaluar("(m, p) => m.precioParaElComprador(p)", {"estado": "disponible", "precio_usd": 18500})
    assert r == "USD 18.500"


def test_un_vendido_no_muestra_precio(evaluar):
    """Lo que se pagó por algo que ya no está no es una oferta."""
    r = evaluar("(m, p) => m.precioParaElComprador(p)", {"estado": "vendido", "precio_usd": 18500})
    assert r is None


def test_un_reservado_si_muestra_precio(evaluar):
    """Una reserva se cae: sigue siendo una oferta."""
    r = evaluar("(m, p) => m.precioParaElComprador(p)", {"estado": "reservado", "precio_usd": 19000})
    assert r == "USD 19.000"


def test_la_faja_solo_aparece_cuando_hace_falta(evaluar):
    assert evaluar("(m, p) => m.fajaDeEstado(p)", {"estado": "disponible"}) is None
    assert evaluar("(m, p) => m.fajaDeEstado(p)", {"estado": "vendido"})["texto"] == "Vendido"
    assert evaluar("(m, p) => m.fajaDeEstado(p)", {"estado": "reservado"})["texto"] == "Reservado"


def test_los_datos_de_la_tarjeta_omiten_lo_que_falta(evaluar):
    """En una vidriera, un hueco se lee mejor que tres carteles
    avisando que falta algo."""
    r = evaluar("(m, p) => m.datosParaLaTarjeta(p, null)", {"superficie_m2": None})
    assert r == []
    r2 = evaluar("(m, p, med) => m.datosParaLaTarjeta(p, med)", {"superficie_m2": 7344.1}, "Frente 53,3 m × Largo 146,3 m")
    assert r2 == ["7.344,1 m²", "Frente 53,3 m × Largo 146,3 m"]


def test_la_ubicacion_junta_lo_que_hay(evaluar):
    assert evaluar("(m, p) => m.ubicacionParaElComprador(p)", {"sector": "Merlo", "barrio": "Cerro de Oro"}) == "Merlo · Cerro de Oro"
    assert evaluar("(m, p) => m.ubicacionParaElComprador(p)", {"sector": "Merlo"}) == "Merlo"
    assert evaluar("(m, p) => m.ubicacionParaElComprador(p)", {}) is None


# ---------------------------------------------------------------------------
# La miniatura satelital con el límite del lote
# ---------------------------------------------------------------------------
#
# Es lo único que este producto tiene y la competencia no: los portales
# muestran un pin sobre un mapa de calles. Y en una cartera recién
# cargada la mayoría de los lotes no tiene fotos, así que sin esto el
# catálogo es una pared de cuadros grises.
#
# Se prueba con números porque los dos defectos posibles son invisibles
# para cualquier chequeo de DOM: un tile que Esri devuelve GRIS con HTTP
# 200, y un polígono proyectado fuera de la miniatura (la tarjeta se ve
# igual de "cargada", solo que vacía).

ANCHO, ALTO = 400, 300


def test_el_centro_del_lote_cae_en_el_centro_de_la_miniatura(evaluar):
    """Si la proyección está mal, el polígono se dibuja fuera de cuadro y
    la tarjeta queda con foto satelital y nada encima."""
    r = evaluar(
        f"""(m) => {{
              const lat = -32.41, lon = -65.08, z = 17;
              const mo = m.mosaicoSatelital(lat, lon, z, {ANCHO}, {ALTO});
              return m.aPixelesDeLaMiniatura(lat, lon, z, mo.origenX, mo.origenY);
            }}"""
    )
    assert abs(r["x"] - ANCHO / 2) < 0.01
    assert abs(r["y"] - ALTO / 2) < 0.01


def test_los_tiles_cubren_toda_la_miniatura(evaluar):
    """Un hueco sin tile es un rectángulo del color de fondo en el medio
    de la vidriera."""
    r = evaluar(
        f"""(m) => {{
              const mo = m.mosaicoSatelital(-32.41, -65.08, 18, {ANCHO}, {ALTO});
              const izq = Math.min(...mo.tiles.map((t) => t.izquierda));
              const arr = Math.min(...mo.tiles.map((t) => t.arriba));
              const der = Math.max(...mo.tiles.map((t) => t.izquierda + mo.lado));
              const aba = Math.max(...mo.tiles.map((t) => t.arriba + mo.lado));
              return {{ izq, arr, der, aba, cuantos: mo.tiles.length }};
            }}"""
    )
    assert r["izq"] <= 0 and r["arr"] <= 0
    assert r["der"] >= ANCHO and r["aba"] >= ALTO
    assert r["cuantos"] >= 1


@pytest.mark.parametrize("zoom", [15, 16, 17, 18, 19])
def test_nunca_se_le_pide_a_esri_un_zoom_que_no_tiene(evaluar, zoom):
    """LA TRAMPA DE ESRI. Pasado su zoom máximo no devuelve un error:
    devuelve un cuadro GRIS que dice "Map data not yet available", con
    HTTP 200. O sea que no hay status que mirar ni excepción que atrapar,
    y el catálogo se llena de cuadros grises con el polígono flotando
    encima. Pasó de verdad el 2026-09-24.
    """
    r = evaluar(
        f"""(m) => [...new Set(m.mosaicoSatelital(-32.41, -65.08, {zoom}, {ANCHO}, {ALTO}).tiles.map((t) => t.z))]"""
    )
    # 17 ESCRITO A MANO, no leído de la constante del módulo. Es un dato
    # sobre la cobertura de Esri en San Luis, no una preferencia nuestra:
    # comparar contra m.ZOOM_NATIVO_MAX hacía que el test pasara igual si
    # alguien subía la constante a 22, que es exactamente el cambio que
    # tiene que agarrar. Verificado: con la constante en 22 y este assert
    # contra ella, los cinco casos pasaban.
    assert all(z <= 17 for z in r), f"se le pidió a Esri {r}, y arriba de 17 devuelve gris"


def test_pasado_el_tope_los_tiles_se_agrandan_en_vez_de_pedirse_mas_cerca(evaluar):
    """Es lo que hace Leaflet con maxNativeZoom. Sin esto había que
    elegir entre cuadros grises (zoom alto) o lotes de 17 px (zoom
    tope), que es la "mota" que ya se arregló en el mapa."""
    r = evaluar(
        f"""(m) => {{
              const a = m.mosaicoSatelital(-32.41, -65.08, 17, {ANCHO}, {ALTO});
              const b = m.mosaicoSatelital(-32.41, -65.08, 19, {ANCHO}, {ALTO});
              return {{ ladoEnTope: a.lado, ladoMasCerca: b.lado, zA: a.zoomNativo, zB: b.zoomNativo }};
            }}"""
    )
    assert r["zA"] == r["zB"], "los dos tienen que pedirle a Esri el mismo zoom"
    assert r["ladoMasCerca"] == r["ladoEnTope"] * 4, "zoom 19 sobre 17 son dos duplicaciones"


def test_un_lote_chico_no_queda_como_una_mota(evaluar):
    """Un lote de 450 m² son unos 21 m de lado. A zoom 17 mide 17 px:
    la "mota" que ya costó un defecto en el mapa."""
    z = evaluar("(m) => m.zoomParaElLote(21, 300, -32.4)")
    assert z >= 18, f"para un lote de 21 m se eligió zoom {z}, que lo deja diminuto"


def test_un_lote_grande_no_se_sale_de_cuadro(evaluar):
    """Un campo de 7.344 m² son unos 86 m de lado."""
    z = evaluar("(m) => m.zoomParaElLote(86, 300, -32.4)")
    assert 15 <= z <= 19


def test_sin_geometria_no_se_inventa_un_zoom(evaluar):
    assert evaluar("(m) => m.zoomParaElLote(null)") == 17
    assert evaluar("(m) => m.zoomParaElLote(0)") == 17


def test_el_lado_del_lote_sale_de_su_geometria(evaluar):
    """~0,0007 grados de latitud son unos 78 m."""
    anillo = [
        {"lon": -65.0800, "lat": -32.4100},
        {"lon": -65.0793, "lat": -32.4100},
        {"lon": -65.0793, "lat": -32.4107},
        {"lon": -65.0800, "lat": -32.4107},
        {"lon": -65.0800, "lat": -32.4100},
    ]
    r = evaluar("(m, a) => m.ladoAproximadoEnMetros(a)", anillo)
    assert 60 < r < 100, f"midió {r} m"


def test_una_geometria_rota_no_tira(evaluar):
    """Lo que hay en Firestore lo pudo haber editado alguien a mano."""
    assert evaluar("(m) => m.ladoAproximadoEnMetros([])") is None
    assert evaluar("(m) => m.ladoAproximadoEnMetros(null)") is None
