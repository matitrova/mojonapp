"""La imagen que se ve al compartir un link por WhatsApp o Facebook.

QUÉ CUBRE Y POR QUÉ. Son metaetiquetas que solo lee un crawler externo,
así que la app puede funcionar perfecto con esto roto y nadie se entera
hasta que alguien se manda el link a sí mismo. Por eso se blindan acá.

ERA UN SVG Y NO SERVÍA. Durante un tiempo og:image apuntó a
og-imagen.svg, y WhatsApp y Facebook DESCARTAN el SVG: la tarjeta salía
sin ninguna imagen, que es exactamente lo que esa etiqueta venía a
arreglar. Ahora es un PNG generado desde ese SVG con
scripts/generar_og_imagen.py.

Es la imagen de RESERVA: cuando se comparte un lote con fotos, el
middleware la reemplaza por la foto de la propiedad (ver
functions/_middleware.js y tests/test_compartir_lote_publico.py).
"""

from playwright.sync_api import expect

IMAGEN = "https://mojonapp.com.ar/og-imagen.png"


def test_metaetiquetas_og_apuntan_a_la_imagen_de_marca(page, base_url):
    page.goto(base_url)

    # La app corre en un puerto local durante el test, pero la etiqueta
    # tiene que quedar siempre con el dominio real (WhatsApp/Facebook no
    # van a poder pedirle nada a localhost) — se verifica el dominio
    # absoluto puesto a mano en index.html, no algo relativo al
    # base_url del test.
    #
    # Al compartir un LOTE el middleware reescribe esto al vuelo con el
    # origen que está atendiendo el pedido, para que desde la vista
    # previa no apunte a un archivo que ahí no existe.
    expect(page.locator('meta[property="og:image"]')).to_have_attribute("content", IMAGEN)
    expect(page.locator('meta[property="og:image:type"]')).to_have_attribute("content", "image/png")
    expect(page.locator('meta[name="twitter:card"]')).to_have_attribute("content", "summary_large_image")
    expect(page.locator('meta[name="twitter:image"]')).to_have_attribute("content", IMAGEN)


def test_la_imagen_existe_y_es_un_png_de_verdad(page, base_url):
    """OJO CON EL 200 QUE MIENTE. Cloudflare Pages sirve el index.html
    con HTTP 200 para cualquier ruta que no existe, así que un chequeo de
    status no distingue "está" de "no está": hay que mirar el tipo.
    """
    response = page.goto(f"{base_url}/og-imagen.png")
    assert response.ok
    tipo = (response.header_value("content-type") or "").lower()
    assert "png" in tipo, f"og-imagen.png no es un PNG, sirve {tipo!r}"


def test_ninguna_metaetiqueta_de_imagen_quedo_en_svg(page, base_url):
    """Guardia explícito: el defecto no era que faltara la etiqueta, era
    que apuntaba a un formato que los dos crawlers tiran a la basura."""
    page.goto(base_url)
    contenidos = page.evaluate(
        """() => [...document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')]
                  .map((m) => m.content)"""
    )
    assert contenidos, "no quedó ninguna metaetiqueta de imagen"
    for c in contenidos:
        assert not c.endswith(".svg"), f"apunta a un SVG, que WhatsApp descarta: {c}"
