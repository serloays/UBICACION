"use strict";
const { useEffect, useMemo, useRef, useState } = React;
/* ──────────────────────────────────────────────────────────────
   Calculadora — Factor Ubicación + Equipamiento Urbano
   Factor = C_distancia × C_acceso × C_equipamiento(dominante)
   Acotado entre piso (0.70) y techo (1.19)

   Capa GIS (sin claves ni cuentas):
   - Geocodificación: Nominatim (OpenStreetMap)
   - Equipamiento cercano: Overpass API (OpenStreetMap)
   - Mapa: Leaflet + teselas de OpenStreetMap
   OSM es colaborativo: que no aparezca un equipamiento NO prueba que
   no exista. El criterio del perito (checkboxes) siempre manda.
   ────────────────────────────────────────────────────────────── */
const DIST_DEFAULT = [
    { label: "En el punto de mayor valor", hint: "Hasta 100 m del polo de valor", c: 1.0 },
    { label: "Muy próximo", hint: "Hasta 300 m", c: 0.98 },
    { label: "Distancia media", hint: "Hasta 600 m", c: 0.95 },
    { label: "Alejado / periférico", hint: "Hasta 1000 m", c: 0.8 },
    { label: "En el extremo del sector", hint: "Más de 1000 m", c: 0.7 },
];
const ACC_DEFAULT = [
    { label: "Vía principal / eje consolidado", hint: "Frente directo, alto tránsito", c: 1.0 },
    { label: "Vía secundaria consolidada", hint: "Pavimentada, servicios completos", c: 0.95 },
    { label: "Calle interior", hint: "Menor jerarquía", c: 0.88 },
    { label: "Pasaje / callejón", hint: "Acceso restringido", c: 0.79 },
    { label: "Servidumbre", hint: "Sin frente a vía pública", c: 0.7 },
];
const EQUIP_DEFAULT = [
    { label: "Parque", c: 1.08 },
    { label: "Centro comercial", c: 1.07 },
    { label: "Zona bancaria / financiera", c: 1.05 },
    { label: "Institución educativa", c: 1.04 },
    { label: "Centro de salud / clínica pequeña", c: 0.97 },
    { label: "Estación de bomberos", c: 0.95 },
    { label: "Mercado / terminal terrestre", c: 0.88 },
    { label: "Cementerio", c: 0.88 },
    { label: "Hospital", c: 0.88 },
    { label: "Gasolinera / subestación / industria", c: 0.87 },
    { label: "Cárcel / centro de rehabilitación", c: 0.83 },
];
// Etiquetas OSM por categoría: [clave, valor]. Una categoría se marca si
// algún elemento cercano cumple al menos una de sus etiquetas.
const OSM_TAGS = {
    "Parque": [["leisure", "park"]],
    "Centro comercial": [["shop", "mall"]],
    "Zona bancaria / financiera": [["amenity", "bank"]],
    "Institución educativa": [
        ["amenity", "school"],
        ["amenity", "college"],
        ["amenity", "university"],
    ],
    "Centro de salud / clínica pequeña": [
        ["amenity", "clinic"],
        ["amenity", "doctors"],
    ],
    "Estación de bomberos": [["amenity", "fire_station"]],
    "Mercado / terminal terrestre": [
        ["amenity", "marketplace"],
        ["amenity", "bus_station"],
    ],
    "Cementerio": [
        ["amenity", "grave_yard"],
        ["landuse", "cemetery"],
    ],
    "Hospital": [["amenity", "hospital"]],
    "Gasolinera / subestación / industria": [
        ["amenity", "fuel"],
        ["power", "substation"],
        ["landuse", "industrial"],
    ],
    "Cárcel / centro de rehabilitación": [["amenity", "prison"]],
};
const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];
const MACHALA_CENTER = [-3.2586, -79.9554];
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
const BANDS = [
    { min: 1.1, name: "Premiada", color: "#7FA65A" },
    { min: 1.0, name: "Favorable", color: "#E9B44C" },
    { min: 0.9, name: "Neutra", color: "#B7A26A" },
    { min: 0.8, name: "Desfavorable", color: "#C97B63" },
    { min: 0.0, name: "Muy desfavorable (piso)", color: "#A8574A" },
];
function nivelFor(f) {
    return BANDS.find((b) => f >= b.min) || BANDS[BANDS.length - 1];
}
function clampRange(v, lo, hi) {
    if (isNaN(v))
        return lo;
    return Math.min(hi, Math.max(lo, v));
}
function haversine(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const sLat = Math.sin(dLat / 2), sLng = Math.sin(dLng / 2);
    const h = sLat * sLat + Math.cos(lat1) * Math.cos(lat2) * sLng * sLng;
    return 2 * R * Math.asin(Math.sqrt(h));
}
// Carga única de Leaflet (CSS + JS) desde cdnjs
function loadLeaflet() {
    if (window.__leafletPromise)
        return window.__leafletPromise;
    window.__leafletPromise = new Promise((resolve, reject) => {
        if (window.L) {
            resolve(window.L);
            return;
        }
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = LEAFLET_CSS;
        document.head.appendChild(css);
        const script = document.createElement("script");
        script.src = LEAFLET_JS;
        script.async = true;
        script.onload = () => resolve(window.L);
        script.onerror = () => {
            window.__leafletPromise = null;
            reject(new Error("No se pudo cargar el mapa (Leaflet). Revisa tu conexión."));
        };
        document.head.appendChild(script);
    });
    return window.__leafletPromise;
}
// UTM (WGS84 / SIRGAS-ECU, zona 17 Sur: Machala y El Oro) → grados decimales
function utmToLatLng(E, N, zone = 17) {
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
    const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const x = E - 500000, y = N - 10000000; // hemisferio sur
    const M = y / k0;
    const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const phi1 = mu +
        (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) +
        (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
        (151 * e1 ** 3 / 96) * Math.sin(6 * mu) +
        (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
    const C1 = ep2 * c * c, T1 = t * t;
    const N1 = a / Math.sqrt(1 - e2 * s * s);
    const R1 = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
    const D = x / (N1 * k0);
    const lat = phi1 -
        ((N1 * t) / R1) *
            (D * D / 2 -
                ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
                ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
    const lon0 = ((zone * 6 - 183) * Math.PI) / 180;
    const lon = lon0 +
        (D -
            ((1 + 2 * T1 + C1) * D ** 3) / 6 +
            ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) /
            c;
    return { lat: (lat * 180) / Math.PI, lng: (lon * 180) / Math.PI };
}
// Acepta: grados decimales "lat, lng", UTM 17S "Este, Norte" o una dirección (Nominatim)
async function geocode(q) {
    // Acepta punto o coma decimal (613995,343  9641151,066 / 616057.3, 9639763.1 / -3.2586, -79.9554)
    const m = q.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/);
    if (m) {
        let a = parseFloat(m[1].replace(",", "."));
        let b = parseFloat(m[2].replace(",", "."));
        if (Math.abs(a) > 1000 || Math.abs(b) > 1000) {
            // Rectangulares UTM: si vienen como Norte, Este se invierten
            if (a > 5000000 && b < 1000000)
                [a, b] = [b, a];
            if (a < 100000 || a > 900000 || b < 9000000 || b > 10000000) {
                throw new Error("Coordenadas UTM fuera de rango para Ecuador (zona 17 Sur). Ingresa Este, Norte — ej. 616057, 9639763.");
            }
            return utmToLatLng(a, b);
        }
        if (Math.abs(a) > 90 || Math.abs(b) > 180) {
            throw new Error("Grados decimales fuera de rango. Usa el formato: latitud, longitud (ej. -3.2586, -79.9554).");
        }
        return { lat: a, lng: b };
    }
    const full = /machala/i.test(q) ? q : `${q}, Machala, Ecuador`;
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ec&q=" +
        encodeURIComponent(full);
    let res;
    try {
        res = await fetch(url, { headers: { "Accept-Language": "es" } });
    }
    catch (_a) {
        throw new Error("Este entorno no tiene conexión con el buscador de direcciones de OpenStreetMap. Ingresa las coordenadas del predio (UTM o lat, lng).");
    }
    if (!res.ok)
        throw new Error("El servicio de direcciones no respondió. Intenta de nuevo.");
    const arr = await res.json();
    if (!arr.length) {
        throw new Error("OpenStreetMap no encontró esa dirección. Toca el mapa para ubicar el predio, o pega coordenadas (lat, lng).");
    }
    return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
}
function buildQuery(lat, lng, radius) {
    const parts = [];
    Object.values(OSM_TAGS).forEach((sels) => sels.forEach(([k, v]) => parts.push(`nwr["${k}"="${v}"](around:${radius},${lat},${lng});`)));
    return `[out:json][timeout:25];(${parts.join("")});out center tags;`;
}
async function overpass(query) {
    let lastErr = null;
    for (const url of OVERPASS_ENDPOINTS) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
            const res = await fetch(url, {
                method: "POST",
                body: "data=" + encodeURIComponent(query),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                signal: ctrl.signal,
            });
            if (!res.ok)
                throw new Error("HTTP " + res.status);
            return await res.json();
        }
        catch (e) {
            lastErr = e;
        }
        finally {
            clearTimeout(timer);
        }
    }
    const red = lastErr && (lastErr.name === "TypeError" || /fetch|network/i.test(lastErr.message || ""));
    throw new Error(red
        ? "Este entorno no tiene conexión con los servidores de OpenStreetMap (la app o el navegador la bloquea). Usa la consulta manual de abajo."
        : "El servidor de OpenStreetMap (Overpass) no respondió" +
            (lastErr ? ` (${lastErr.message})` : "") +
            ". Espera un momento e intenta de nuevo, o usa la consulta manual de abajo.");
}
function UbicacionEquipamiento() {
    const [distIdx, setDistIdx] = useState(0);
    const [accIdx, setAccIdx] = useState(0);
    const [dist, setDist] = useState(DIST_DEFAULT);
    const [acc, setAcc] = useState(ACC_DEFAULT);
    const [equip, setEquip] = useState(EQUIP_DEFAULT);
    const [selected, setSelected] = useState({});
    const [floor, setFloor] = useState(0.7);
    const [ceiling, setCeiling] = useState(1.19);
    const [radio, setRadio] = useState(1000);
    const [radioPleno, setRadioPleno] = useState(300);
    const [distManual, setDistManual] = useState({}); // { [i]: "450" } distancia escrita a mano (m)
    const [calibrar, setCalibrar] = useState(false);
    // GIS
    const [address, setAddress] = useState("");
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState(null);
    const [autoResults, setAutoResults] = useState({}); // { [equipIndex]: {distance, name, location, count} }
    const [geoLocation, setGeoLocation] = useState(null);
    const [leafletReady, setLeafletReady] = useState(false);
    const [mapStatus, setMapStatus] = useState("cargando"); // cargando | ok | tiles | libreria
    const [manual, setManual] = useState(null); // { loc, url } cuando no hay conexión con Overpass
    const [manualText, setManualText] = useState("");
    const mapDivRef = useRef(null);
    const mapRef = useRef(null);
    const layerRef = useRef(null);
    const autoRef = useRef({});
    const buscarRef = useRef(null);
    const tileErrRef = useRef(0);
    const cDist = dist[distIdx].c;
    const cAcc = acc[accIdx].c;
    // Atenuación por distancia: efecto completo hasta radioPleno, decrece linealmente a 0 en el radio
    const peso = (d) => {
        if (d == null || d <= radioPleno)
            return 1;
        if (d >= radio)
            return 0;
        return (radio - d) / (radio - radioPleno);
    };
    const { cEquip, dominant, activeItems } = useMemo(() => {
        const active = equip
            .map((e, i) => {
            var _a;
            const dm = parseFloat(String((_a = distManual[i]) !== null && _a !== void 0 ? _a : "").replace(",", "."));
            const d = Number.isFinite(dm) && dm >= 0 ? dm : autoResults[i] ? autoResults[i].distance : null; // sin distancia = efecto completo
            const w = peso(d);
            return { ...e, w, ce: 1 + (e.c - 1) * w, d };
        })
            .filter((_, i) => selected[i]);
        if (active.length === 0)
            return { cEquip: 1.0, dominant: null, activeItems: active };
        const dom = active.reduce((best, cur) => Math.abs(cur.ce - 1) > Math.abs(best.ce - 1) ? cur : best);
        return { cEquip: dom.ce, dominant: dom, activeItems: active };
    }, [equip, selected, autoResults, distManual, radio, radioPleno]);
    const raw = cDist * cAcc * cEquip;
    const flooredByRule = raw < floor;
    const cappedByRule = raw > ceiling;
    const appliedExact = clampRange(raw, floor, ceiling);
    const applied = Math.round(appliedExact * 100) / 100;
    const nivel = nivelFor(appliedExact);
    const toggle = (i) => setSelected((s) => ({ ...s, [i]: !s[i] }));
    const setDistC = (i, v) => setDist((d) => d.map((x, k) => (k === i ? { ...x, c: clampRange(v, floor, 1) } : x)));
    const setAccC = (i, v) => setAcc((d) => d.map((x, k) => (k === i ? { ...x, c: clampRange(v, floor, 1) } : x)));
    const setEquipC = (i, v) => setEquip((d) => d.map((x, k) => (k === i ? { ...x, c: clampRange(v, floor, ceiling) } : x)));
    const reset = () => {
        setDist(DIST_DEFAULT);
        setAcc(ACC_DEFAULT);
        setEquip(EQUIP_DEFAULT);
        setFloor(0.7);
        setCeiling(1.19);
        setRadio(1000);
    };
    // Busca equipamiento alrededor de un punto ya conocido
    // Convierte una respuesta de Overpass en equipamiento detectado
    const aplicarResultados = (loc, data) => {
        const results = {};
        for (const el of data.elements || []) {
            if (!el.tags)
                continue;
            const pos = el.type === "node"
                ? { lat: el.lat, lng: el.lon }
                : el.center
                    ? { lat: el.center.lat, lng: el.center.lon }
                    : null;
            if (!pos)
                continue;
            const d = Math.round(haversine(loc, pos));
            equip.forEach((e, i) => {
                const sels = OSM_TAGS[e.label];
                if (!sels || !sels.some(([k, v]) => el.tags[k] === v))
                    return;
                const prev = results[i];
                const name = el.tags.name || el.tags["name:es"] || "Sin nombre en OSM";
                if (!prev)
                    results[i] = { distance: d, name, location: pos, count: 1 };
                else {
                    prev.count += 1;
                    if (d < prev.distance) {
                        prev.distance = d;
                        prev.name = name;
                        prev.location = pos;
                    }
                }
            });
        }
        // Reemplaza las marcas automáticas anteriores; conserva las manuales
        const newSel = {};
        Object.keys(results).forEach((k) => (newSel[k] = true));
        setSelected((s) => {
            const next = { ...s };
            Object.keys(autoRef.current).forEach((k) => delete next[k]);
            return { ...next, ...newSel };
        });
        autoRef.current = results;
        setAutoResults(results);
    };
    const buscarEn = async (loc) => {
        setSearching(true);
        setSearchError(null);
        setManual(null);
        setGeoLocation(loc);
        try {
            const data = await overpass(buildQuery(loc.lat, loc.lng, radio));
            aplicarResultados(loc, data);
        }
        catch (e) {
            setSearchError(e.message || "Ocurrió un error al buscar equipamiento.");
            setManual({
                loc,
                urls: [
                    ["Servidor 1", "https://overpass.kumi.systems/api/interpreter"],
                    ["Servidor 2", "https://overpass.private.coffee/api/interpreter"],
                    ["Servidor 3", "https://overpass-api.de/api/interpreter"],
                ].map(([n, u]) => [n, u + "?data=" + encodeURIComponent(buildQuery(loc.lat, loc.lng, radio))]),
            });
        }
        finally {
            setSearching(false);
        }
    };
    buscarRef.current = buscarEn;
    // Consulta manual: el resultado de Overpass se pega aquí cuando el entorno no tiene red
    const procesarManual = () => {
        try {
            const data = JSON.parse(manualText.trim());
            if (!data || !Array.isArray(data.elements))
                throw new Error("sin elements");
            aplicarResultados(manual.loc, data);
            setSearchError(null);
            setManual(null);
            setManualText("");
        }
        catch (_a) {
            setSearchError('El texto pegado no es una respuesta válida de Overpass. Debe ser el texto completo que empieza con { "version": … y contiene "elements".');
        }
    };
    // Centra el mapa en el predio (si ya hay uno) o en Machala
    const centrarMapa = () => {
        const map = mapRef.current;
        if (!map)
            return;
        if (geoLocation)
            map.setView([geoLocation.lat, geoLocation.lng], 16);
        else
            map.setView(MACHALA_CENTER, 14);
    };
    const buscarDireccion = async () => {
        if (!address.trim()) {
            setSearchError("Ingresa una dirección, coordenadas (lat, lng) o toca el mapa.");
            return;
        }
        setSearching(true);
        setSearchError(null);
        try {
            const loc = await geocode(address);
            await buscarEn(loc);
        }
        catch (e) {
            setSearchError(e.message || "No se pudo ubicar el predio.");
            setSearching(false);
        }
    };
    // Inicializa el mapa (Leaflet) una sola vez
    useEffect(() => {
        let cancelled = false;
        loadLeaflet()
            .then((L) => {
            if (cancelled || !mapDivRef.current || mapRef.current)
                return;
            // Controles de zoom propios (más abajo): no dependen del CSS externo de Leaflet
            const map = L.map(mapDivRef.current, { zoomControl: false }).setView(MACHALA_CENTER, 14);
            setTimeout(() => map.invalidateSize(), 250);
            const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 19,
                attribution: "© OpenStreetMap contributors",
            }).addTo(map);
            // 'load' también se dispara cuando los tiles fallan: se cuentan los errores del ciclo
            tiles.on("loading", () => {
                tileErrRef.current = 0;
            });
            tiles.on("tileerror", () => {
                tileErrRef.current += 1;
            });
            tiles.on("load", () => setMapStatus(tileErrRef.current > 0 ? "tiles" : "ok"));
            setTimeout(() => setMapStatus((s) => (s === "cargando" ? "tiles" : s)), 10000);
            layerRef.current = L.layerGroup().addTo(map);
            map.on("click", (ev) => {
                if (buscarRef.current)
                    buscarRef.current({ lat: ev.latlng.lat, lng: ev.latlng.lng });
            });
            mapRef.current = map;
            setLeafletReady(true);
        })
            .catch(() => setMapStatus("libreria"));
        return () => {
            cancelled = true;
            if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
                layerRef.current = null;
            }
        };
    }, []);
    // Dibuja predio, radio y equipamiento detectado
    useEffect(() => {
        const L = window.L;
        const map = mapRef.current;
        const layer = layerRef.current;
        if (!L || !map || !layer)
            return;
        layer.clearLayers();
        if (!geoLocation)
            return;
        const center = [geoLocation.lat, geoLocation.lng];
        const circle = L.circle(center, {
            radius: radio,
            color: "#E9B44C",
            weight: 1,
            fillColor: "#E9B44C",
            fillOpacity: 0.05,
        }).addTo(layer);
        L.circleMarker(center, {
            radius: 8,
            color: "#12161C",
            weight: 2,
            fillColor: "#E9B44C",
            fillOpacity: 1,
        })
            .addTo(layer)
            .bindTooltip("Predio en estudio");
        Object.entries(autoResults).forEach(([i, r]) => {
            const c = equip[i] ? equip[i].c : 1;
            const col = c > 1 ? "#7FA65A" : c < 1 ? "#C97B63" : "#8A93A0";
            L.circleMarker([r.location.lat, r.location.lng], {
                radius: 6,
                color: "#12161C",
                weight: 1,
                fillColor: col,
                fillOpacity: 0.95,
            })
                .addTo(layer)
                .bindTooltip(`${r.name} · ${r.distance} m`);
        });
        map.fitBounds(circle.getBounds(), { padding: [10, 10] });
    }, [geoLocation, autoResults, radio, equip, leafletReady]);
    return (React.createElement("div", { className: "ue-root" },
        React.createElement("style", null, CSS),
        React.createElement("header", { className: "ue-head" },
            React.createElement("div", { className: "ue-eyebrow" }, "Aval\u00FAo \u00B7 Suelo"),
            React.createElement("h1", { className: "ue-title" }, "Ubicaci\u00F3n + Equipamiento urbano"),
            React.createElement("p", { className: "ue-sub" }, "Distancia \u00D7 Acceso \u00D7 Equipamiento (dominante)"),
            React.createElement("span", { className: "ue-chip" },
                "Piso ",
                floor.toFixed(2),
                " \u00B7 Techo ",
                ceiling.toFixed(2),
                " \u00B7 Radio ",
                radio,
                " m")),
        React.createElement("section", { className: "ue-group" },
            React.createElement("div", { className: "ue-glabel" },
                "Distancia al punto de mayor valor",
                React.createElement("span", { className: "ue-ghint" }, "Qu\u00E9 tan lejos est\u00E1 el predio del polo de valor")),
            React.createElement("div", { className: "ue-options" }, dist.map((d, i) => (React.createElement(Option, { key: i, active: i === distIdx, onClick: () => setDistIdx(i), label: d.label, hint: d.hint, coef: d.c, editable: calibrar, onEdit: (v) => setDistC(i, v) }))))),
        React.createElement("section", { className: "ue-group" },
            React.createElement("div", { className: "ue-glabel" },
                "Acceso al predio",
                React.createElement("span", { className: "ue-ghint" }, "Jerarqu\u00EDa de la v\u00EDa por la que se accede")),
            React.createElement("div", { className: "ue-options" }, acc.map((d, i) => (React.createElement(Option, { key: i, active: i === accIdx, onClick: () => setAccIdx(i), label: d.label, hint: d.hint, coef: d.c, editable: calibrar, onEdit: (v) => setAccC(i, v) }))))),
        React.createElement("section", { className: "ue-group" },
            React.createElement("div", { className: "ue-glabel" },
                "Detecci\u00F3n autom\u00E1tica (OpenStreetMap)",
                React.createElement("span", { className: "ue-ghint" }, "Ubica el predio y busca equipamiento en el radio \u00B7 sin claves ni cuentas")),
            React.createElement("div", { className: "ue-gis-row" },
                React.createElement("input", { className: "ue-gis-input", type: "text", placeholder: "Direcci\u00F3n, o coordenadas (Este, Norte UTM 17S / lat, lng)", value: address, onChange: (e) => setAddress(e.target.value), onKeyDown: (e) => e.key === "Enter" && buscarDireccion() }),
                React.createElement("button", { className: "ue-gis-btn", onClick: buscarDireccion, disabled: searching }, searching ? "Buscando…" : "Buscar")),
            React.createElement("p", { className: "ue-gis-tip" }, "Coordenadas aceptadas: rectangulares UTM zona 17 Sur WGS84 (Este, Norte \u2014 ej. 616057, 9639763; se acepta punto o coma decimal) o grados decimales (lat, lng \u2014 ej. -3.2586, -79.9554). Tambi\u00E9n puedes tocar el mapa si OpenStreetMap no conoce la direcci\u00F3n."),
            searchError && React.createElement("div", { className: "ue-gis-error" }, searchError),
            manual && (React.createElement("div", { className: "ue-manual" },
                React.createElement("p", { className: "ue-gis-tip", style: { margin: "0 0 8px" } }, "Consulta manual: abre este enlace en el navegador de tu tel\u00E9fono o computadora, copia todo el texto que aparece y p\u00E9galo abajo."),
                manual.urls.map(([n, u]) => (React.createElement("div", { key: n },
                    React.createElement("a", { className: "ue-manual-link", href: u, target: "_blank", rel: "noopener noreferrer" },
                        "Abrir consulta \u00B7 ",
                        n,
                        " \u2197")))),
                React.createElement("p", { style: { opacity: 0.7, fontSize: 12 } }, "Si un servidor muestra error o no responde, prueba con el siguiente."),
                React.createElement("textarea", { className: "ue-manual-text", rows: 4, placeholder: 'Pega aqu\u00ED el resultado (empieza con { "version": \u2026)', value: manualText, onChange: (e) => setManualText(e.target.value) }),
                React.createElement("button", { className: "ue-gis-btn ue-manual-btn", onClick: procesarManual, disabled: !manualText.trim() }, "Procesar resultado"))),
            React.createElement("div", { className: "ue-map-wrap" },
                React.createElement("div", { className: "ue-map", ref: mapDivRef }),
                React.createElement("div", { className: "ue-map-ctrl" },
                    React.createElement("button", { type: "button", "aria-label": "Acercar", onClick: () => mapRef.current && mapRef.current.zoomIn() }, "+"),
                    React.createElement("button", { type: "button", "aria-label": "Alejar", onClick: () => mapRef.current && mapRef.current.zoomOut() }, "\u2212"),
                    React.createElement("button", { type: "button", "aria-label": "Centrar", title: "Centrar en el predio (o en Machala)", onClick: centrarMapa }, "\u25CE"))),
            mapStatus !== "ok" && (React.createElement("div", { className: "ue-map-status" + (mapStatus === "cargando" ? "" : " warn") },
                mapStatus === "cargando" && "Cargando mapa base…",
                mapStatus === "tiles" &&
                    "Este entorno no muestra las imágenes del mapa base de OpenStreetMap. La búsqueda funciona igual: usa el esquema de abajo.",
                mapStatus === "libreria" &&
                    "No cargó la librería del mapa en este entorno. Ingresa coordenadas y usa el esquema de abajo; la búsqueda funciona igual.")),
            React.createElement(Schema, { geo: geoLocation, radio: radio, results: autoResults, equip: equip }),
            React.createElement("p", { className: "ue-gis-footnote" }, "OpenStreetMap es colaborativo: si un equipamiento no aparece, no significa que no exista. Verifica en campo y ajusta los checkboxes con tu criterio. \"Centro de rehabilitaci\u00F3n\" no tiene etiqueta confiable en OSM; solo se detectan c\u00E1rceles.")),
        React.createElement("section", { className: "ue-group" },
            React.createElement("div", { className: "ue-glabel" },
                "Equipamiento urbano cercano",
                React.createElement("span", { className: "ue-ghint" },
                    "Marca lo presente dentro del radio \u00B7 efecto completo hasta ",
                    radioPleno,
                    " m, se aten\u00FAa hasta 0 a ",
                    radio,
                    " m \u00B7 aplica el m\u00E1s dominante")),
            React.createElement("div", { className: "ue-eq-list" }, equip.map((e, i) => {
                const isActive = !!selected[i];
                const isDominant = dominant && dominant.label === e.label && isActive;
                const isPremia = e.c > 1;
                const isCastiga = e.c < 1;
                const auto = autoResults[i];
                return (React.createElement("div", { key: i, className: "ue-eq-wrap" },
                    React.createElement("div", { className: "ue-eq" + (isActive ? " active" : "") + (isDominant ? " dominant" : "") },
                        React.createElement("button", { className: "ue-eq-main", onClick: () => toggle(i) },
                            React.createElement("span", { className: "ue-eq-box" }),
                            React.createElement("span", { className: "ue-eq-text" },
                                React.createElement("span", { className: "ue-eq-label" }, e.label),
                                React.createElement("span", { className: "ue-eq-tag", style: { color: isPremia ? "#7FA65A" : isCastiga ? "#C97B63" : "#8A93A0" } },
                                    isPremia ? "Premia" : isCastiga ? "Castiga" : "Neutro",
                                    isDominant && " · dominante"),
                                auto && (React.createElement("span", { className: "ue-eq-auto" },
                                    "Detectado \u00B7 \u2248",
                                    auto.distance,
                                    " m \u00B7 ",
                                    auto.name,
                                    auto.count > 1 && ` (+${auto.count - 1})`,
                                    " · efecto ",
                                    Math.round(peso(auto.distance) * 100),
                                    "%",
                                    " → ",
                                    (1 + (e.c - 1) * peso(auto.distance)).toFixed(2))))),
                        calibrar ? (React.createElement("input", { className: "ue-eq-input", type: "number", step: "0.01", min: floor, max: ceiling, value: e.c, onChange: (ev) => setEquipC(i, parseFloat(ev.target.value)) })) : (React.createElement("span", { className: "ue-eq-coef" }, e.c.toFixed(2)))),
                    isActive && (() => {
                        var _a, _b;
                        const dm = parseFloat(String((_a = distManual[i]) !== null && _a !== void 0 ? _a : "").replace(",", "."));
                        const dUso = Number.isFinite(dm) && dm >= 0 ? dm : auto ? auto.distance : null;
                        const w = peso(dUso);
                        return (React.createElement("label", { className: "ue-eq-dist" },
                            "Distancia (m)",
                            React.createElement("input", { type: "text", inputMode: "decimal", placeholder: auto ? String(auto.distance) : "0–" + radio, value: (_b = distManual[i]) !== null && _b !== void 0 ? _b : "", onChange: (ev) => setDistManual((m) => ({ ...m, [i]: ev.target.value })) }),
                            React.createElement("span", null, dUso == null
                                ? "sin distancia → efecto 100%"
                                : (Number.isFinite(dm) && dm >= 0 ? "manual" : "detectada") + " · efecto " + Math.round(w * 100) + "% → " + (1 + (e.c - 1) * w).toFixed(2))));
                    })()));
            })),
            activeItems.length === 0 && (React.createElement("p", { className: "ue-eq-empty" }, "Sin equipamiento relevante marcado \u2192 factor 1.00"))),
        React.createElement("section", { className: "ue-result", style: { borderColor: nivel.color + "66" } },
            React.createElement("div", { className: "ue-result-top" },
                React.createElement("span", { className: "ue-result-eyebrow" }, "Factor aplicable"),
                React.createElement("span", { className: "ue-badge", style: { color: nivel.color, borderColor: nivel.color + "66" } }, nivel.name)),
            React.createElement("div", { className: "ue-value", style: { color: nivel.color } }, applied.toFixed(2)),
            React.createElement("div", { className: "ue-calc" },
                React.createElement("span", { className: "ue-mono" }, cDist.toFixed(2)),
                React.createElement("span", { className: "ue-times" }, "\u00D7"),
                React.createElement("span", { className: "ue-mono" }, cAcc.toFixed(2)),
                React.createElement("span", { className: "ue-times" }, "\u00D7"),
                React.createElement("span", { className: "ue-mono" }, cEquip.toFixed(2)),
                React.createElement("span", { className: "ue-times" }, "="),
                React.createElement("span", { className: "ue-mono ue-raw" }, raw.toFixed(3))),
            dominant && (React.createElement("div", { className: "ue-dom-note" },
                "Equipamiento dominante: ",
                React.createElement("strong", null, dominant.label),
                " (",
                dominant.c.toFixed(2),
                dominant.w < 1 && ` × efecto ${Math.round(dominant.w * 100)}% a ${dominant.d} m = ${dominant.ce.toFixed(2)}`,
                ")",
                activeItems.length > 1 && ` — de ${activeItems.length} marcados`)),
            flooredByRule && (React.createElement("div", { className: "ue-clamp-note" },
                "Piso aplicado \u2014 el producto bruto (",
                raw.toFixed(3),
                ") se ajusta a ",
                floor.toFixed(2),
                ".")),
            cappedByRule && (React.createElement("div", { className: "ue-clamp-note ue-clamp-pos" },
                "Techo aplicado \u2014 el producto bruto (",
                raw.toFixed(3),
                ") se ajusta a ",
                ceiling.toFixed(2),
                "."))),
        React.createElement("p", { className: "ue-note" },
            "Multiplica el ",
            React.createElement("strong", null, "valor unitario base"),
            " del suelo. Analiza aparte frente, fondo, forma y topograf\u00EDa para no penalizar dos veces la misma caracter\u00EDstica."),
        React.createElement("div", { className: "ue-calib" },
            React.createElement("button", { className: "ue-calib-toggle", onClick: () => setCalibrar((v) => !v), "aria-expanded": calibrar },
                React.createElement("span", { className: "ue-chev" + (calibrar ? " open" : "") }, "\u25B8"),
                "Calibrar al mercado local"),
            calibrar && (React.createElement("div", { className: "ue-calib-body" },
                React.createElement("p", { className: "ue-calib-hint" }, "Edita los coeficientes de cada opci\u00F3n arriba, o el piso / techo / radio aqu\u00ED."),
                React.createElement("div", { className: "ue-calib-grid" },
                    React.createElement("label", { className: "ue-calib-field" },
                        React.createElement("span", null, "Piso"),
                        React.createElement("input", { type: "number", step: "0.01", value: floor, onChange: (e) => setFloor(clampRange(parseFloat(e.target.value), 0, ceiling)) })),
                    React.createElement("label", { className: "ue-calib-field" },
                        React.createElement("span", null, "Techo"),
                        React.createElement("input", { type: "number", step: "0.01", value: ceiling, onChange: (e) => setCeiling(clampRange(parseFloat(e.target.value), floor, 3)) })),
                    React.createElement("label", { className: "ue-calib-field" },
                        React.createElement("span", null, "Radio (m)"),
                        React.createElement("input", { type: "number", step: "50", value: radio, onChange: (e) => setRadio(Math.max(0, parseFloat(e.target.value) || 0)) }))),
                React.createElement("button", { className: "ue-reset", onClick: reset }, "Restablecer valores de referencia"))))));
}
const SHORT = {
    "Parque": "Parque",
    "Centro comercial": "C. comercial",
    "Zona bancaria / financiera": "Banco",
    "Institución educativa": "Educación",
    "Centro de salud / clínica pequeña": "C. salud",
    "Estación de bomberos": "Bomberos",
    "Mercado / terminal terrestre": "Mercado/Terminal",
    "Cementerio": "Cementerio",
    "Hospital": "Hospital",
    "Gasolinera / subestación / industria": "Gasolinera/Ind.",
    "Cárcel / centro de rehabilitación": "Cárcel",
};
// Esquema de distancias: no depende de mapa base ni de librerías externas.
// Norte arriba; el predio al centro; anillos al 25/50/75/100 % del radio.
function Schema({ geo, radio, results, equip }) {
    const S = 300, C = 150, R = 118;
    if (!geo) {
        return React.createElement("div", { className: "ue-schema ue-schema-empty" }, "Busca un predio para ver el esquema de distancias.");
    }
    const k = R / Math.max(radio, 1);
    const cosLat = Math.cos((geo.lat * Math.PI) / 180);
    const pts = Object.entries(results).map(([i, r]) => {
        const dx = (r.location.lng - geo.lng) * 111320 * cosLat; // este (m)
        const dy = (r.location.lat - geo.lat) * 110540; // norte (m)
        const d = Math.hypot(dx, dy);
        const f = d > radio ? radio / d : 1; // polígonos grandes: se ajusta al borde
        const c = equip[i] ? equip[i].c : 1;
        const nombre = equip[i] ? SHORT[equip[i].label] || equip[i].label : "";
        return {
            i,
            x: C + dx * f * k,
            y: C - dy * f * k,
            color: c > 1 ? "#7FA65A" : c < 1 ? "#C97B63" : "#8A93A0",
            label: `${nombre} ${r.distance} m`,
        };
    });
    return (React.createElement("div", { className: "ue-schema" },
        React.createElement("svg", { viewBox: `0 0 ${S} ${S}`, role: "img", "aria-label": "Esquema de distancias al predio", style: { overflow: "visible" } },
            [0.25, 0.5, 0.75, 1].map((f) => (React.createElement("g", { key: f },
                React.createElement("circle", { cx: C, cy: C, r: R * f, fill: "none", stroke: "#2C333D", strokeWidth: "1", strokeDasharray: f === 1 ? "0" : "3 3" }),
                React.createElement("text", { x: C, y: C + R * f + 9, textAnchor: "middle", fontSize: "8", fill: "#8A93A0", fontFamily: "monospace" },
                    Math.round(radio * f),
                    " m")))),
            React.createElement("text", { x: C, y: 14, textAnchor: "middle", fontSize: "10", fill: "#8A93A0", fontFamily: "monospace" }, "N \u2191"),
            pts.map((p) => (React.createElement("g", { key: p.i },
                React.createElement("circle", { cx: p.x, cy: p.y, r: "5", fill: p.color, stroke: "#12161C", strokeWidth: "1" }),
                React.createElement("text", { x: p.x + (p.x > 170 ? -8 : 8), y: p.y + 3, textAnchor: p.x > 170 ? "end" : "start", fontSize: "8.5", fill: "#E8E6E0", fontFamily: "monospace" }, p.label)))),
            React.createElement("circle", { cx: C, cy: C, r: "7", fill: "#E9B44C", stroke: "#12161C", strokeWidth: "2" }),
            React.createElement("text", { x: C, y: C - 11, textAnchor: "middle", fontSize: "8.5", fill: "#E9B44C", fontFamily: "monospace" }, "Predio"))));
}
function Option({ active, onClick, label, hint, coef, editable, onEdit }) {
    return (React.createElement("div", { className: "ue-opt" + (active ? " active" : "") },
        React.createElement("button", { className: "ue-opt-main", onClick: onClick },
            React.createElement("span", { className: "ue-dot" }),
            React.createElement("span", { className: "ue-opt-text" },
                React.createElement("span", { className: "ue-opt-label" }, label),
                React.createElement("span", { className: "ue-opt-hint" }, hint))),
        editable ? (React.createElement("input", { className: "ue-opt-input", type: "number", step: "0.01", value: coef, onChange: (e) => onEdit(parseFloat(e.target.value)) })) : (React.createElement("span", { className: "ue-opt-coef" }, coef.toFixed(2)))));
}
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

.ue-root{
  --ink:#12161C; --panel:#1A2028; --line:#2C333D;
  --txt:#E8E6E0; --muted:#8A93A0; --gold:#E9B44C;
  --pos:#7FA65A; --neg:#C97B63;
  --sans:'Space Grotesk',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--ink); color:var(--txt); font-family:var(--sans);
  min-height:100vh; box-sizing:border-box;
  max-width:480px; margin:0 auto; padding:26px 18px 40px;
  -webkit-font-smoothing:antialiased;
}
.ue-root *{box-sizing:border-box;}

.ue-head{margin-bottom:20px;}
.ue-eyebrow{
  font-family:var(--mono); font-size:11px; letter-spacing:.22em;
  text-transform:uppercase; color:var(--gold); margin-bottom:8px;
}
.ue-title{font-size:22px; font-weight:600; line-height:1.18; margin:0; letter-spacing:-.01em;}
.ue-sub{font-family:var(--mono); font-size:12.5px; color:var(--muted); margin:8px 0 0;}
.ue-chip{
  display:inline-block; margin-top:12px; padding:5px 11px;
  font-family:var(--mono); font-size:10.5px; color:var(--gold);
  border:1px solid rgba(233,180,76,.35); border-radius:20px;
  background:rgba(233,180,76,.08);
}

.ue-group{margin-bottom:20px;}
.ue-glabel{font-size:14px; font-weight:600; margin-bottom:11px; display:flex; flex-direction:column; gap:2px;}
.ue-ghint{font-family:var(--mono); font-size:11px; font-weight:400; color:var(--muted);}

.ue-options{display:flex; flex-direction:column; gap:7px;}
.ue-opt{
  display:flex; align-items:stretch; gap:8px;
  background:var(--panel); border:1px solid var(--line); border-radius:11px; overflow:hidden;
  transition:border-color .2s ease, background .2s ease;
}
.ue-opt.active{border-color:var(--gold); background:#20262E;}
.ue-opt-main{
  flex:1; display:flex; align-items:center; gap:11px; background:transparent; border:0;
  color:inherit; cursor:pointer; padding:11px 4px 11px 13px; text-align:left;
  font-family:var(--sans); min-height:52px;
}
.ue-dot{flex:none; width:15px; height:15px; border-radius:50%; border:2px solid var(--line); position:relative;}
.ue-opt.active .ue-dot{border-color:var(--gold);}
.ue-opt.active .ue-dot::after{content:""; position:absolute; inset:2.5px; border-radius:50%; background:var(--gold);}
.ue-opt-text{display:flex; flex-direction:column; gap:1px; min-width:0;}
.ue-opt-label{font-size:13.5px; font-weight:500; line-height:1.2;}
.ue-opt-hint{font-family:var(--mono); font-size:10.5px; color:var(--muted); line-height:1.3;}
.ue-opt-coef{
  flex:none; display:flex; align-items:center; padding:0 15px;
  font-family:var(--mono); font-size:14px; font-weight:500; color:var(--muted);
  border-left:1px solid var(--line);
}
.ue-opt.active .ue-opt-coef{color:var(--txt);}
.ue-opt-input{
  flex:none; width:64px; margin:8px 8px 8px 0; padding:6px;
  background:var(--ink); border:1px solid var(--line); border-radius:7px;
  color:var(--txt); font-family:var(--mono); font-size:13px; text-align:center;
}

/* GIS */
.ue-gis-row{display:flex; gap:8px; margin-bottom:8px;}
.ue-gis-input{
  flex:1; min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:9px;
  padding:10px 12px; color:var(--txt); font-family:var(--sans); font-size:13.5px;
}
.ue-gis-input:focus{outline:none; border-color:var(--gold);}
.ue-gis-btn{
  flex:none; background:var(--gold); color:#1A1403; border:0; border-radius:9px;
  padding:0 16px; font-family:var(--sans); font-weight:600; font-size:13px; cursor:pointer;
}
.ue-gis-btn:disabled{opacity:.6; cursor:default;}
.ue-gis-tip{font-family:var(--mono); font-size:10.5px; color:var(--muted); line-height:1.5; margin:0 2px 10px;}
.ue-gis-error{
  background:rgba(201,123,99,.1); border:1px solid rgba(201,123,99,.3); border-radius:9px;
  padding:9px 12px; font-family:var(--mono); font-size:11.5px; color:#D89685; margin-bottom:10px;
}
.ue-manual{
  background:var(--panel); border:1px solid var(--line); border-radius:10px;
  padding:12px; margin-bottom:10px;
}
.ue-manual-link{
  display:inline-block; font-family:var(--mono); font-size:12px; color:var(--gold);
  margin-bottom:10px; text-decoration:underline;
}
.ue-manual-text{
  display:block; width:100%; background:var(--ink); border:1px solid var(--line); border-radius:8px;
  padding:9px 10px; color:var(--txt); font-family:var(--mono); font-size:11.5px; resize:vertical;
  margin-bottom:8px;
}
.ue-manual-text:focus{outline:none; border-color:var(--gold);}
.ue-manual-btn{width:100%; padding:11px 16px;}
.ue-map-status{
  font-family:var(--mono); font-size:11px; line-height:1.5; color:var(--muted);
  margin:-2px 2px 10px;
}
.ue-map-status.warn{
  background:rgba(233,180,76,.08); border:1px solid rgba(233,180,76,.25); border-radius:9px;
  padding:9px 12px; margin:0 0 10px; color:var(--gold);
}
.ue-schema{
  background:#0d1014; border:1px solid var(--line); border-radius:12px;
  padding:8px 8px 12px; margin-bottom:10px;
}
.ue-schema svg{width:100%; height:auto; display:block;}
.ue-schema-empty{
  font-family:var(--mono); font-size:11px; color:var(--muted); text-align:center; padding:22px 12px;
}
.ue-map-wrap{position:relative; margin-bottom:10px;}
.ue-map{
  position:relative; z-index:0;
  width:100%; height:260px; border-radius:12px; border:1px solid var(--line);
  overflow:hidden; background:#0d1014;
}
.ue-map-ctrl{
  position:absolute; top:10px; right:10px; z-index:5;
  display:flex; flex-direction:column; gap:6px;
}
.ue-map-ctrl button{
  width:38px; height:38px; border-radius:9px; border:1px solid var(--line);
  background:rgba(18,22,28,.92); color:var(--txt); font-family:var(--mono);
  font-size:20px; line-height:1; cursor:pointer; touch-action:manipulation;
}
.ue-map-ctrl button:active{border-color:var(--gold); color:var(--gold);}

/* Estilos estructurales mínimos de Leaflet, integrados para que el mapa
   funcione aunque la hoja de estilos externa no cargue */
.leaflet-container{overflow:hidden; position:relative; -webkit-tap-highlight-color:transparent;}
.leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-tile-container,
.leaflet-pane>svg,.leaflet-pane>canvas,.leaflet-zoom-box,.leaflet-image-layer,.leaflet-layer{position:absolute; left:0; top:0;}
.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow{user-select:none; -webkit-user-drag:none;}
.leaflet-tile{filter:inherit; visibility:hidden;}
.leaflet-tile-loaded{visibility:inherit;}
.leaflet-container img.leaflet-tile{max-width:none !important; max-height:none !important; width:256px; height:256px;}
.leaflet-container .leaflet-overlay-pane svg{max-width:none !important; max-height:none !important;}
.leaflet-container.leaflet-touch-drag{touch-action:none;}
.leaflet-pane{z-index:400;}
.leaflet-tile-pane{z-index:200;}
.leaflet-overlay-pane{z-index:400;}
.leaflet-shadow-pane{z-index:500;}
.leaflet-marker-pane{z-index:600;}
.leaflet-tooltip-pane{z-index:650;}
.leaflet-popup-pane{z-index:700;}
.leaflet-map-pane svg{z-index:200;}
.leaflet-zoom-anim .leaflet-zoom-animated{will-change:transform; transition:transform .25s cubic-bezier(0,0,.25,1);}
.leaflet-zoom-anim .leaflet-tile,.leaflet-pan-anim .leaflet-tile{transition:none;}
.leaflet-zoom-anim .leaflet-zoom-hide{visibility:hidden;}
.leaflet-interactive{cursor:pointer;}
.leaflet-grab{cursor:grab;}
.leaflet-dragging .leaflet-grab{cursor:move;}
.leaflet-control-container .leaflet-control-attribution{
  position:absolute; right:0; bottom:0; z-index:800; background:rgba(18,22,28,.8);
  color:var(--muted); font-size:9.5px; padding:1px 6px; font-family:var(--sans);
}
.leaflet-control-attribution a{color:var(--muted);}
.leaflet-tooltip{
  position:absolute; padding:4px 8px; background:#12161C; color:#E8E6E0;
  border:1px solid #2C333D; border-radius:6px; font:11px var(--mono); white-space:nowrap; pointer-events:none;
}
.ue-gis-footnote{font-family:var(--mono); font-size:10.5px; color:var(--muted); line-height:1.5; margin:4px 2px 0;}

/* Equipamiento */
.ue-eq-list{display:flex; flex-direction:column; gap:7px;}
.ue-eq-wrap{display:flex; flex-direction:column;}
.ue-eq-dist{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:4px 4px 0; padding:6px 10px; font-family:var(--mono); font-size:10px; color:var(--muted); background:rgba(255,255,255,.03); border:1px dashed var(--line); border-radius:8px;}
.ue-eq-dist input{width:84px; background:var(--panel); color:var(--txt); border:1px solid var(--line); border-radius:6px; padding:5px 7px; font-family:var(--mono); font-size:12px;}
.ue-eq-dist span{color:var(--gold);}
.ue-eq{
  display:flex; align-items:stretch; gap:8px;
  background:var(--panel); border:1px solid var(--line); border-radius:11px; overflow:hidden;
  transition:border-color .2s ease, background .2s ease;
}
.ue-eq.active{border-color:var(--muted); background:#20262E;}
.ue-eq.dominant{border-color:var(--gold); box-shadow:0 0 0 1px rgba(233,180,76,.25) inset;}
.ue-eq-main{
  flex:1; display:flex; align-items:center; gap:11px; background:transparent; border:0;
  color:inherit; cursor:pointer; padding:11px 4px 11px 13px; text-align:left;
  font-family:var(--sans); min-height:50px;
}
.ue-eq-box{
  flex:none; width:15px; height:15px; border-radius:4px; border:2px solid var(--line); position:relative;
}
.ue-eq.active .ue-eq-box{border-color:var(--gold); background:var(--gold);}
.ue-eq-text{display:flex; flex-direction:column; gap:1px; min-width:0;}
.ue-eq-label{font-size:13px; font-weight:500; line-height:1.25;}
.ue-eq-tag{font-family:var(--mono); font-size:10px; letter-spacing:.03em; text-transform:uppercase;}
.ue-eq-auto{font-family:var(--mono); font-size:10px; color:var(--gold); line-height:1.4;}
.ue-eq-coef{
  flex:none; display:flex; align-items:center; padding:0 15px;
  font-family:var(--mono); font-size:14px; font-weight:500; color:var(--muted);
  border-left:1px solid var(--line);
}
.ue-eq.active .ue-eq-coef{color:var(--txt);}
.ue-eq-input{
  flex:none; width:64px; margin:8px 8px 8px 0; padding:6px;
  background:var(--ink); border:1px solid var(--line); border-radius:7px;
  color:var(--txt); font-family:var(--mono); font-size:13px; text-align:center;
}
.ue-eq-empty{font-family:var(--mono); font-size:11px; color:var(--muted); margin:10px 2px 0;}

/* Resultado */
.ue-result{
  margin-top:24px; padding:18px 18px 20px; border-radius:14px;
  background:linear-gradient(180deg,#171C23,#12161C); border:1px solid;
}
.ue-result-top{display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;}
.ue-result-eyebrow{font-family:var(--mono); font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--muted);}
.ue-badge{
  font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:.06em;
  padding:4px 10px; border:1px solid; border-radius:20px;
}
.ue-value{font-family:var(--mono); font-size:52px; font-weight:600; line-height:1; letter-spacing:-.02em; margin:2px 0 10px;}
.ue-calc{display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:13.5px; flex-wrap:wrap;}
.ue-mono{color:var(--txt);}
.ue-times{color:var(--muted);}
.ue-raw{color:var(--muted); font-size:13px;}

.ue-dom-note{
  margin-top:12px; padding:9px 12px; border-radius:9px;
  background:rgba(233,180,76,.08); border:1px solid rgba(233,180,76,.25);
  font-family:var(--mono); font-size:11px; line-height:1.5; color:var(--muted);
}
.ue-dom-note strong{color:var(--txt);}
.ue-clamp-note{
  margin-top:10px; padding:9px 12px; border-radius:9px;
  background:rgba(201,123,99,.1); border:1px solid rgba(201,123,99,.3);
  font-family:var(--mono); font-size:11px; line-height:1.5; color:#D89685;
}
.ue-clamp-note.ue-clamp-pos{background:rgba(127,166,90,.1); border-color:rgba(127,166,90,.3); color:#A8C98C;}

.ue-note{margin:16px 2px 0; font-size:12.5px; line-height:1.55; color:var(--muted);}
.ue-note strong{color:var(--txt); font-weight:600;}

.ue-calib{margin-top:20px; border-top:1px solid var(--line); padding-top:14px;}
.ue-calib-toggle{
  display:flex; align-items:center; gap:9px; width:100%; background:transparent; border:0;
  color:var(--txt); cursor:pointer; font-family:var(--sans); font-size:13.5px; font-weight:500; padding:4px 0;
}
.ue-chev{display:inline-block; color:var(--gold); transition:transform .2s ease;}
.ue-chev.open{transform:rotate(90deg);}
.ue-calib-body{padding:10px 2px 0;}
.ue-calib-hint{font-family:var(--mono); font-size:11px; color:var(--muted); line-height:1.5; margin:0 0 12px;}
.ue-calib-grid{display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:12px;}
.ue-calib-field{display:flex; flex-direction:column; gap:5px; font-family:var(--mono); font-size:10px; color:var(--muted);}
.ue-calib-field input{
  background:var(--panel); border:1px solid var(--line); border-radius:7px; padding:7px;
  color:var(--txt); font-family:var(--mono); font-size:12.5px; text-align:center;
}
.ue-reset{
  background:transparent; border:1px solid var(--line); color:var(--muted);
  font-family:var(--mono); font-size:12px; padding:8px 14px; border-radius:8px; cursor:pointer; width:100%;
}
.ue-reset:active{border-color:var(--gold); color:var(--txt);}

button:focus-visible, input:focus-visible{outline:2px solid var(--gold); outline-offset:2px;}

@media (max-width:360px){
  .ue-calib-grid{grid-template-columns:1fr 1fr;}
  .ue-gis-row{flex-direction:column;}
}
`;
