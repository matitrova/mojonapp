"""
Test liviano para la imagen de marca del preview de WhatsApp/Facebook
(idea #10): confirma que las metaetiquetas Open Graph/Twitter apuntan a
og-imagen.svg con card "summary_large_image" — no hay nada interactivo
que probar acá (son metaetiquetas que solo lee el crawler externo, no
la propia app), pero vale la pena blindarlas contra un cambio futuro
que las borre sin querer.
"""

from playwright.sync_api import expect


def test_metaetiquetas_og_apuntan_a_la_imagen_de_marca(page, base_url):
    page.goto(base_url)

    # La app corre en un puerto local durante el test, pero la etiqueta
    # tiene que quedar siempre con el dominio real (WhatsApp/Facebook no
    # van a poder pedirle nada a localhost) — se verifica el dominio
    # absoluto puesto a mano en index.html, no algo relativo al
    # base_url del test.
    expect(page.locator('meta[property="og:image"]')).to_have_attribute(
        "content", "https://mojonapp.com.ar/og-imagen.svg"
    )
    expect(page.locator('meta[name="twitter:card"]')).to_have_attribute("content", "summary_large_image")
    expect(page.locator('meta[name="twitter:image"]')).to_have_attribute(
        "content", "https://mojonapp.com.ar/og-imagen.svg"
    )


def test_og_imagen_svg_carga_sin_errores(page, base_url):
    response = page.goto(f"{base_url}/og-imagen.svg")
    assert response.ok
    assert "svg" in (response.header_value("content-type") or "").lower()
