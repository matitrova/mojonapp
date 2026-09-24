"""Los 8 defectos de la revisión visual que dejaban algo inusable.

DE DÓNDE SALEN. Una revisión de las quince pantallas, en escritorio y
teléfono, con cada hallazgo verificado por un agente independiente que
intentó refutarlo. Sobrevivieron 68; estos 8 son los que la revisión
marcó como "rompe": no se ven feos, directamente impiden hacer algo.

POR QUÉ UN ARCHIVO PROPIO Y NO REPARTIDOS. Son ocho cosas que ninguna
suite agarró durante meses, y todas por el mismo motivo: los tests
miraban el DOM (¿existe el botón? ¿dice lo que tiene que decir?) y estos
defectos son de GEOMETRÍA (¿el botón está dentro de la pantalla? ¿se
puede clickear? ¿el lote se ve?). Juntos dejan claro qué clase de
chequeo hacía falta, y que hay que seguir haciéndolo.

Casi todos miden posiciones y tamaños reales en el navegador. Es lento y
vale la pena: es la única forma de que fallen cuando el defecto vuelve.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import (
    abrir_menu,
    borrar_lote_de_prueba,
    crear_lote_de_prueba,
    esperar_sesion_en_el_menu,
    soltar_el_mouse,
)

TELEFONO = {"width": 390, "height": 800}
NOTEBOOK = {"width": 1366, "height": 768}
ESCRITORIO = {"width": 1280, "height": 800}


def _geometria(lon, lat, lado=0.0007):
    return {
        "type": "Polygon",
        "coordinates": [
            {"lon": lon, "lat": lat},
            {"lon": lon + lado, "lat": lat},
            {"lon": lon + lado, "lat": lat - lado},
            {"lon": lon, "lat": lat - lado},
            {"lon": lon, "lat": lat},
        ],
    }


# ---------------------------------------------------------------------------
# El mapa
# ---------------------------------------------------------------------------


def test_volver_al_mapa_desde_lotes_no_deja_el_mapa_vacio(page, base_url):
    """Entrando directo a /lotes y volviendo con la flecha ←, el mapa
    aparecía sobre El Desaguadero sin un solo lote: foto satelital pelada
    y la sensación de que la cartera está vacía.

    La causa: los lotes llegan de Firestore apenas arranca la app, y si
    el mapa está escondido su contenedor mide 0x0 — Leaflet encuadra
    sobre la nada y nadie volvía a encuadrar al mostrarlo.
    """
    doc_id = crear_lote_de_prueba(
        {"manzana": f"MAP-{uuid.uuid4().hex[:8]}", "lote": "1", "superficie_m2": 800,
         "estado": "disponible", "geometry": _geometria(-65.0800, -32.4100)}
    )
    try:
        page.set_viewport_size(ESCRITORIO)
        # Entrar DIRECTO a /lotes: así el mapa nunca se mostró.
        page.goto(f"{base_url}/lotes")
        page.wait_for_selector(f".lote-{doc_id}", state="attached", timeout=30000)

        page.locator("#vista-lista .btn-volver").first.click()
        page.wait_for_timeout(2500)

        # ¿Hay algún lote DENTRO de la pantalla? No alcanza con que esté
        # dibujado: el bug era justamente que estaban dibujados lejos.
        visibles = page.evaluate(
            """() => {
                 const m = document.getElementById('mapa').getBoundingClientRect();
                 return [...document.querySelectorAll('.lote-poligono')].filter((p) => {
                   const r = p.getBoundingClientRect();
                   return r.width > 0 && r.right > m.left && r.left < m.right
                       && r.bottom > m.top && r.top < m.bottom;
                 }).length;
               }"""
        )
        assert visibles > 0, "se volvió al mapa y no hay ni un lote en pantalla"
    finally:
        borrar_lote_de_prueba(doc_id)


def test_los_lotes_del_mapa_se_pueden_ver_y_tocar(page, base_url):
    """Al entrar, los lotes eran motas de 4x6 px: no se distinguía su
    color ni se podían tocar con el dedo (el tamaño táctil recomendado es
    44 px). El encuadre enfocaba el grupo más numeroso a zoom 13, que es
    exactamente el zoom donde un lote mide dos píxeles.
    """
    marcador = uuid.uuid4().hex[:8]
    # Dos grupos lejos entre sí: así entra la rama "enfocar un grupo",
    # que es la que estaba mal.
    ids = [
        crear_lote_de_prueba({"manzana": f"Z1-{marcador}", "lote": str(i), "superficie_m2": 900,
                              "estado": "disponible", "geometry": _geometria(-65.080 + i * 0.001, -32.410)})
        for i in range(3)
    ]
    ids.append(
        crear_lote_de_prueba({"manzana": f"Z2-{marcador}", "lote": "9", "superficie_m2": 900,
                              "estado": "disponible", "geometry": _geometria(-66.300, -33.500)})
    )
    try:
        page.set_viewport_size(ESCRITORIO)
        page.goto(base_url)
        page.wait_for_selector(f".lote-{ids[0]}", state="attached", timeout=30000)
        page.wait_for_timeout(3000)

        mayor = page.evaluate(
            """() => {
                 let mejor = 0;
                 for (const p of document.querySelectorAll('.lote-poligono')) {
                   const r = p.getBoundingClientRect();
                   mejor = Math.max(mejor, Math.min(r.width, r.height));
                 }
                 return Math.round(mejor);
               }"""
        )
        # 20 px es modesto y deja margen para que el encuadre cambie: lo
        # que se afirma es que un lote NO es una mota. Antes el más
        # grande medía 7 px de lado corto en teléfono.
        assert mayor >= 20, f"el lote más grande mide {mayor} px de lado: es una mota"
    finally:
        for i in ids:
            borrar_lote_de_prueba(i)


# ---------------------------------------------------------------------------
# El CRM
# ---------------------------------------------------------------------------


@pytest.mark.con_sesion
def test_en_telefono_nuevo_contacto_entra_en_la_pantalla(page, base_url):
    """La acción principal del CRM arrancaba en x=330 de una pantalla de
    390 y se leía "+ Nue". Y no había forma de llegar: nada scrollea
    horizontal ahí."""
    page.set_viewport_size(TELEFONO)
    page.goto(f"{base_url}/contactos")
    expect(page.locator("#panel-crm")).to_be_visible(timeout=20000)
    page.wait_for_timeout(1500)

    r = page.locator("#btn-agregar-contacto").bounding_box()
    assert r is not None
    assert r["x"] + r["width"] <= 391, (
        f"el botón termina en x={r['x'] + r['width']:.0f} y la pantalla mide 390"
    )
    assert r["x"] >= -1, f"el botón empieza fuera de pantalla, en x={r['x']:.0f}"


@pytest.mark.con_sesion
def test_las_acciones_del_crm_siguen_clickeables_al_scrollear(page, base_url):
    """El encabezado pegajoso pasaba POR ENCIMA de la barra de
    herramientas: los controles se veían cortados al medio y un click en
    su mitad superior se lo comía el encabezado. Parecía que los botones
    fallaban a veces.
    """
    page.set_viewport_size(ESCRITORIO)
    page.goto(f"{base_url}/contactos")
    expect(page.locator("#panel-crm")).to_be_visible(timeout=20000)
    page.wait_for_timeout(1500)
    page.evaluate("() => { document.getElementById('panel-crm').scrollTop = 700; }")
    page.wait_for_timeout(600)

    tapados = page.evaluate(
        """() => {
             const malos = [];
             for (const id of ['crm-buscar', 'btn-crm-modo-kanban', 'btn-crm-modo-tabla', 'btn-agregar-contacto']) {
               const el = document.getElementById(id);
               if (!el) continue;
               const r = el.getBoundingClientRect();
               if (r.width === 0) { malos.push(id + ' (no se ve)'); continue; }
               const arriba = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
               if (arriba !== el && !el.contains(arriba)) {
                 malos.push(id + ' tapado por ' + (arriba ? (arriba.className || arriba.tagName) : 'nada'));
               }
             }
             return malos;
           }"""
    )
    assert tapados == [], f"con el panel scrolleado, estos controles no se pueden clickear: {tapados}"


# ---------------------------------------------------------------------------
# Las tablas de administración
# ---------------------------------------------------------------------------


@pytest.mark.con_sesion
def test_en_telefono_los_botones_de_las_tablas_de_admin_se_alcanzan(page, base_url):
    """La tabla mide 600px y en un teléfono se ven 366: Editar y Borrar
    caían fuera de la pantalla. Se podía arrastrar la tabla de costado,
    pero no había barra ni sombra ni nada que lo dijera: esas pantallas
    parecían de solo lectura en el celular."""
    page.set_viewport_size(TELEFONO)
    nombre = f"Motivo-{uuid.uuid4().hex[:8]}"
    page.goto(f"{base_url}/motivos-de-perdida")
    expect(page.locator("#panel-motivos")).to_be_visible(timeout=20000)
    soltar_el_mouse(page)
    page.click("#btn-agregar-motivo")
    page.fill("#motivo-nombre", nombre)
    page.click("#formulario-motivo button[type=submit]")

    fila = page.locator("#tabla-motivos-cuerpo tr", has_text=nombre)
    expect(fila).to_be_visible(timeout=15000)
    try:
        boton = fila.locator(".btn-borrar-fila")
        r = boton.bounding_box()
        assert r is not None, "no se encontró el botón Borrar"
        assert r["x"] + r["width"] <= 391, (
            f"Borrar termina en x={r['x'] + r['width']:.0f} con la pantalla en 390"
        )
        # Y sigue ahí después de arrastrar la tabla: es una columna fija,
        # no un botón que justo entraba.
        page.evaluate("() => { document.querySelector('#panel-motivos .tabla-scroll').scrollLeft = 999; }")
        page.wait_for_timeout(400)
        r2 = boton.bounding_box()
        assert r2["x"] + r2["width"] <= 391, "al arrastrar la tabla, Borrar se fue de la pantalla"
    finally:
        page.once("dialog", lambda d: d.accept())
        fila.locator(".btn-borrar-fila").click()
        page.wait_for_timeout(1500)


@pytest.mark.con_sesion
def test_en_notebook_el_menu_no_esconde_pantallas_sin_avisar(page, base_url):
    """A 1366x768 el menú medía 1072px de contenido en 708 visibles y
    quedaban afuera cinco pantallas de administración, más el bloque de
    "quién sos". Scrolleaba, pero en Mac la barra se esconde sola y no
    había ninguna señal."""
    page.set_viewport_size(NOTEBOOK)
    page.goto(f"{base_url}/dashboard")
    page.wait_for_function(
        """() => { const b = document.getElementById('btn-abrir-auditoria');
                   return b && !b.classList.contains('oculto'); }""",
        timeout=30000,
    )
    page.wait_for_timeout(1200)

    estado = page.evaluate(
        """() => {
             const u = document.getElementById('lateral-usuario');
             const r = u.getBoundingClientRect();
             return { usuarioVisible: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.height > 0 };
           }"""
    )
    # "Quién sos" quedaba al final de un menú más alto que la pantalla.
    # Ahora está pegado abajo: si esto falla, volvió a irse de cuadro.
    assert estado["usuarioVisible"], "el bloque de usuario del menú quedó fuera de pantalla"


# ---------------------------------------------------------------------------
# El comparador
# ---------------------------------------------------------------------------


# Apartados pide sesión desde 2026-09-22: sin ella el botón del menú
# está oculto y el click no llega.
@pytest.mark.con_sesion
def test_el_comparador_en_telefono_no_pierde_las_etiquetas(page, base_url):
    """Al arrastrar la tabla de costado desaparecía la columna que dice
    QUÉ es cada valor (Zona, Barrio, Superficie, Estado, Precio): quedaban
    números sueltos. Comparar sin saber qué se compara no es comparar.

    CUATRO LOTES, NO DOS. Con dos, la tabla entra en una pantalla de
    390px y no hay nada que arrastrar: el test pasaba igual con el
    arreglo sacado, o sea que no probaba nada. Se comprueba primero que
    la tabla DE VERDAD se haya corrido, y recién después que la columna
    de etiquetas se haya quedado.
    """
    marcador = uuid.uuid4().hex[:8]
    ids = [
        crear_lote_de_prueba({
            "manzana": f"CM-{marcador}", "lote": str(i), "superficie_m2": 300 + i * 100,
            "estado": "disponible", "precio_usd": 12000 + i * 1000,
            "sector": "Potrero de los Funes", "barrio": "Las Chacras",
            "geometry": _geometria(-65.0600 + i * 0.001, -32.4000),
        })
        for i in range(1, 5)
    ]
    try:
        page.set_viewport_size(TELEFONO)
        page.goto(base_url)
        page.evaluate("ids => localStorage.setItem('mojonapp_favoritos', JSON.stringify(ids))", ids)
        page.reload()
        page.wait_for_selector(f".lote-{ids[0]}", state="attached", timeout=30000)

        esperar_sesion_en_el_menu(page)
        abrir_menu(page)
        page.locator("#btn-abrir-favoritos").click()
        soltar_el_mouse(page)
        for i in ids:
            page.locator(f'li[data-lote-id="{i}"] .favorito-comparar-check').check()
        page.locator("#btn-comparar-favoritos").click()
        expect(page.locator("#tabla-comparar-lotes")).to_be_visible(timeout=15000)
        page.wait_for_timeout(700)

        etiqueta = page.locator("#tabla-comparar-lotes tbody tr", has_text="Superficie").locator("th, td").first
        antes = etiqueta.bounding_box()

        corrido = page.evaluate(
            """() => { const c = document.querySelector('#panel-comparar-lotes .tabla-scroll');
                       if (!c) return -1;
                       c.scrollLeft = 9999;
                       return c.scrollLeft; }"""
        )
        page.wait_for_timeout(500)

        # PRECONDICIÓN. Sin esto el test no prueba nada: si la tabla no
        # se corre, la columna no se puede haber ido.
        assert corrido > 50, (
            f"la tabla no se corrió ({corrido}px): con cuatro lotes tiene que desbordar "
            "una pantalla de 390px, o este test no está probando el arrastre"
        )

        despues = etiqueta.bounding_box()
        assert despues is not None and despues["width"] > 0, "la columna de etiquetas desapareció al arrastrar"
        assert abs(despues["x"] - antes["x"]) < 8, (
            f"la columna de etiquetas se corrió de x={antes['x']:.0f} a x={despues['x']:.0f}: "
            "dejó de estar pegada y los valores quedan sin nombre"
        )
    finally:
        for i in ids:
            borrar_lote_de_prueba(i)


# ---------------------------------------------------------------------------
# La página del comprador
# ---------------------------------------------------------------------------


@pytest.fixture
def lote_vendido():
    doc_id = crear_lote_de_prueba(
        {"manzana": f"VEN-{uuid.uuid4().hex[:8]}", "lote": "3", "superficie_m2": 700,
         "estado": "vendido", "precio_usd": 18500, "sector": "Carpintería",
         "geometry": _geometria(-65.0700, -32.4200)}
    )
    try:
        yield doc_id
    finally:
        borrar_lote_de_prueba(doc_id)


def test_un_lote_vendido_no_pide_consultas(page, base_url, lote_vendido, inmobiliaria_configurada):
    """Un lote vendido se veía igual que uno en venta: precio gigante,
    formulario completo y botón de WhatsApp. Lo único que lo decía era
    una fila chica entre Superficie y Zona. El comprador mandaba la
    consulta igual y del otro lado llegaba un lead por algo que ya no se
    puede vender.
    """
    page.set_viewport_size(ESCRITORIO)
    page.goto(f"{base_url}/lote/{lote_vendido}")
    expect(page.locator("#lp-contenido")).to_be_visible(timeout=25000)
    page.wait_for_timeout(2500)

    expect(page.locator("#lp-estado")).to_be_visible()
    expect(page.locator("#lp-estado")).to_have_text("Vendido")
    expect(page.locator("#lp-contacto")).to_be_hidden()
    expect(page.locator("#lp-whatsapp")).to_be_hidden()
    # Y no queda en un callejón: se le ofrece el catálogo.
    expect(page.locator("#lp-no-disponible")).to_be_visible()
    expect(page.locator("#lp-ver-otras")).to_be_visible()


def test_un_lote_disponible_sigue_pidiendo_consultas(page, base_url, inmobiliaria_configurada):
    """El otro lado del mismo arreglo: sin esto, esconder el formulario
    de más pasaría desapercibido — y sería peor que el defecto."""
    doc_id = crear_lote_de_prueba(
        {"manzana": f"DIS-{uuid.uuid4().hex[:8]}", "lote": "4", "superficie_m2": 700,
         "estado": "disponible", "precio_usd": 20000, "geometry": _geometria(-65.0710, -32.4210)}
    )
    try:
        page.set_viewport_size(ESCRITORIO)
        page.goto(f"{base_url}/lote/{doc_id}")
        expect(page.locator("#lp-contenido")).to_be_visible(timeout=25000)
        page.wait_for_timeout(2000)
        expect(page.locator("#lp-estado")).to_be_hidden()
        expect(page.locator("#lp-contacto")).to_be_visible()
        expect(page.locator("#lp-no-disponible")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(doc_id)


def test_un_lote_reservado_avisa_pero_deja_consultar(page, base_url, inmobiliaria_configurada):
    """Reservado no es vendido: una reserva se cae. Se avisa, pero no se
    corta el contacto."""
    doc_id = crear_lote_de_prueba(
        {"manzana": f"RES-{uuid.uuid4().hex[:8]}", "lote": "5", "superficie_m2": 700,
         "estado": "reservado", "precio_usd": 21000, "geometry": _geometria(-65.0720, -32.4220)}
    )
    try:
        page.set_viewport_size(ESCRITORIO)
        page.goto(f"{base_url}/lote/{doc_id}")
        expect(page.locator("#lp-contenido")).to_be_visible(timeout=25000)
        page.wait_for_timeout(2000)
        expect(page.locator("#lp-estado")).to_have_text("Reservado")
        expect(page.locator("#lp-contacto")).to_be_visible()
    finally:
        borrar_lote_de_prueba(doc_id)
