"""Las tarjetas del Dashboard muestran la variación contra el mes anterior.

Pedido del rediseño del 2026-09-18: las tarjetas del mockup decían
"+12.5% vs. mes anterior".

POR QUÉ NO USA FIRESTORE. Los contactos se inyectan en el estado en
memoria de la app (setContactosActuales) y se pide el re-render. Así el
test puede plantar una historia de tres meses —que es lo que la
comparación necesita— sin sembrar nada en la base, sin gastar cuota de
lecturas y sin depender de qué día del mes se corra. Lo que se prueba
acá es el DIBUJO: que el porcentaje aparezca, con el signo y el color
correctos. El cálculo tiene sus propios tests en test_comparacion.py.

EL COLOR ES LA MITAD DE LA INFORMACIÓN, y por eso se chequea: en "Sin
atender" y "Estancados" bajar es la buena noticia, así que un -40% ahí
va en verde. Si se pintara por el signo, el dashboard estaría dando la
alarma justo cuando las cosas mejoran.
"""

import pytest
from playwright.sync_api import expect

# Fechas relativas al mes: el test tiene que dar lo mismo el día 1 que
# el 28, así que las arma el navegador a partir de la fecha de hoy.
SEMBRAR = """(contactos) => Promise.all([
     import('/js/estado.js'),
     import('/js/dashboard.js'),
   ]).then(([estado, dashboard]) => {
     estado.setContactosActuales(contactos);
     dashboard.renderDashboard();
     return estado.getContactosActuales().length;
   })"""

# Un contacto "de antes": creado hace `diasAtras`, con su cambio de
# etapa en la fecha que se pida.
ARMAR = """([viejos, nuevos, laSemanaPasada]) => {
     const dia = 86400000;
     const ahora = new Date();
     const cierreMesPasado = new Date(ahora.getFullYear(), ahora.getMonth(), 0, 23, 59, 59);
     const contactos = [];
     // Los "viejos" nacieron bien antes del cierre del mes pasado.
     for (let i = 0; i < viejos; i++) {
       contactos.push({
         id: `viejo-${i}`,
         nombre: `Viejo ${i}`,
         estado: 'contactado',
         fecha_creacion: new Date(cierreMesPasado.getTime() - 60 * dia).toISOString(),
         fecha_actualizacion: new Date(cierreMesPasado.getTime() - 60 * dia).toISOString(),
         actividades: [],
         lotes_interes: [],
       });
     }
     // Los "nuevos" nacieron después del cierre: suman a hoy y no al pasado.
     for (let i = 0; i < nuevos; i++) {
       contactos.push({
         id: `nuevo-${i}`,
         nombre: `Nuevo ${i}`,
         estado: 'nuevo',
         fecha_creacion: new Date(ahora.getTime() - 1 * dia).toISOString(),
         fecha_actualizacion: new Date(ahora.getTime() - 1 * dia).toISOString(),
         actividades: [],
         lotes_interes: [],
       });
     }
     // Los de "la semana pasada" nacieron entre 7 y 14 días atrás: son
     // la BASE de la tarjeta de ventana ("Nuevos (7 días)"). Sin ellos
     // la ventana anterior vale 0 y no hay porcentaje posible — que es
     // el comportamiento correcto, pero deja la tarjeta sin variación.
     for (let i = 0; i < laSemanaPasada; i++) {
       contactos.push({
         id: `semana-${i}`,
         nombre: `Semana ${i}`,
         estado: 'nuevo',
         fecha_creacion: new Date(ahora.getTime() - 10 * dia).toISOString(),
         fecha_actualizacion: new Date(ahora.getTime() - 10 * dia).toISOString(),
         actividades: [],
         lotes_interes: [],
       });
     }
     return contactos;
   }"""


@pytest.fixture
def app(page, base_url):
    page.goto(base_url)
    page.wait_for_function("() => window.L", timeout=30000)

    def _sembrar(viejos, nuevos, la_semana_pasada=0):
        contactos = page.evaluate(ARMAR, [viejos, nuevos, la_semana_pasada])
        page.evaluate(SEMBRAR, contactos)
        # El dashboard está oculto sin sesión; para leer el HTML no hace
        # falta verlo, y así el test no depende del login.
        return page.locator("#dashboard-ventas-stats")

    return _sembrar


def test_muestra_la_variacion_cuando_hay_mes_anterior(app):
    """4 contactos el mes pasado, 6 hoy: +50%."""
    stats = app(viejos=4, nuevos=2)
    expect(stats).to_contain_text("+50%")
    expect(stats).to_contain_text("vs. mes anterior")


def test_mas_contactos_se_pinta_de_buena_noticia(app):
    """El color es la mitad de la información: verde o rojo es lo que se
    lee de un vistazo, antes que el número."""
    stats = app(viejos=4, nuevos=2)
    # La primera tarjeta es "Contactos": subir es bueno.
    variacion = stats.locator(".crm-stat", has_text="Contactos").first.locator(".crm-stat-variacion")
    expect(variacion).to_have_class("crm-stat-variacion buena")


def test_sin_mes_anterior_no_muestra_nada(app):
    """La base arrancó este mes. Mostrar "0%" sería afirmar que no
    cambió nada, y no lo sabemos: no había con qué comparar."""
    stats = app(viejos=0, nuevos=5)
    expect(stats).to_contain_text("Contactos")
    expect(stats).not_to_contain_text("vs. mes anterior")


def test_la_ventana_de_7_dias_se_compara_contra_la_semana_anterior(app):
    """Comparar una ventana de 7 días contra un mes entero daría 7
    contra 30: un número catastrófico que no significa nada. Por eso esa
    tarjeta lleva otra leyenda.

    Necesita gente en la semana ANTERIOR para tener base: sin eso la
    variación es null y la tarjeta no muestra nada, que es lo correcto
    (lo cubre el test de abajo).
    """
    stats = app(viejos=4, nuevos=2, la_semana_pasada=4)
    expect(stats).to_contain_text("vs. semana anterior")


def test_sin_semana_anterior_esa_tarjeta_no_muestra_variacion(app):
    """Pasar de 0 a 2 no es "+200%": no había base."""
    stats = app(viejos=4, nuevos=2)
    expect(stats).not_to_contain_text("vs. semana anterior")


def test_las_tarjetas_de_plata_no_muestran_variacion(app):
    """No hay historial de precios, así que el valor de hace un mes se
    calcularía con los precios de hoy: un número que nunca existió, en
    las tarjetas que se miran para decidir. Ver js/historial-precios.js."""
    stats = app(viejos=4, nuevos=2)
    html = stats.inner_html()
    # Se recorta el bloque de las tres últimas tarjetas y se comprueba
    # que ninguna traiga el <em> de la variación.
    for clase in ("crm-stat-valor", "crm-stat-comision", "crm-stat-comision-ganada"):
        trozo = html.split(clase, 1)[1].split("</div>", 1)[0]
        assert "crm-stat-variacion" not in trozo, (
            f"la tarjeta {clase} muestra una variación y no debería: no hay "
            f"historial de precios con el que calcularla"
        )
