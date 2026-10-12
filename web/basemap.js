// The base map: quiet enough that the subway lines carry the color. Vector tiles from OpenFreeMap
// (OpenMapTiles schema), hillshade from the public Terrarium DEM tiles.
//
// No 3D terrain mesh on purpose: with terrain, lines are draped on the ground and any building in
// front of them hides them. Flat ground keeps lines drawn on top of the extruded buildings.
//
// Colors come from a palette, so the map can be dark, light, or follow Seoul's actual daylight
// (blending through dusk).

const name = ["coalesce", ["get", "name:ko"], ["get", "name"]];
const FONT = ["Noto Sans Regular"];

export const PALETTES = {
  dark: {
    bg: "#0b0f14", land: "#0d1218", wood: "#0e1913", park: "#0f1c16", water: "#0c1d2e", waterLine: "#10263b",
    motorway: "#2a3646", major: "#1d2733", minor: "#161d26", building: "#18202b", buildingTop: "#25303d",
    label: "#6b7785", halo: "#0b0f14", hsShadow: "#04060a", hsHighlight: "#22303f", hsAccent: "#0b1118",
    sky: "#0a1220", horizon: "#1a2a3c", light: "#d6e6ff",
    hillshade: 0.45, lightIntensity: 0.35, buildingOpacity: 0.8,
    // Used by the app's own layers.
    text: "#d5dde6", dim: "#2a323c", glow: 0.2,
  },
  dusk: {
    bg: "#1b1624", land: "#201a2b", wood: "#1e2028", park: "#21242c", water: "#24233c", waterLine: "#2c2a48",
    motorway: "#4a3c52", major: "#362d41", minor: "#2a2334", building: "#2b2437", buildingTop: "#463a55",
    label: "#a397b4", halo: "#1b1624", hsShadow: "#0c0910", hsHighlight: "#4a3a52", hsAccent: "#1a1420",
    sky: "#2a2246", horizon: "#e0875a", light: "#ffc9a3",
    hillshade: 0.45, lightIntensity: 0.4, buildingOpacity: 0.8,
    text: "#e9e1f2", dim: "#3a3245", glow: 0.18,
  },
  light: {
    bg: "#eef1f4", land: "#e9ecef", wood: "#dde8da", park: "#d6e7d2", water: "#b7d2e8", waterLine: "#a5c5df",
    motorway: "#ffffff", major: "#fbfcfd", minor: "#f5f7f9", building: "#dfe3e8", buildingTop: "#f6f7f9",
    label: "#6b7785", halo: "#ffffff", hsShadow: "#8d99a6", hsHighlight: "#ffffff", hsAccent: "#c7ced6",
    sky: "#bcd8f1", horizon: "#eef3f8", light: "#ffffff",
    hillshade: 0.3, lightIntensity: 0.45, buildingOpacity: 0.9,
    text: "#26303b", dim: "#c3cad2", glow: 0.12,
  },
};

const hex = (c) => {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

function mix(a, b, t) {
  const out = {};
  for (const k of Object.keys(a)) {
    out[k] = typeof a[k] === "number" ? a[k] + (b[k] - a[k]) * t : toHex(hex(a[k]).map((v, i) => v + (hex(b[k])[i] - v) * t));
  }
  return out;
}

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Sun elevation over Seoul in degrees (low-precision solar position; good to a fraction of a degree). */
export function sunElevation(date = new Date(), lat = 37.55, lon = 126.98) {
  const r = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * r;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * r;
  const e = (23.439 - 0.00000036 * d) * r;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = (gmst * 15 + lon) * r - ra;
  return Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(ha)) / r;
}

/**
 * The palette for a theme. "auto" follows the sun over Seoul: day, then dusk around sunset,
 * then night, and back through dawn. `ui` says whether panels should be light or dark.
 */
export function paletteFor(theme, date = new Date()) {
  if (theme === "light") return { palette: PALETTES.light, ui: "light" };
  if (theme === "dark") return { palette: PALETTES.dark, ui: "dark" };
  const el = sunElevation(date);
  const palette = el >= 0
    ? mix(PALETTES.dusk, PALETTES.light, smooth(0, 9, el))
    : mix(PALETTES.dark, PALETTES.dusk, smooth(-9, 0, el));
  return { palette, ui: el > 3 ? "light" : "dark" };
}

/** Paint properties of the base layers; shared by the initial style and theme changes. */
function paints(p) {
  return {
    bg: { "background-color": p.bg },
    landuse: { "fill-color": p.land },
    wood: { "fill-color": p.wood },
    park: { "fill-color": p.park },
    hillshade: {
      "hillshade-exaggeration": p.hillshade,
      "hillshade-shadow-color": p.hsShadow,
      "hillshade-highlight-color": p.hsHighlight,
      "hillshade-accent-color": p.hsAccent,
    },
    water: { "fill-color": p.water },
    waterway: { "line-color": p.waterLine },
    "road-minor": { "line-color": p.minor },
    "road-major": { "line-color": p.major },
    "road-motorway": { "line-color": p.motorway },
    buildings: {
      "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 10], 0, p.building, 120, p.buildingTop],
      "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, p.buildingOpacity],
    },
    "place-district": { "text-color": p.label, "text-halo-color": p.halo },
    "place-city": { "text-color": p.label, "text-halo-color": p.halo },
  };
}

const sky = (p) => ({
  "sky-color": p.sky,
  "horizon-color": p.horizon,
  "fog-color": p.bg,
  "sky-horizon-blend": 0.7,
  "horizon-fog-blend": 0.5,
  "fog-ground-blend": 0.5,
  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 1, 13, 0],
});
const light = (p) => ({ anchor: "viewport", color: p.light, intensity: p.lightIntensity, position: [1.3, 210, 35] });

export function applyPalette(map, p) {
  for (const [layer, props] of Object.entries(paints(p))) {
    for (const [k, v] of Object.entries(props)) map.setPaintProperty(layer, k, v);
  }
  map.setSky(sky(p));
  map.setLight(light(p));
}

const DEM = {
  type: "raster-dem",
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  encoding: "terrarium",
  tileSize: 256,
  maxzoom: 14,
  attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen/AWS</a>',
};

export function baseStyle(p) {
  const P = paints(p);
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
      hillshade: DEM,
    },
    sky: sky(p),
    light: light(p),
    layers: [
      { id: "bg", type: "background", paint: P.bg },
      {
        id: "landuse", type: "fill", source: "omt", "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial", "retail"]]],
        paint: P.landuse,
      },
      {
        id: "wood", type: "fill", source: "omt", "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["wood", "grass", "farmland"]]],
        paint: { ...P.wood, "fill-opacity": 0.8 },
      },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { ...P.park, "fill-opacity": 0.7 } },
      { id: "hillshade", type: "hillshade", source: "hillshade", paint: P.hillshade },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: P.water },
      {
        id: "waterway", type: "line", source: "omt", "source-layer": "waterway",
        paint: { ...P.waterway, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 15, 2] },
      },
      {
        id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 12.5,
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "tertiary"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { ...P["road-minor"], "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12.5, 0.5, 17, 6] },
      },
      {
        id: "road-major", type: "line", source: "omt", "source-layer": "transportation", minzoom: 9,
        filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "trunk"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { ...P["road-major"], "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 9, 0.4, 17, 10] },
      },
      {
        id: "road-motorway", type: "line", source: "omt", "source-layer": "transportation", minzoom: 8,
        filter: ["==", ["get", "class"], "motorway"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { ...P["road-motorway"], "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 8, 0.5, 17, 12] },
      },
      {
        id: "buildings", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 13,
        paint: {
          ...P.buildings,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 10],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-vertical-gradient": true,
        },
      },
      {
        id: "place-district", type: "symbol", source: "omt", "source-layer": "place", minzoom: 10, maxzoom: 15,
        filter: ["in", ["get", "class"], ["literal", ["suburb", "borough", "quarter"]]],
        layout: {
          "text-field": name,
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 13],
          "text-letter-spacing": 0.1,
        },
        paint: { ...P["place-district"], "text-opacity": 0.55, "text-halo-width": 1.2 },
      },
      {
        id: "place-city", type: "symbol", source: "omt", "source-layer": "place", maxzoom: 11,
        filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
        layout: { "text-field": name, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 7, 11, 11, 15], "text-letter-spacing": 0.15 },
        paint: { ...P["place-city"], "text-opacity": 0.7, "text-halo-width": 1.4 },
      },
    ],
  };
}
