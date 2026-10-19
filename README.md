# Ubicación + Equipamiento urbano

Herramienta de campo para la valoración de inmuebles: ubica el predio, mide
distancias al equipamiento urbano cercano y calcula el factor de ubicación.

Factor = coeficiente de distancia × coeficiente de acceso × coeficiente del
equipamiento dominante, acotado entre 0.70 y 1.19.

Los coeficientes son los mismos de la hoja **LISTAS** de la ficha de valoración
(`FICHA_VALORACION_10_2026`), así que lo que se mide aquí se copia tal cual a
**INVEST CAMPO** y a **FICHA-A**.

| Banda de distancia | Hasta | Coeficiente |
|---|---|---|
| En el punto de mayor valor | 100 m | 1.00 |
| Muy próximo | 300 m | 0.98 |
| Distancia media | 600 m | 0.95 |
| Alejado / periférico | 1000 m | 0.80 |
| En el extremo del sector | más de 1000 m | 0.70 |

El efecto del equipamiento es completo hasta 300 m y decrece linealmente hasta
cero a los 1000 m. Solo rige el equipamiento dominante, es decir, el que más se
aleja de 1.00.

## Datos

- Mapa y teselas: OpenStreetMap
- Geocodificación: Nominatim
- Equipamiento cercano: Overpass API

OpenStreetMap es colaborativo. Que un equipamiento no aparezca no prueba que no
exista, y lo que aparece puede estar mal clasificado. El criterio del perito
siempre manda: las casillas se marcan y se desmarcan a mano.

## Publicar

Es un sitio estático. Los archivos van en la raíz del repositorio y GitHub Pages
los sirve tal cual; no hay que compilar nada.

## Archivos

- `index.html` — página
- `app.js` — la calculadora
- `manifest.webmanifest`, `icon-180.png`, `icon-512.png` — para instalarla en el
  teléfono desde el navegador
