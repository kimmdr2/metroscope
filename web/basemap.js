// A quiet, dark base map so the subway lines carry the color. Vector tiles from OpenFreeMap
// (OpenMapTiles schema), hillshade from the public Terrarium DEM tiles.
//
// No 3D terrain mesh on purpose: with terrain, lines are draped on the ground and any building in
// front of them hides them. Flat ground keeps lines drawn on top of the extruded buildings.

const name = ["coalesce", ["get", "name:ko"], ["get", "name"]];
const FONT = ["Noto Sans Regular"];

const C = {
  bg: "#0b0f14",
  land: "#0d1218",
  wood: "#0e1913",
  park: "#0f1c16",
  water: "#0c1d2e",
  waterLine: "#10263b",
  motorway: "#2a3646",
  major: "#1d2733",
  minor: "#161d26",
  building: "#18202b",
  buildingTop: "#25303d",
  label: "#6b7785",
  labelHalo: "#0b0f14",
};

const DEM = {
  type: "raster-dem",
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  encoding: "terrarium",
  tileSize: 256,
  maxzoom: 14,
  attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen/AWS</a>',
};

export function baseStyle() {
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
      hillshade: DEM,
    },
    sky: {
      "sky-color": "#0a1220",
      "horizon-color": "#1a2a3c",
      "fog-color": "#0b0f14",
      "sky-horizon-blend": 0.7,
      "horizon-fog-blend": 0.5,
      "fog-ground-blend": 0.5,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 1, 13, 0],
    },
    light: { anchor: "viewport", color: "#d6e6ff", intensity: 0.35, position: [1.3, 210, 35] },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.bg } },
      {
        id: "landuse", type: "fill", source: "omt", "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial", "retail"]]],
        paint: { "fill-color": C.land },
      },
      {
        id: "wood", type: "fill", source: "omt", "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["wood", "grass", "farmland"]]],
        paint: { "fill-color": C.wood, "fill-opacity": 0.8 },
      },
      {
        id: "park", type: "fill", source: "omt", "source-layer": "park",
        paint: { "fill-color": C.park, "fill-opacity": 0.7 },
      },
      {
        id: "hillshade", type: "hillshade", source: "hillshade",
        paint: {
          "hillshade-exaggeration": 0.45,
          "hillshade-shadow-color": "#04060a",
          "hillshade-highlight-color": "#22303f",
          "hillshade-accent-color": "#0b1118",
        },
      },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": C.water } },
      {
        id: "waterway", type: "line", source: "omt", "source-layer": "waterway",
        paint: { "line-color": C.waterLine, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 15, 2] },
      },
      {
        id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 12.5,
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "tertiary"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.minor, "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12.5, 0.5, 17, 6] },
      },
      {
        id: "road-major", type: "line", source: "omt", "source-layer": "transportation", minzoom: 9,
        filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "trunk"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.major, "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 9, 0.4, 17, 10] },
      },
      {
        id: "road-motorway", type: "line", source: "omt", "source-layer": "transportation", minzoom: 8,
        filter: ["==", ["get", "class"], "motorway"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.motorway, "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 8, 0.5, 17, 12] },
      },
      {
        id: "buildings", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 13,
        paint: {
          "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 10], 0, C.building, 120, C.buildingTop],
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 10],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 0.8],
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
        paint: { "text-color": C.label, "text-opacity": 0.55, "text-halo-color": C.labelHalo, "text-halo-width": 1.2 },
      },
      {
        id: "place-city", type: "symbol", source: "omt", "source-layer": "place", maxzoom: 11,
        filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
        layout: { "text-field": name, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 7, 11, 11, 15], "text-letter-spacing": 0.15 },
        paint: { "text-color": C.label, "text-opacity": 0.7, "text-halo-color": C.labelHalo, "text-halo-width": 1.4 },
      },
    ],
  };
}
