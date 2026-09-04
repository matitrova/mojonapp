#!/usr/bin/env python3
"""
Servidor estático para probar la app en local, igual que
`python3 -m http.server`, pero sin caché.

Por qué existe: http.server no manda ningún header de Cache-Control, así
que el navegador cachea los módulos JS con "heuristic freshness" (RFC
7234) y una sesión de prueba larga puede terminar viendo un js/*.js
viejo aunque el archivo en disco ya se haya editado — el índice
(index.html) tiene su propio `?v=` para cache-busting, pero los módulos
que importa entre sí (ficha.js, vista-lista.js, etc.) no, así que quedan
a merced del caché del navegador. Pasó en vivo: vista-lista.js se sirvió
cacheado (deliveryType "cache", transferSize 0) incluso después de varias
recargas normales, y una edición nueva no se reflejaba hasta forzar un
fetch con cache:"no-store".

Solo para desarrollo local — no toca nada de producción (Cloudflare
Pages sirve los archivos reales con sus propios headers).
"""

import http.server
import sys


class ManejadorSinCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    http.server.test(HandlerClass=ManejadorSinCache, port=puerto)
